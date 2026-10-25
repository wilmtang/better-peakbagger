"""Publish a portable, credential-free catalog of verified national PMTiles."""
import argparse
import json
from pathlib import Path
import time

from fcc_download import ROOT, atomic_json



def build_catalog(records, complete):
    assert len({(item['provider'], item['variant']) for item in records}) == len(records)
    if complete:
        assert len(records) == 9, 'Complete catalog requires all nine national archives'
    archives = []
    for record in sorted(records, key=lambda item: (item['provider'], item['variant'])):
        filename = Path(record['path'])
        assert not filename.is_absolute() and '..' not in filename.parts
        assert filename.parts[0] == 'tiles' and filename.suffix == '.pmtiles'
        assert record['bytes'] > 0 and len(record['sha256']) == 64
        info = record['verification']
        archives.append({'id':record['provider']+'-'+record['variant'],
                         'provider':record['provider'],'variant':record['variant'],
                         'url':record['path'],'bytes':record['bytes'],'sha256':record['sha256'],
                         'bounds':info['bounds'],'minZoom':info['minimumZoom'],'maxZoom':info['maximumZoom'],
                         'sourceLayer':info['sourceLayer'],'fields':info['fields']})
    return {'schemaVersion':1,'status':'complete' if complete else 'building',
            'asOfDate':'2025-12-31','attribution':'Source data: FCC Broadband Data Collection',
            'sourceLicense':'https://broadbandmap.fcc.gov/about?version=dec2025',
            'geometry':'Derived vector map tiles; geometry quantization and simplification apply',
            'environmentValues':{'0':'Outdoor stationary only','1':'In-vehicle mobile and outdoor stationary'},
            'archives':archives}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--watch', action='store_true')
    args = parser.parse_args()
    last = None
    while True:
        records = [json.loads(path.read_text()) for path in (ROOT/'metadata/national').glob('*.json')]
        complete = (ROOT/'manifest.json').exists()
        catalog = build_catalog(records, complete)
        if catalog != last:
            for item in catalog['archives']:
                assert (ROOT/item['url']).stat().st_size == item['bytes']
            atomic_json(ROOT/'catalog.json',catalog)
            last = catalog
            print(json.dumps({'catalogStatus':catalog['status'],'archives':len(records)}),flush=True)
        if complete or not args.watch:
            return
        time.sleep(5)


if __name__ == '__main__':
    main()
