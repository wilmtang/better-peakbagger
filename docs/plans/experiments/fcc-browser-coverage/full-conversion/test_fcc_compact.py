"""Small fixtures for lossless close-ups and bounded approximate overview geometry."""
import gzip
import hashlib
import json
import math
import mmap
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import mapbox_vector_tile
from mapbox_vector_tile.Mapbox import vector_tile_pb2
from pmtiles.reader import Reader
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from shapely.geometry import MultiPolygon, Point, Polygon, box, mapping, shape

from fcc_compact import (SafeWriter, benchmark, compact_archive, compact_tile,
                         delivery, simplify_geometry, verify_feature_fields)
from install_compaction_vps import render_unit


def fixture():
    shell = [(100, 100), (3900, 100), (3900, 3000)]
    shell += [(x, 3000+round(18*math.sin(x/45))) for x in range(3895, 99, -5)]
    shell.append(shell[0])
    hole = [(800, 800), (800, 1000), (1000, 1000), (1000, 800), (800, 800)]
    polygon = Polygon(shell, [hole])
    island = box(4000, 4000, 4003, 4003)
    properties = dict(frn='0006945950', providerid=130403, brandname='T-Mobile',
                      technology=400, mindown=5.0, minup=1.0, minsignal=-110, environmnt=0)
    return [dict(id=37, geometry=mapping(MultiPolygon([polygon, island])), properties=properties),
            dict(id=38, geometry=mapping(box(1500, 1500, 1600, 1600)),
                 properties=dict(properties, environmnt=1, minsignal=-90))]


def payload():
    raw = mapbox_vector_tile.encode({'name':'coverage', 'features':fixture()},
                                   default_options={'y_coord_down':True})
    return gzip.compress(raw, mtime=0)


def read_features(data):
    return mapbox_vector_tile.decode(gzip.decompress(data),
                                    default_options={'y_coord_down':True})['coverage']['features']


def write_archive(path):
    with path.open('wb') as output:
        writer = SafeWriter(output, path.parent)
        data = payload()
        # Hilbert order is not necessarily x/y order.
        for tileid in sorted(zxy_to_tileid(*zxy) for zxy in [(4, 1, 1), (8, 10, 10), (12, 100, 100), (12, 100, 101)]):
            writer.write_tile(tileid, data)
        writer.finalize({'tile_compression':Compression.GZIP, 'tile_type':TileType.MVT,
                         'min_lon_e7':0, 'min_lat_e7':0, 'max_lon_e7':10000000, 'max_lat_e7':10000000,
                         'center_zoom':4, 'center_lon_e7':0, 'center_lat_e7':0},
                        {'vector_layers':[{'id':'coverage', 'fields':{key:'Number' for key in fixture()[0]['properties']}}]})


class CompactionTests(unittest.TestCase):
    def test_service_template_binds_host_values_without_recording_them(self):
        template = Path(__file__).with_name('fcc-tiles-compaction.service.in').read_text()
        rendered = render_unit(template, 'tester', 'testers', '/home/tester')
        self.assertIn('User=tester\n', rendered)
        self.assertIn('Group=testers\n', rendered)
        self.assertIn('ExecStart=/home/tester/Dev/fcc-tiles/.venv/bin/python ', rendered)
        self.assertIn('ExecStartPre=/usr/bin/mountpoint --quiet /mnt/fcc-tiles', rendered)
        self.assertNotIn('@FCC_', rendered)
        with self.assertRaises(AssertionError):
            render_unit(template, 'tester\nUser=root', 'testers', '/home/tester')
        with self.assertRaises(AssertionError):
            render_unit(template, 'tester', 'testers', '/home/tester\nExecStart=/bin/false')

    def test_finest_zoom_is_copied_without_even_decoding(self):
        # This also catches accidentally applying the overview transform at z12.
        data = b'opaque original compressed bytes'
        self.assertIs(compact_tile(data, 12), data)
        self.assertIs(compact_tile(data, 13), data)

    def test_overviews_reduce_vertices_and_preserve_holes_islands_tags_and_ids(self):
        original = payload()
        result = compact_tile(original, 8)
        self.assertLess(len(result), len(original))
        before, after = read_features(original), read_features(result)
        self.assertEqual(len(before), len(after))
        for source, candidate in zip(before, after):
            self.assertEqual(source['properties'], candidate['properties'])
            self.assertEqual(source['id'], candidate['id'])
            a, b = shape(source['geometry']), shape(candidate['geometry'])
            self.assertTrue(b.is_valid)
            self.assertEqual(a.geom_type, b.geom_type)
            parts_a = list(a.geoms) if a.geom_type == 'MultiPolygon' else [a]
            parts_b = list(b.geoms) if b.geom_type == 'MultiPolygon' else [b]
            self.assertEqual([len(p.interiors) for p in parts_a], [len(p.interiors) for p in parts_b])
            self.assertLessEqual(a.boundary.hausdorff_distance(b.boundary), 4.000001)
            for x in range(120, 4050, 79):
                for y in range(120, 4050, 83):
                    point = Point(x, y)
                    if a.boundary.distance(point) > 4:
                        self.assertEqual(a.covers(point), b.covers(point))
        geometry = shape(after[0]['geometry'])
        self.assertFalse(geometry.covers(Point(900, 900)), 'Hole filled')
        self.assertTrue(geometry.covers(Point(4001, 4001)), 'Small island lost')

    def test_tile_edge_crossings_are_exactly_unchanged(self):
        top = [(x, 2000+round(30*math.sin(x/37))) for x in range(-40, 4141, 5)]
        original = Polygon(top+[(4140, 3000), (-40, 3000), top[0]])
        reduced = simplify_geometry(original, 4, 4096)
        self.assertLess(len(reduced.exterior.coords), len(original.exterior.coords))
        self.assertTrue(reduced.is_valid)
        seam = box(0, 0, 4096, 4096).boundary
        self.assertTrue(original.intersection(seam).equals(reduced.intersection(seam)))
        self.assertLessEqual(original.boundary.hausdorff_distance(reduced.boundary), 4.000001)

    def test_invalid_geometry_is_retained_instead_of_repaired_or_dropped(self):
        bowtie = Polygon([(0, 0), (100, 100), (0, 100), (100, 0), (0, 0)])
        self.assertFalse(bowtie.is_valid)
        self.assertIs(simplify_geometry(bowtie, 4, 4096), bowtie)

    def test_only_subpixel_overview_holes_are_filled(self):
        tiny = [(900, 900), (900, 904), (904, 904), (904, 900), (900, 900)]
        large = [(1500, 1500), (1500, 1600), (1600, 1600), (1600, 1500), (1500, 1500)]
        original = Polygon([(100, 100), (3900, 100), (3900, 3900), (100, 3900), (100, 100)], [tiny, large])
        reduced = simplify_geometry(original, 4, 4096)
        self.assertTrue(reduced.covers(Point(902, 902)))
        self.assertFalse(reduced.covers(Point(1550, 1550)))
        self.assertEqual(len(reduced.interiors), 1)
        # A small hole crossing a tile edge must remain, preventing seams.
        crossing = Polygon([(-40, -40), (4140, -40), (4140, 4140), (-40, 4140), (-40, -40)],
                           [[(-2, 100), (-2, 104), (2, 104), (2, 100), (-2, 100)], tiny])
        kept = simplify_geometry(crossing, 4, 4096)
        self.assertEqual(len(kept.interiors), 1)
        self.assertFalse(kept.covers(Point(0, 102)))
        self.assertTrue(kept.covers(Point(902, 902)))

    def test_memory_guards_preserve_oversized_inputs_and_field_audit_rejects_changes(self):
        original = payload()
        with patch('fcc_compact.MAX_RAW_TILE_BYTES', 1):
            self.assertEqual(compact_tile(original, 8), original)
        with patch('fcc_compact.MAX_GEOMETRY_COMMANDS', 1):
            self.assertEqual(compact_tile(original, 8), original)
        message = vector_tile_pb2.tile()
        message.ParseFromString(gzip.decompress(original))
        message.layers[0].features[0].id = 999
        broken = gzip.compress(message.SerializeToString(), mtime=0)
        with self.assertRaisesRegex(AssertionError, 'Feature order, IDs, attributes'):
            verify_feature_fields(original, broken)

    def test_archive_keeps_every_address_and_original_and_audits_all_finest_tiles(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source, output = root/'original.pmtiles', root/'compact.pmtiles'
            write_archive(source)
            original = source.read_bytes()
            result = compact_archive(source, output)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(result['verifiedTileAddresses'], 4)
            self.assertTrue(result['allFinestZoomTilesByteIdentical'])
            self.assertTrue(result['allGzipPayloadsVerified'])
            self.assertEqual(result['sha256'], hashlib.sha256(output.read_bytes()).hexdigest())
            with output.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                reader = Reader(lambda offset, length:data[offset:offset+length])
                self.assertEqual(reader.get(12, 100, 100), payload())
                self.assertEqual(reader.get(12, 100, 101), payload())
                self.assertIn('bpb_compaction', reader.metadata())
            with self.assertRaisesRegex(AssertionError, 'overwrite'):
                compact_archive(source, output)
            sample = benchmark(source, root/'benchmark.json')
            self.assertTrue(sample['sampleOnly'])
            self.assertTrue(sample['tiles'][-1]['identicalPayload'])

    def test_full_delivery_cannot_start_before_baseline_audit(self):
        with tempfile.TemporaryDirectory() as name, patch('fcc_compact.ROOT', Path(name)):
            with self.assertRaisesRegex(RuntimeError, 'Baseline data audit'):
                delivery()

    def test_independent_archive_audit_rejects_changed_finest_payload(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source, output = root/'original.pmtiles', root/'compact.pmtiles'
            write_archive(source)
            def broken(data, zoom):
                return gzip.compress(gzip.decompress(data), mtime=7) if zoom == 12 else data
            with patch('fcc_compact.compact_tile', side_effect=broken):
                with self.assertRaisesRegex(AssertionError, 'Finest-zoom tile changed'):
                    compact_archive(source, output)
            self.assertFalse(output.exists(), 'Unverified output was published')
            self.assertFalse(output.with_suffix('.json').exists())

    def test_delivery_publishes_portable_catalog_and_resumes_verified_outputs(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root/'tiles').mkdir()
            (root/'verification').mkdir()
            (root/'verification/vps-final-data-audit.json').write_text(json.dumps({'status':'complete'}))
            records = []
            for provider in ['att', 'verizon', 'tmobile']:
                for variant in ['lte', '5g-7-1', '5g-35-3']:
                    path = root/'tiles'/(provider+'-'+variant+'.pmtiles')
                    write_archive(path)
                    records.append(dict(provider=provider, variant=variant, path=str(path.relative_to(root)),
                        bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                        verification=dict(bounds=[0, 0, 1, 1], minimumZoom=4, maximumZoom=12,
                                          sourceLayer='coverage', fields=fixture()[0]['properties'])))
            (root/'manifest.json').write_text(json.dumps({'status':'complete', 'archives':records,
                                                        'tileBytes':sum(r['bytes'] for r in records)}))
            with patch('fcc_compact.ROOT', root):
                delivery()
                with patch('fcc_compact.compact_archive', side_effect=AssertionError('Should resume existing outputs')):
                    delivery()
            catalog = json.loads((root/'delivery/catalog.json').read_text())
            self.assertEqual(catalog['status'], 'complete')
            self.assertEqual(len(catalog['archives']), 9)
            for item in catalog['archives']:
                self.assertTrue((root/'delivery'/item['url']).is_file())
                self.assertEqual(item['maxZoom'], 12)
            for record in records:
                self.assertEqual(hashlib.sha256((root/record['path']).read_bytes()).hexdigest(), record['sha256'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
