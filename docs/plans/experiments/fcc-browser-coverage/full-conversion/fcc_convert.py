"""Stream FCC source archives to attribute-preserving, coalesced coverage PMTiles."""
import argparse
import fcntl
from collections import defaultdict, OrderedDict
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
import gzip
import hashlib
import json
import math
import mmap
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import zipfile

import mapbox_vector_tile
import pyarrow as pa
import pyarrow.compute as pc
import pyogrio
from pmtiles.reader import Reader
from pmtiles.tile import Compression
import shapely
from shapely.geometry import Point, shape

from fcc_download import ROOT, atomic_json

BIN = Path(os.environ.get('FCC_TIPPECANOE_DIR', ROOT/'tools/felt-tippecanoe-68ab8dc')).expanduser().resolve()
PROVIDERS = {'130077': 'att', '131425': 'verizon', '130403': 'tmobile'}
MINZOOM, MAXZOOM = 4, 12
FIELDS = ['frn', 'providerid', 'brandname', 'technology', 'mindown', 'minup', 'minsignal', 'environmnt']


def validate_source(gpkg, info, row, entry_name):
    """Check identity and distinguish catalog estimates from actual source rows."""
    layer = Path(entry_name).stem
    assert layer.rsplit('_', 1)[0] == row['file_name'].rsplit('_', 1)[0], 'Unexpected source archive identity'
    assert info['layer_name'] == layer, 'Unexpected source layer identity'
    assert info['crs'] == 'EPSG:4326'
    assert set(info['fields']) == set(FIELDS), ('Unexpected source columns', info['fields'])
    assert info['geometry_type'] in ('Polygon', 'MultiPolygon')
    assert info['features'] > 0
    result = {'catalogFeatures': int(row['record_count']), 'packageFeatures': int(info['features'])}
    if result['catalogFeatures'] != result['packageFeatures']:
        # The FCC can publish a catalog count differing from both source formats.
        # Verify the actual package independently; never fabricate missing rows.
        with sqlite3.connect(gpkg.as_uri() + '?mode=ro', uri=True) as db:
            assert db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'Source database integrity failure'
            quoted = '"' + layer.replace('"', '""') + '"'
            counted = db.execute('SELECT COUNT(*) FROM ' + quoted).fetchone()[0]
        assert counted == info['features'], 'GeoPackage feature metadata differs from actual rows'
        result.update(countedFeatures=counted, catalogCountDiffers=True,
                      policy='All actual source rows retained; FCC catalog count differs')
    return result


def tile_key(lon, lat, zoom):
    count = 2**zoom
    x = (lon + 180) / 360 * count
    y = (1 - math.asinh(math.tan(math.radians(max(-85.05112878, min(85.05112878, lat))))) / math.pi) / 2 * count
    return min(count-1, max(0, math.floor(x))), min(count-1, max(0, math.floor(y))), x % 1, y % 1


def verify_tiles(path, samples):
    with path.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as mapping:
        assert mapping[:8] == b'PMTiles\x03'
        reader = Reader(lambda offset, length: mapping[offset:offset+length])
        header = reader.header()
        metadata = reader.metadata()
        assert header['min_zoom'] == MINZOOM and header['max_zoom'] == MAXZOOM
        assert header['tile_data_offset'] + header['tile_data_length'] == len(mapping)
        assert header['addressed_tiles_count'] > 0
        layers = metadata['vector_layers']
        assert len(layers) == 1 and layers[0]['id'] == 'coverage'
        assert set(layers[0]['fields']) == set(FIELDS)
        cache = OrderedDict()
        checked_tiles = set()
        checked = 0
        for sample in samples:
            lon, lat = sample['point']
            x, y, u, v = tile_key(lon, lat, MAXZOOM)
            key = (x, y)
            if key not in cache:
                data = reader.get(MAXZOOM, x, y)
                assert data, ('No tile for source sample', sample)
                if header['tile_compression'] == Compression.GZIP:
                    data = gzip.decompress(data)
                cache[key] = mapbox_vector_tile.decode(data, default_options={'y_coord_down': True})['coverage']
                if len(cache) > 16:
                    cache.popitem(last=False)
            cache.move_to_end(key)
            checked_tiles.add(key)
            layer = cache[key]
            point = Point(u * layer['extent'], v * layer['extent'])
            matches = [f for f in layer['features'] if f['properties'] == sample['properties']]
            assert any(shape(feature['geometry']).covers(point) for feature in matches), ('Source classification lost', sample)
            checked += 1
        assert checked > 0, 'No independent source geometry samples were checked'
        return {'sampledSourcePoints': checked, 'sampledMaximumZoomTiles': len(checked_tiles),
                'addressedTiles': header['addressed_tiles_count'],
                'uniqueTileContents': header['tile_contents_count'],
                'minimumZoom': MINZOOM, 'maximumZoom': MAXZOOM,
                'bounds': [header[key]/1e7 for key in ['min_lon_e7','min_lat_e7','max_lon_e7','max_lat_e7']],
                'sourceLayer': 'coverage', 'fields': list(layers[0]['fields'])}


def convert_one(file_id):
    file_id = str(file_id)
    receipt_path = ROOT / 'metadata/downloads' / (file_id + '.json')
    receipt = json.loads(receipt_path.read_text())
    row = receipt['source']
    archive = ROOT / 'data' / (file_id + '.zip')
    work = ROOT / 'work' / file_id
    work.mkdir(parents=True, exist_ok=True)
    status = ROOT / 'metadata/converting' / (file_id + '.json')
    destination = ROOT / 'tiles/states' / (file_id + '.pmtiles')
    destination.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()

    def stage(name, **extra):
        atomic_json(status, {'fileId': file_id, 'stage': name, 'provider': row['provider_name'],
                             'state': row['state_name'], 'technology': row['technology_code_desc'], **extra})

    stage('extracting')
    assert archive.stat().st_size == receipt['bytes']
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    assert digest == receipt['sha256'], 'Downloaded archive changed'
    gpkg = work / 'source.gpkg'
    with zipfile.ZipFile(archive) as zipped:
        names = zipped.namelist()
        assert len(names) == 1 and names[0].endswith('.gpkg')
        entry = zipped.getinfo(names[0])
        if shutil.disk_usage(ROOT).free < 12 * 1024**3 + entry.file_size * 3:
            raise RuntimeError('Insufficient free space for source and streaming intermediates')
        with zipped.open(entry) as source, gpkg.open('wb') as target:
            shutil.copyfileobj(source, target, length=1024*1024)
        assert gpkg.stat().st_size == entry.file_size
    info = pyogrio.read_info(gpkg, force_feature_count=True)
    source_validation = validate_source(gpkg, info, row, entry.filename)
    bounds = [float(v) for v in info['total_bounds']]
    assert all(math.isfinite(v) for v in bounds)
    assert -180 <= bounds[0] <= bounds[2] <= 180 and -90 <= bounds[1] <= bounds[3] <= 90
    sequence = work / 'source.geojsonl'
    stage('streaming_geojson', sourceFeatures=info['features'])
    seen, samples = 0, []
    values = defaultdict(set)
    stride = max(1, info['features'] // 24)
    next_sample = 0
    with pyogrio.open_arrow(gpkg, use_pyarrow=True, batch_size=1024) as (meta, source_reader):
        geom = meta['geometry_name']

        def batches():
            nonlocal seen, next_sample
            for batch in source_reader:
                assert batch.column(geom).null_count == 0
                for name in FIELDS:
                    column = batch.column(name)
                    assert column.null_count == 0, 'Null source property: ' + name
                    values[name].update(pc.unique(column).to_pylist())
                assert pc.all(pc.equal(batch.column('providerid'), int(row['provider_id']))).as_py()
                assert pc.all(pc.equal(batch.column('technology'), int(row['technology_code']))).as_py()
                assert values['environmnt'] <= {0, 1}
                # Source points are calculated before JSON/tiling, independently of the tile encoder.
                while seen + batch.num_rows > next_sample and len(samples) < 32:
                    index = min(batch.num_rows-1, max(0, next_sample-seen))
                    indices = list(range(index, min(index+8, batch.num_rows)))
                    for candidate in indices:
                        polygon = shapely.from_wkb(batch.column(geom)[candidate].as_py())
                        assert polygon.geom_type in ('Polygon', 'MultiPolygon') and not polygon.is_empty
                        point = polygon.representative_point()
                        # Keep point assertions away from the documented MVT quantization boundary.
                        if point.distance(polygon.boundary) > 0.00005:
                            properties = {name: batch.column(name)[candidate].as_py() for name in FIELDS}
                            samples.append({'point': [point.x, point.y], 'properties': properties})
                            break
                    next_sample += stride
                seen += batch.num_rows
                if seen % (1024*128) == 0:
                    stage('streaming_geojson', streamedFeatures=seen, sourceFeatures=info['features'])
                yield batch

        reader = pa.RecordBatchReader.from_batches(source_reader.schema, batches())
        pyogrio.write_arrow(reader, sequence, driver='GeoJSONSeq', geometry_name=geom,
                            geometry_type=info['geometry_type'], crs=meta['crs'],
                            layer_options={'COORDINATE_PRECISION': '9', 'RS': 'NO'})
    assert seen == info['features'] and samples
    atomic_json(work / 'source-oracle.json', samples)
    stage('tiling', sourceFeatures=seen, geojsonBytes=sequence.stat().st_size)
    temporary = work / 'coverage.pmtiles'
    temporary.unlink(missing_ok=True)
    command = [str(BIN/'tippecanoe'), '--minimum-zoom='+str(MINZOOM), '--maximum-zoom='+str(MAXZOOM),
               '--layer=coverage', '--coalesce', '--no-feature-limit', '--no-tile-size-limit',
               '--no-tiny-polygon-reduction', '--no-simplification-of-shared-nodes',
               '--full-detail=12', '--low-detail=12', '--output='+str(temporary), str(sequence)]
    environment = {**os.environ, 'TIPPECANOE_MAX_THREADS': '1', 'TMPDIR': str(work)}
    with (ROOT/'logs'/('tile-'+file_id+'.log')).open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=environment, check=True)
    stage('verifying')
    verification = verify_tiles(temporary, samples)
    output_digest = hashlib.file_digest(temporary.open('rb'), 'sha256').hexdigest()
    destination.unlink(missing_ok=True)
    temporary.replace(destination)
    speed = 'lte' if row['technology_code']=='400' else '5g-'+row['speed_tier'].replace('/', '-')
    result = {'source': row, 'sourceDownload': receipt, 'sourceFeatures': seen,
              'sourceValidation': source_validation,
              'asOfDate': '2025-12-31', 'provider': PROVIDERS[row['provider_id']], 'variant': speed,
              'tileFile': str(destination.relative_to(ROOT)), 'tileBytes': destination.stat().st_size,
              'sha256': output_digest, 'verification': verification,
              'sourcePropertyValues': {key: sorted(value) for key, value in values.items()},
              'sourceSamples': samples, 'seconds': round(time.monotonic()-started, 2),
              'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    atomic_json(ROOT/'metadata/converted'/(file_id+'.json'), result)
    shutil.rmtree(work)
    status.unlink(missing_ok=True)
    archive.unlink()  # Reproducible download cache; receipt and hashes remain.
    return {'fileId': file_id, 'provider': result['provider'], 'variant': speed,
            'state': row['state_name'], 'sourceFeatures': seen, 'tileBytes': result['tileBytes'],
            'seconds': result['seconds']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file-id', type=int)
    parser.add_argument('--jobs', type=int, default=1)
    parser.add_argument('--watch', action='store_true')
    args = parser.parse_args()
    assert 1 <= args.jobs <= 4
    for name in ['work','logs','metadata/converting','metadata/converted']:
        (ROOT/name).mkdir(parents=True, exist_ok=True)
    if args.file_id:
        print(json.dumps(convert_one(args.file_id)), flush=True)
        return
    assert args.watch, 'Select --file-id or --watch'
    conversion_lock = (ROOT/'metadata/converter.lock').open('a+')
    fcntl.flock(conversion_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    selected = json.loads((ROOT/'metadata/selected-downloads.json').read_text())
    expected = {str(row['file_id']) for row in selected}
    active = {}

    def disk_reserve(fid):
        receipt = json.loads((ROOT/'metadata/downloads'/(fid+'.json')).read_text())
        # Reserve for extraction, JSON, encoder scratch, and the generated tile archive.
        return max(2*1024**3, receipt['entries'][0]['bytes']*8)

    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        while True:
            complete = {p.stem for p in (ROOT/'metadata/converted').glob('*.json')}
            if complete == expected:
                atomic_json(ROOT/'metadata/conversion-complete.json', {'count': len(complete)})
                return
            assert complete <= expected
            ready = [p.stem for p in (ROOT/'metadata/downloads').glob('*.json')
                     if p.stem not in complete and p.stem not in active.values()]
            for fid in sorted(ready, key=int):
                if len(active) >= args.jobs:
                    break
                reserved = sum(disk_reserve(other) for other in active.values())
                if shutil.disk_usage(ROOT).free >= 12*1024**3 + reserved + disk_reserve(fid):
                    active[pool.submit(convert_one, fid)] = fid
            atomic_json(ROOT/'metadata/conversion-progress.json',
                        {'complete': len(complete), 'total': len(expected), 'active': list(active.values()),
                         'pid': os.getpid(), 'updatedAt': time.time(), 'jobs': args.jobs})
            if active:
                finished, _ = wait(active, timeout=5, return_when=FIRST_COMPLETED)
                for future in finished:
                    result = future.result()
                    del active[future]
                    print(json.dumps(result), flush=True)
            else:
                time.sleep(5)


if __name__ == '__main__':
    main()
