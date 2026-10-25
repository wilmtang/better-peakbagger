"""Measure selected source sizes from receipts or bounded ZIP central-directory reads."""
import fcntl
import hashlib
import io
import json
import re
import sys
import time
import zipfile

from curl_cffi import requests
from fcc_download import ROOT, atomic_json


def parse_tail(data, content_range):
    match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',content_range or '')
    assert match,'Missing valid Content-Range'
    start,end,total=map(int,match.groups())
    assert end==total-1 and len(data)==end-start+1 and len(data)<=65536
    with zipfile.ZipFile(io.BytesIO(data)) as zipped:
        items=zipped.infolist()
        assert len(items)==1 and items[0].filename.endswith('.gpkg')
        entry=items[0]
        return {'bytes':total,'entries':[{'name':entry.filename,'bytes':entry.file_size,
                                        'compressedBytes':entry.compress_size,'crc32':entry.CRC}],
                'rangeBytes':len(data),'tailSha256':hashlib.sha256(data).hexdigest(),
                'measurement':'Content-Range total and ZIP central directory; member not downloaded'}


def measure_one(row, session, headers):
    fid=str(row['file_id'])
    for attempt in range(3):
        with (ROOT/'metadata/api-rate.lock').open('a+') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            stamp=ROOT/'metadata/last-api-request.txt'
            last=float(stamp.read_text()) if stamp.exists() else 0
            time.sleep(max(0,6.5-(time.time()-last)))
            stamp.write_text(str(time.time()))
            response=session.get('https://bdc.fcc.gov/api/public/map/downloads/downloadFile/availability/'+fid+'/2',
                headers={**headers,'Range':'bytes=-65536'},stream=True,allow_redirects=False,timeout=60)
        if response.status_code in (429,500,502,503,504):
            response.close();time.sleep(10*(attempt+1));continue
        try:
            assert response.status_code==206,f'FCC {fid} ignored Range; stopped without reading full file'
            data=bytearray()
            for block in response.iter_content(16384):
                data.extend(block)
                assert len(data)<=65536,'Unbounded source-size response'
            result=parse_tail(bytes(data),response.headers.get('content-range'))
            result.update(source=row,measuredAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
            assert result['entries'][0]['name'].rsplit('_',1)[0]==row['file_name'].rsplit('_',1)[0]
            return result
        finally:response.close()
    raise RuntimeError('Source-size retries exhausted: '+fid)


def main():
    assert len(sys.argv)==1,'Unknown source-size survey arguments'
    selected=json.loads((ROOT/'metadata/selected-downloads.json').read_text())
    assert len({str(row['file_id']) for row in selected})==len(selected)>0,'Empty or duplicate selected inventory'
    headers=json.loads((ROOT/'.secrets/fcc.json').read_text())
    headers.update(Origin='https://broadbandmap.fcc.gov',Referer='https://broadbandmap.fcc.gov/')
    folder=ROOT/'metadata/source-sizes';folder.mkdir(exist_ok=True)
    measurements=[]
    with requests.Session(impersonate='chrome') as session:
        for row in selected:
            fid=str(row['file_id']);receipt=ROOT/'metadata/downloads'/(fid+'.json');proof=folder/(fid+'.json')
            if receipt.exists():result=json.loads(receipt.read_text())
            elif proof.exists():result=json.loads(proof.read_text())
            else:
                result=measure_one(row,session,headers)
                atomic_json(proof,result)
            assert result['source']==row
            measurements.append(result)
            summary={'scope':'AT&T, Verizon, T-Mobile; US LTE and both 5G tiers; 2025-12-31',
                     'expectedSourceArchives':len(selected),'measuredSourceArchives':len(measurements),
                     'complete':len(measurements)==len(selected),
                     'compressedZipBytes':sum(item['bytes'] for item in measurements),
                     'uncompressedGeoPackageBytes':sum(entry['bytes'] for item in measurements for entry in item['entries']),
                     'method':'Download receipts where available; otherwise bounded ZIP central-directory reads',
                     'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
            atomic_json(ROOT/'metadata/raw-size-survey.json',summary)
            print(json.dumps({'measured':len(measurements),'expected':len(selected),'lastFileId':fid,
                              'compressedZipBytes':summary['compressedZipBytes'],
                              'uncompressedGeoPackageBytes':summary['uncompressedGeoPackageBytes']}),flush=True)


if __name__=='__main__':
    main()
