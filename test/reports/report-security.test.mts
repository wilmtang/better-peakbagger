// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import rules from '../../src/reports/report-protection.json' with { type: 'json' };
import { peakbaggerCloudflare as Cloudflare } from '../../src/peakbagger/peakbagger-cloudflare.ts';
import { createFirefoxManifest } from '../../scripts/build-firefox-package.mts';
import { REPORT_CSP, protectedReportDocument, protectReportHeaders } from '../../src/reports/report-security-policy.ts';
import { readFile } from 'node:fs/promises';

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

test('packaged rules and Firefox transport retain one challenge marker and policy', async () => {
    for (const rule of rules.filter(candidate => candidate.action.type === 'modifyHeaders')) {
        assert.deepEqual(rule.condition.excludedResponseHeaders, [{header:Cloudflare.CHALLENGE_HEADER,values:[Cloudflare.CHALLENGE_VALUE]}]);
        assert.equal(rule.action.responseHeaders![0].value, REPORT_CSP);
    }
    type Manifest = { permissions:string[]; declarative_net_request:{rule_resources:{id:string;enabled:boolean}[]} };
    const source=JSON.parse(await readFile('manifest.json','utf8')) as Manifest;const firefox=createFirefoxManifest(source) as Manifest;
    assert(source.declarative_net_request.rule_resources.some(rule=>rule.id==='report-protection'&&rule.enabled));
    assert(!firefox.declarative_net_request.rule_resources.some(rule=>rule.id==='report-protection'));
    assert(firefox.declarative_net_request.rule_resources.some(rule=>rule.id==='report-media'&&rule.enabled));
    assert(firefox.permissions.includes('webRequestBlocking'));
    assert(!source.permissions.includes('webRequestBlocking'));
});
