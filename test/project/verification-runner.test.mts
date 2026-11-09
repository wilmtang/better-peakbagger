// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runVerification } from '../../scripts/verify.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = (name: string) => path.join(root, 'scripts', name);

test('verification targets preserve the existing checks and browser order with one build', async t => {
    const cases: [string[], string[][]][] = [
        [['chrome'], [['verify-extension.mts']]],
        [['firefox'], [['verify-firefox-extension.mts']]],
        [['browsers'], [['verify-extension.mts'], ['verify-firefox-extension.mts']]],
        [['capture-popup'], [['verify-capture-popup.mts']]],
        [['popup-photo-entry'], [['verify-popup-photo-entry.mts']]],
        [['gpx-header'], [['verify-gpx-header.mjs']]],
        [['layout-stability', '--firefox-only', '--surface=maps'],
            [['verify-layout-stability.mts', '--firefox-only', '--surface=maps']]],
        [['multi-summit'], [['verify-multi-summit.mjs']]],
        [['draft-recovery'], [['verify-draft-recovery.mjs', 'chrome'], ['verify-draft-recovery.mjs', 'firefox']]],
        [['profile-editor'], [['verify-profile-editor.mts', 'chrome'], ['verify-profile-editor.mts', 'firefox']]],
        [['instagram'], [['verify-instagram.mjs', 'chrome'], ['verify-instagram.mjs', 'firefox']]],
        [['report-security'], [['verify-report-security.mjs', 'chrome'], ['verify-report-security.mjs', 'firefox'], ['verify-report-routes.mts', 'chrome'], ['verify-report-routes.mts', 'firefox']]],
        [['inline-buddies'], [['verify-inline-buddies.mjs'], ['verify-inline-buddies.mjs', '--firefox']]],
        [['capture-flow'], [['verify-capture-flow.mts']]],
        [['capture-readiness', 'firefox'], [['verify-capture-readiness.mjs', 'firefox']]],
        [['provider-contracts'], [['verify-provider-contracts.mjs']]],
        [['provider-performance'], [['verify-provider-performance.mjs']]],
        [['map-handoffs'], [['verify-map-handoffs.mjs']]],
        [['onx'], [['verify-onx.mjs', 'chrome'], ['verify-onx.mjs', 'firefox']]],
        [['map-layers'], [['verify-map-layer-control.mts'], ['verify-map-layers.mts']]],
        [['settings-navigation'], [['verify-settings-fragments.mjs', 'chrome'], ['verify-settings-fragments.mjs', 'firefox']]],
        [['map-location'], [['verify-ascent-weather.mjs', '--map-location'], ['verify-ascent-weather.mjs', '--map-location', '--firefox']]],
        [['api-rate-limits'], [['verify-api-rate-limits.mjs']]],
        [['ascent-backup-lifecycle'], [['verify-ascent-backup-lifecycle.mjs']]],
        [['peak-map-layout'], [['verify-peak-map-layout.mts']]],
        [['weather-intervals'], [['verify-weather-intervals.mjs']]],
        [['weather', '--live'], [['verify-ascent-weather.mjs', '--live'], ['verify-ascent-weather.mjs', '--firefox', '--live']]],
        [['peak-weather'], [['verify-ascent-weather.mjs', '--peak'], ['verify-ascent-weather.mjs', '--peak', '--firefox']]],
        [['snow'], [['verify-ascent-weather.mjs', '--snow'], ['verify-ascent-weather.mjs', '--snow', '--firefox']]],
        [['snow-map'], [['verify-ascent-weather.mjs', '--snow-map'], ['verify-ascent-weather.mjs', '--snow-map', '--firefox']]],
        [['peak-card-placement'], [['verify-ascent-weather.mjs', '--cards-placement'], ['verify-ascent-weather.mjs', '--cards-placement', '--firefox']]],
        [['map-controls'], [['verify-map-controls.mjs'], ['verify-map-controls.mjs', '--firefox']]],
        [['terrain'], [['verify-terrain-visual.mts']]],
        [['terrain', 'chrome', '/tmp/terrain evidence'], [['verify-terrain-visual.mts', '/tmp/terrain evidence']]],
        [['terrain', 'firefox'], [['verify-firefox-terrain.mts']]],
        [['terrain', 'cache-owners'], [['verify-terrain-cache-owners.mts']]],
        [['terrain', 'lod'], [['verify-terrain-lod.mts']]],
    ];
    for (const [args, expected] of cases) {
        await t.test(args.join(' '), async () => {
            const calls: unknown[][] = [];
            await runVerification(args, { execute: async (...call) => { calls.push(call); } });
            assert.deepEqual(calls, [['build.mts'], ...expected].map(([name, ...options]) =>
                [process.execPath, [script(name), ...options], { cwd: root }]));
        });
    }
});

test('package verification uses the supplied archives without rebuilding production bytes', async () => {
    const calls: unknown[][] = [];
    await runVerification(['packages', '/tmp/Chrome archive.zip', '/tmp/Firefox archive.zip'], {
        execute: async (...call) => { calls.push(call); },
    });
    assert.deepEqual(calls, [[process.execPath, [script('verify-packaged-extensions.mts'),
        '/tmp/Chrome archive.zip', '/tmp/Firefox archive.zip'], { cwd: root }]]);
});

test('invalid targets and missing package arguments fail before building or launching', async () => {
    for (const args of [[], ['chromee'], ['toString'], ['gaia'], ['onxx'], ['terrain', 'firefoxx'],
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
    const help = spawnSync(process.execPath, [script('verify.mts'), '--help'], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: npm run verify -- TARGET/);
    assert.match(help.stdout, /packages CHROME.zip FIREFOX.zip \(no build\)/);
    assert.match(help.stdout, /terrain \[chrome\|firefox\|cache-owners\|lod\]/);
    for (const args of [[], ['chromee'], ['terrain', 'firefoxx']]) {
        const result = spawnSync(process.execPath, [script('verify.mts'), ...args], { encoding: 'utf8', timeout: 5_000 });
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
        const result = spawnSync(process.execPath, [script('verify-profile-editor.mts'), ...args], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Usage: node scripts\/verify-profile-editor/);
    }
});

test('settings navigation rejects unknown and extra selections before opening a browser', () => {
    for (const args of [['chromee'], ['chrome', '--unknown']]) {
        const result = spawnSync(process.execPath, [script('verify-settings-fragments.mjs'), ...args], { encoding: 'utf8', timeout: 5000 });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Usage: node scripts\/verify-settings-fragments/);
    }
});

test('focused no-argument verifiers reject unknown selections before opening a browser', () => {
    for (const name of ['verify-api-rate-limits.mjs', 'verify-ascent-backup-lifecycle.mjs', 'verify-peak-map-layout.mts', 'verify-weather-intervals.mjs']) {
        const result = spawnSync(process.execPath, [script(name), '--unknown'], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Usage: node scripts\//);
    }
});

test('peak-card placement rejects unknown and conflicting selections before opening a browser', () => {
    for (const args of [['--cards-placement', '--unknown'], ['--cards-placement', '--cards'], ['--cards-placement', '--interactions']]) {
        const result = spawnSync(process.execPath, [script('verify-ascent-weather.mjs'), ...args], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Unsupported weather verification arguments/);
    }
});


test('onX verification rejects unknown or empty selections before opening a browser', () => {
    for (const args of [[], ['chromee'], ['chrome', '--unknown'], ['firefox', '--screenshots=a', '--screenshots=b']]) {
        const result = spawnSync(process.execPath, [script('verify-onx.mjs'), ...args], { encoding: 'utf8', timeout: 5000 });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Usage: verify-onx/);
    }
});
