// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readInstagramCarousel, installInstagramDisplay } from '../../src/reports/instagram-provider.js';
import { waitFor } from '../helpers/load-page.mjs';

function fixture(count=10,direction=1) {
    const dom=new JSDOM('<div class="Embed"><ul></ul><button aria-label="Go back">Previous</button><button aria-label="Next">Next</button></div>',
        {url:'https://www.instagram.com/p/Fixture/embed/captioned/',pretendToBeVisual:true});
    const doc=dom.window.document,parent={postMessage(){}},origin='chrome-extension://fixture';
    Object.defineProperty(dom.window,'parent',{value:parent});
    Object.defineProperty(doc.documentElement,'clientWidth',{value:400,configurable:true});
    let index=0,nextClicks=0,backClicks=0;
    const list=doc.querySelector('ul');
    for(let i=0;i<count;i++){
        const item=doc.createElement('li');
        // Virtualized slots are deliberately empty, including the valid last
        // image/video. Limits must come from the slots, never their contents.
        // Firefox aligns empty virtual slots on a different vertical baseline.
        item.getBoundingClientRect=()=>({x:(i-index)*400*direction,y:i===index?54:318,width:400,height:i===index?400:0});list.append(item);
    }
    const next=doc.querySelector('[aria-label="Next"]'),back=doc.querySelector('[aria-label="Go back"]');
    next.onclick=()=>{nextClicks++;index++;list.style.transform=`translateX(${-index*400}px)`;};
    back.onclick=()=>{backClicks++;index--;list.style.transform=`translateX(${-index*400}px)`;};
    const display=installInstagramDisplay(doc,origin);
    const configure=(data={},source=parent,senderOrigin=origin)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{
        source,origin:senderOrigin,data:{__bpbInstagramDisplay:true,enabled:true,theme:'dark',...data},
    }));
    return {dom,doc,list,next,back,configure,display,setIndex:(value,mutate=true)=>{index=value;if(mutate)list.style.transform=`translateX(${-index*400}px)`;},
        state:()=>({index,nextClicks,backClicks}),close:()=>{display?.dispose();dom.window.close();}};
}

test('only the actual extension parent can enable display changes; theme changes and revocation are reversible',async()=>{
    const f=fixture();try{
        f.configure({},f.dom.window);f.configure({},undefined,'https://www.instagram.com');
        assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);
        f.configure({theme:'arbitrary-css'});assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);
        f.configure();assert.equal(f.doc.documentElement.dataset.bpbInstagramTheme,'dark');
        f.configure({theme:'light'});assert.equal(f.doc.documentElement.dataset.bpbInstagramTheme,'light');
        f.setIndex(9);await waitFor(f.dom,()=>f.next.hasAttribute('data-bpb-instagram-end'));
        f.configure({enabled:false});assert.equal(f.next.hasAttribute('data-bpb-instagram-end'),false);
        assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);
        f.next.click();assert.equal(f.state().nextClicks,1,'revocation restores the native control');
    }finally{f.close();}
});

test('viewport-unit slides retain their boundary with a scrollbar and after a CSS transition ends',async()=>{
    const f=fixture();try{
        Object.defineProperty(f.doc.documentElement,'clientWidth',{value:385});
        Object.defineProperty(f.dom.window,'innerWidth',{value:400});
        f.setIndex(8.5);f.configure();
        await new Promise(resolve=>f.dom.window.requestAnimationFrame(resolve));
        assert.equal(f.next.hasAttribute('data-bpb-instagram-end'),false);
        f.setIndex(9,false);f.list.dispatchEvent(new f.dom.window.Event('transitionend',{bubbles:true}));
        await waitFor(f.dom,()=>f.next.hasAttribute('data-bpb-instagram-end'));
        f.next.click();assert.equal(f.state().index,9);
    }finally{f.close();}
});

test('carousel boundaries use all native slots, including sparse 20-item posts, and guard repeated last activation',async()=>{
    for(const count of [2,10,20]){
        const f=fixture(count);try{
            f.configure();
            for(let index=0;index<count-1;index++){f.next.click();assert.equal(f.state().index,index+1);}
            f.next.click();f.next.click();assert.equal(f.state().index,count-1);
            assert.equal(f.state().nextClicks,count-1,'the terminal Next must not create an empty extra page');
            f.back.click();assert.equal(f.state().index,count-2);
            f.next.click();assert.equal(f.state().index,count-1,'the valid last media item remains reachable');
        }finally{f.close();}
    }
});

test('a recognized overflow recovers once; transitions and unknown layouts keep native behavior',async()=>{
    const f=fixture();try{
        f.setIndex(10);f.configure();await waitFor(f.dom,()=>f.state().index===9);
        assert.equal(f.state().backClicks,1);
        f.setIndex(8.5);assert.equal(readInstagramCarousel(f.doc),null,'partial transitions are not terminal states');
        const extra=f.doc.createElement('ul');extra.innerHTML='<li></li><li></li>';f.doc.querySelector('.Embed').append(extra);
        for(const [i,item]of [...extra.children].entries())item.getBoundingClientRect=()=>({x:i*400,y:54,width:400,height:400});
        f.setIndex(0);assert.equal(readInstagramCarousel(f.doc),null,'ambiguous galleries are not modified');
        await waitFor(f.dom,()=>!f.next.hasAttribute('data-bpb-instagram-end'));
        f.next.click();assert.equal(f.state().nextClicks,1);
    }finally{f.close();}
});

test('localized native direction controls and right-to-left slot geometry retain every item',async()=>{
    const f=fixture(3,-1);try{
        f.next.setAttribute('aria-label','Suivant');f.next.className='_afxw';
        f.back.setAttribute('aria-label','Précédent');f.back.className='_afxv';
        f.configure();f.next.click();f.next.click();f.next.click();
        assert.equal(f.state().index,2);assert.equal(f.state().nextClicks,2);
        f.back.click();assert.equal(f.state().index,1);
    }finally{f.close();}
});
