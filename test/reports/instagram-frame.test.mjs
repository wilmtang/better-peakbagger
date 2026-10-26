// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { accelerateTimeout, evalBundle, waitFor } from '../helpers/load-page.mjs';

test('the isolated player requests the native captioned embed without granting additional sandbox capabilities', async () => {
    const html=await readFile('src/reports/instagram.html','utf8');
    const token='ab'.repeat(24),url='https://www.instagram.com/p/Caption_Post/';
    const dom=new JSDOM(html,{url:'https://extension.test/reports/instagram.html#'+token,runScripts:'outside-only',pretendToBeVisual:true});
    const sent=[],reported=[];
    dom.window.chrome={runtime:{sendMessage:async message=>{sent.push(message);return {ok:true,url,parentOrigin:'https://www.peakbagger.com'};}}};
    Object.defineProperty(dom.window,'parent',{value:{postMessage:(...message)=>reported.push(message)}});
    try{
        await evalBundle(dom.window,'reports/instagram-frame.js');
        const frame=dom.window.document.getElementById('post');
        await waitFor(dom,()=>frame.hasAttribute('src'));
        assert.deepEqual(JSON.parse(JSON.stringify(sent)),[{type:'INSTAGRAM_FRAME_CLAIM',token}]);
        assert.equal(frame.src,url+'embed/captioned/');
        assert.equal(frame.getAttribute('sandbox'),'allow-scripts');
        assert.equal(frame.getAttribute('referrerpolicy'),'no-referrer');
        const measure=(source,origin,data)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source,origin,data}));
        measure(dom.window,'null',JSON.stringify({type:'MEASURE',details:{height:1500}}));
        measure(frame.contentWindow,'https://www.instagram.com',JSON.stringify({type:'MEASURE',details:{height:1500}}));
        measure(frame.contentWindow,'null','not JSON');
        measure(frame.contentWindow,'null',JSON.stringify({type:'MOUNTED',details:{styles:[['height','1500px']]}}));
        measure(frame.contentWindow,'null',JSON.stringify({type:'MEASURE',details:{height:640}}));
        measure(frame.contentWindow,'null',JSON.stringify({type:'MEASURE',details:{height:'900px'}}));
        frame.dispatchEvent(new dom.window.Event('load'));
        await waitFor(dom,()=>reported.length===1);
        assert.equal(frame.hidden,false);
        assert.deepEqual(JSON.parse(JSON.stringify(reported)),[[{__bpbInstagram:'loaded',height:640},'https://www.peakbagger.com']]);
        measure(frame.contentWindow,'null',JSON.stringify({type:'MEASURE',details:{height:1200}}));
        assert.equal(reported.length,1,'late provider resizing must not bounce the report');
    }finally{dom.window.close();}
});

test('completion accepts a post-load measurement and has a bounded fallback when none arrives',async()=>{
    const html=await readFile('src/reports/instagram.html','utf8');
    for(const measured of [true,false]){
        const dom=new JSDOM(html,{url:'https://extension.test/reports/instagram.html#'+'ab'.repeat(24),runScripts:'outside-only'});
        const reported=[],delays=accelerateTimeout(dom,1000);
        dom.window.chrome={runtime:{sendMessage:async()=>({ok:true,url:'https://www.instagram.com/p/Caption_Post/',parentOrigin:'https://www.peakbagger.com'})}};
        Object.defineProperty(dom.window,'parent',{value:{postMessage:(data)=>reported.push(data)}});
        try{
            await evalBundle(dom.window,'reports/instagram-frame.js');
            const frame=dom.window.document.getElementById('post');await waitFor(dom,()=>frame.hasAttribute('src'));
            frame.dispatchEvent(new dom.window.Event('load'));assert.equal(reported.length,0,'load alone waits for measurement or its deadline');
            if(measured)dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow,origin:'null',
                data:JSON.stringify({type:'MEASURE',details:{height:581.25}})}));
            await waitFor(dom,()=>reported.length===1);
            assert.deepEqual(JSON.parse(JSON.stringify(reported)),[{__bpbInstagram:'loaded',...(measured&&{height:582})}]);
            assert.deepEqual(delays,[1000],'the fallback is bounded to one second after provider load');
        }finally{dom.window.close();}
    }
});
