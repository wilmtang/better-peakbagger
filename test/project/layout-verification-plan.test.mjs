// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutVerificationPlan } from '../../scripts/layout-verification-plan.mjs';

const surfaces = ['timestamps', 'ascent-columns', 'peak-columns', 'report-filter', ...Array.from({ length: 20 }, (_, i) => `surface-${i}`)];
const identity = value => JSON.stringify(value);

test('four balanced shards preserve every browser, surface, theme and viewport exactly once', () => {
    const full = layoutVerificationPlan([], surfaces).cases;
    assert.equal(full.length, 192);
    const shards = [];
    for (const browser of ['chrome', 'firefox']) for (let shard = 1; shard <= 4; shard++) {
        const cases = layoutVerificationPlan([`--${browser}-only`, `--shard=${shard}/4`], surfaces).cases;
        assert.equal(cases.length, 24);
        assert.equal(new Set(cases.map(c => c.name)).size, 1);
        shards.push(...cases);
    }
    assert.equal(new Set(shards.map(identity)).size, full.length);
    assert.deepEqual(shards.map(identity).sort(), full.map(identity).sort());
});

test('focused selections preserve their enlarged-text cases and browser selections', () => {
    for (const surface of surfaces.slice(0, 4)) {
        const cases = layoutVerificationPlan(['--firefox-only', `--surface=${surface}`], surfaces).cases;
        assert.equal(cases.length, 8);
        assert.deepEqual([...new Set(cases.map(c => c.zoom))], [1, 1.5]);
        assert.ok(cases.every(c => c.browser === 'firefox' && c.surface === surface));
    }
});

test('invalid or empty selections fail before any browser can launch', () => {
    for (const args of [['--missing'], ['--surface='], ['--surface=missing'], ['--chrome-only', '--firefox-only'],
        ['--shard=0/4'], ['--shard=5/4'], ['--shard=1/5'], ['--shard=1/0'], ['--shard=1/4', '--shard=2/4'],
        ['--surface=timestamps', '--surface=report-filter']]) assert.throws(() => layoutVerificationPlan(args, surfaces));
    assert.throws(() => layoutVerificationPlan([], []));
});

test('preflight runs the actual API, focus and settings fixtures without replacing full coverage', () => {
    const plan = layoutVerificationPlan(['--chrome-only', '--preflight'], [...surfaces, 'popup', 'settings', 'maps']);
    assert.deepEqual(plan.cases.map(value => value.surface), ['popup', 'timestamps', 'settings', 'maps']);
    assert.ok(plan.cases.every(value => value.browser === 'chrome' && value.width === 390 && value.theme === 'light'));
    assert.throws(() => layoutVerificationPlan(['--preflight', '--shard=1/4'], surfaces));
    assert.throws(() => layoutVerificationPlan(['--preflight', '--surface=timestamps'], surfaces));
    assert.throws(() => layoutVerificationPlan(['--preflight'], []));
});
