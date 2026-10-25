"""Authenticated, resumable FCC GeoPackage archive download queue."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import urllib.parse
import zipfile

from curl_cffi import requests

ROOT = Path(os.environ.get('FCC_TILE_ROOT', Path.home()/'Dev/fcc-tiles')).expanduser().resolve()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def download_one(row, session, headers):
    fid = str(row['file_id'])
    destination = ROOT / 'data' / (fid + '.zip')
    receipt = ROOT / 'metadata/downloads' / (fid + '.json')
    done = ROOT / 'metadata/converted' / (fid + '.json')
    if done.exists():
        return 'converted'
    if destination.exists() and receipt.exists():
        item = json.loads(receipt.read_text())
        if destination.stat().st_size == item['bytes']:
            return 'downloaded'
        raise RuntimeError('Existing archive size mismatch: ' + fid)
    while sum(p.stat().st_size for p in (ROOT / 'data').glob('*.zip')) > 6 * 1024**3:
        print(json.dumps({'state': 'waiting_for_conversion', 'fileId': fid}), flush=True)
        time.sleep(10)
    if shutil.disk_usage(ROOT).free < 15 * 1024**3:
        raise RuntimeError('Less than 15 GiB free; stopping before another download')
    url = 'https://bdc.fcc.gov/api/public/map/downloads/downloadFile/availability/' + fid + '/2'
    part = destination.with_suffix('.zip.part')
    for attempt in range(1, 4):
        with (ROOT / 'metadata/api-rate.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            rate = ROOT / 'metadata/last-api-request.txt'
            last = float(rate.read_text()) if rate.exists() else 0
            pause = max(0, 6.5 - (time.time() - last))
            if pause:
                time.sleep(pause)
            rate.write_text(str(time.time()))
            response = session.get(url, headers=headers, stream=True,
                                   allow_redirects=False, timeout=300)
        if response.status_code in (429, 500, 502, 503, 504):
            response.close()
            print(json.dumps({'state': 'retry', 'fileId': fid, 'attempt': attempt}), flush=True)
            time.sleep(10 * attempt)
            continue
        if response.status_code != 200:
            body = response.content[:500].decode('utf-8', errors='replace')
            raise RuntimeError(f'FCC file {fid}: HTTP {response.status_code}; ' + body)
        if 'zip' not in response.headers.get('content-type', '').lower():
            raise RuntimeError('Expected ZIP content for ' + fid)
        expected = int(response.headers.get('content-length', '0'))
        if expected and expected > shutil.disk_usage(ROOT).free - 15 * 1024**3:
            raise RuntimeError('Archive will exceed free-space reserve: ' + fid)
        digest = hashlib.sha256()
        total = 0
        started = time.monotonic()
        try:
            with part.open('wb') as target:
                for chunk in response.iter_content(1024 * 1024):
                    target.write(chunk)
                    total += len(chunk)
                    digest.update(chunk)
                    if shutil.disk_usage(ROOT).free < 12 * 1024**3:
                        raise RuntimeError('Free-space reserve reached while downloading')
            if expected and total != expected:
                raise RuntimeError('Incomplete ZIP for ' + fid)
            with zipfile.ZipFile(part) as zipped:
                entries = [{'name': item.filename, 'bytes': item.file_size,
                            'compressedBytes': item.compress_size, 'crc32': item.CRC}
                           for item in zipped.infolist()]
                if len(entries) != 1 or not entries[0]['name'].lower().endswith('.gpkg'):
                    raise RuntimeError('Unexpected ZIP layout for ' + fid)
            part.replace(destination)
            atomic_json(receipt, {'source': row, 'url': url, 'bytes': total,
                                 'sha256': digest.hexdigest(), 'entries': entries,
                                 'contentDisposition': response.headers.get('content-disposition'),
                                 'downloadedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                 'seconds': round(time.monotonic() - started, 2)})
            return 'downloaded'
        finally:
            response.close()
    raise RuntimeError('Download retries exhausted: ' + fid)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error('--limit must be positive')
    (ROOT / 'data').mkdir(exist_ok=True)
    (ROOT / 'metadata/downloads').mkdir(parents=True, exist_ok=True)
    credentials = json.loads((ROOT / '.secrets/fcc.json').read_text())
    headers = {**credentials, 'Origin': 'https://broadbandmap.fcc.gov',
               'Referer': 'https://broadbandmap.fcc.gov/'}
    rows = json.loads((ROOT / 'metadata/selected-downloads.json').read_text())
    # Finish small archives first while the bounded conversion queue drains.
    rows.sort(key=lambda row: (row['state_fips'] != '53', int(row['record_count'])))
    if args.limit:
        rows = rows[:args.limit]
    with (ROOT / 'metadata/downloader.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with requests.Session(impersonate='chrome') as session:
            for index, row in enumerate(rows, 1):
                state = download_one(row, session, headers)
                result = {'index': index, 'total': len(rows), 'fileId': row['file_id'],
                          'provider': row['provider_name'], 'stateName': row['state_name'],
                          'technology': row['technology_code_desc'], 'speedTier': row['speed_tier'],
                          'state': state}
                atomic_json(ROOT / 'metadata/download-progress.json', result)
                print(json.dumps(result), flush=True)
    atomic_json(ROOT / 'metadata/download-complete.json', {'count': len(rows)})


if __name__ == '__main__':
    main()
