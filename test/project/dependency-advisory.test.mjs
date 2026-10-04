// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateAudit } from '../../scripts/check-npm-audit.mjs';

const baseline = {
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 3, critical: 0, total: 3 } },
    vulnerabilities: {
        '@devicefarmer/adbkit': {
            name: '@devicefarmer/adbkit', severity: 'high', isDirect: false,
            via: ['node-forge'], effects: ['web-ext'], nodes: ['node_modules/@devicefarmer/adbkit'],
        },
        'node-forge': {
            name: 'node-forge', severity: 'high', isDirect: false,
            via: [{ source: 1240912, name: 'node-forge', dependency: 'node-forge',
                url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
                severity: 'high', range: '<=1.4.0' }],
            effects: ['@devicefarmer/adbkit'], nodes: ['node_modules/node-forge'],
        },
        'web-ext': {
            name: 'web-ext', severity: 'high', isDirect: true,
            via: ['@devicefarmer/adbkit'], effects: [], nodes: ['node_modules/web-ext'],
        },
    },
};
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
const options = () => ({ allowReviewedDevelopmentAdvisory: true,
    lockfile: structuredClone(lock), now: Date.parse('2026-10-04T00:00:00Z') });

test('only ordinary CI opts into the reviewed advisory; default and release audits stay strict', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['audit:ci'], 'node scripts/check-npm-audit.mjs');
    const ci = await readFile(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
    assert.match(ci, /run: npm run audit:ci -- --allow-reviewed-development-advisory/);
    for (const file of ['release.yml', 'retry-firefox-release.yml']) {
        const workflow = await readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
        assert.doesNotMatch(workflow, /allow-reviewed-development-advisory/, file);
    }
});

test('strict default rejects the advisory and explicit review accepts only the recorded development path', () => {
    assert.throws(() => evaluateAudit(baseline), /Unowned/);
    assert.equal(evaluateAudit(baseline, options()).status, 'accepted-development-advisory');
});

test('clean output remains clean with or without the review option', () => {
    const clean = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
    assert.deepEqual(evaluateAudit(clean), { status: 'clean' });
    assert.deepEqual(evaluateAudit(clean, options()), { status: 'clean' });
});

test('the exception expires exactly at midnight October 17 in Los Angeles', () => {
    for (const now of [Date.parse('2026-10-17T07:00:00Z'), NaN, Infinity]) {
        assert.throws(() => evaluateAudit(baseline, { ...options(), now }), /Unowned/);
    }
});

for (const [label, mutate] of [
    ['new advisory', a => a.vulnerabilities['node-forge'].via.push({ source: 99 })],
    ['different identity', a => a.vulnerabilities['node-forge'].via[0].source++],
    ['different severity', a => a.vulnerabilities['node-forge'].severity = 'critical'],
    ['different location', a => a.vulnerabilities['node-forge'].nodes.push('node_modules/other/node_modules/node-forge')],
    ['different parent', a => a.vulnerabilities['@devicefarmer/adbkit'].via.push('other')],
    ['different effects', a => a.vulnerabilities['node-forge'].effects.push('other')],
    ['extra package', a => a.vulnerabilities.other = {}],
    ['inconsistent counts', a => a.metadata.vulnerabilities.total++],
]) {
    test(`review still rejects ${label}`, () => {
        const audit = structuredClone(baseline);
        mutate(audit);
        assert.throws(() => evaluateAudit(audit, options()), /Unowned/);
    });
}

for (const name of ['web-ext', '@devicefarmer/adbkit', 'node-forge']) {
    test(`review rejects changed or production ${name} resolutions`, () => {
        for (const [key, value] of [['dev', false], ['version', '99.0.0']]) {
            const opts = options();
            opts.lockfile.packages[`node_modules/${name}`][key] = value;
            assert.throws(() => evaluateAudit(baseline, opts), /Unowned/);
        }
    });
}

test('review rejects duplicated or rerouted dependency edges', () => {
    const duplicate = options();
    duplicate.lockfile.packages['node_modules/other/node_modules/node-forge'] = { version: '1.4.0', dev: true };
    assert.throws(() => evaluateAudit(baseline, duplicate), /Unowned/);
    const rerouted = options();
    rerouted.lockfile.packages['node_modules/web-ext'].dependencies['@devicefarmer/adbkit'] = '4.0.0';
    assert.throws(() => evaluateAudit(baseline, rerouted), /Unowned/);
});
