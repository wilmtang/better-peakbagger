// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
const [kind, ...args] = process.argv.slice(2);
assert(['chrome', 'firefox'].includes(kind) && args.every(arg => arg.startsWith('--screenshots=')), 'Usage: node scripts/verify-custom-layer-menu.mjs chrome|firefox [--screenshots=PATH]');
const shots = args[0]?.slice(14), resources = createResourceStack();
try {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bpb-custom-menu-'));resources.defer('menu files', () => rm(root, { recursive:true,force:true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot:root });resources.defer('menu server', () => fixture.close());
    if (kind === 'chrome') assertChromeLaunchAllowed();
    const context = await (kind === 'chrome' ? chromium : firefox).launchPersistentContext(path.join(root,'profile'), kind === 'chrome'
        ? { channel:'chromium', headless:true, args:[...fixture.chromeTrustArgs,'--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
        : { headless:true, ignoreHTTPSErrors:true, firefoxUserPrefs:{ 'network.dns.localDomains':'www.peakbagger.com' } });
    resources.defer('menu browser', () => context.close());
    const bundle = await build({ stdin:{ resolveDir:process.cwd(), contents:`
        import {createMapLayerControl} from './src/maps/map-layer-control.js';
        import {createCustomOverlayControl} from './src/maps/custom-overlay-control.js';
        import {settingsSchema} from './src/settings/settings-schema.js';
        const native=createMapLayerControl({document});document.body.append(native.element);
        const owner=createCustomOverlayControl({win:window,panel:native.element.querySelector('.bpb-layers-panel'),readView:()=>({zoom:12})});
        const id='custom:0537a032-271c-4d11-9b8c-0edc566b47c1';
        const source={id,revision:1,name:'My topo',kind:'raster',source:{tiles:['https://tiles.example.com/{z}/{x}/{y}.png'],minNativeZoom:0,maxNativeZoom:18,scheme:'xyz',tileSize:256},
            approvedOrigins:['https://tiles.example.com'],attribution:{text:''},appearance:{opacity:60,rules:[]}};
        const paint=()=>{native.render({state:settingsSchema.mapOverlayState({slope:{enabled:true,opacity:60}}),zoom:12,theme:window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'});native.position(document.getElementById('map').getBoundingClientRect())};
        window.fixture={native,owner,id,source,paint,status:state=>owner.status(id,state),name:value=>{source.name=value;announce()}};
        function announce(){window.dispatchEvent(new MessageEvent('message',{source:window,origin:location.origin,data:{__bpbCustomOverlays:true,dir:'toPage',type:'registry',registry:{schemaVersion:1,revision:1,sources:[source]},preferences:{},settingsUrl:'chrome-extension://fixture/options/options.html#custom-map-layers'}}))}
        announce();paint();` },bundle:true,write:false,format:'iife' });
    const page = await context.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
    const url=`https://www.peakbagger.com:${fixture.port}/map/MasterMap.aspx?customUx=1`;
    await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><style>body{margin:0;font:12px Tahoma}#map{height:600px;background:#dce6d7}#after{height:200px}label{color:inherit}input{padding:0}</style><form><div id="map"></div></form><p id="after">Following native content</p>'}));
    await page.goto(url);await page.addStyleTag({content:await readFile('src/maps/map-layers.css','utf8')});await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.getByRole('button',{name:/^Overlays/}).click();
    const custom = page.locator('.bpb-custom-source'), checkbox=custom.locator('input[type=checkbox]');await checkbox.check();
    let cases=0;
    for (const width of [736,320]) for (const theme of ['light','dark']) for (const scale of [1,1.5]) {
        await page.setViewportSize({width,height:800});await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
        await page.evaluate(scale=>{document.querySelector('.bpb-map-layers').style.fontSize=13*scale+'px';window.fixture.paint();window.fixture.status({message:'Loaded'});},scale);
        const match=await page.evaluate(()=>{
            const built=document.querySelector('[data-layer=slope]'),custom=document.querySelector('.bpb-custom-source>summary');
            const read=(root,selector)=>{const node=root.querySelector(selector),r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,width:r.width,height:r.height,font:s.font,color:s.color,margin:s.margin,padding:s.padding};};
            return {built:[read(built,'input'),read(built,'.bpb-layers-row-name'),read(built,'.bpb-layers-summary'),read(built,'.bpb-layers-chevron')],custom:[read(custom,'input'),read(custom,'.bpb-layers-row-name'),read(custom,'.bpb-layers-summary'),read(custom,'.bpb-layers-chevron')]};
        });
        for (let i=0;i<match.built.length;i++) {
            assert.equal(match.built[i].x,match.custom[i].x,`row part ${i} shares horizontal alignment`);
            assert.equal(match.built[i].font,match.custom[i].font);assert.equal(match.built[i].color,match.custom[i].color);
            if (i===0||i===3) {assert.equal(match.built[i].width,match.custom[i].width);assert.equal(match.built[i].height,match.custom[i].height);}
        }
        await custom.locator('summary').first().focus();await custom.locator('summary').first().press('Space');assert(await custom.evaluate(node=>node.open));
        const slider=custom.getByRole('slider',{name:'My topo opacity'});const previous=Number(await slider.inputValue());await slider.focus();await slider.press('ArrowRight');assert.equal(Number(await slider.inputValue()),previous+1);
        const retry=custom.locator('.bpb-custom-actions button:not([data-bpb-private-layer])');await retry.focus();
        const geometry=()=>page.evaluate(()=>{
            const read=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
            return [read('.bpb-layers-trigger'),read('.bpb-custom-source>summary'),read('.bpb-custom-actions'),read('#after'),[window.scrollY]];
        });const before=await geometry();
        for(const state of [{pending:true,message:'Loading tiles'},{error:true,code:'access',message:'Source unavailable'}, {message:'Loaded'}, {lower:true,message:'Lower detail'}]) {
            await page.evaluate(state=>window.fixture.status(state),state);
            const after=await geometry();assert(after.every((rect,index)=>rect.every((value,axis)=>Math.abs(value-before[index][axis])<=1)),'status updates keep actions and native content anchored');
            assert.equal(await retry.evaluate(node=>node===document.activeElement),true,'updates preserve focus');
        }
        assert(!await custom.locator('summary').first().innerText().then(text=>text.includes('Lower detail')));
        assert((await custom.locator('.bpb-custom-feedback').innerText()).includes('enlarged tiles'));
        assert.equal(await custom.locator('[data-bpb-private-layer]').isVisible(),false);
        if(shots&&scale===1){await mkdir(shots,{recursive:true});await page.screenshot({path:path.join(shots,`menu-${kind}-${width}-${theme}-open.png`)});}
        await custom.locator('summary').first().press('Space');assert(!await custom.evaluate(node=>node.open));
        if(shots&&scale===1)await page.screenshot({path:path.join(shots,`menu-${kind}-${width}-${theme}.png`)});
        cases++;
    }
    await page.evaluate(()=>window.fixture.name('A custom layer with a long descriptive name that needs room'));
    const fits=await custom.evaluate(node=>node.scrollWidth<=node.clientWidth);assert(fits,'long layer names wrap within the menu');
    assert.equal(errors.length,0,errors.join('\n'));assert.equal(cases,8);
    console.log(JSON.stringify({verification:'custom-layer-menu',kind,version:context.browser().version(),hidden:true,viewportWidths:[736,320],height:800,cases,sharedRowStyles:true,statusActionsAnchored:true,keyboardOpacityAndDisclosure:true,reducedMotion:true,fixture:'presentation only; I/O and status values stubbed'}));
    await resources.dispose();
}catch(error){await resources.dispose(error);}
