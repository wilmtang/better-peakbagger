// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runVerification } from '../../scripts/verify.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = name => path.join(root, 'scripts', name);

test('verification targets preserve the existing checks and browser order with one build', async t => {
    const cases = [
        [['chrome'], [['verify-extension.mjs']]],
        [['firefox'], [['verify-firefox-extension.mjs']]],
        [['browsers'], [['verify-extension.mjs'], ['verify-firefox-extension.mjs']]],
        [['capture-popup'], [['verify-capture-popup.mjs']]],
        [['gpx-header'], [['verify-gpx-header.mjs']]],
        [['layout-stability', '--firefox-only', '--surface=maps'],
            [['verify-layout-stability.mjs', '--firefox-only', '--surface=maps']]],
        [['multi-summit'], [['verify-multi-summit.mjs']]],
        [['draft-recovery'], [['verify-draft-recovery.mjs', 'chrome'], ['verify-draft-recovery.mjs', 'firefox']]],
        [['profile-editor'], [['verify-profile-editor.mjs', 'chrome'], ['verify-profile-editor.mjs', 'firefox']]],
        [['inline-buddies'], [['verify-inline-buddies.mjs'], ['verify-inline-buddies.mjs', '--firefox']]],
        [['capture-flow'], [['verify-capture-flow.mjs']]],
        [['capture-readiness', 'firefox'], [['verify-capture-readiness.mjs', 'firefox']]],
        [['provider-contracts'], [['verify-provider-contracts.mjs']]],
        [['provider-performance'], [['verify-provider-performance.mjs']]],
        [['map-handoffs'], [['verify-map-handoffs.mjs']]],
        [['map-layers'], [['verify-map-layer-control.mjs'], ['verify-map-layers.mjs']]],
        [['map-location'], [['verify-ascent-weather.mjs', '--map-location'], ['verify-ascent-weather.mjs', '--map-location', '--firefox']]],
        [['api-rate-limits'], [['verify-api-rate-limits.mjs']]],
        [['ascent-backup-lifecycle'], [['verify-ascent-backup-lifecycle.mjs']]],
        [['peak-map-layout'], [['verify-peak-map-layout.mjs']]],
        [['weather-intervals'], [['verify-weather-intervals.mjs']]],
        [['weather', '--live'], [['verify-ascent-weather.mjs', '--live'], ['verify-ascent-weather.mjs', '--firefox', '--live']]],
        [['peak-weather'], [['verify-ascent-weather.mjs', '--peak'], ['verify-ascent-weather.mjs', '--peak', '--firefox']]],
        [['snow'], [['verify-ascent-weather.mjs', '--snow'], ['verify-ascent-weather.mjs', '--snow', '--firefox']]],
        [['snow-map'], [['verify-ascent-weather.mjs', '--snow-map'], ['verify-ascent-weather.mjs', '--snow-map', '--firefox']]],
        [['map-controls'], [['verify-map-controls.mjs'], ['verify-map-controls.mjs', '--firefox']]],
        [['terrain'], [['verify-terrain-visual.mjs']]],
        [['terrain', 'chrome', '/tmp/terrain evidence'], [['verify-terrain-visual.mjs', '/tmp/terrain evidence']]],
        [['terrain', 'firefox'], [['verify-firefox-terrain.mjs']]],
        [['terrain', 'cache-owners'], [['verify-terrain-cache-owners.mjs']]],
        [['terrain', 'lod'], [['verify-terrain-lod.mjs']]],
    ];
    for (const [args, expected] of cases) {
        await t.test(args.join(' '), async () => {
            const calls = [];
            await runVerification(args, { execute: async (...call) => { calls.push(call); } });
            assert.deepEqual(calls, [['build.mjs'], ...expected].map(([name, ...options]) =>
                [process.execPath, [script(name), ...options], { cwd: root }]));
        });
    }
});

test('package verification uses the supplied archives without rebuilding production bytes', async () => {
    const calls = [];
    await runVerification(['packages', '/tmp/Chrome archive.zip', '/tmp/Firefox archive.zip'], {
        execute: async (...call) => { calls.push(call); },
    });
    assert.deepEqual(calls, [[process.execPath, [script('verify-packaged-extensions.mjs'),
        '/tmp/Chrome archive.zip', '/tmp/Firefox archive.zip'], { cwd: root }]]);
});

test('invalid targets and missing package arguments fail before building or launching', async () => {
    for (const args of [[], ['chromee'], ['toString'], ['gaia'], ['onx'], ['terrain', 'firefoxx'],
        ['packages'], ['packages', 'chrome.zip'], ['packages', 'chrome.zip', 'firefox.zip', 'extra']]) {
        let calls = 0;
        await assert.rejects(runVerification(args, {
            execute: async () => { calls++; },
        }), /Unknown .*target|Usage: npm run verify/);
        assert.equal(calls, 0, args.join(' '));
    }
});

test('a failed build or verifier stops the sequence and preserves the failure', async () => {
    for (const failAt of [1, 2]) {
        const failure = new Error('CHECK_FAILED');
        let calls = 0;
        await assert.rejects(runVerification(['browsers'], {
            execute: async () => {
                if (++calls === failAt) throw failure;
            },
        }), error => error === failure);
        assert.equal(calls, failAt, 'no later browser should run after failure');
    }
});

test('CLI help lists the targets and invalid selections exit unsuccessfully', () => {
    const help = spawnSync(process.execPath, [script('verify.mjs'), '--help'], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: npm run verify -- TARGET/);
    assert.match(help.stdout, /packages CHROME.zip FIREFOX.zip \(no build\)/);
    assert.match(help.stdout, /terrain \[chrome\|firefox\|cache-owners\|lod\]/);
    for (const args of [[], ['chromee'], ['terrain', 'firefoxx']]) {
        const result = spawnSync(process.execPath, [script('verify.mjs'), ...args], { encoding: 'utf8', timeout: 5_000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Unknown .*target/);
    }
});

test('draft recovery rejects missing, unknown and extra selections before opening a browser', () => {
    for (const args of [[], ['chromee'], ['chrome', '--unknown']]) {
        const result = spawnSync(process.execPath, [script('verify-draft-recovery.mjs'), ...args], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Usage: node scripts\/verify-draft-recovery/);
    }
});

test('profile editor rejects missing, unknown and extra selections before opening a browser', () => {
    for (const args of [[], ['chromee'], ['chrome', '--unknown']]) {
        const result = spawnSync(process.execPath, [script('verify-profile-editor.mjs'), ...args], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Usage: node scripts\/verify-profile-editor/);
    }
});

test('focused no-argument verifiers reject unknown selections before opening a browser', () => {
    for (const name of ['verify-api-rate-limits.mjs', 'verify-ascent-backup-lifecycle.mjs', 'verify-peak-map-layout.mjs', 'verify-weather-intervals.mjs']) {
        const result = spawnSync(process.execPath, [script(name), '--unknown'], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Usage: node scripts\//);
    }
});
