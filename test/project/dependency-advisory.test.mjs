// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import yaml from 'js-yaml';
import { evaluateAudit } from '../../scripts/check-npm-audit.mjs';

const baseline = {
    metadata: { vulnerabilities: { info: 0, low: 3, moderate: 0, high: 0, critical: 0, total: 3 } },
    vulnerabilities: {
        'addons-linter': {
            name: 'addons-linter', severity: 'low', isDirect: false,
            via: ['deepmerge'], effects: ['web-ext'], nodes: ['node_modules/addons-linter'],
        },
        'deepmerge': {
            name: 'deepmerge', severity: 'low', isDirect: false,
            via: [{ source: 1243505, name: 'deepmerge', dependency: 'deepmerge',
                url: 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4',
                severity: 'low', range: '>=4.2.0 <=4.3.1' }],
            effects: ['addons-linter'], nodes: ['node_modules/deepmerge'],
        },
        'web-ext': {
            name: 'web-ext', severity: 'low', isDirect: true,
            via: ['addons-linter'], effects: [], nodes: ['node_modules/web-ext'],
        },
    },
};
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
const options = () => ({ allowReviewedDevelopmentAdvisory: true,
    lockfile: structuredClone(lock), now: Date.parse('2026-10-28T00:00:00Z') });

test('ordinary CI and releases opt into the reviewed advisory; the default stays strict', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['audit:ci'], 'node scripts/check-npm-audit.mjs');
    const ci = await readFile(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
    assert.match(ci, /run: npm run audit:ci -- --allow-reviewed-development-advisory/);
    const release = yaml.load(await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
    const auditStep = release.jobs.verify.steps.find(step => step.name === 'Check dependency advisories');
    assert.equal(auditStep.run, 'npm run audit:ci -- --allow-reviewed-development-advisory');
    assert.equal(auditStep.env, undefined);
    const recovery = await readFile(new URL('../../.github/workflows/retry-firefox-release.yml', import.meta.url), 'utf8');
    assert.doesNotMatch(recovery, /allow-reviewed-development-advisory/);
});

test('strict default rejects the advisory and explicit review accepts only the recorded development path', () => {
    assert.throws(() => evaluateAudit(baseline), /Unowned/);
    assert.equal(evaluateAudit(baseline, options()).status, 'accepted-development-advisory');
});

test('the review is pinned to the installed tool versions', () => {
    for (const version of ['10.7.0', '10.8.1', '10.99.0', '11.0.0', '10.8.0-beta.1', 'invalid']) {
        const opts = options();
        opts.lockfile.packages['node_modules/web-ext'].version = version;
        assert.throws(() => evaluateAudit(baseline, opts), /Unowned/);
    }
});

test('clean output remains clean with or without the review option', () => {
    const clean = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
    assert.deepEqual(evaluateAudit(clean), { status: 'clean' });
    assert.deepEqual(evaluateAudit(clean, options()), { status: 'clean' });
});

test('the low-severity development exception expires after October 30 in Los Angeles', () => {
    for (const now of [Date.parse('2026-10-24T07:00:00Z'), Date.parse('2026-10-31T06:59:59.999Z')]) {
        assert.equal(evaluateAudit(baseline, { ...options(), now }).status, 'accepted-development-advisory');
    }
});

test('the exception expires exactly at midnight October 31 in Los Angeles', () => {
    assert.throws(() => evaluateAudit(baseline, { ...options(), now: Date.parse('2026-10-31T07:00:00Z') }),
        /Reviewed development advisory expired at 2026-10-31T07:00:00Z/);
    for (const now of [NaN, Infinity]) {
        assert.throws(() => evaluateAudit(baseline, { ...options(), now }), /Unowned/);
    }
});

for (const [label, mutate] of [
    ['new advisory', a => a.vulnerabilities['deepmerge'].via.push({ source: 99 })],
    ['different identity', a => a.vulnerabilities['deepmerge'].via[0].source++],
    ['different severity', a => a.vulnerabilities['deepmerge'].severity = 'critical'],
    ['different location', a => a.vulnerabilities['deepmerge'].nodes.push('node_modules/other/node_modules/deepmerge')],
    ['different parent', a => a.vulnerabilities['addons-linter'].via.push('other')],
    ['different effects', a => a.vulnerabilities['deepmerge'].effects.push('other')],
    ['extra package', a => a.vulnerabilities.other = {}],
    ['retired forge advisory', a => a.vulnerabilities['node-forge'] = { severity: 'high' }],
    ['inconsistent counts', a => a.metadata.vulnerabilities.total++],
]) {
    test(`review still rejects ${label}`, () => {
        const audit = structuredClone(baseline);
        mutate(audit);
        assert.throws(() => evaluateAudit(audit, options()), /Unowned/);
    });
}

for (const name of ['web-ext', 'addons-linter', 'deepmerge']) {
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
    duplicate.lockfile.packages['node_modules/other/node_modules/deepmerge'] = { version: '4.3.1', dev: true };
    assert.throws(() => evaluateAudit(baseline, duplicate), /Unowned/);
    const rerouted = options();
    rerouted.lockfile.packages['node_modules/web-ext'].dependencies['addons-linter'] = '4.0.0';
    assert.throws(() => evaluateAudit(baseline, rerouted), /Unowned/);
});
