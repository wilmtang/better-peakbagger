// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The report reader against hostile and native report markup, in a real page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { evalBundle } from '../helpers/fixture-page.mts';

test('reader rebuilds hostile report DOM even when it contains controls and preserves native headings/prose', async () => {
    const html = (await readFile('test/fixtures/pages/ascent-ignored-report.html','utf8')).replace('Synthetic report text',
        '<script>run()</script><form><input id="QuickSearchTB"></form><svg onload="run()"></svg><span id="Form1" onclick="run()">Safe prose</span>');
    const dom = new FixtureDom(html, {url:'https://www.peakbagger.com/climber/ascent.aspx?aid=1' });
    try {
        await evalBundle(dom.window, 'content/report-protection.js');
        const cell = dom.window.document.querySelector('[data-bpb-report-protected]');
        assert(cell); assert.match(cell.textContent, /Safe prose/);
        assert.equal(cell.querySelector('h2')!.textContent,'Ascent Trip Report');
        assert.equal(cell.querySelector('script,form,input,svg,[onclick],[onload],[id],iframe'),null);
        assert.match(cell.querySelector('.bpb-rs-title')!.textContent,/3 scripts blocked/);
        assert(cell.querySelector('figure figcaption'));
        assert(dom.window.document.getElementById('Gmap'), 'native map remains outside the report');
    } finally {dom.window.close();}
});

test('native saved-report hostname links become post blocks while the external-report field remains a link',async()=>{
    const url='https://www.instagram.com/p/Native_Post/';
    const html='<table class="gray"><tr><td colspan="2"><h2>Ascent Trip Report</h2>'
        + `<b>URL Link: </b><a href="${url}?igshid=fixture">instagram.com</a><br><br>`
        + `Before the post<br><br><a href="${url}?igshid=fixture">www.instagram.com</a><br><br>After the post</td></tr></table>`;
    const dom=new FixtureDom(html,{url:'https://www.peakbagger.com/climber/ascent.aspx?aid=1'});
    try{
        await evalBundle(dom.window,'content/report-protection.js');
        const cell=dom.window.document.querySelector('[data-bpb-report-protected]'); assert(cell);
        const post=[...cell.querySelectorAll('p')].find(p=>p.textContent===url);
        assert(post,'the standalone hostname link must produce a recognizable canonical post paragraph');
        assert.equal(post.querySelector('a')!.href,url);
        assert.match(cell.textContent,/URL Link: instagram\.com/);
        assert.match(cell.textContent,/Before the post/);assert.match(cell.textContent,/After the post/);
    }finally{dom.window.close();}
});
