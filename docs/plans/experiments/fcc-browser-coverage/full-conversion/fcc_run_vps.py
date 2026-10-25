"""Supervise the resumed VPS conversion; use bounded memory and external data storage."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from fcc_download import ROOT, atomic_json
from fcc_audit import audit_archive

CODE = Path(__file__).resolve().parent
CHILDREN = []
STARTED = time.time()


def raw_sizes():
    selected = json.loads((ROOT/'metadata/selected-downloads.json').read_text())
    expected = {str(row['file_id']) for row in selected}
    receipts = [json.loads(path.read_text()) for path in (ROOT/'metadata/downloads').glob('*.json') if path.stem in expected]
    result = {'scope':'Three selected US providers, LTE and both 5G tiers, 2025-12-31',
              'expectedSourceArchives':len(expected),'measuredSourceArchives':len(receipts),
              'complete':len(receipts)==len(expected),
              'compressedZipBytes':sum(item['bytes'] for item in receipts),
              'uncompressedGeoPackageBytes':sum(entry['bytes'] for item in receipts for entry in item['entries'])}
    atomic_json(ROOT/'metadata/raw-sizes.json',result)
    return result


def status(stage, **extra):
    record = {'stage':stage,'pid':os.getpid(),'startedAt':STARTED,'updatedAt':time.time(),
              'convertedSourceArchives':len(list((ROOT/'metadata/converted').glob('*.json'))),
              'rawSizes':raw_sizes(),**extra}
    atomic_json(ROOT/'metadata/vps-run.json',record)
    print(json.dumps(record),flush=True)


def launch(script, *arguments):
    log = (ROOT/'logs'/(Path(script).stem+'.log')).open('ab')
    process = subprocess.Popen([sys.executable,str(CODE/script),*arguments],stdin=subprocess.DEVNULL,
                               stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    log.close()
    CHILDREN.append(process)
    return process


def wait_for(stage, processes):
    while any(process.poll() is None for process in processes):
        for process in processes:
            result = process.poll()
            if result not in (None,0):
                raise RuntimeError(f'Child {process.pid} failed with exit {result}; inspect logs')
        status(stage,childPids=[process.pid for process in processes if process.poll() is None])
        time.sleep(10)
    assert all(process.returncode==0 for process in processes)


def verify_migration():
    assert ROOT.is_mount(), 'VPS data root must be the dedicated mounted disk'
    plan = json.loads((ROOT/'metadata/import-plan.json').read_text())
    covered = set()
    for path in (ROOT/'metadata/national').glob('*.json'):
        record = json.loads(path.read_text())
        target = ROOT/record['path']
        assert target.stat().st_size == record['bytes']
        with target.open('rb') as source:
            assert hashlib.file_digest(source,'sha256').hexdigest()==record['sha256']
        covered.update(map(str,record['sourceFileIds']))
    # A resumed national assembly may already have replaced imported states.
    required=[item for item in plan['files']
              if not (item['path'].startswith('tiles/states/') and Path(item['path']).stem in covered)]
    while True:
        missing=[item['path'] for item in required
                 if not (ROOT/item['path']).exists() or (ROOT/item['path']).stat().st_size!=item['bytes']]
        if not missing:
            break
        status('waiting_for_imported_outputs',remainingFiles=len(missing))
        time.sleep(10)
    for item in required:
        with (ROOT/item['path']).open('rb') as source:
            assert hashlib.file_digest(source,'sha256').hexdigest()==item['sha256']
    converted = list((ROOT/'metadata/converted').glob('*.json'))
    assert set(plan['importedSourceFileIds'])<={path.stem for path in converted}
    for path in converted:
        record = json.loads(path.read_text())
        if path.stem in covered or path.stem not in plan['importedSourceFileIds']:
            continue
        target = ROOT/record['tileFile']
        assert target.stat().st_size==record['tileBytes']
        with target.open('rb') as source:
            assert hashlib.file_digest(source,'sha256').hexdigest()==record['sha256']
    atomic_json(ROOT/'metadata/migration-complete.json',{'verified':True,
                'importedSourceConversions':len(plan['importedSourceFileIds']),
                'verifiedOutputFiles':len(required),'verifiedOutputBytes':sum(item['bytes'] for item in required),
                'supersededImportedStateFiles':len(plan['files'])-len(required)})


def data_audit():
    manifest = json.loads((ROOT/'manifest.json').read_text())
    catalog = json.loads((ROOT/'catalog.json').read_text())
    expected = {str(row['file_id']) for row in json.loads((ROOT/'metadata/selected-downloads.json').read_text())}
    assert len(expected)==460
    converted = {path.stem:json.loads(path.read_text()) for path in (ROOT/'metadata/converted').glob('*.json')}
    assert set(converted)==expected
    assert manifest['status']==catalog['status']=='complete'
    assert len(manifest['archives'])==len(catalog['archives'])==9
    assert manifest['sourceFeatures']==sum(item['sourceFeatures'] for item in converted.values())
    visited=[]
    reports=[]
    for record in manifest['archives']:
        status('auditing_payloads',archive=record['path'])
        ids=[str(fid) for fid in record['sourceFileIds']]
        visited.extend(ids)
        assert record['sourceFeatures']==sum(converted[fid]['sourceFeatures'] for fid in ids)
        item=next(item for item in catalog['archives'] if item['id']==record['provider']+'-'+record['variant'])
        assert (item['url'],item['sha256'],item['bytes'])==(record['path'],record['sha256'],record['bytes'])
        reports.append(audit_archive(record))
        atomic_json(ROOT/'verification/vps-archive-audits.json',reports)
    assert len(visited)==len(set(visited))==len(expected) and set(visited)==expected
    assert manifest['tileBytes']==sum(item['bytes'] for item in reports)
    assert not list((ROOT/'data').glob('*.zip*'))
    assert not list((ROOT/'tiles/states').glob('*.pmtiles'))
    raw=raw_sizes()
    assert raw['complete']
    result={'status':'complete','scope':'Source conversion, national assembly, catalog and every tile gzip payload',
            'browserVerification':'pending separately; VPS has no hardware GPU',
            'sourceArchives':len(expected),'nationalArchives':9,'sourceFeatures':manifest['sourceFeatures'],
            'tileBytes':manifest['tileBytes'],'rawSizes':raw,'archives':reports,
            'completedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    atomic_json(ROOT/'verification/vps-final-data-audit.json',result)


def interrupt(_signal,_frame):
    raise KeyboardInterrupt


def main():
    assert len(sys.argv)==1, 'Unknown runner arguments'
    signal.signal(signal.SIGTERM,interrupt)
    signal.signal(signal.SIGINT,interrupt)
    try:
        assert ROOT.is_mount(), 'VPS data root must be the dedicated mounted disk'
        completed=ROOT/'verification/vps-final-data-audit.json'
        if completed.exists() and json.loads(completed.read_text())['status']=='complete':
            assert json.loads((ROOT/'manifest.json').read_text())['status']=='complete'
            assert json.loads((ROOT/'catalog.json').read_text())['status']=='complete'
            status('complete',browserVerification='pending separately')
            return
        plan=json.loads((ROOT/'metadata/import-plan.json').read_text())
        assert set(plan['importedSourceFileIds'])<={path.stem for path in (ROOT/'metadata/converted').glob('*.json')}
        status('downloading_and_converting')
        processes=[launch('fcc_download.py'),launch('fcc_convert.py','--watch','--jobs','1')]
        wait_for('downloading_and_converting',processes)
        status('verifying_imported_outputs')
        verify_migration()
        process=launch('fcc_finalize.py')
        wait_for('assembling_national_archives',[process])
        process=launch('fcc_catalog.py')
        wait_for('writing_catalog',[process])
        data_audit()
        status('complete',browserVerification='pending separately')
    except KeyboardInterrupt:
        status('stopped')
        raise
    except Exception as error:
        status('failed',error=str(error))
        raise
    finally:
        for process in CHILDREN:
            if process.poll() is None:
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass
        for process in CHILDREN:
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass


if __name__=='__main__':
    main()
