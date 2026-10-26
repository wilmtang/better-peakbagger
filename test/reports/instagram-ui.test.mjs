// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createInstagramPresentation} from '../../src/reports/instagram-ui.js';
import {fireTrustedEvent,waitFor} from '../helpers/load-page.mjs';
const URL='https://www.instagram.com/p/fA9uwTtkSN/';
function setup({issue,automatic=false,timeoutMs=1000}={}){
    const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://www.peakbagger.com/climber/ascent.aspx?aid=1',pretendToBeVisual:true});
    const doc=dom.window.document,sent=[],listeners=new Set();let changed;
    Object.defineProperty(dom.window.HTMLElement.prototype,'clientWidth',{get:()=>500});
    dom.window.HTMLElement.prototype.getClientRects=function(){return [{width:500,height:100}];};
    const ext={runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path,onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},sendMessage:async message=>{
        sent.push(message);if(message.type==='TRUSTED_ACTION_ISSUE')return {ok:true,token:'activation'};
        return issue?issue(message):{ok:true,token:'ab'.repeat(24)};
    }}};
    const ui=createInstagramPresentation({doc,ext,timeoutMs,preferences:{requireCurrent:async()=>({loadInstagramAutomatically:automatic}),subscribe:fn=>{changed=fn;return ()=>{};}}});
    const root=doc.getElementById('root'),card=ui.create(URL);root.append(card.element);
    return {dom,doc,ui,root,card,sent,changed:value=>changed({loadInstagramAutomatically:value}),listeners,
        loaded:height=>{const frame=card.element.querySelector('iframe');dom.window.dispatchEvent(new dom.window.MessageEvent('message',{origin:'chrome-extension://fixture',source:frame.contentWindow,data:{__bpbInstagram:'loaded',height}}));},
        close:()=>{ui.destroy();dom.window.close();}};
}
test('blocked posts make no runtime or frame request; synthetic clicks cannot start loading',async()=>{
    const s=setup();try{await new Promise(resolve=>setTimeout(resolve,0));s.card.element.querySelector('button').click();
        assert.equal(s.sent.length,0);assert.equal(s.card.element.querySelector('iframe'),null);
        assert.equal(s.card.element.querySelector('a').href,URL);
    }finally{s.close();}
});
test('a completed player adopts one bounded height and hide clears its media footprint',async()=>{
    const s=setup();try{
        const button=s.card.element.querySelector('button'),media=s.card.element.querySelector('.bpb-instagram-media');
        fireTrustedEvent(button,'click');await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));
        s.loaded(1000000);assert.equal(media.style.height,'1600px');
        s.loaded(400);assert.equal(media.style.height,'1600px','later messages must not resize a loaded post');
        fireTrustedEvent(button,'click');assert.equal(media.style.height,'');assert(media.hidden);
        fireTrustedEvent(button,'click');await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));
        s.loaded('900px');assert.equal(media.style.height,'','CSS strings cannot influence layout');
    }finally{s.close();}
});
test('trusted loading, ready, hide and current preference changes retain the action node',async()=>{
    const s=setup();try{const button=s.card.element.querySelector('button');fireTrustedEvent(button,'click');
        await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));s.loaded();
        assert.equal(s.card.element.dataset.state,'loaded');assert.equal(s.card.element.querySelector('button'),button);
        s.changed(true);await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));s.loaded();
        s.changed(false);assert.equal(s.card.element.querySelector('iframe'),null);assert.equal(s.card.element.dataset.state,'idle');
        fireTrustedEvent(button,'click');await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));s.loaded();
        fireTrustedEvent(button,'click');assert.equal(s.card.element.querySelector('iframe'),null);assert.equal(s.card.element.querySelector('button'),button);
    }finally{s.close();}
});
test('cancelling and destroying a pending grant prevent late frames from appearing',async()=>{
    for(const destroy of [false,true]){let release;const s=setup({issue:()=>new Promise(resolve=>{release=resolve;})});
        try{const button=s.card.element.querySelector('button');fireTrustedEvent(button,'click');await waitFor(s.dom,()=>release);
            if(destroy)s.card.destroy();else fireTrustedEvent(button,'click');release({ok:true,token:'ab'.repeat(24)});
            await new Promise(resolve=>setTimeout(resolve,0));assert.equal(s.card.element.querySelector('iframe'),null);
        }finally{s.close();}}
});
test('cancellation revokes the private source nonce before a renderer can claim its grant',async()=>{
    const s=setup();try{
        const button=s.card.element.querySelector('button');fireTrustedEvent(button,'click');
        await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));
        const sourceNonce=s.sent.find(m=>m.type==='INSTAGRAM_FRAME_ISSUE').sourceNonce;
        const check=()=>{let answer;for(const listener of s.listeners)listener({type:'INSTAGRAM_FRAME_SOURCE_CURRENT',nonce:sourceNonce},{id:'fixture'},r=>{answer=r;});return answer;};
        assert.equal(check().ok,true);fireTrustedEvent(button,'click');assert.equal(check().ok,false);
        fireTrustedEvent(button,'click');await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));assert.equal(check().ok,false,'old load became current again');
    }finally{s.close();}
});
test('preview reconciliation retains the loaded post and removes deleted instances',async()=>{
    const s=setup();try{
        const make=prose=>new JSDOM(`<p>${prose}</p><p><a href="${URL}">${URL}</a></p><p>After</p>`).window.document.body.childNodes;
        s.card.destroy();s.root.replaceChildren();s.ui.render(s.root,make('Before'));
        const box=s.root.querySelector('.bpb-instagram'),button=box.querySelector('button');fireTrustedEvent(button,'click');
        await waitFor(s.dom,()=>box.querySelector('iframe'));const frame=box.querySelector('iframe');
        s.ui.render(s.root,make('Changed prose'));assert.equal(s.root.querySelector('.bpb-instagram'),box);assert.equal(box.querySelector('iframe'),frame);
        assert.equal(s.sent.filter(m=>m.type==='INSTAGRAM_FRAME_ISSUE').length,1);
        s.ui.render(s.root,[]);assert.equal(s.root.querySelector('iframe'),null);
    }finally{s.close();}
});
test('failure stays actionable without an empty player and rejects spoofed ready messages',async()=>{
    const s=setup({timeoutMs:30});try{
        const button=s.card.element.querySelector('button');fireTrustedEvent(button,'click');await waitFor(s.dom,()=>s.card.element.querySelector('iframe'));
        s.dom.window.dispatchEvent(new s.dom.window.MessageEvent('message',{origin:'https://evil.test',data:{__bpbInstagram:'loaded'}}));
        assert.equal(s.card.element.dataset.state,'pending');await waitFor(s.dom,()=>s.card.element.dataset.state==='error');
        assert.equal(s.card.element.querySelector('iframe'),null);assert.match(button.textContent,/Retry/);assert(s.card.element.querySelector('.bpb-instagram-media').hidden);
    }finally{s.close();}
});
