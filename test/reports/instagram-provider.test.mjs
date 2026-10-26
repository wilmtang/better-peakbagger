// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installInstagramDisplay } from '../../src/reports/instagram-provider.js';

function fixture(url='https://www.instagram.com/p/Fixture/embed/captioned/') {
    const dom=new JSDOM('<div class="Embed"><ul><li>Photo</li><li>Video</li></ul><button aria-label="Go back">Previous</button><button aria-label="Next">Next</button></div>',{url});
    const doc=dom.window.document,parent={postMessage(){}},origin='chrome-extension://fixture';
    Object.defineProperty(dom.window,'parent',{value:parent});
    const display=installInstagramDisplay(doc,origin);
    const configure=(data={},source=parent,senderOrigin=origin)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{
        source,origin:senderOrigin,data:{__bpbInstagramDisplay:true,enabled:true,theme:'dark',...data},
    }));
    return {dom,doc,configure,display,close:()=>{display?.dispose();dom.window.close();}};
}

test('only the actual extension parent can enable the theme; changes and revocation are reversible',()=>{
    const f=fixture();try{
        f.configure({},f.dom.window);f.configure({},undefined,'https://www.instagram.com');
        assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);
        f.configure({theme:'arbitrary-css'});assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);
        f.configure();assert.equal(f.doc.documentElement.dataset.bpbInstagramTheme,'dark');
        f.configure({theme:'light'});assert.equal(f.doc.documentElement.dataset.bpbInstagramTheme,'light');
        f.configure({enabled:false});assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);
        f.configure();f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));
        f.configure();assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);
    }finally{f.close();}
});

test('the theme helper never edits, intercepts or advances native carousel navigation',()=>{
    const f=fixture();try{
        const native=f.doc.querySelector('.Embed'),before=native.outerHTML;
        let next=0,back=0;native.querySelector('[aria-label="Next"]').onclick=()=>{next++;};
        native.querySelector('[aria-label="Go back"]').onclick=()=>{back++;};
        f.configure();native.querySelector('[aria-label="Next"]').click();
        f.configure({theme:'light'});native.querySelector('[aria-label="Go back"]').click();
        f.configure({enabled:false});assert.equal(native.outerHTML,before);
        assert.equal(next,1);assert.equal(back,1);
    }finally{f.close();}
});

test('non-captioned or non-Instagram documents cannot install the theme helper',()=>{
    for(const url of ['https://www.instagram.com/p/Fixture/','https://www.instagram.com/p/Fixture/embed/','https://other.test/p/Fixture/embed/captioned/']){
        const f=fixture(url);try{assert.equal(f.display,null);f.configure();assert.equal(f.doc.documentElement.hasAttribute('data-bpb-instagram-theme'),false);}finally{f.close();}
    }
});
