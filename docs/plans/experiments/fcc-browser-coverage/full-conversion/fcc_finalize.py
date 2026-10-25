"""Merge verified state PMTiles into nine national carrier/technology archives."""
import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

from fcc_convert import ROOT, BIN, ENCODER_THREADS, verify_tiles
from fcc_download import atomic_json


def source_group(row):
    provider = {'130077': 'att', '131425': 'verizon', '130403': 'tmobile'}[row['provider_id']]
    variant = 'lte' if row['technology_code'] == '400' else '5g-' + row['speed_tier'].replace('/', '-')
    return provider, variant


def ready_groups(selected, records):
    expected = defaultdict(set)
    groups = defaultdict(list)
    for row in selected:
        expected[source_group(row)].add(str(row['file_id']))
    for record in records:
        fid = str(record['source']['file_id'])
        group = record['provider'], record['variant']
        assert group == source_group(record['source'])
        assert fid in expected[group], 'Unexpected source file in national assembly'
        groups[group].append(record)
    ready = {}
    for group, items in groups.items():
        actual = {str(item['source']['file_id']) for item in items}
        assert len(actual) == len(items), 'Duplicate national source file'
        if actual == expected[group]:
            ready[group] = sorted(items, key=lambda item: str(item['source']['file_id']))
    return ready


def merge_group(provider, variant, records):
    name = f'{provider}-{variant}-2025-12-31'
    destination = ROOT/'tiles'/(name+'.pmtiles')
    receipt = ROOT/'metadata/national'/(name+'.json')
    source_ids = [record['source']['file_id'] for record in records]
    if receipt.exists():
        record = json.loads(receipt.read_text())
        assert record['sourceFileIds'] == source_ids
        assert destination.stat().st_size == record['bytes']
        with destination.open('rb') as source:
            assert hashlib.file_digest(source,'sha256').hexdigest() == record['sha256']
        return record
    files = [ROOT/record['tileFile'] for record in records]
    for path, record in zip(files,records):
        assert path.stat().st_size == record['tileBytes']
        with path.open('rb') as source:
            assert hashlib.file_digest(source,'sha256').hexdigest() == record['sha256']
    work = ROOT/'work'/('national-'+name)
    work.mkdir(parents=True,exist_ok=True)
    source_bytes = sum(path.stat().st_size for path in files)
    assert shutil.disk_usage(ROOT).free > source_bytes*2 + 12*1024**3, 'Insufficient merge disk reserve'
    temporary = work/'national.pmtiles'
    temporary.unlink(missing_ok=True)
    command = [str(BIN/'tile-join'),'--no-tile-size-limit','--no-tile-stats',
               '--name=FCC '+provider+' '+variant+' as of 2025-12-31',
               '--description=FCC BDC raw coverage; original coverage attributes retained; MVT quantization applies',
               '--attribution=Federal Communications Commission, Broadband Data Collection, 2025-12-31',
               '--output='+str(temporary), *map(str,files)]
    atomic_json(ROOT/'metadata/finalization-progress.json',{'provider':provider,'variant':variant,'stage':'merging'})
    print(json.dumps({'state':'merging','name':name,'sourceFiles':len(files),'sourceTileBytes':source_bytes}),flush=True)
    with (ROOT/'logs'/('merge-'+name+'.log')).open('w') as log:
        subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,
                       env={**os.environ,'TIPPECANOE_MAX_THREADS':str(ENCODER_THREADS),'TMPDIR':str(work)},check=True)
    verification = verify_tiles(temporary,[sample for record in records for sample in record['sourceSamples']])
    with temporary.open('rb') as source:
        digest = hashlib.file_digest(source,'sha256').hexdigest()
    destination.unlink(missing_ok=True)
    temporary.replace(destination)
    record = {'provider':provider,'variant':variant,'asOfDate':'2025-12-31',
              'path':str(destination.relative_to(ROOT)),'bytes':destination.stat().st_size,
              'sha256':digest,'sourceFileIds':source_ids,
              'sourceFeatures':sum(item['sourceFeatures'] for item in records),
              'states':[item['source']['state_name'] for item in records],
              'verification':verification}
    atomic_json(receipt,record)
    shutil.rmtree(work)
    for path in files:
        path.unlink()  # Verified national archive supersedes these generated intermediates.
    print(json.dumps({'state':'verified','name':name,'bytes':record['bytes'],
                      'sampledSourcePoints':verification['sampledSourcePoints']}),flush=True)
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--watch', action='store_true')
    args = parser.parse_args()
    selected = json.loads((ROOT/'metadata/selected-downloads.json').read_text())
    expected = {str(row['file_id']) for row in selected}
    assert len(expected) == len(selected) == 460
    assert len({source_group(row) for row in selected}) == 9
    (ROOT/'metadata/national').mkdir(exist_ok=True)
    finished = {}
    while True:
        paths = list((ROOT/'metadata/converted').glob('*.json'))
        complete = {path.stem for path in paths}
        assert complete <= expected
        records = [json.loads(path.read_text()) for path in paths]
        for record in records:
            if record['sourceFeatures'] != int(record['source']['record_count']):
                validation = record['sourceValidation']
                assert validation['catalogCountDiffers']
                assert record['sourceFeatures'] == validation['packageFeatures'] == validation['countedFeatures']
        groups = ready_groups(selected, records)
        for group, items in sorted(groups.items()):
            if group not in finished:
                finished[group] = merge_group(*group, items)
        if complete == expected:
            assert len(finished) == 9
            break
        if not args.watch:
            raise RuntimeError(f'Only {len(complete)}/{len(expected)} source archives converted')
        atomic_json(ROOT/'metadata/finalization-progress.json', {
            'stage':'waiting_for_sources','verifiedNationalArchives':len(finished),
            'convertedSourceArchives':len(complete),'expectedSourceArchives':len(expected)})
        time.sleep(10)
    results = [finished[group] for group in sorted(finished)]
    total_features = sum(record['sourceFeatures'] for record in results)
    discrepancies = [{'fileId': record['source']['file_id'], **record['sourceValidation']}
                     for record in records
                     if record.get('sourceValidation', {}).get('catalogCountDiffers')]
    catalog_features = sum(int(row['record_count']) for row in selected)
    assert total_features - catalog_features == sum(item['packageFeatures']-item['catalogFeatures'] for item in discrepancies)
    manifest = {'status':'complete','asOfDate':'2025-12-31','source':'FCC BDC Public Data API, Raw Coverage',
                'selectedProviders':['AT&T','Verizon','T-Mobile'],
                'expectedSourceArchives':len(expected),'convertedSourceArchives':len(complete),
                'sourceFeatures':total_features,'tileArchiveCount':len(results),
                'catalogFeatures':catalog_features,'sourceCountDiscrepancies':discrepancies,
                'tileBytes':sum(record['bytes'] for record in results),'archives':results,
                'coverageModes':'Original environmnt values retained; 0 outdoor stationary only, 1 in-vehicle mobile and outdoor stationary',
                'geometryPolicy':'Identical-attribute geometry coalescing; no feature-count or tile-size dropping; MVT quantization and simplification apply',
                'completedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    atomic_json(ROOT/'manifest.json',manifest)
    atomic_json(ROOT/'metadata/finalization-progress.json',{'stage':'complete','bytes':manifest['tileBytes']})
    print(json.dumps({key:value for key,value in manifest.items() if key!='archives'}),flush=True)


if __name__=='__main__':
    main()
