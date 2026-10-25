"""Prepare a bounded FCC-derived sample, not an official FCC download archive."""
import hashlib
import json
import pathlib
import sqlite3
import struct
import sys
import time
import urllib.parse
import urllib.request
import zipfile

assert len(sys.argv) == 2, 'Usage: python3 prepare.py /absolute/disposable-directory'
root = pathlib.Path(sys.argv[1])
assert root.is_absolute() and root.is_dir()
base = 'https://services6.arcgis.com/clPWQMwZfdWn4MQZ/ArcGIS/rest/services/FCC_Mobile_Broadband/FeatureServer/195'
bounds = [-111.86, 34.78, -111.66, 34.96]
max_bytes = 8 * 1024 * 1024
requests = []


def fetch(url):
    start = time.perf_counter()
    request = urllib.request.Request(url, headers={'Origin': 'https://www.peakbagger.com'})
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read(max_bytes + 1)
        assert len(body) <= max_bytes, 'Response exceeded experiment limit'
        data = json.loads(body)
        assert 'error' not in data, data.get('error')
        requests.append({'url': url, 'bytes': len(body), 'status': response.status,
                         'cors': response.headers.get('Access-Control-Allow-Origin'),
                         'elapsedMs': round(1000 * (time.perf_counter() - start), 2)})
        return data


def query(**extra):
    params = dict(f='json', where='1=1', geometry=','.join(map(str, bounds)),
                  geometryType='esriGeometryEnvelope', inSR=4326,
                  spatialRel='esriSpatialRelIntersects')
    params.update(extra)
    return fetch(base + '/query?' + urllib.parse.urlencode(params))


item = fetch('https://www.arcgis.com/sharing/rest/content/items/0182656631264741ae7cdd5a0569397b?f=json')
count = query(returnCountOnly='true')['count']
assert 0 < count <= 8000, f'Unexpected sample count: {count}'
features = []
for offset in range(0, count, 2000):
    time.sleep(0.5)  # Conservative source request pacing, not a browser readiness wait.
    page = query(f='geojson', outSR=4326, outFields='objectid,h3_res9_id,technology,mindown,minup,environmnt',
                 resultOffset=offset, resultRecordCount=2000, orderByFields='objectid ASC')
    records = page.get('features', [])
    assert records and len(records) <= 2000
    features.extend(records)
    truncated = page.get('exceededTransferLimit', page.get('properties', {}).get('exceededTransferLimit', False))
    assert bool(truncated) == (len(features) < count), 'Unexpected pagination completeness'
assert len(features) == count
assert len({f['properties']['objectid'] for f in features}) == count

database = root / 'sample.gpkg'
database.unlink(missing_ok=True)
with sqlite3.connect(database) as db:
    db.executescript('''
        PRAGMA application_id=1196444487;
        PRAGMA user_version=10300;
        CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY,
            organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
            definition TEXT NOT NULL, description TEXT);
        INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined Cartesian',-1,'NONE',-1,'undefined','');
        INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined geographic',0,'NONE',0,'undefined','');
        INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84',4326,'EPSG',4326,
            'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]','');
        CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT NOT NULL,
            identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL,
            min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
        CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL,
            geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL,
            m TINYINT NOT NULL, PRIMARY KEY (table_name,column_name));
        CREATE TABLE mobile (id INTEGER PRIMARY KEY, h3_res9_id TEXT, technology INTEGER,
            mindown REAL, minup REAL, environmnt INTEGER, geom BLOB);
        CREATE VIRTUAL TABLE sample_bounds USING rtree(id,min_x,max_x,min_y,max_y);
        INSERT INTO gpkg_geometry_columns VALUES ('mobile','geom','POLYGON',4326,0,0);
    ''')
    oracle = []
    for feature in features:
        props = feature['properties']
        geometry = feature['geometry']
        assert geometry['type'] == 'Polygon', 'Sample supports Polygon only; fail rather than flatten'
        rings = geometry['coordinates']
        assert all(len(ring) >= 4 and ring[0] == ring[-1] for ring in rings)
        points = [point for ring in rings for point in ring]
        assert all(len(point) == 2 and -180 <= point[0] <= 180 and -90 <= point[1] <= 90 for point in points)
        west, east = min(p[0] for p in points), max(p[0] for p in points)
        south, north = min(p[1] for p in points), max(p[1] for p in points)
        # GeoPackage little-endian header with XY envelope, followed by OGC WKB.
        blob = b'GP\x00\x03' + struct.pack('<i4d', 4326, west, east, south, north)
        blob += struct.pack('<BII', 1, 3, len(rings))
        for ring in rings:
            blob += struct.pack('<I', len(ring))
            blob += b''.join(struct.pack('<dd', *point) for point in ring)
        db.execute('INSERT INTO mobile VALUES (?,?,?,?,?,?,?)',
                   (props['objectid'], props['h3_res9_id'], props['technology'],
                    props['mindown'], props['minup'], props['environmnt'], blob))
        db.execute('INSERT INTO sample_bounds VALUES (?,?,?,?,?)', (props['objectid'], west, east, south, north))
        oracle.append({'id': props['objectid'], 'bounds': [west, south, east, north], 'geometry': geometry})
    db.execute('INSERT INTO gpkg_contents VALUES (?,?,?,?,?,?,?,?,?,?)',
               ('mobile', 'features', 'mobile', 'Locally repackaged, bounded AZGeo FCC-derived sample',
                '2026-10-25T00:00:00.000Z', *bounds, 4326))
    db.commit()
    db.execute('VACUUM')
archive = root / 'sample.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
    zipped.write(database, 'sample.gpkg')
(root / 'oracle.json').write_text(json.dumps(oracle, separators=(',', ':')))
manifest = dict(
    source='AZGeo FCC-derived mobile LTE layer; bounded sample, not an FCC carrier/state archive',
    sourceUrl=base, itemUrl='https://www.arcgis.com/home/item.html?id=' + item['id'],
    owner=item['owner'], sourceModified=item['modified'], reportingDate='not established',
    carrier='not present in this mirror schema', bounds=bounds, rows=count,
    uniqueHexagons=len({f['properties']['h3_res9_id'] for f in features}),
    storedServiceBytes=item['size'],
    storedServiceBytesMeaning='ArcGIS item storage across all service layers; NOT download archive bytes',
    packageProvenance='Locally generated SQLite GeoPackage fixture with private sample_bounds R-tree; not an original FCC export',
    geopackageBytes=database.stat().st_size, zipBytes=archive.stat().st_size,
    zipSha256=hashlib.sha256(archive.read_bytes()).hexdigest(), requests=requests)
(root / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({k: v for k, v in manifest.items() if k != 'requests'}))
