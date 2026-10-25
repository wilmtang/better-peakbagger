"""Measure PMTiles for the retained small sample; never extrapolate it nationally."""
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import zipfile


assert len(sys.argv) == 4, 'Usage: measure-tiles.py sample.zip empty-output-directory tippecanoe'
archive, output, executable = map(lambda value: Path(value).resolve(), sys.argv[1:])
assert output.is_dir() and not any(output.iterdir()), 'Use an empty output directory'
assert executable.is_file()
decoder = executable.with_name('tippecanoe-decode')
assert decoder.is_file()
manifest_path = Path(__file__).with_name('source-manifest.json')
manifest = json.loads(manifest_path.read_text())
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest['zipSha256']
with zipfile.ZipFile(archive) as zipped:
    assert zipped.namelist() == ['sample.gpkg']
    assert zipped.getinfo('sample.gpkg').file_size == manifest['geopackageBytes']
    database = zipped.read('sample.gpkg')


def geometry(blob):
    # This deliberately accepts only the trusted fixture's exact GP/WKB variant.
    assert blob[:4] == b'GP\x00\x03'
    assert struct.unpack_from('<i', blob, 4)[0] == 4326
    offset = 40
    endian, kind, ring_count = struct.unpack_from('<BII', blob, offset)
    assert (endian, kind) == (1, 3) and ring_count > 0
    offset += 9
    rings = []
    for _ in range(ring_count):
        count = struct.unpack_from('<I', blob, offset)[0]
        offset += 4
        assert count >= 4
        points = [list(struct.unpack_from('<dd', blob, offset + i * 16)) for i in range(count)]
        offset += count * 16
        assert points[0] == points[-1]
        assert all(math.isfinite(x) and math.isfinite(y) and -180 <= x <= 180 and -90 <= y <= 90
                   for x, y in points)
        rings.append(points)
    assert offset == len(blob)
    return {'type': 'Polygon', 'coordinates': rings}


with sqlite3.connect(':memory:') as db:
    db.deserialize(database)
    rows = db.execute('SELECT id,h3_res9_id,technology,mindown,minup,environmnt,geom FROM mobile').fetchall()
assert len(rows) == manifest['rows']
features = []
for row in rows:
    properties = dict(zip(['h3_res9_id', 'technology', 'mindown', 'minup', 'environmnt'], row[1:6]))
    features.append({'type': 'Feature', 'id': row[0], 'properties': properties, 'geometry': geometry(row[6])})
expected_ids = {feature['id'] for feature in features}
assert len(expected_ids) == len(features)
version = subprocess.check_output([str(executable), '--version'], stderr=subprocess.STDOUT, text=True).strip()
results = []
for name, maxzoom, keep_h3 in [('details-z12', 12, True), ('details-z14', 14, True), ('coverage-z14', 14, False)]:
    source = output / f'{name}.geojsonl'
    selected = []
    for feature in features:
        properties = {key: value for key, value in feature['properties'].items() if keep_h3 or key != 'h3_res9_id'}
        selected.append(dict(feature, properties=properties))
    source.write_text(''.join(json.dumps(feature, separators=(',', ':')) + '\n' for feature in selected))
    target = output / f'{name}.pmtiles'
    args = [str(executable), '--quiet', '--minimum-zoom=6', f'--maximum-zoom={maxzoom}',
            '--layer=coverage', '--no-feature-limit', '--no-tile-size-limit',
            '--no-tiny-polygon-reduction', '--no-line-simplification',
            '--output=' + str(target), str(source)]
    subprocess.run(args, check=True)
    data = target.read_bytes()
    assert data[:8] == b'PMTiles\x03' and data[100:102] == bytes([6, maxzoom])
    tile_bytes = struct.unpack_from('<Q', data, 64)[0]
    addressed, entries, contents = struct.unpack_from('<QQQ', data, 72)
    decoded = json.loads(subprocess.check_output([str(decoder), str(target)], stderr=subprocess.DEVNULL))
    tiles = decoded['features']
    assert len(tiles) == addressed
    max_tiles = [tile for tile in tiles if tile['properties']['zoom'] == maxzoom]
    max_features = [feature for tile in max_tiles for layer in tile['features']
                    for feature in layer['features']]
    actual_ids = {feature['id'] for feature in max_features}
    assert actual_ids == expected_ids, 'Tiling lost source features at maximum zoom'
    expected_properties = {feature['id']: feature['properties'] for feature in selected}
    assert all(feature['properties'] == expected_properties[feature['id']] for feature in max_features)
    encoded_geometries = [feature['geometry'] for feature in max_features]
    assert encoded_geometries and all(item['type'] in ('Polygon', 'MultiPolygon') for item in encoded_geometries)
    results.append(dict(name=name, minimumZoom=6, maximumZoom=maxzoom,
                        properties=list(selected[0]['properties']), sourceBytes=source.stat().st_size,
                        pmtilesBytes=len(data), tilePayloadBytes=tile_bytes, addressedTiles=addressed,
                        tileEntries=entries, uniqueTileContents=contents,
                        sha256=hashlib.sha256(data).hexdigest(), allSourceIdsPresentAtMaximumZoom=True,
                        observedMaximumZoomSourceIds=len(actual_ids),
                        tilesByZoom={str(zoom): sum(t['properties']['zoom'] == zoom for t in tiles)
                                     for zoom in range(6, maxzoom + 1)},
                        command=[executable.name, *args[1:-2], '--output=' + target.name, source.name]))

result = dict(sample='Retained locally repackaged AZGeo FCC-derived Sedona sample, not an FCC original',
              inputZipSha256=manifest['zipSha256'], rows=len(features),
              carrier=manifest['carrier'], reportingDate=manifest['reportingDate'],
              tippecanoe=version, simplification=False, tinyPolygonReduction=False,
              note='Local build and ID checks only; no visual, HTTP Range, R2 or nationwide-size proof.',
              configurations=results)
(output / 'tile-size-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
