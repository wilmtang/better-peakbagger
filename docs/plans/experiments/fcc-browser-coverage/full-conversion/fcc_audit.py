"""Audit every generated tile payload and cross-check the complete FCC inventory."""
import argparse
from collections import defaultdict
import hashlib
import json
import mmap
from pathlib import Path
import time
import zlib

from pmtiles.reader import Reader
from pmtiles.tile import Compression, deserialize_directory, tileid_to_zxy
from fcc_convert import FIELDS, MINZOOM, MAXZOOM
from fcc_download import ROOT, atomic_json



def audit_archive(record):
    target = ROOT/record['path']
    assert target.stat().st_size == record['bytes']
    with target.open('rb') as source:
        assert hashlib.file_digest(source,'sha256').hexdigest() == record['sha256']
    started = time.monotonic()
    by_zoom = defaultdict(lambda: {'addressedTiles':0,'storedPayloadBytes':0,'maximumTileBytes':0})
    seen = set()
    decompressed = 0
    last_tile = -1
    with target.open('rb') as source, mmap.mmap(source.fileno(),0,access=mmap.ACCESS_READ) as data:
        reader = Reader(lambda offset,length: data[offset:offset+length])
        header = reader.header()
        metadata = reader.metadata()
        assert header['min_zoom'] == MINZOOM and header['max_zoom'] == MAXZOOM
        assert header['tile_compression'] == Compression.GZIP
        assert header['tile_data_offset']+header['tile_data_length'] == len(data)
        assert len(metadata['vector_layers']) == 1
        layer = metadata['vector_layers'][0]
        assert layer['id'] == 'coverage' and set(layer['fields']) == set(FIELDS)

        def directory(offset,length,depth=0):
            nonlocal decompressed,last_tile
            assert depth < 4 and length > 0 and offset+length <= len(data)
            for entry in deserialize_directory(data[offset:offset+length]):
                if entry.run_length == 0:
                    directory(header['leaf_directory_offset']+entry.offset,entry.length,depth+1)
                    continue
                assert entry.tile_id > last_tile
                last_tile = entry.tile_id+entry.run_length-1
                zoom = tileid_to_zxy(entry.tile_id)[0]
                assert MINZOOM <= zoom <= MAXZOOM
                assert tileid_to_zxy(last_tile)[0] == zoom
                stats = by_zoom[zoom]
                stats['addressedTiles'] += entry.run_length
                stats['maximumTileBytes'] = max(stats['maximumTileBytes'],entry.length)
                key = entry.offset,entry.length
                if key in seen:
                    continue
                seen.add(key)
                assert entry.length > 0 and entry.offset+entry.length <= header['tile_data_length']
                stats['storedPayloadBytes'] += entry.length
                begin = header['tile_data_offset']+entry.offset
                end = begin+entry.length
                decoder = zlib.decompressobj(16+zlib.MAX_WBITS)
                for position in range(begin,end,65536):
                    decompressed += len(decoder.decompress(data[position:min(end,position+65536)]))
                decompressed += len(decoder.flush())
                assert decoder.eof and not decoder.unused_data, 'Incomplete or trailing gzip tile data'

        directory(header['root_offset'],header['root_length'])
        assert sum(item['addressedTiles'] for item in by_zoom.values()) == header['addressed_tiles_count']
        assert len(seen) == header['tile_contents_count']
        assert sum(item['storedPayloadBytes'] for item in by_zoom.values()) == header['tile_data_length']
    return {'provider':record['provider'],'variant':record['variant'],'path':record['path'],
            'bytes':record['bytes'],'sha256':record['sha256'],'sha256Verified':True,
            'allTileGzipChecksumsVerified':True,'uniqueTilePayloads':len(seen),
            'decompressedBytes':decompressed,'byZoom':dict(by_zoom),
            'seconds':round(time.monotonic()-started,2)}


def audit_inventory(manifest,catalog,browser):
    selected = json.loads((ROOT/'metadata/selected-downloads.json').read_text())
    expected = {str(row['file_id']):row for row in selected}
    assert len(expected) == len(selected) == 460
    paths = list((ROOT/'metadata/converted').glob('*.json'))
    assert {path.stem for path in paths} == set(expected)
    converted = {path.stem:json.loads(path.read_text()) for path in paths}
    discrepancies = []
    for fid,record in converted.items():
        assert record['source'] == expected[fid]
        assert record['sourceDownload']['source'] == expected[fid]
        original = json.loads((ROOT/'metadata/downloads'/(fid+'.json')).read_text())
        assert record['sourceDownload'] == original
        name = original['entries'][0]['name']
        assert Path(name).stem.rsplit('_',1)[0] == expected[fid]['file_name'].rsplit('_',1)[0]
        count = record['sourceFeatures']
        assert count > 0 and record['sourceSamples']
        if count != int(expected[fid]['record_count']):
            validation = record['sourceValidation']
            assert validation['countedFeatures'] == validation['packageFeatures'] == count
            discrepancies.append({'fileId':int(fid),**validation})
    assert manifest['status'] == catalog['status'] == browser['status'] == 'complete'
    assert len(manifest['archives']) == len(catalog['archives']) == len(browser['archives']) == 9
    assert manifest['expectedSourceArchives'] == manifest['convertedSourceArchives'] == 460
    actual = []
    for archive in manifest['archives']:
        ids = [str(fid) for fid in archive['sourceFileIds']]
        assert len(ids) == len(set(ids))
        assert archive['sourceFeatures'] == sum(converted[fid]['sourceFeatures'] for fid in ids)
        actual.extend(ids)
        item = next(item for item in catalog['archives'] if item['id']==archive['provider']+'-'+archive['variant'])
        assert item['url'] == archive['path'] and item['sha256'] == archive['sha256'] and item['bytes'] == archive['bytes']
        view = next(item for item in browser['archives'] if (item['provider'],item['variant'])==(archive['provider'],archive['variant']))
        assert len(view['cases']) >= 3 and all(case['renderedSourceMatch'] for case in view['cases'])
    assert len(actual) == len(set(actual)) == len(expected) and set(actual) == set(expected)
    assert manifest['sourceFeatures'] == sum(item['sourceFeatures'] for item in converted.values())
    assert manifest['tileBytes'] == sum(item['bytes'] for item in manifest['archives'])
    assert sorted(discrepancies,key=lambda item:item['fileId']) == sorted(manifest['sourceCountDiscrepancies'],key=lambda item:item['fileId'])
    assert not list((ROOT/'data').glob('*.zip'))
    assert not list((ROOT/'data').glob('*.zip.part'))
    assert not list((ROOT/'tiles/states').glob('*.pmtiles'))
    return {'sourceArchives':len(expected),'nationalArchives':len(manifest['archives']),
            'sourceFeatures':manifest['sourceFeatures'],'tileBytes':manifest['tileBytes'],
            'sourceCountDiscrepancies':discrepancies,'browserCases':sum(len(item['cases']) for item in browser['archives'])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--watch',action='store_true')
    args = parser.parse_args()
    checked = {}
    while True:
        for path in sorted((ROOT/'metadata/national').glob('*.json')):
            if path.stem in checked:
                continue
            record = json.loads(path.read_text())
            atomic_json(ROOT/'verification/audit-progress.json',{'stage':'checking_all_tile_payloads','archive':path.stem})
            result = audit_archive(record)
            checked[path.stem] = result
            atomic_json(ROOT/'verification/archive-audits.json',list(checked.values()))
            print(json.dumps({'state':'archive_payloads_verified',**{key:value for key,value in result.items() if key!='byZoom'}}),flush=True)
        required = [ROOT/'manifest.json',ROOT/'catalog.json',ROOT/'verification/browser-results.json']
        if all(path.exists() for path in required):
            manifest,catalog,browser = [json.loads(path.read_text()) for path in required]
            if all(item['status']=='complete' for item in [manifest,catalog,browser]):
                assert len(checked) == 9
                result = audit_inventory(manifest,catalog,browser)
                result.update(status='complete',archives=list(checked.values()),
                              completedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
                atomic_json(ROOT/'verification/final-audit.json',result)
                atomic_json(ROOT/'verification/audit-progress.json',{'stage':'complete','nationalArchives':9})
                print(json.dumps({key:value for key,value in result.items() if key!='archives'}),flush=True)
                return
        if not args.watch:
            raise RuntimeError('Full conversion, catalog, and browser verification are not complete')
        time.sleep(5)


if __name__ == '__main__':
    main()
