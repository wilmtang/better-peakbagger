"""Build smaller delivery PMTiles from completed archives; never rewrite originals."""
import argparse
from collections import defaultdict
import fcntl
import gzip
import hashlib
import json
import mmap
from pathlib import Path
import shutil
import tempfile
import time
import zlib

from mapbox_vector_tile.Mapbox import vector_tile_pb2
from mapbox_vector_tile.decoder import TileData
from pmtiles.reader import Reader
from pmtiles.tile import Compression, Entry, deserialize_directory, tileid_to_zxy
from pmtiles.writer import Writer
from shapely.geometry import LineString, MultiPolygon, Polygon, box, shape

from fcc_download import ROOT, atomic_json
from fcc_catalog import build_catalog

PROFILE = 'overview-subpixel-holes-v2'
KEEP_FROM_ZOOM = 12
TOLERANCE_PIXELS = 0.5
HOLE_MAX_PIXELS = 1.0
MAX_RAW_TILE_BYTES = 128*1024**2
MAX_GEOMETRY_COMMANDS = 1_000_000


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def entries(data, header, offset=None, length=None, depth=0):
    """Yield addressed directory runs without materializing all tile payloads."""
    assert depth < 4
    if offset is None:
        offset, length = header['root_offset'], header['root_length']
    assert length > 0 and 0 <= offset < offset + length <= len(data)
    for entry in deserialize_directory(data[offset:offset+length]):
        if entry.run_length:
            assert entry.length > 0 and entry.offset + entry.length <= header['tile_data_length']
            yield entry
        else:
            yield from entries(data, header, header['leaf_directory_offset']+entry.offset, entry.length, depth+1)


def area(coords):
    return sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(coords, coords[1:]))


def simplify_ring(coords, tolerance, extent):
    """RDP chains with pinned seam crossings; retain original integer vertices."""
    points = list(map(tuple, coords[:-1]))
    count = len(points)
    if count <= 3:
        return coords
    if min(max(p[axis] for p in points)-min(p[axis] for p in points) for axis in (0, 1)) <= 2*tolerance:
        return coords  # Do not reshape very small islands or narrow holes.
    anchors = {0, count//3, 2*count//3}
    for i, p in enumerate(points):
        q = points[(i+1) % count]
        # Pin both endpoints of every segment crossing a tile edge, and vertices
        # close to it. Adjacent tiles must keep their original edge intersections.
        near = any(abs(p[axis]-edge) <= 2*tolerance for axis in (0, 1) for edge in (0, extent))
        crosses = any(min(p[axis], q[axis]) <= edge <= max(p[axis], q[axis])
                      for axis in (0, 1) for edge in (0, extent))
        if near or crosses:
            anchors.update((i, (i+1) % count))
    anchors = sorted(anchors)
    output = []
    for start, stop in zip(anchors, anchors[1:] + [anchors[0]+count]):
        chain = points[start:stop+1] if stop < count else points[start:] + points[:stop-count+1]
        reduced = list(LineString(chain).simplify(tolerance, preserve_topology=False).coords)
        output.extend(reduced[:-1])
    output.append(output[0])
    if len(output) < 4 or area(coords)*area(output) <= 0:
        return coords
    return output


def simplify_geometry(original, tolerance, extent):
    """Keep invalid inputs unchanged; reject topology or seam changes."""
    if original.is_empty or not original.is_valid:
        return original
    polygons = list(original.geoms) if original.geom_type == 'MultiPolygon' else [original]
    reduced = []
    seam = box(0, 0, extent, extent).boundary
    for polygon in polygons:
        shell = simplify_ring(list(polygon.exterior.coords), tolerance, extent)
        holes = []
        for ring in polygon.interiors:
            left, bottom, right, top = ring.bounds
            if max(right-left, top-bottom) <= extent/512*HOLE_MAX_PIXELS and not ring.intersects(seam):
                continue  # A distant overview cannot reliably display subpixel holes.
            holes.append(simplify_ring(list(ring.coords), tolerance, extent))
        reduced.append(Polygon(shell, holes))
    candidate = MultiPolygon(reduced) if original.geom_type == 'MultiPolygon' else reduced[0]
    if candidate.is_empty or not candidate.is_valid:
        return original
    if not original.intersection(seam).equals(candidate.intersection(seam)):
        return original
    return candidate


def geometry_commands(geometry):
    """Encode polygon commands only; retain protobuf IDs, tags and dictionaries."""
    result, x, y = [], 0, 0
    polygons = list(geometry.geoms) if geometry.geom_type == 'MultiPolygon' else [geometry]
    for polygon in polygons:
        for ring in [polygon.exterior, *polygon.interiors]:
            coords = list(ring.coords)[:-1]
            assert len(coords) >= 3
            for i, (px, py) in enumerate(coords):
                assert px == int(px) and py == int(py), 'Simplification introduced new coordinates'
                if i == 0:
                    result.append(9)  # MoveTo, count 1
                elif i == 1:
                    result.append(((len(coords)-1) << 3) | 2)
                dx, dy = int(px)-x, int(py)-y
                result.extend(((dx << 1) ^ (dx >> 63), (dy << 1) ^ (dy >> 63)))
                x, y = int(px), int(py)
            result.append(15)  # ClosePath, count 1
    return result


def compact_tile(payload, zoom):
    if zoom >= KEEP_FROM_ZOOM:
        return payload
    decoder = zlib.decompressobj(16+zlib.MAX_WBITS)
    raw = decoder.decompress(payload, MAX_RAW_TILE_BYTES+1)
    if len(raw) > MAX_RAW_TILE_BYTES or decoder.unconsumed_tail:
        return payload  # Leave exceptionally large inputs intact instead of exhausting RAM.
    assert decoder.eof and not decoder.unused_data, 'Invalid gzip tile payload'
    message = vector_tile_pb2.tile()
    message.ParseFromString(raw)
    del raw
    parser = TileData(b'')
    changed = False
    for layer in message.layers:
        assert layer.name == 'coverage' and layer.version == 2 and layer.extent > 0
        tolerance = layer.extent / 512 * TOLERANCE_PIXELS
        for feature in layer.features:
            assert feature.type == 3, 'Expected polygon coverage'
            if len(feature.geometry) > MAX_GEOMETRY_COMMANDS:
                continue
            original = shape(parser.parse_geometry(feature.geometry, 3, layer.extent, True, None))
            candidate = simplify_geometry(original, tolerance, layer.extent)
            commands = geometry_commands(candidate) if candidate is not original else None
            if commands is not None and len(commands) < len(feature.geometry):
                del feature.geometry[:]
                feature.geometry.extend(commands)
                changed = True
    if not changed:
        return payload
    result = gzip.compress(message.SerializeToString(), compresslevel=9, mtime=0)
    return result if len(result) < len(payload) else payload


def verify_feature_fields(original, result):
    if original == result:
        return
    messages = []
    for payload in (original, result):
        message = vector_tile_pb2.tile()
        message.ParseFromString(gzip.decompress(payload))
        for layer in message.layers:
            for feature in layer.features:
                feature.ClearField('geometry')
        messages.append(message.SerializeToString())
    assert messages[0] == messages[1], 'Feature order, IDs, attributes or layer schema changed'


class SafeWriter(Writer):
    """Use SHA-256 plus byte comparisons, and scratch on the dedicated disk."""
    def __init__(self, output, directory):
        super().__init__(output)
        self.tile_f.close()
        self.tile_f = tempfile.TemporaryFile(dir=directory)

    def write_tile(self, tileid, data):
        assert not self.tile_entries or tileid >= self.tile_entries[-1].tile_id+self.tile_entries[-1].run_length
        key = hashlib.sha256(data).digest()
        if key in self.hash_to_offset:
            offset, length = self.hash_to_offset[key]
            self.tile_f.seek(offset)
            assert length == len(data) and self.tile_f.read(length) == data, 'Payload digest collision'
            self.tile_f.seek(self.offset)
            last = self.tile_entries[-1]
            if tileid == last.tile_id+last.run_length and last.offset == offset:
                last.run_length += 1
            else:
                self.tile_entries.append(Entry(tileid, offset, length, 1))
        else:
            self.tile_f.write(data)
            self.tile_entries.append(Entry(tileid, self.offset, len(data), 1))
            self.hash_to_offset[key] = self.offset, len(data)
            self.offset += len(data)
        self.addressed_tiles += 1


def benchmark(path, output, maximum=2_000_000):
    rows = []
    code_hash = digest(Path(__file__))
    with path.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
        reader = Reader(lambda offset, length: data[offset:offset+length])
        header = reader.header()
        assert header['tile_compression'] == Compression.GZIP
        selected = {}
        for entry in entries(data, header):
            zoom = tileid_to_zxy(entry.tile_id)[0]
            if entry.length <= maximum and (zoom not in selected or entry.length > selected[zoom].length):
                selected[zoom] = entry
        assert selected and KEEP_FROM_ZOOM in selected
        for zoom, entry in sorted(selected.items()):
            begin = header['tile_data_offset']+entry.offset
            payload = data[begin:begin+entry.length]
            started = time.monotonic()
            result = compact_tile(payload, zoom)
            verify_feature_fields(payload, result)
            row = {'zxy':tileid_to_zxy(entry.tile_id), 'beforeBytes':len(payload), 'afterBytes':len(result),
                   'savedPercent':round(100*(1-len(result)/len(payload)), 2),
                   'identicalPayload':result == payload, 'seconds':round(time.monotonic()-started, 3)}
            if zoom >= KEEP_FROM_ZOOM:
                assert row['identicalPayload']
            rows.append(row)
            atomic_json(output, {'status':'running', 'profile':PROFILE, 'sampleOnly':True, 'tiles':rows})
            print(json.dumps(row), flush=True)
    report = {'status':'complete', 'profile':PROFILE, 'sampleOnly':True, 'input':str(path),
              'codeSha256':code_hash, 'allFeatureFieldsAndOrderVerified':True,
              'maximumCompressedInputBytes':maximum, 'tiles':rows,
              'wholeArchiveSizeReduction':'Not measured by this bounded sample'}
    atomic_json(output, report)
    return report


def compact_archive(source_path, destination):
    assert source_path.resolve() != destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    assert not destination.exists(), 'Refusing to overwrite an output without a verified receipt'
    assert shutil.disk_usage(destination.parent).free > source_path.stat().st_size*2+12*1024**3
    temporary = destination.with_suffix('.pmtiles.part')
    progress = destination.with_suffix('.progress.json')
    before_hash = digest(source_path)
    counts = defaultdict(lambda: {'tiles':0, 'beforePayloadBytes':0, 'afterPayloadBytes':0})
    with source_path.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
        reader = Reader(lambda offset, length: data[offset:offset+length])
        header, metadata = reader.header(), reader.metadata()
        assert header['tile_compression'] == Compression.GZIP and header['max_zoom'] == KEEP_FROM_ZOOM
        with temporary.open('wb') as output:
            writer = SafeWriter(output, destination.parent)
            try:
                for entry in entries(data, header):
                    zoom = tileid_to_zxy(entry.tile_id)[0]
                    assert tileid_to_zxy(entry.tile_id+entry.run_length-1)[0] == zoom
                    start = header['tile_data_offset']+entry.offset
                    payload = data[start:start+entry.length]
                    reduced = compact_tile(payload, zoom)
                    for tileid in range(entry.tile_id, entry.tile_id+entry.run_length):
                        writer.write_tile(tileid, reduced)
                    stats = counts[zoom]
                    stats['tiles'] += entry.run_length
                    stats['beforePayloadBytes'] += len(payload)*entry.run_length
                    stats['afterPayloadBytes'] += len(reduced)*entry.run_length
                    if sum(item['tiles'] for item in counts.values()) % 100 == 0:
                        atomic_json(progress, {'stage':'compacting', 'profile':PROFILE, 'byZoom':dict(counts)})
                metadata['bpb_compaction'] = {'profile':PROFILE, 'unchangedFromZoom':KEEP_FROM_ZOOM,
                    'overviewTolerancePixelsAt512':TOLERANCE_PIXELS, 'allSourceAttributesRetained':True,
                    'overviewHoleMaxPixelsAt512':HOLE_MAX_PIXELS,
                    'originalArchiveSha256':before_hash, 'overviewGeometryIsApproximate':True}
                writer.finalize(dict(header), metadata)
            finally:
                writer.tile_f.close()
    # Independent archive traversal: every tile address retained, every gzip
    # valid, and all finest-zoom compressed bytes exactly match the original.
    with source_path.open('rb') as original, temporary.open('rb') as output, \
            mmap.mmap(original.fileno(), 0, access=mmap.ACCESS_READ) as a, \
            mmap.mmap(output.fileno(), 0, access=mmap.ACCESS_READ) as b:
        source_reader = Reader(lambda offset, length: a[offset:offset+length])
        result_reader = Reader(lambda offset, length: b[offset:offset+length])
        result_header = result_reader.header()
        assert result_header['addressed_tiles_count'] == header['addressed_tiles_count']
        verified = 0
        finest = hashlib.sha256()
        for entry in entries(a, header):
            for tileid in range(entry.tile_id, entry.tile_id+entry.run_length):
                zxy = tileid_to_zxy(tileid)
                result = result_reader.get(*zxy)
                assert result is not None
                gzip.decompress(result)
                if zxy[0] >= KEEP_FROM_ZOOM:
                    assert result == source_reader.get(*zxy), 'Finest-zoom tile changed'
                    finest.update(tileid.to_bytes(8, 'little'))
                    finest.update(hashlib.sha256(result).digest())
                else:
                    verify_feature_fields(source_reader.get(*zxy), result)
                verified += 1
        assert verified == header['addressed_tiles_count']
    assert digest(source_path) == before_hash, 'Original archive changed during compaction'
    receipt = {'status':'complete', 'profile':PROFILE, 'inputSha256':before_hash,
               'inputBytes':source_path.stat().st_size, 'bytes':temporary.stat().st_size,
               'sha256':digest(temporary), 'byZoom':dict(counts), 'verifiedTileAddresses':verified,
               'allGzipPayloadsVerified':True, 'allFinestZoomTilesByteIdentical':True,
               'allFeatureFieldsAndOrderVerified':True,
               'finestZoomPayloadSetSha256':finest.hexdigest(), 'browserVerification':'pending separately'}
    temporary.replace(destination)
    atomic_json(destination.with_suffix('.json'), receipt)
    progress.unlink(missing_ok=True)
    return receipt


def delivery(wait=False):
    """Wait for the independent baseline build, then produce a separate catalog."""
    output = ROOT/'delivery'
    output.mkdir(exist_ok=True)
    with (output/'compaction.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return build_delivery(output, wait)


def build_delivery(output, wait):
    audit = ROOT/'verification/vps-final-data-audit.json'
    while not audit.exists() or json.loads(audit.read_text()).get('status') != 'complete':
        if not wait:
            raise RuntimeError('Baseline data audit must complete before full delivery compaction')
        run = json.loads((ROOT/'metadata/vps-run.json').read_text())
        if run['stage'] in ('failed', 'stopped'):
            raise RuntimeError('Baseline conversion is '+run['stage'])
        atomic_json(output/'status.json', {'stage':'waiting_for_baseline', 'profile':PROFILE,
                    'convertedSourceArchives':run['convertedSourceArchives']})
        time.sleep(30)
    manifest = json.loads((ROOT/'manifest.json').read_text())
    assert manifest['status'] == 'complete' and len(manifest['archives']) == 9
    results = []
    for record in manifest['archives']:
        source = ROOT/record['path']
        destination = output/'tiles'/Path(record['path']).name
        receipt_path = destination.with_suffix('.json')
        if receipt_path.exists():
            receipt = json.loads(receipt_path.read_text())
            assert receipt['status'] == 'complete' and receipt['profile'] == PROFILE
            assert receipt['inputSha256'] == record['sha256'] == digest(source)
            assert receipt['sha256'] == digest(destination)
        else:
            atomic_json(output/'status.json', {'stage':'compacting', 'profile':PROFILE, 'archive':record['path']})
            assert digest(source) == record['sha256']
            receipt = compact_archive(source, destination)
        results.append({**record, **receipt, 'path':str(destination.relative_to(output))})
    result = {**manifest, 'profile':PROFILE, 'geometryPolicy':'Zoom 12 unchanged; approximate overviews fill holes no larger than one pixel at 512 px per tile',
              'originalTileBytes':manifest['tileBytes'], 'tileBytes':sum(item['bytes'] for item in results),
              'archives':results, 'browserVerification':'pending separately'}
    atomic_json(output/'manifest.json', result)
    catalog = build_catalog(results, True)
    catalog.update(profile=PROFILE, geometry=result['geometryPolicy'])
    atomic_json(output/'catalog.json', catalog)
    atomic_json(output/'status.json', {'stage':'complete', 'profile':PROFILE,
                'originalTileBytes':result['originalTileBytes'], 'tileBytes':result['tileBytes']})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    sample = commands.add_parser('benchmark')
    sample.add_argument('input', type=Path)
    sample.add_argument('report', type=Path)
    sample.add_argument('--maximum-input-bytes', type=int, default=2_000_000)
    build = commands.add_parser('delivery')
    build.add_argument('--wait', action='store_true')
    args = parser.parse_args()
    if args.command == 'benchmark':
        assert 0 < args.maximum_input_bytes <= 2_000_000
        benchmark(args.input, args.report, args.maximum_input_bytes)
    else:
        try:
            delivery(args.wait)
        except Exception as error:
            atomic_json(ROOT/'delivery/status.json', {'stage':'failed', 'profile':PROFILE, 'error':str(error)})
            raise


if __name__ == '__main__':
    main()
