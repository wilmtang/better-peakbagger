"""Small, stopped-batch comparison: decode only visible FCC/GitHub tiles."""
from collections import Counter
from functools import lru_cache
import gzip
import hashlib
import html
import json
import math
import os
from pathlib import Path
import time

from curl_cffi import requests
import mapbox_vector_tile
from pmtiles.reader import Reader
from shapely.geometry import shape, box, mapping
from shapely.ops import transform

OUT = Path(os.environ.get('FCC_COMPARISON_OUTPUT', Path(__file__).resolve().parent)).expanduser().resolve()
OUT.mkdir(parents=True,exist_ok=True)
ROOT = Path(os.environ.get('FCC_TILE_ROOT', Path.home()/'Dev/fcc-tiles')).expanduser().resolve()
LOCAL = ROOT/'tiles/tmobile-lte-2025-12-31.pmtiles'
COMMIT = '28f72437259d20268dd89a0686a05c0c0b507a19'
REMOTE = f'https://raw.githubusercontent.com/wispiANt/cell-site-atlas-tiles/{COMMIT}/fcc-coverage/tiles/coverage-lte-r8-tmobile-0.pmtiles'
WIDTH,HEIGHT = 800,470
COLORS = {-110:'#d1e5f0',-100:'#a9cde3',-90:'#78b3d1',-80:'#4a96bc',-70:'#2379a5',-60:'#115c89',-50:'#083f6b'}
CALLS=[]
session=requests.Session(impersonate='chrome')
source=LOCAL.open('rb')


@lru_cache(maxsize=64)
def local_bytes(offset,length):
    source.seek(offset)
    return source.read(length)


@lru_cache(maxsize=32)
def remote_bytes(offset,length):
    assert length <= 2*1024**2, 'Comparison must use bounded ranges'
    cache=OUT/f'range-{offset}-{length}.bin'
    if cache.exists():
        data=cache.read_bytes()
    else:
        response=session.get(REMOTE,headers={'Range':f'bytes={offset}-{offset+length-1}'},timeout=30)
        assert response.status_code==206
        data=response.content
        assert len(data)==length
        cache.write_bytes(data)
    assert len(data)==length
    CALLS.append({'offset':offset,'length':length,'sha256':hashlib.sha256(data).hexdigest()})
    return data


local,remote=Reader(local_bytes),Reader(remote_bytes)
assert local.header()['max_zoom']==12 and remote.header()['max_zoom']==10


def world(lon,lat):
    return (lon+180)/360,(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2


def geographic(x,y):
    return x*360-180,math.degrees(math.atan(math.sinh(math.pi*(1-2*y))))


def svg_geometry(geometry):
    polygons=[geometry['coordinates']] if geometry['type']=='Polygon' else geometry['coordinates']
    pieces=[]
    for rings in polygons:
        for ring in rings:
            if len(ring)<3:continue
            pieces.append('M'+'L'.join(f'{x:.2f},{y:.2f}' for x,y in ring)+'Z')
    return ''.join(pieces)


def features(reader,zoom,bounds,raw):
    left,top,right,bottom=bounds
    n=2**zoom
    result=[]
    evidence=[]
    for ty in range(math.floor(top*n),math.floor(bottom*n)+1):
        for tx in range(math.floor(left*n),math.floor(right*n)+1):
            data=reader.get(zoom,tx,ty)
            if not data:continue
            layer=mapbox_vector_tile.decode(gzip.decompress(data),default_options={'y_coord_down':True})['coverage']
            extent=layer['extent']
            tile_box=box(max(0,(tx/n-left)/(right-left)*WIDTH),max(0,(ty/n-top)/(bottom-top)*HEIGHT),
                         min(WIDTH,((tx+1)/n-left)/(right-left)*WIDTH),min(HEIGHT,((ty+1)/n-top)/(bottom-top)*HEIGHT))
            kept=0
            for feature in layer['features']:
                props=feature['properties']
                # FCC environment 1 supports BOTH in-vehicle and outdoor use;
                # outdoor coverage includes environment codes 0 and 1.
                if raw:assert props['environmnt'] in (0,1)
                value=props['minsignal'] if raw else props['dbm']
                def project(x,y,z=None):
                    return ((tx+x/extent)/n-left)/(right-left)*WIDTH,((ty+y/extent)/n-top)/(bottom-top)*HEIGHT
                polygon=transform(project,shape(feature['geometry'])).intersection(tile_box)
                if polygon.is_empty:continue
                if polygon.geom_type=='GeometryCollection':
                    parts=[item for item in polygon.geoms if item.geom_type in ['Polygon','MultiPolygon']]
                else:parts=[polygon]
                for part in parts:
                    if part.geom_type not in ['Polygon','MultiPolygon']:continue
                    result.append({'value':value,'geometry':mapping(part)})
                kept+=1
            evidence.append({'z':zoom,'x':tx,'y':ty,'compressedBytes':len(data),'renderedFeatures':kept})
    return sorted(result,key=lambda f:f['value']),evidence


def basemap(name,bounds):
    target=OUT/(name+'-hillshade.png')
    radius=6378137
    half=math.pi*radius
    left,top,right,bottom=bounds
    mercator=[(left*2-1)*half,(1-bottom*2)*half,(right*2-1)*half,(1-top*2)*half]
    url='https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/export'
    if not target.exists():
        r=session.get(url,params={'bbox':','.join(str(v) for v in mercator),'bboxSR':'3857','imageSR':'3857',
                                 'size':f'{WIDTH},{HEIGHT}','dpi':'96','format':'png32','transparent':'false','f':'image'},timeout=30)
        r.raise_for_status()
        assert r.content[:8]==b'\x89PNG\r\n\x1a\n',r.text[:300]
        target.write_bytes(r.content)
    return {'provider':'Esri World Hillshade','service':url,'bbox3857':mercator,'bytes':target.stat().st_size}


def map_svg(name,items,bounds,scale_meters,locator=None):
    paths=''.join(f'<path d="{svg_geometry(item["geometry"])}" fill="{COLORS[item["value"]]}"/>' for item in items)
    x,y=world(-121.4133,47.4233)
    left,top,right,bottom=bounds
    sx,sy=(x-left)/(right-left)*WIDTH,(y-top)/(bottom-top)*HEIGHT
    marker=''
    if 50<sx<WIDTH-150 and 40<sy<HEIGHT-40:
        marker=f'<g class="place"><circle cx="{sx:.1f}" cy="{sy:.1f}" r="3.5"/><text x="{sx+9:.1f}" y="{sy+5:.1f}">Snoqualmie Pass</text></g>'
    midlat=geographic((left+right)/2,(top+bottom)/2)[1]
    view_meters=(right-left)*40075016.68557849*math.cos(math.radians(midlat))
    bar=scale_meters/view_meters*WIDTH
    label=(str(scale_meters//1000)+' km') if scale_meters>=1000 else str(scale_meters)+' m'
    rect=''
    if locator:
        l,t,r,b=locator
        rect=f'<rect x="{(l-left)/(right-left)*WIDTH:.2f}" y="{(t-top)/(bottom-top)*HEIGHT:.2f}" width="{(r-l)/(right-left)*WIDTH:.2f}" height="{(b-t)/(bottom-top)*HEIGHT:.2f}" fill="none" stroke="#d8612d" stroke-width="2.5" stroke-dasharray="6 4"/>'
    return f'''<svg viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-label="{html.escape(name)}">
    <defs><clipPath id="mapclip"><rect width="{WIDTH}" height="{HEIGHT}"/></clipPath></defs>
    <g clip-path="url(#mapclip)"><image href="{name.split('-')[0]}-hillshade.png" width="{WIDTH}" height="{HEIGHT}" opacity="0.62"/>
    <g fill-rule="evenodd" opacity="0.76">{paths}</g>{rect}{marker}</g>
    <g class="north"><rect x="{WIDTH-48}" y="12" width="34" height="48" rx="8"/><text x="{WIDTH-31}" y="30" text-anchor="middle">N</text><path d="M{WIDTH-31},36l-5,11h10Z"/></g>
    <g class="scale"><rect x="12" y="{HEIGHT-45}" width="{bar+30:.1f}" height="33" rx="6"/><path d="M24,{HEIGHT-30}v7h{bar:.1f}v-7"/><text x="24" y="{HEIGHT-33}">{label}</text></g>
    </svg>'''


def bounds_for(lon,lat,zoom):
    x,y=world(lon,lat)
    world_pixels=512*2**zoom
    return [x-WIDTH/2/world_pixels,y-HEIGHT/2/world_pixels,x+WIDTH/2/world_pixels,y+HEIGHT/2/world_pixels]


DETAIL=bounds_for(-121.429,47.443,14)
VIEWS=[('overview',-121.429,47.443,12,2000),('detail',-121.429,47.443,14,500)]
sections=[]
evidence=[]
for name,lon,lat,zoom,scale in VIEWS:
    bounds=bounds_for(lon,lat,zoom)
    raw,raw_tiles=features(local,12,bounds,True)
    compact,compact_tiles=features(remote,10,bounds,False)
    assert raw and compact
    baseline=basemap(name,bounds)
    row=[]
    for suffix,label,sub,items in [('raw','Detailed conversion','FCC raw polygons · outdoor coverage (codes 0 + 1)',raw),
                                   ('github','GitHub conversion','H3 resolution 8 · environment unspecified',compact)]:
        svg=map_svg(name+'-'+suffix,items,bounds,scale,DETAIL if name=='overview' else None)
        (OUT/(name+'-'+suffix+'.svg')).write_text(svg)
        row.append(f'<article><header><span class="eyebrow">{label}</span><h2>{sub}</h2></header>{svg}</article>')
    sections.append(f'<section id="{name}"><div class="view-title"><h3>{"Regional view" if name=="overview" else "Close-up"}</h3><p>{"Orange box marks the close-up below" if name=="overview" else "Same location enlarged 4×; neither source gains new detail"}</p></div><div class="maps">'+''.join(row)+'</div></section>')
    evidence.append({'view':name,'center':[lon,lat],'displayZoomEquivalent':zoom,'worldBounds':bounds,
                     'boundsWestSouthEastNorth':[*geographic(bounds[0],bounds[3]),*geographic(bounds[2],bounds[1])],
                     'localTiles':raw_tiles,'githubTiles':compact_tiles,'hillshade':baseline,
                     'rawFeaturesRendered':len(raw),'githubFeaturesRendered':len(compact)})

legend=''.join(f'<span class="swatch" style="background:{color}" title="{value} dBm"></span>' for value,color in COLORS.items())
document='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FCC coverage detail comparison — Snoqualmie Pass</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f5f3;color:#172d3a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1704px;margin:auto;padding:28px 28px 24px}.title{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}h1{font-size:28px;line-height:1.2;margin:0 0 8px;letter-spacing:-.6px}.subtitle{font-size:16px;color:#435866;margin:0}.legend{min-width:260px;font-size:12px;flex-shrink:0}.ramp{display:flex;margin:6px 0 4px}.swatch{height:12px;width:35px}.legend-labels{display:flex;justify-content:space-between;max-width:245px}.note{font-size:13px;line-height:1.45;color:#51616a;max-width:1480px;margin:16px 0 4px}.view-title{display:flex;gap:16px;align-items:baseline;margin:22px 0 10px}h3{font-size:18px;letter-spacing:-.2px;margin:0}.view-title p{margin:0;color:#596d76;font-size:13px}.maps{display:grid;grid-template-columns:1fr 1fr;gap:20px}article{background:white;border:1px solid #d8e0e0;border-radius:12px;overflow:hidden;min-width:0}header{padding:14px 18px 12px}.eyebrow{font-size:17px;font-weight:650}h2{font-weight:400;font-size:13px;margin:4px 0 0;color:#586b75}svg{display:block;width:100%;height:auto;background:#f0f1ed}.place text{font:600 13px system-ui;fill:#18303c;paint-order:stroke;stroke:white;stroke-width:4;stroke-linejoin:round}.place circle{fill:#18303c;stroke:white;stroke-width:2}.north rect,.scale rect{fill:white;opacity:.88}.north text{font:600 12px system-ui;fill:#243b45}.north path{fill:#243b45}.scale path{fill:none;stroke:#243b45;stroke-width:2}.scale text{font:11px system-ui;fill:#243b45}.footer{font-size:12px;line-height:1.45;color:#5b6f79;margin-top:16px}a{color:#245a7a} @media(max-width:850px){.maps{grid-template-columns:1fr}.title{display:block}.legend{margin-top:18px}.view-title{display:block}.view-title p{margin-top:5px}.page{padding:18px}}
</style><main class="page"><div class="title"><div><h1>What the extra detail buys</h1><p class="subtitle">Snoqualmie Pass area, Washington · T-Mobile LTE · identical extent, colors, and scale</p></div><div class="legend">Modeled signal strength<div class="ramp">'''+legend+'''</div><div class="legend-labels"><span>Weaker · −110 dBm</span><span>Stronger · −50 dBm</span></div></div></div>
<p class="note">Blue indicates modeled coverage; unfilled terrain has no coverage polygon in the selected data. Left: FCC Dec 31, 2025 data, including both codes eligible for outdoor use. Right: public GitHub dataset labeled D25. Its environment and aggregation rule are unspecified; differences cannot be attributed to resolution alone.</p>
'''+''.join(sections)+'''<p class="footer">Source data: FCC Broadband Data Collection. GitHub tiles: <a href="https://github.com/wispiANt/cell-site-atlas-tiles/tree/'''+COMMIT+'''">wispiANt/cell-site-atlas-tiles, pinned commit</a>. Terrain: Esri World Hillshade (Esri, USGS and contributors). Both archives are already vector map tiles; these views do not reprocess the FCC source. Finer boundaries do not guarantee better reception predictions.</p></main></html>'''
(OUT/'index.html').write_text(document)
(OUT/'comparison-evidence.json').write_text(json.dumps({'status':'prepared','localArchive':str(LOCAL),'remoteArchive':REMOTE,
    'readAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'localEnvironment':{'selection':[0,1],'interpretation':'Outdoor includes outdoor-only (0) and in-vehicle plus outdoor (1)'},'remoteEnvironment':'not documented',
    'minSignalColorRamp':COLORS,'viewWidth':WIDTH,'viewHeight':HEIGHT,'views':evidence,'githubRanges':CALLS,
    'githubBytesRead':sum(call['length'] for call in CALLS)},indent=2)+'\n')
print(json.dumps({'html':str(OUT/'index.html'),'githubRanges':len(CALLS),'githubBytesRead':sum(call['length'] for call in CALLS),
                  'views':[{k:v for k,v in item.items() if k in ['view','rawFeaturesRendered','githubFeaturesRendered']} for item in evidence]}))
source.close();session.close()
