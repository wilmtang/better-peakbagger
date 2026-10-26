// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { canonicalInstagramUrl, instagramPasteUrl, instagramBlocks, instagramParagraphUrl } from '../../src/reports/instagram-url.js';
const URL='https://www.instagram.com/p/fA9uwTtkSN/';
test('Instagram identity accepts only canonical HTTPS post/reel paths and strips tracking',()=>{
    assert.equal(canonicalInstagramUrl(' https://instagram.com/p/fA9uwTtkSN/?utm_source=ig_web_copy_link#tracking '),URL);
    assert.equal(canonicalInstagramUrl('https://www.instagram.com:443/reel/a_B-123'),'https://www.instagram.com/reel/a_B-123/');
    for(const raw of ['http://instagram.com/p/a/','https://evil.instagram.com/p/a/','https://www.instagram.com.evil.test/p/a/',
        'https://instagram.com@evil.test/p/a/','https://x@instagram.com/p/a/','https://instagram.com:444/p/a/',
        'https://instagram.com/p/a/extra','https://instagram.com/p/a%2fb/','https://instagram.com/p/../p/a/',
        'https://instagram.com/p/%2e%2e/p/a/','https://instagram.com/stories/a/','https://instagram.com/share/a/',
        'https://instagram.com/p/a/\\evil','https://instagram.com/p/'+ 'a'.repeat(65)+'/']) assert.equal(canonicalInstagramUrl(raw),null,raw);
});
test('embed paste extracts a single permalink without admitting scripts or conflicting posts',()=>{
    const snippet=`<blockquote class="instagram-media" data-instgrm-permalink="${URL}?utm_source=embed" style="width: 100%"><div><a href="${URL}">View this post</a><svg><path d="x > y" /></svg></div></blockquote><script async src="https://evil.test/run.js">run()</script>`;
    assert.equal(instagramPasteUrl(snippet),URL);
    assert.equal(instagramPasteUrl(snippet.replace('View this post','<a href="https://www.instagram.com/p/other/">Other</a>')),null);
    assert.equal(instagramPasteUrl(snippet+'keep this prose'),null);
    assert.equal(instagramPasteUrl(`<blockquote class="instagram-media" data-instgrm-permalink="${URL}"></blockquote`),null);
    assert.equal(instagramPasteUrl(`<blockquote class="instagram-media" data-instgrm-permalink="${URL}" data-instgrm-permalink="${URL}"></blockquote>`),null);
    assert.equal(instagramPasteUrl('<script>run()</script>'),null);
    assert.equal(instagramPasteUrl('x'.repeat(65537)),null);
});
test('only standalone post lines become blocks; inline and labelled links remain prose',()=>{
    const link={t:'a',href:URL,kids:[{t:'text',text:URL}]};
    assert.deepEqual(instagramBlocks([{type:'p',kids:[{t:'text',text:'Before'},{t:'br'},link,{t:'br'},{t:'text',text:'After'}]}]),[
        {type:'p',kids:[{t:'text',text:'Before'}]},{type:'instagram',url:URL},{type:'p',kids:[{t:'text',text:'After'}]},
    ]);
    const inline={type:'p',kids:[{t:'text',text:'See '},link]};assert.deepEqual(instagramBlocks([inline]),[inline]);
    const labelled={type:'p',kids:[{...link,kids:[{t:'text',text:'my photo'}]}]};assert.deepEqual(instagramBlocks([labelled]),[labelled]);
    const code={type:'pre',text:URL};assert.deepEqual(instagramBlocks([code]),[code]);
});
test('standalone saved-post links recognize Peakbagger hostname labels through the shared identity rule',()=>{
    for(const label of ['instagram.com','www.instagram.com','WWW.Instagram.Com']){
        const href=URL+'?igshid=fixture';
        const dom=new JSDOM(`<p><a href="${href}">${label}</a></p>`);
        try{assert.equal(instagramParagraphUrl(dom.window.document.querySelector('p')),URL,label);}
        finally{dom.window.close();}
        assert.deepEqual(instagramBlocks([{type:'p',kids:[{t:'a',href,kids:[{t:'text',text:label}]}]}]),[{type:'instagram',url:URL}],label);
    }
    for(const [href,label]of [[URL,'Instagram post'],[URL,'my photo'],['https://evil.test/p/x','www.instagram.com'],
        [URL,'www.instagram.com.evil.test'],[URL,'https://www.instagram.com/p/other/']]){
        const dom=new JSDOM(`<p><a href="${href}">${label}</a></p>`);
        try{assert.equal(instagramParagraphUrl(dom.window.document.querySelector('p')),null,`${href}/${label}`);}
        finally{dom.window.close();}
    }
});
