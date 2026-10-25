import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile,writeFile,mkdtemp,rm,stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const scriptDirectory=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(process.env.BPB_REPO || path.join(scriptDirectory, '../../../../..'));
const {assertChromeLaunchAllowed}=await import(path.join(repo, 'scripts/chrome-launch-guard.mjs'));

assertChromeLaunchAllowed();
const root=path.resolve(process.env.FCC_COMPARISON_OUTPUT || scriptDirectory);
const require=createRequire(path.join(repo,'package.json'));
const {chromium}=require('playwright');
const temporary=await mkdtemp(path.join(os.tmpdir(),'fcc-compare-render-'));
let server,browser;
let signalError;
const stop=()=>{signalError=new Error('Comparison cancelled');browser?.close().catch(()=>{});};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const errors=[];
try {
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',path.join(temporary,'key.pem'),
  '-out',path.join(temporary,'cert.pem'),'-subj','/CN=www.peakbagger.com'],{stdio:'ignore'});
 server=https.createServer({key:await readFile(path.join(temporary,'key.pem')),cert:await readFile(path.join(temporary,'cert.pem'))},async(req,res)=>{
  try{
   const name=path.basename(new URL(req.url,'https://www.peakbagger.com').pathname)||'index.html';
   assert(/^(index\.html|(?:overview|detail)-(?:raw\.svg|github\.svg|hillshade\.png))$/.test(name));
   res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.svg')?'image/svg+xml':'image/png');
   res.end(await readFile(path.join(root,name)));
  }catch(error){res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='https://www.peakbagger.com:'+server.address().port;
 assertChromeLaunchAllowed();
 browser=await chromium.launch({channel:'chromium',headless:true,
  ignoreDefaultArgs:['--enable-unsafe-swiftshader'],
  args:['--disable-gpu','--renderer-process-limit=1','--num-raster-threads=1',
        '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1','--no-proxy-server']});
 const context=await browser.newContext({viewport:{width:1704,height:1440},deviceScaleFactor:1,ignoreHTTPSErrors:true});
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(String(error)));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin+'/index.html',{waitUntil:'networkidle',timeout:20000});
 await page.evaluate(()=>document.fonts.ready);
 const images=await page.evaluate(async()=>{
  const urls=[...document.querySelectorAll('svg image')].map(image=>image.getAttribute('href'));
  return await Promise.all(urls.map(url=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve({url,width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>resolve({url,error:true});image.src=url;})));
 });
 assert(images.length===4&&images.every(image=>image.width===800&&image.height===470),JSON.stringify(images));
 assert.equal(await page.locator('article').count(),4);
 assert.equal(errors.length,0,JSON.stringify(errors));
 await page.screenshot({path:path.join(root,'comparison.png'),fullPage:true});
 await page.locator('#detail').screenshot({path:path.join(root,'close-up.png')});
 const evidence=JSON.parse(await readFile(path.join(root,'comparison-evidence.json'),'utf8'));
 evidence.status='rendered';evidence.browser={version:browser.version(),hidden:true,viewport:{width:1704,height:1440},
  method:'Static SVG rendering of decoded vector tiles over identical hillshade; no WebGL and no converter',images};
 evidence.generatedAt=new Date().toISOString();
 await writeFile(path.join(root,'comparison-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({png:path.join(root,'comparison.png'),bytes:(await stat(path.join(root,'comparison.png'))).size,
  browser:browser.version(),viewport:evidence.browser.viewport,images:images.length,temporary}));
 if(signalError)throw signalError;
}finally{
 process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
 if(browser)await browser.close();
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await rm(temporary,{recursive:true,force:true});
}
