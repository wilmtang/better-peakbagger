// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { accelerateTimeout, evalBundle, waitFor } from '../helpers/load-page.mjs';

test('the isolated captioned player retains only Instagram’s origin and authenticates size messages', async () => {
    const html=await readFile('src/reports/instagram.html','utf8');
    const token='ab'.repeat(24),url='https://www.instagram.com/p/Caption_Post/';
    const dom=new JSDOM(html,{url:'https://extension.test/reports/instagram.html#'+token,runScripts:'outside-only',pretendToBeVisual:true});
    const sent=[],reported=[];
    dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    dom.window.chrome={runtime:{sendMessage:async message=>{sent.push(message);return {ok:true,url,parentOrigin:'https://www.peakbagger.com'};}}};
    Object.defineProperty(dom.window,'parent',{value:{postMessage:(...message)=>reported.push(message)}});
    try{
        await evalBundle(dom.window,'reports/instagram-frame.js');
        const frame=dom.window.document.getElementById('post');
        await waitFor(dom,()=>frame.hasAttribute('src'));
        assert.deepEqual(JSON.parse(JSON.stringify(sent)),[{type:'INSTAGRAM_FRAME_CLAIM',token}]);
        assert.equal(frame.src,url+'embed/captioned/');
        assert.equal(frame.getAttribute('sandbox'),'allow-scripts allow-same-origin');
        assert.match(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
            /frame-src https:\/\/www\.instagram\.com;/, 'the provider cannot navigate into the extension or Peakbagger origin');
        assert.equal(frame.getAttribute('referrerpolicy'),'no-referrer');
        const measure=(source,origin,data)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source,origin,data}));
        measure(dom.window,'https://www.instagram.com',JSON.stringify({type:'MEASURE',details:{height:1500}}));
        measure(frame.contentWindow,'null',JSON.stringify({type:'MEASURE',details:{height:1500}}));
        measure(frame.contentWindow,'https://evil.test',JSON.stringify({type:'MEASURE',details:{height:1500}}));
        measure(frame.contentWindow,'https://www.instagram.com','not JSON');
        measure(frame.contentWindow,'https://www.instagram.com',JSON.stringify({type:'MOUNTED',details:{styles:[['height','1500px']]}}));
        measure(frame.contentWindow,'https://www.instagram.com',JSON.stringify({type:'MEASURE',details:{height:640}}));
        measure(frame.contentWindow,'https://www.instagram.com',JSON.stringify({type:'MEASURE',details:{height:'900px'}}));
        frame.dispatchEvent(new dom.window.Event('load'));
        await waitFor(dom,()=>reported.length===1);
        assert.equal(frame.hidden,false);
        assert.deepEqual(JSON.parse(JSON.stringify(reported)),[[{__bpbInstagram:'loaded',height:640},'https://www.peakbagger.com']]);
        measure(frame.contentWindow,'https://www.instagram.com',JSON.stringify({type:'MEASURE',details:{height:1200}}));
        assert.equal(reported.length,1,'late provider resizing must not bounce the report');
    }finally{dom.window.close();}
});

test('completion accepts a post-load measurement and has a bounded fallback when none arrives',async()=>{
    const html=await readFile('src/reports/instagram.html','utf8');
    for(const measured of [true,false]){
        const dom=new JSDOM(html,{url:'https://extension.test/reports/instagram.html#'+'ab'.repeat(24),runScripts:'outside-only'});
        const reported=[],delays=accelerateTimeout(dom,1000);
        dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
        dom.window.chrome={runtime:{sendMessage:async()=>({ok:true,url:'https://www.instagram.com/p/Caption_Post/',parentOrigin:'https://www.peakbagger.com'})}};
        Object.defineProperty(dom.window,'parent',{value:{postMessage:(data)=>reported.push(data)}});
        try{
            await evalBundle(dom.window,'reports/instagram-frame.js');
            const frame=dom.window.document.getElementById('post');await waitFor(dom,()=>frame.hasAttribute('src'));
            frame.dispatchEvent(new dom.window.Event('load'));assert.equal(reported.length,0,'load alone waits for measurement or its deadline');
            if(measured)dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow,origin:'https://www.instagram.com',
                data:JSON.stringify({type:'MEASURE',details:{height:581.25}})}));
            await waitFor(dom,()=>reported.length===1);
            assert.deepEqual(JSON.parse(JSON.stringify(reported)),[{__bpbInstagram:'loaded',...(measured&&{height:582})}]);
            assert.deepEqual(delays,measured?[]:[1000],'only a missing measurement needs the bounded one-second fallback');
        }finally{dom.window.close();}
    }
});

test('the wrapper reads permission through the worker, follows stored theme, and discards stale or disposed configuration',async()=>{
    const dom=new JSDOM(await readFile('src/reports/instagram.html','utf8'),{url:'https://extension.test/reports/instagram.html#'+'ab'.repeat(24),runScripts:'outside-only',pretendToBeVisual:true});
    let theme='dark',allowed=true,hold=false,release;const changes=[],messages=[],runtimeListeners=[];
    dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    dom.window.chrome={storage:{sync:{get:async()=>({bpbSettings:{theme}})},local:{get:async()=>({})},onChanged:{addListener:fn=>changes.push(fn),removeListener(){}}},
        runtime:{id:'fixture',onMessage:{addListener:fn=>runtimeListeners.push(fn),removeListener:fn=>runtimeListeners.splice(runtimeListeners.indexOf(fn),1)},
            sendMessage:async message=>message.type==='INSTAGRAM_FRAME_CLAIM'?{ok:true,url:'https://www.instagram.com/p/Caption_Post/',parentOrigin:'https://www.peakbagger.com'}:
                hold?new Promise(resolve=>{release=resolve;}):{ok:true,allowed}}};
    try{
        await evalBundle(dom.window,'reports/instagram-frame.js');const frame=dom.window.document.getElementById('post');
        await waitFor(dom,()=>frame.hasAttribute('src'));
        frame.contentWindow.postMessage=data=>messages.push(JSON.parse(JSON.stringify(data)));
        const ready=source=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source,origin:'https://www.instagram.com',data:{__bpbInstagramProvider:'ready'}}));
        ready(dom.window);assert.equal(messages.length,0,'a different Instagram window cannot configure this player');
        ready(frame.contentWindow);await waitFor(dom,()=>messages.length>0);
        assert.deepEqual(messages.at(-1),{__bpbInstagramDisplay:true,enabled:true,theme:'dark'});
        theme='light';for(const fn of changes)fn({bpbSettings:{newValue:{theme}}},'sync');
        await waitFor(dom,()=>messages.at(-1).theme==='light');
        hold=true;ready(frame.contentWindow);await waitFor(dom,()=>!!release);const stale=release;hold=false;allowed=false;
        for(const fn of runtimeListeners)fn({type:'INSTAGRAM_DISPLAY_CHANGED'},{id:'other'});
        assert.equal(messages.at(-1).enabled,true);
        for(const fn of runtimeListeners)fn({type:'INSTAGRAM_DISPLAY_CHANGED'},{id:'fixture'});
        await waitFor(dom,()=>messages.at(-1).enabled===false);const count=messages.length;
        stale({ok:true,allowed:true});await Promise.resolve();await Promise.resolve();assert.equal(messages.length,count);
        hold=true;ready(frame.contentWindow);await waitFor(dom,()=>release!==stale);
        dom.window.dispatchEvent(new dom.window.Event('pagehide'));release({ok:true,allowed:true});
        await Promise.resolve();await Promise.resolve();assert.equal(messages.length,count);assert.equal(runtimeListeners.length,0);
    }finally{dom.window.close();}
});
