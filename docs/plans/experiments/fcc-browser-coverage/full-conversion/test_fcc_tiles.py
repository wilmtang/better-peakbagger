"""Small independent geometry checks for the coverage tile pipeline."""
import gzip
from contextlib import closing
import json
import mmap
from pathlib import Path
import shutil
import subprocess
import tempfile
import sqlite3
import unittest
from unittest.mock import patch
import hashlib
import zlib
import io
import zipfile

from pmtiles.reader import Reader
from pmtiles.tile import Compression
import mapbox_vector_tile
from shapely.geometry import Point, shape

from fcc_convert import BIN, MAXZOOM, MINZOOM, FIELDS, tile_key, verify_tiles, validate_source, available_sources
from fcc_finalize import ready_groups
from fcc_catalog import build_catalog
from fcc_audit import audit_archive
from fcc_run_vps import raw_sizes, verify_migration, main as vps_main
from fcc_sizes import parse_tail
from pmtiles.tile import deserialize_directory


class TileGeometryTests(unittest.TestCase):
    def test_resume_accepts_imported_states_superseded_by_verified_national_output(self):
        with tempfile.TemporaryDirectory(prefix='fcc-import-check-') as name:
            root=Path(name)
            for folder in ['metadata/national','metadata/converted','tiles']:(root/folder).mkdir(parents=True,exist_ok=True)
            payload=b'verified national archive'
            (root/'tiles/national.pmtiles').write_bytes(payload)
            record={'path':'tiles/national.pmtiles','bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest(),'sourceFileIds':[1]}
            (root/'metadata/national/group.json').write_text(json.dumps(record))
            (root/'metadata/converted/1.json').write_text(json.dumps({'tileFile':'tiles/states/1.pmtiles'}))
            plan={'importedSourceFileIds':['1'],'files':[{'path':'tiles/states/1.pmtiles','bytes':10,'sha256':'unused because superseded'}]}
            (root/'metadata/import-plan.json').write_text(json.dumps(plan))
            with patch('fcc_run_vps.ROOT',root),patch.object(Path,'is_mount',return_value=True):
                verify_migration()
            marker=json.loads((root/'metadata/migration-complete.json').read_text())
            self.assertTrue(marker['verified'])
            self.assertEqual(marker['supersededImportedStateFiles'],1)

    def test_completed_vps_build_does_not_start_downloader_again(self):
        with tempfile.TemporaryDirectory(prefix='fcc-finished-check-') as name:
            root=Path(name);(root/'verification').mkdir()
            for path in ['verification/vps-final-data-audit.json','manifest.json','catalog.json']:
                (root/path).write_text(json.dumps({'status':'complete'}))
            with patch('fcc_run_vps.ROOT',root),patch.object(Path,'is_mount',return_value=True),\
                    patch('fcc_run_vps.sys.argv',['fcc_run_vps.py']),patch('fcc_run_vps.signal.signal'),\
                    patch('fcc_run_vps.status') as report,patch('fcc_run_vps.launch') as launch:
                vps_main()
            launch.assert_not_called()
            report.assert_called_once_with('complete',browserVerification='pending separately')

    def test_migrated_receipts_and_partial_downloads_are_not_ready_to_convert(self):
        with tempfile.TemporaryDirectory(prefix='fcc-resume-check-') as name:
            root=Path(name)
            (root/'metadata/downloads').mkdir(parents=True)
            (root/'data').mkdir()
            for fid in ['1','2','3']:(root/'metadata/downloads'/(fid+'.json')).write_text('{}')
            (root/'data/1.zip.part').write_bytes(b'partial')
            (root/'data/2.zip').write_bytes(b'published')
            (root/'data/3.zip').write_bytes(b'published')
            with patch('fcc_convert.ROOT',root):
                self.assertEqual(available_sources({'3'},set()),['2'])
                self.assertEqual(available_sources({'3'},{'2'}),[])
                (root/'data/1.zip.part').rename(root/'data/1.zip')
                self.assertEqual(set(available_sources({'3'},set())),{'1','2'})

    def test_bounded_zip_tail_reports_original_sizes_and_rejects_truncation(self):
        target=io.BytesIO()
        with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('source.gpkg',b'x'*100000)
        data=target.getvalue();tail=data[-65536:]
        result=parse_tail(tail,f'bytes {len(data)-len(tail)}-{len(data)-1}/{len(data)}')
        self.assertEqual(result['bytes'],len(data))
        self.assertEqual(result['entries'][0]['bytes'],100000)
        with self.assertRaises(AssertionError):
            parse_tail(tail[:-1],f'bytes {len(data)-len(tail)}-{len(data)-1}/{len(data)}')

    def test_raw_size_totals_use_receipts_and_require_every_selected_archive(self):
        with tempfile.TemporaryDirectory(prefix='fcc-size-check-') as name:
            root=Path(name)
            (root/'metadata/downloads').mkdir(parents=True)
            (root/'metadata/selected-downloads.json').write_text(json.dumps([{'file_id':1},{'file_id':2}]))
            (root/'metadata/downloads/1.json').write_text(json.dumps({'bytes':10,'entries':[{'bytes':20}]}))
            (root/'metadata/downloads/3.json').write_text(json.dumps({'bytes':999,'entries':[{'bytes':999}]}))
            with patch('fcc_run_vps.ROOT',root):
                partial=raw_sizes()
                self.assertFalse(partial['complete'])
                self.assertEqual((partial['compressedZipBytes'],partial['uncompressedGeoPackageBytes']),(10,20))
                (root/'metadata/downloads/2.json').write_text(json.dumps({'bytes':5,'entries':[{'bytes':15}]}))
                complete=raw_sizes()
                self.assertTrue(complete['complete'])
                self.assertEqual((complete['measuredSourceArchives'],complete['compressedZipBytes'],complete['uncompressedGeoPackageBytes']),(2,15,35))

    def test_complete_catalog_cannot_publish_a_partial_dataset(self):
        record = dict(provider='tmobile',variant='lte',path='tiles/tmobile-lte.pmtiles',bytes=100,
                      sha256='a'*64,verification=dict(bounds=[-180,-20,180,80],minimumZoom=4,
                      maximumZoom=12,sourceLayer='coverage',fields=FIELDS))
        catalog = build_catalog([record],False)
        self.assertEqual(catalog['status'],'building')
        self.assertEqual(catalog['archives'][0]['url'],'tiles/tmobile-lte.pmtiles')
        with self.assertRaisesRegex(AssertionError,'all nine'):
            build_catalog([record],True)
        with self.assertRaises(AssertionError):
            build_catalog([dict(record,path='../.secrets/fcc.json')],False)

    def test_national_assembly_waits_for_every_selected_source_in_its_group(self):
        rows = [dict(file_id=1, provider_id='130077', technology_code='400', speed_tier=None),
                dict(file_id=2, provider_id='130077', technology_code='400', speed_tier=None),
                dict(file_id=3, provider_id='130403', technology_code='500', speed_tier='7/1')]
        records = [dict(source=rows[0], provider='att', variant='lte'),
                   dict(source=rows[2], provider='tmobile', variant='5g-7-1')]
        self.assertEqual(set(ready_groups(rows,records)), {('tmobile','5g-7-1')})
        records.append(dict(source=rows[1],provider='att',variant='lte'))
        self.assertEqual(set(ready_groups(rows,records)), {('tmobile','5g-7-1'),('att','lte')})
        with self.assertRaisesRegex(AssertionError,'Duplicate'):
            ready_groups(rows,records+[records[0]])

    def test_catalog_discrepancy_requires_actual_rows_and_source_identity(self):
        with tempfile.TemporaryDirectory(prefix='fcc-source-check-') as name:
            source = Path(name)/'source.gpkg'
            layer = 'bdc_11_130077_5GNR_7_1_mobile_broadband_D25_23jun2026'
            with closing(sqlite3.connect(source)) as db, db:
                db.execute('CREATE TABLE "'+layer+'" (fid INTEGER)')
                db.executemany('INSERT INTO "'+layer+'" VALUES (?)', [(1,), (2,)])
            row = dict(file_name=layer.replace('23jun2026', '19oct2026'), record_count='3')
            info = dict(layer_name=layer, crs='EPSG:4326', fields=FIELDS, geometry_type='Polygon', features=2)
            result = validate_source(source, info, row, layer+'.gpkg')
            self.assertEqual((result['catalogFeatures'],result['packageFeatures'],result['countedFeatures']),(3,2,2))
            self.assertTrue(result['catalogCountDiffers'])
            with self.assertRaisesRegex(AssertionError, 'actual rows'):
                validate_source(source, dict(info,features=1), row, layer+'.gpkg')
            with self.assertRaisesRegex(AssertionError, 'archive identity'):
                validate_source(source, info, dict(row,file_name=row['file_name'].replace('130077','131425')), layer+'.gpkg')

    def test_holes_modes_and_small_islands_survive(self):
        with tempfile.TemporaryDirectory(prefix='fcc-tile-check-') as name:
            work = Path(name)
            properties = dict(frn='0006945950', providerid=130403, brandname='T-Mobile',
                              technology=400, mindown=5.0, minup=1.0, minsignal=-110, environmnt=0)
            outer = [[-105.2,39.8],[-105.0,39.8],[-105.0,40.0],[-105.2,40.0],[-105.2,39.8]]
            hole = [[-105.12,39.88],[-105.12,39.92],[-105.08,39.92],[-105.08,39.88],[-105.12,39.88]]
            island = [[-105.3,40.1],[-105.299,40.1],[-105.299,40.101],[-105.3,40.101],[-105.3,40.1]]
            vehicle = dict(properties, environmnt=1, minsignal=-90)
            features = [dict(type='Feature',properties=properties,geometry=dict(type='Polygon',coordinates=[outer,hole])),
                        dict(type='Feature',properties=properties,geometry=dict(type='Polygon',coordinates=[island])),
                        dict(type='Feature',properties=vehicle,geometry=dict(type='Polygon',coordinates=[outer]))]
            source = work/'fixture.geojsonl'
            source.write_text(''.join(json.dumps(f)+'\n' for f in features))
            target = work/'fixture.pmtiles'
            subprocess.run([str(BIN/'tippecanoe'),'--quiet',f'--minimum-zoom={MINZOOM}',
                            f'--maximum-zoom={MAXZOOM}','--layer=coverage','--coalesce',
                            '--no-feature-limit','--no-tile-size-limit','--no-tiny-polygon-reduction',
                            '--no-simplification-of-shared-nodes','--full-detail=12','--low-detail=12',
                            '--output='+str(target),str(source)],check=True)
            points = [{'point':[-105.18,39.82],'properties':properties},
                      {'point':[-105.2995,40.1005],'properties':properties},
                      {'point':[-105.1,39.9],'properties':vehicle}]
            result = verify_tiles(target,points)
            self.assertEqual(result['sampledSourcePoints'],3)
            # A deliberately incorrect coverage claim inside the outdoor hole must fail.
            with self.assertRaisesRegex(AssertionError,'Source classification lost'):
                verify_tiles(target,[{'point':[-105.1,39.9],'properties':properties}])
            # A point outside the modeled area must also fail rather than imply coverage.
            with self.assertRaises(AssertionError):
                verify_tiles(target,[{'point':[-106.0,40.0],'properties':properties}])
            # National assembly must keep both separated source regions and all fields.
            def move(value):
                if isinstance(value[0], (float,int)):
                    return [value[0]+1,value[1]]
                return [move(item) for item in value]
            shifted=[]
            for feature in features:
                shifted.append(dict(feature,geometry=dict(type='Polygon',coordinates=move(feature['geometry']['coordinates']))))
            second=work/'second.geojsonl'
            second.write_text(''.join(json.dumps(f)+'\n' for f in shifted))
            second_tile=work/'second.pmtiles'
            subprocess.run([str(BIN/'tippecanoe'),'--quiet',f'--minimum-zoom={MINZOOM}',
                            f'--maximum-zoom={MAXZOOM}','--layer=coverage','--coalesce',
                            '--no-feature-limit','--no-tile-size-limit','--no-tiny-polygon-reduction',
                            '--output='+str(second_tile),str(second)],check=True)
            national=work/'national.pmtiles'
            subprocess.run([str(BIN/'tile-join'),'--quiet','--no-tile-size-limit','--no-tile-stats',
                            '--name=FCC fixture','--description=independent geometry test',
                            '--attribution=FCC fixture','--output='+str(national),str(target),str(second_tile)],check=True)
            all_points=points+[dict(point=[sample['point'][0]+1,sample['point'][1]],properties=sample['properties']) for sample in points]
            merged=verify_tiles(national,all_points)
            self.assertEqual(merged['sampledSourcePoints'],6)
            audit_record = dict(provider='fixture',variant='lte',path=national.name,
                                bytes=national.stat().st_size,sha256=hashlib.sha256(national.read_bytes()).hexdigest())
            with patch('fcc_audit.ROOT',work):
                audited = audit_archive(audit_record)
                self.assertTrue(audited['allTileGzipChecksumsVerified'])
                self.assertGreater(audited['uniqueTilePayloads'],0)
                # A malformed payload must fail even if its whole-file hash is updated.
                raw = bytearray(national.read_bytes())
                reader = Reader(lambda offset,length:bytes(raw[offset:offset+length]))
                header = reader.header()
                entries = deserialize_directory(bytes(raw[header['root_offset']:header['root_offset']+header['root_length']]))
                entry = next(item for item in entries if item.run_length>0)
                raw[header['tile_data_offset']+entry.offset+entry.length-8] ^= 1
                corrupted = work/'corrupted.pmtiles';corrupted.write_bytes(raw)
                with self.assertRaises(zlib.error):
                    audit_archive(dict(audit_record,path=corrupted.name,sha256=hashlib.sha256(raw).hexdigest()))


if __name__=='__main__':
    unittest.main(verbosity=2)
