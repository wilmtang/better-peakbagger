"""Read progress without displaying credentials or source row contents."""
from pathlib import Path
import json
import shutil

from fcc_download import ROOT as root
selected = json.loads((root/'metadata/selected-downloads.json').read_text())
downloads = list((root/'metadata/downloads').glob('*.json'))
converted = list((root/'metadata/converted').glob('*.json'))
records = [json.loads(path.read_text()) for path in converted]
national = [json.loads(path.read_text()) for path in (root/'metadata/national').glob('*.json')]
browser_path = root/'verification/browser-results.json'
browser = json.loads(browser_path.read_text()) if browser_path.exists() else {'archives':[]}
progress_path = root/'metadata/conversion-progress.json'
running = set(json.loads(progress_path.read_text()).get('active', [])) if progress_path.exists() else set()
active = [json.loads(path.read_text()) for path in (root/'metadata/converting').glob('*.json') if path.stem in running]
print(json.dumps({'expectedArchives':len(selected),'downloadedArchives':len(downloads),
                  'convertedArchives':len(records),
                  'convertedSourceFeatures':sum(record['sourceFeatures'] for record in records),
                  'sourceCountDiscrepancies':[{'fileId':record['source']['file_id'], **record['sourceValidation']}
                      for record in records if record.get('sourceValidation',{}).get('catalogCountDiffers')],
                  'stateTileBytes':sum(p.stat().st_size for p in (root/'tiles/states').glob('*.pmtiles')),
                  'verifiedNationalArchives':len(national),
                  'nationalTileBytes':sum(item['bytes'] for item in national),
                  'browserVerifiedNationalArchives':len(browser['archives']),
                  'downloadCacheBytes':sum(p.stat().st_size for p in (root/'data').glob('*.zip')),
                  'freeDiskBytes':shutil.disk_usage(root).free,'activeConversions':active,
                  'finalManifestExists':(root/'manifest.json').exists()},indent=2))
