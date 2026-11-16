// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
// Real MapLibre hardware acceptance; provider responses are held, never intercepted.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {build} from 'esbuild';
import type {Page} from 'playwright';
import {createFixtureCertificate,waitForCondition as untypedWaitForCondition} from './browser-verification-fixtures.mjs';
import {createResourceStack,listenServer,closeServer} from './resource-stack.mjs';
import {createVerificationRoot,launchVerificationChrome,PEAKBAGGER_HOST_RULE} from './verification-launch.mts';

// Page-world globals the evaluated callbacks below install and read.
interface FixtureGlMap {
    isStyleLoaded(): boolean; getCanvas(): HTMLCanvasElement; getStyle(): {sources: Record<string, unknown>};
    jumpTo(options: object): void; remove(): void; _listeners?: Record<string, unknown[]>;
}
interface FixtureRenderer { update(sources: unknown[], ...rest: object[]): void; dispose(): void }
interface FixtureStatus { pending?: boolean; [field: string]: unknown }
declare const map: FixtureGlMap, maplibre: unknown, renderer: FixtureRenderer, source: {id: string},
    statuses: FixtureStatus[], customKeys: () => string[], centerPixel: () => number[], baseListeners: Record<string, number>;
declare const createCustomRenderer: (options: object) => FixtureRenderer;
declare global {
    interface Window {
        map: FixtureGlMap; maplibre: unknown; renderer: FixtureRenderer; source: object; statuses: FixtureStatus[];
        customKeys: () => string[]; centerPixel: () => number[]; baseListeners: Record<string, number>;
    }
}
const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => T, options: {description: string; isReady: (value: T) => boolean}) => Promise<T>;
assert.equal(process.argv.length,2,'Usage: node scripts/verify-custom-overlay-replacement.mts');
const root=process.cwd(),resources=createResourceStack(); let cases=0;
const screenshots=process.env.BPB_CUSTOM_REPLACEMENT_SCREENSHOTS;
const screenshot=async(page: Page,name: string)=>{if(screenshots){await mkdir(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,name+'.png')});}};
const pending=new Set<{send: () => void}>();let hold=true,canceled=0,png: Buffer[]=[];const requests: (string|undefined)[]=[];
try{
    const temporaryRoot=await createVerificationRoot(resources,'bpb-r03-gpu-','temporary fixture');
    const cert=await createFixtureCertificate({directory:temporaryRoot as never});assert.ok(cert);resources.defer('fixture certificate',()=>cert.remove());
    const bundle=await build({stdin:{contents:"import {createCustomRenderer} from './src/maps/custom-overlay-render.js'; window.createCustomRenderer=createCustomRenderer;",resolveDir:root},bundle:true,format:'iife',write:false});
    const assets=new Map<string,Buffer>(await Promise.all(['maplibre-gl.mjs','maplibre-gl-shared.mjs','maplibre-gl-worker.mjs','maplibre-gl.css'].map(async name=>['/vendor/'+name,await readFile(path.join(root,'dist/vendor',name))] as const)));
    const html='<!doctype html><html><head><link rel="stylesheet" href="/vendor/maplibre-gl.css"><style>html,body,#map{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><div id="map"></div><script src="/renderer.js"></script><script type="module">import * as maplibre from "/vendor/maplibre-gl.mjs";window.maplibre=maplibre;maplibre.setWorkerUrl(location.origin+"/vendor/maplibre-gl-worker.mjs");window.map=new maplibre.Map({container:"map",style:{version:8,sources:{},layers:[{id:"background",type:"background",paint:{"background-color":"#dce6d7"}}]},center:[-121.76,46.85],zoom:9,pitch:35,interactive:false,attributionControl:false,canvasContextAttributes:{preserveDrawingBuffer:true}});</script></body></html>';
    const server=createServer({key:cert.key,cert:cert.cert},(request,response)=>{
        const url=request.url||'';requests.push(url);
        response.setHeader('cache-control','no-store');
        if(assets.has(url)){response.setHeader('content-type',url.endsWith('.css')?'text/css':'text/javascript');response.end(assets.get(url));return;}
        if(url==='/renderer.js'){response.setHeader('content-type','text/javascript');response.end(bundle.outputFiles[0].contents);return;}
        if(url==='/metadata.json'){response.setHeader('content-type','application/json');response.end(JSON.stringify({tilejson:'3.0.0',minzoom:0,maxzoom:16,tiles:[`https://${request.headers.host}/new/{z}/{x}/{y}.png`]}));return;}
        if(/^\/(old|new)\//.test(url)){
            const send=()=>{if(!response.destroyed&&!response.writableEnded){response.setHeader('content-type','image/png');response.end(png[url.startsWith('/old/')?0:1]);}};
            if(url.startsWith('/new/')&&hold){const item={send,response};pending.add(item);response.once('close',()=>{if(pending.delete(item)&&!response.writableEnded)canceled++;});return;}
            send();return;
        }
        response.setHeader('content-type','text/html');response.end(html);
    });resources.defer('HTTPS fixture',()=>closeServer(server));await listenServer(server,0,'127.0.0.1');
    resources.defer('held responses',()=>{hold=false;for(const item of pending){item.send();}pending.clear();});
    const context=await launchVerificationChrome(resources,'Chrome',path.join(temporaryRoot,'profile'),{viewport:{width:1000,height:760},ignoreDefaultArgs:['--enable-unsafe-swiftshader'],trustArgs:cert.chromeTrustArgs,args:['--no-proxy-server'],hosts:[PEAKBAGGER_HOST_RULE]});
    const page=await context.newPage(),errors: string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`https://www.peakbagger.com:${(server.address() as AddressInfo).port}/map/MasterMap.aspx`);await page.waitForFunction(()=>window.map?.isStyleLoaded());
    png=(await page.evaluate(()=>['#f02010','#1020f0'].map(color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const drawing=canvas.getContext('2d')!;drawing.fillStyle=color;drawing.fillRect(0,0,256,256);return [...Uint8Array.from(atob(canvas.toDataURL().split(',')[1]),c=>c.charCodeAt(0))];}))).map(value=>Buffer.from(value));
    const hardware=await page.evaluate(()=>{const gl=map.getCanvas().getContext('webgl2')!,ext=gl.getExtension('WEBGL_debug_renderer_info');return ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;});assert.ok(hardware&&!/swiftshader|software|llvmpipe/i.test(hardware),hardware||'no renderer');
    await page.evaluate(()=>{
        window.statuses=[];window.source={id:'custom:0537a032-271c-4d11-9b8c-0edc566b47c1',revision:1,name:'GPU fixture',kind:'raster',source:{tiles:[location.origin+'/old/{z}/{x}/{y}.png'],metadataUrl:location.origin+'/metadata.json',minNativeZoom:0,maxNativeZoom:18,scheme:'xyz',tileSize:256},approvedOrigins:[location.origin],attribution:{text:''},appearance:{opacity:100,rules:[]}};
        window.baseListeners=Object.fromEntries(['sourcedata','render','error'].map(type=>[type,map._listeners?.[type]?.length||0]));
        window.renderer=createCustomRenderer({win:window,map,maplibre,parse:async()=>{},onStatus:(_id: string,value: FixtureStatus)=>statuses.push(value)});renderer.update([source]);
        window.customKeys=()=>Object.keys(map.getStyle().sources).filter(key=>key.startsWith('bpb-custom-'));
        window.centerPixel=()=>{const canvas=map.getCanvas(),gl=canvas.getContext('webgl2')!,pixel=new Uint8Array(4);gl.readPixels(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
    });
    await page.waitForFunction(()=>centerPixel()[0]>200&&centerPixel()[2]<80&&!statuses.at(-1)?.pending);const old=await page.evaluate(()=>customKeys()[0]);
    await screenshot(page,'old');
    await page.evaluate(()=>renderer.update([source],{}, {[source.id]:1}));
    await waitForCondition(()=>pending.size,{description:'new provider tiles are held',isReady:value=>value>0});
    assert.equal(await page.evaluate(key=>customKeys().includes(key),old),true);assert.ok((await page.evaluate(()=>centerPixel()))[0]>200);
    await page.evaluate(()=>map.jumpTo({center:[-121.72,46.85],zoom:10}));
    await waitForCondition(()=>canceled,{description:'viewport cancels held edge tiles',isReady:value=>value>0});
    await page.waitForFunction(()=>centerPixel()[0]>200&&centerPixel()[2]<80);assert.equal(await page.evaluate(key=>customKeys().includes(key),old),true);
    await screenshot(page,'pending');
    const beforeRelease={retained:await page.evaluate(key=>customKeys().includes(key),old),pixel:await page.evaluate(()=>centerPixel()),canceled,pending:pending.size,status:await page.evaluate(()=>statuses.at(-1))};
    hold=false;for(const item of pending)item.send();pending.clear();
    await page.waitForFunction(key=>!customKeys().includes(key)&&centerPixel()[2]>200&&centerPixel()[0]<80&&!statuses.at(-1)?.pending,old,{timeout:20000});
    const afterRelease={sources:await page.evaluate(()=>customKeys()),pixel:await page.evaluate(()=>centerPixel()),status:await page.evaluate(()=>statuses.at(-1))};
    await screenshot(page,'new');
    const cleanup=await page.evaluate(()=>{renderer.update([]);renderer.dispose();return {sources:customKeys(),listeners:Object.fromEntries(['sourcedata','render','error'].map(type=>[type,map._listeners?.[type]?.length||0])),baseline:baseListeners};});
    assert.deepEqual(cleanup.sources,[]);assert.deepEqual(cleanup.listeners,cleanup.baseline);assert.deepEqual(errors,[]);
    cases++; assert.equal(cases,1);
    assert.deepEqual(page.viewportSize(),{width:1000,height:760});
    console.log(JSON.stringify({verification:'custom-overlay-replacement',cases,browser:context.browser()!.version(),hidden:true,hardware,viewport:{width:1000,height:760},beforeRelease,afterRelease,cleanup,requests:requests.length}));
    await page.evaluate(()=>map.remove());
}finally{await resources.dispose();}
