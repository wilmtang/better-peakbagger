// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildReportProtection, REPORT_PARTITIONS, MAP_PARTITIONS } from '../../scripts/generate-report-protection.mts';

test('packaged report policy is generated from its readable contract', async () => {
    assert.equal(await readFile('src/reports/report-protection.json', 'utf8'), JSON.stringify(buildReportProtection(), null, 2) + '\n');
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8')) as { declarative_net_request: { rule_resources: { path: string }[] } };
    let count = 0;
    for (const entry of manifest.declarative_net_request.rule_resources) {
        const file = entry.path.replace(/^rules\//, 'src/reports/');
        count += (JSON.parse(await readFile(file, 'utf8')) as { condition: { regexFilter?: string } }[]).filter(rule => rule.condition.regexFilter).length;
    }
    assert.ok(count > 0 && count < 900, `static regex budget: ${count}`);
});

test('filename partitions are complete and disjoint for every encoding mask', () => {
    for (const [word, partitions] of [['ascent.aspx', REPORT_PARTITIONS], ['MasterMap.aspx', MAP_PARTITIONS]] as const) {
        for (let mask = 0; mask < 2 ** word.length; mask++) {
            const bits = mask.toString(2).padStart(word.length, '0');
            assert.equal(partitions.filter(prefix => bits.startsWith(prefix)).length, 1, word + ' ' + bits);
        }
    }
});

test('label-count matching and domain conditions jointly retain exact hosts', () => {
    const rules = buildReportProtection();
    for (const rule of rules) assert.deepEqual(rule.condition.requestDomains, ['peakbagger.com']);
    for (const host of ['foo.peakbagger.com', 'www.foo.peakbagger.com', 'www.peakbagger.com.evil.test']) {
        const url = `https://${host}/climber/ascent.aspx`;
        assert.ok(rules.every(rule => !new RegExp(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive ? '' : 'i').test(url)), host);
    }
    // The compact hostname shape is intentionally not a suffix check by itself.
    // The mandatory requestDomains condition excludes unrelated two-label hosts.
    assert.equal(new URL('https://evil.test/climber/ascent.aspx').hostname.endsWith('.peakbagger.com'), false);
});
