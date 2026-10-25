import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';

const root = path.resolve(process.env.FCC_TILE_ROOT || path.join(os.homedir(), 'Dev/fcc-tiles'));
const repo = path.resolve(process.env.BPB_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../..'));
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('playwright');
const { assertChromeLaunchAllowed } = await import(path.join(repo, 'scripts/chrome-launch-guard.mjs'));
assertChromeLaunchAllowed();
assert(process.argv.slice(2).every(arg => arg === '--watch'), 'Unknown verification argument');
const watch = process.argv.includes('--watch');
const vendor = path.join(repo, 'node_modules/maplibre-gl/dist');
const out = path.join(root, 'verification');
await mkdir(out, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'fcc-coverage-browser-'));
const requests = [];
const files = new Map();
const failures = [];
let context;
let server;

const html = `<!doctype html><meta charset="utf-8"><title>FCC coverage verification</title>
<link rel="stylesheet" href="/vendor/maplibre-gl.css">
<style>html,body{margin:0;background:#e8edef;color:#20313b;font:15px system-ui}#label{height:40px;box-sizing:border-box;padding:10px 16px}#map{width:960px;height:600px}</style>
<div id="label">FCC mobile coverage</div><div id="map"></div>
<script src="/vendor/pmtiles.js"></script>
<script type="module">
import * as maplibre from '/vendor/maplibre-gl.mjs';
maplibre.setWorkerUrl('/vendor/maplibre-gl-worker.mjs');
const protocol = new pmtiles.Protocol();
maplibre.addProtocol('pmtiles', protocol.tile);
const map = new maplibre.Map({container:'map',center:[-122,47],zoom:12,
 canvasContextAttributes:{preserveDrawingBuffer:true},
 style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e8edef'}}]},
 attributionControl:false,interactive:false,fadeDuration:0});
window.map = map; window.errors=[];
map.on('error', event => window.errors.push(String(event.error?.message || event.error)));
window.showCoverage = (archive,sample) => {
 if (map.getLayer('coverage')) map.removeLayer('coverage');
 if (map.getSource('coverage')) map.removeSource('coverage');
 map.addSource('coverage',{type:'vector',url:'pmtiles://'+location.origin+'/tiles/'+archive,minzoom:4,maxzoom:12});
 map.addLayer({id:'coverage',type:'fill',source:'coverage','source-layer':'coverage',
  filter:['==',['get','environmnt'],sample.properties.environmnt],
  paint:{'fill-color':['interpolate',['linear'],['get','minsignal'],-120,'#d9e6cb',-100,'#80bda2',-80,'#27857b',-50,'#07505a'],'fill-opacity':0.9}});
 map.jumpTo({center:sample.point,zoom:12});
 document.getElementById('label').textContent=archive+' · '+(sample.properties.environmnt===0?'Outdoor-only source class':'In-vehicle + outdoor source class')+' · z12';
};
window.ready=true;
</script>`;

async function readJson(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
async function exists(filename) { try { await access(filename); return true; } catch { return false; } }
async function save(report) {
 const target=path.join(out,'browser-results.json');
 await writeFile(target+'.tmp',JSON.stringify(report,null,2)+'\n');
 const { rename }=await import('node:fs/promises');
 await rename(target+'.tmp',target);
}

try {
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
  '-keyout',path.join(temporary,'key.pem'),'-out',path.join(temporary,'cert.pem'),
  '-subj','/CN=www.peakbagger.com'],{stdio:'ignore'});
 server=https.createServer({key:await readFile(path.join(temporary,'key.pem')),
  cert:await readFile(path.join(temporary,'cert.pem'))}, async (req,res) => {
  try {
   const pathname=new URL(req.url,'https://www.peakbagger.com').pathname;
   if(pathname==='/verify') { res.setHeader('Content-Type','text/html');res.end(html);return; }
   const tile=pathname.startsWith('/tiles/') && files.get(path.basename(pathname));
   if(tile) {
    const size=(await stat(tile.filename)).size;
    const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
    assert(range,'A full-archive request is forbidden in this verifier');
    const start=Number(range[1]),end=Math.min(size-1,Number(range[2]));
    assert(start>=0&&start<=end&&end<size);
    requests.push({archive:path.basename(pathname),start,end,bytes:end-start+1,archiveBytes:size,status:206});
    res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':end-start+1,
     'Content-Range':'bytes '+start+'-'+end+'/'+size,'Accept-Ranges':'bytes',ETag:'"'+tile.sha256+'"',
     'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'ETag,Content-Range',
     'Cache-Control':'public,max-age=3600'});
    const stream=createReadStream(tile.filename,{start,end});
    res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);return;
   }
   const name=pathname.startsWith('/vendor/') && path.basename(pathname);
   if(name && ['maplibre-gl.mjs','maplibre-gl-shared.mjs','maplibre-gl-worker.mjs','maplibre-gl.css','pmtiles.js'].includes(name)) {
    const filename=name==='pmtiles.js'?path.join(root,'tools/pmtiles-4.5.0/dist/pmtiles.js'):path.join(vendor,name);
    res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');
    res.end(await readFile(filename));return;
   }
   res.writeHead(404);res.end();
  } catch(error) { failures.push(String(error));res.writeHead(500);res.end(String(error)); }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='https://www.peakbagger.com:'+server.address().port;
 assertChromeLaunchAllowed();
 context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{
  channel:'chromium',headless:true,ignoreDefaultArgs:['--enable-unsafe-swiftshader'],ignoreHTTPSErrors:true,viewport:{width:960,height:640},
  args:['--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1','--no-proxy-server']});
 const page=await context.newPage();
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin+'/verify');
 await page.waitForFunction(()=>window.ready===true&&window.map.loaded(),undefined,{timeout:60000});
 const renderer=await page.evaluate(()=>{
  const gl=window.map.getCanvas().getContext('webgl2');
  const ext=gl.getExtension('WEBGL_debug_renderer_info');
  return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null;
 });
 assert(renderer&&!/swiftshader|llvmpipe|softpipe|software/i.test(renderer),'Hardware WebGL renderer required: '+renderer);
 const report={status:'partial',method:'isolated headless Chrome for Testing',browser:context.browser().version(),
  renderer,viewport:{width:960,height:640},pmtilesVersion:'4.5.0',maplibreVersion:require('maplibre-gl/package.json').version,
  scope:'Generated national PMTiles via local HTTPS range server; no extension integration or external basemap',archives:[]};
 const tested=new Set();
 while(true) {
  const receipts=await readdir(path.join(root,'metadata/national'));
  for(const filename of receipts.filter(name=>name.endsWith('.json')).sort()) {
   if(tested.has(filename)) continue;
   const archive=await readJson(path.join(root,'metadata/national',filename));
   const basename=path.basename(archive.path);
   files.set(basename,{filename:path.join(root,archive.path),sha256:archive.sha256});
   const states=[];
   for(const id of archive.sourceFileIds) states.push(await readJson(path.join(root,'metadata/converted',id+'.json')));
   const selected=['53','06','36'].map(fips=>states.find(state=>state.source.state_fips===fips)).filter(Boolean);
   assert(selected.length>0,'No geographic verification cases');
   const cases=[];
   const before=requests.length;
   for(const record of selected) {
    const sample=record.sourceSamples.find(item=>item.properties.environmnt===0)||record.sourceSamples[0];
    assert(sample,'Missing independent source sample');
    await page.evaluate(({basename,sample})=>window.showCoverage(basename,sample),{basename,sample});
    await page.waitForFunction(properties=>{
     if(!window.map.isStyleLoaded()||!window.map.loaded()) return false;
     const at=window.map.project(window.map.getCenter());
     return window.map.queryRenderedFeatures(at,{layers:['coverage']}).some(feature=>
      Object.entries(properties).every(([key,value])=>feature.properties[key]===value));
    },sample.properties,{timeout:90000});
    cases.push({state:record.source.state_name,point:sample.point,properties:sample.properties,renderedSourceMatch:true});
    if(cases.length===1) await page.screenshot({path:path.join(out,basename+'.png')});
   }
   assert(requests.length>before,'No PMTiles range requests executed');
   assert.equal(failures.length,0,JSON.stringify(failures));
   const errors=await page.evaluate(()=>window.errors);
   assert.equal(errors.length,0,JSON.stringify(errors));
   const result={provider:archive.provider,variant:archive.variant,path:archive.path,cases,
    rangeRequests:requests.length-before,requestedBytes:requests.slice(before).reduce((sum,row)=>sum+row.bytes,0)};
   report.archives.push(result);tested.add(filename);
   await save(report);console.log(JSON.stringify({state:'browser_verified',...result}));
  }
  if(await exists(path.join(root,'manifest.json'))) {
   const manifest=await readJson(path.join(root,'manifest.json'));
   assert.equal(manifest.status,'complete');assert.equal(tested.size,manifest.tileArchiveCount);
   assert.equal(tested.size,9);report.status='complete';break;
  }
  if(!watch) { assert(tested.size>0,'Zero verification cases executed');break; }
  await pause(5000);
 }
 report.completedAt=new Date().toISOString();report.rangeRequests=requests;
 await save(report);console.log(JSON.stringify({state:'browser_verification_finished',status:report.status,archives:tested.size,renderer}));
} catch(error) {
 await writeFile(path.join(out,'browser-error.txt'),error.stack+'\n');throw error;
} finally {
 if(context) await context.close();
 if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await rm(temporary,{recursive:true,force:true});
}
