// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import rules from '../../src/reports/report-protection.json' with { type: 'json' };
import { peakbaggerCloudflare as Cloudflare } from '../../src/peakbagger/peakbagger-cloudflare.js';
import { createFirefoxManifest } from '../../scripts/build-firefox-package.mjs';
import { REPORT_CSP, protectedReportDocument, protectReportHeaders } from '../../src/reports/report-security-policy.js';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { evalBundle } from '../helpers/load-page.mjs';

test('report response policy covers route variants and nested documents without weakening site CSP', () => {
    for (const path of ['/climber/ascent.aspx?aid=1', '/climber/AsCeNt.aspx', '//climber//ascent.aspx/extra', '/climber/%61scent.aspx']) {
        assert(protectedReportDocument('https://www.peakbagger.com'+path), path);
    }
    assert(!protectedReportDocument('https://www.peakbagger.com/climber/ascentedit.aspx'));
    assert(!protectedReportDocument('https://www.peakbagger.com/report/report.aspx?r=b'), 'native report lists are not trip report documents');
    assert(!protectedReportDocument('http://www.peakbagger.com/climber/ascent.aspx'));
    assert(!protectedReportDocument('https://www.peakbagger.com.evil.test/climber/ascent.aspx'));
    assert(!protectedReportDocument('https://www.peakbagger.com/map/MasterMap.aspx', 'sub_frame'));
    assert(protectedReportDocument('https://www.peakbagger.com/climber/climber.aspx', 'sub_frame'));
    const existing = { name: 'Content-Security-Policy', value: "img-src 'none'" };
    assert.deepEqual(protectReportHeaders({ url: 'https://www.peakbagger.com/climber/ascent.aspx', type:'main_frame', responseHeaders: [existing] }),
        { responseHeaders: [existing, { name:'Content-Security-Policy', value:REPORT_CSP }] });
    assert.deepEqual(protectReportHeaders({ url:'https://www.peakbagger.com/climber/ascent.aspx', type:'main_frame',
        responseHeaders:[{name:'CF-Mitigated',value:'challenge'}] }), {});
    assert.match(REPORT_CSP, /script-src 'none'/); assert.doesNotMatch(REPORT_CSP, /unsafe-inline|unsafe-eval/);
});

test('reader rebuilds hostile report DOM even when it contains controls and preserves native headings/prose', async () => {
    const html = (await readFile('test/fixtures/pages/ascent-ignored-report.html','utf8')).replace('Synthetic report text',
        '<script>run()</script><form><input id="QuickSearchTB"></form><svg onload="run()"></svg><span id="Form1" onclick="run()">Safe prose</span>');
    const dom = new JSDOM(html, {url:'https://www.peakbagger.com/climber/ascent.aspx?aid=1', runScripts:'outside-only'});
    try {
        await evalBundle(dom.window, 'content/report-protection.js');
        const cell = dom.window.document.querySelector('[data-bpb-report-protected]');
        assert(cell); assert.match(cell.textContent, /Safe prose/);
        assert.equal(cell.querySelector('h2').textContent,'Ascent Trip Report');
        assert.equal(cell.querySelector('script,form,input,svg,[onclick],[onload],[id],iframe'),null);
        assert(cell.querySelector('figure figcaption'));
        assert(dom.window.document.getElementById('Gmap'), 'native map remains outside the report');
    } finally {dom.window.close();}
});

test('native saved-report hostname links become post blocks while the external-report field remains a link',async()=>{
    const url='https://www.instagram.com/p/Native_Post/';
    const html='<table class="gray"><tr><td colspan="2"><h2>Ascent Trip Report</h2>'
        + `<b>URL Link: </b><a href="${url}?igshid=fixture">instagram.com</a><br><br>`
        + `Before the post<br><br><a href="${url}?igshid=fixture">www.instagram.com</a><br><br>After the post</td></tr></table>`;
    const dom=new JSDOM(html,{url:'https://www.peakbagger.com/climber/ascent.aspx?aid=1',runScripts:'outside-only'});
    try{
        await evalBundle(dom.window,'content/report-protection.js');
        const cell=dom.window.document.querySelector('[data-bpb-report-protected]');
        const post=[...cell.querySelectorAll('p')].find(p=>p.textContent===url);
        assert(post,'the standalone hostname link must produce a recognizable canonical post paragraph');
        assert.equal(post.querySelector('a').href,url);
        assert.match(cell.textContent,/URL Link: instagram\.com/);
        assert.match(cell.textContent,/Before the post/);assert.match(cell.textContent,/After the post/);
    }finally{dom.window.close();}
});

test('packaged rules and Firefox transport retain one challenge marker and policy', async () => {
    for (const rule of rules.filter(rule => rule.action.type === 'modifyHeaders')) {
        assert.deepEqual(rule.condition.excludedResponseHeaders, [{header:Cloudflare.CHALLENGE_HEADER,values:[Cloudflare.CHALLENGE_VALUE]}]);
        assert.equal(rule.action.responseHeaders[0].value, REPORT_CSP);
    }
    const source=JSON.parse(await readFile('manifest.json','utf8'));const firefox=createFirefoxManifest(source);
    assert(source.declarative_net_request.rule_resources.some(rule=>rule.id==='report-protection'&&rule.enabled));
    assert(!firefox.declarative_net_request.rule_resources.some(rule=>rule.id==='report-protection'));
    assert(firefox.declarative_net_request.rule_resources.some(rule=>rule.id==='report-media'&&rule.enabled));
    assert(firefox.permissions.includes('webRequestBlocking'));
    assert(!source.permissions.includes('webRequestBlocking'));
});
