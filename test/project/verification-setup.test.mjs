// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const load = async name => yaml.load(await readFile(new URL(`../../.github/${name}`, import.meta.url), 'utf8'));

test('ordinary and release package gates share setup, browsers, and their execution command', async () => {
    const ordinary = await load('workflows/test.yml');
    const release = await load('workflows/release.yml');
    for (const job of [ordinary.jobs.chrome, release.jobs.verify]) {
        const setup = job.steps.find(step => step.uses === './.github/actions/setup-verification');
        assert.equal(setup.with['chrome-version'], 'current');
        assert.equal(setup.with['firefox-version'], 'latest');
        assert.equal(setup.with['popup-firefox'], 'true');
        assert.equal(job.steps.filter(step => step.uses === './.github/actions/verify-package').length, 1);
        assert.equal(job['runs-on'], 'macos-15-intel');
    }
    for (const job of [ordinary.jobs.node, ordinary.jobs.scale, release.jobs.scale]) {
        assert.ok(job.steps.some(step => step.uses === './.github/actions/setup-verification'));
    }
});

test('shared package gate builds once and exercises capture against the production bundles', async () => {
    const gate = await load('actions/verify-package/action.yml');
    const steps = gate.runs.steps;
    assert.match(steps[0].run, /npm run release:verify-packages/);
    assert.equal(steps.filter(step => step.run.includes('npm run')).length, 1);
    for (const script of ['capture-popup', 'capture-readiness', 'capture-flow', 'multi-summit']) {
        assert.ok(steps.slice(1).some(step => step.run.includes(`node scripts/verify-${script}.mjs`)), script);
    }
    for (const step of steps) {
        assert.equal(step.shell, 'bash', 'tee must not conceal a failed verifier');
        assert.match(step.run, /2>&1 \| tee browser-evidence\//);
        assert.equal(step['continue-on-error'], undefined);
        assert.equal(step.if, undefined, 'tags and rehearsals must run every capture gate');
    }
});

test('ordinary CI gates on interaction geometry and retains layout evidence', async () => {
    const ordinary = await load('workflows/test.yml');
    const job = ordinary.jobs.layout;
    assert.ok(job, 'the full layout matrix needs a job budget separate from package verification');
    assert.equal(job['runs-on'], ordinary.jobs.chrome['runs-on']);
    assert.equal(job['timeout-minutes'], 20);
    assert.equal(job.if, undefined);
    assert.ok(job.strategy?.matrix, 'each complete browser matrix needs its own job budget');
    assert.deepEqual(job.strategy.matrix.browser, ['chrome', 'firefox']);
    assert.equal(job.strategy['fail-fast'], false, 'retain independent evidence from both browser matrices');
    assert.equal(ordinary.jobs.chrome.steps.some(step => step.run?.includes('verify -- layout-stability')), false);
    assert.ok(ordinary.jobs['chrome-required'].needs.includes('layout'), 'the existing required check must await layout results');
    const required = ordinary.jobs['chrome-required'].steps[0];
    assert.equal(required.env.LAYOUT_RESULT, '${{ needs.layout.result }}');
    assert.match(required.run, /test "\$LAYOUT_RESULT" = success/, 'failed or skipped layout checks must block the release');
    const geometry = job.steps.find(step => step.run?.includes('npm run verify -- layout-stability'));
    assert.ok(geometry, 'state transitions must be checked beyond static manifest smoke');
    assert.equal(geometry.if, undefined);
    assert.equal(geometry['continue-on-error'], undefined);
    assert.equal(ordinary.defaults.run.shell, 'bash', 'pipefail must preserve a verifier failure through tee');
    assert.equal(geometry.env.BPB_JITTER_ARTIFACTS, 'browser-evidence/layout-stability');
    assert.match(geometry.run, /2>&1 \| tee browser-evidence\/layout-stability\.log/);
    assert.ok(geometry.run.includes('--${{ matrix.browser }}-only'), 'each job must select its complete browser matrix');
    assert.ok(job.steps.find(step => step.name === 'Retain layout failure evidence').with.name.includes('${{ matrix.browser }}'));
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(packageJson.scripts.verify, 'node scripts/verify.mjs');
    const verifier = await readFile(new URL('../../scripts/verify-layout-stability.mjs', import.meta.url), 'utf8');
    assert.match(verifier, /'weather-models':.*verifyPeakWeatherRefresh/,
        'ordinary CI must exercise summit model loading, not just hourly readings');
});

test('layout browser selections reject conflicting engines and unknown selections before launching', () => {
    const script = fileURLToPath(new URL('../../scripts/verify-layout-stability.mjs', import.meta.url));
    for (const [args, expected] of [
        [['--chrome-only', '--firefox-only'], /Choose only one layout browser/],
        [['--firefoxx-only'], /Unknown layout argument/],
        [['--firefox-only', '--surface=missing'], /Unknown layout surface/],
    ]) {
        const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
    }
});

test('ordinary CI requires snow/cards on both browsers and a separate hardware snow-map matrix', async () => {
    const ordinary = await load('workflows/test.yml');
    const surfaces = ordinary.jobs.layout.steps.find(step => step.name === 'Verify snow and independent peak cards');
    assert.ok(surfaces, 'the required layout path must execute the newer surface matrices');
    assert.equal(surfaces.if, undefined);
    assert.equal(surfaces['continue-on-error'], undefined);
    for (const mode of ['snow', 'cards']) assert.match(surfaces.run, new RegExp(`verify-ascent-weather\\.mjs --${mode} `));
    assert.equal(surfaces.env.BROWSER, '${{ matrix.browser }}');
    assert.match(surfaces.run, /firefox\) browser_args=\(--firefox\)/);
    assert.match(surfaces.run, /Unknown browser/);
    const gpu = ordinary.jobs['snow-map'];
    assert.equal(gpu['runs-on'], 'macos-15');
    assert.equal(gpu.if, undefined, 'snow-map coverage must not wait for a dependency change');
    assert.deepEqual(gpu.strategy.matrix.browser, ['chrome', 'firefox']);
    assert.equal(gpu.strategy['fail-fast'], false);
    assert.ok(gpu.steps.some(step => /verify-ascent-weather\.mjs --snow-map /.test(step.run || '')));
    const setup = gpu.steps.find(step => step.uses === './.github/actions/setup-verification');
    assert.equal(setup.with['chrome-version'], 'current');
    assert.equal(setup.with['firefox-version'], 'latest');
    assert.ok(ordinary.jobs['chrome-required'].needs.includes('snow-map'));
    assert.match(ordinary.jobs['chrome-required'].steps[0].run, /test "\$SNOW_MAP_RESULT" = success/);
    assert.ok(gpu.steps.some(step => step.if === 'failure()' && step.with?.path === 'browser-evidence/'));
});

test('the CI surface step selects the requested engine and preserves either verifier failure', async () => {
    const ordinary = await load('workflows/test.yml');
    const step = ordinary.jobs.layout.steps.find(step => step.name === 'Verify snow and independent peak cards');
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-surface-ci-'));
    const executable = path.join(directory, 'node'), commands = path.join(directory, 'commands');
    try {
        await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BPB_SURFACE_COMMANDS"\nif [ "$2" = "$BPB_SURFACE_FAIL" ]; then exit 9; fi\n');
        await chmod(executable, 0o755);
        for (const browser of ['chrome', 'firefox', 'missing']) for (const fail of ['', '--snow', '--cards', '--interactions']) {
            await rm(commands, { force: true });
            const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', 'mkdir -p browser-evidence\n' + step.run], {
                cwd: directory, encoding: 'utf8', timeout: 5000,
                env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BROWSER: browser,
                    BPB_SURFACE_COMMANDS: commands, BPB_SURFACE_FAIL: fail },
            });
            const calls = (await readFile(commands, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
            assert.equal(result.status === 0, browser !== 'missing' && !fail, result.stderr);
            const modes = browser === 'missing' ? [] : fail === '--snow' ? ['snow']
                : fail === '--cards' ? ['snow', 'cards'] : ['snow', 'cards', 'interactions'];
            assert.deepEqual(calls, modes.map(mode => `scripts/verify-ascent-weather.mjs --${mode}${browser === 'firefox' ? ' --firefox' : ''}`));
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared setup exports the installed paths and versions and keeps exact toolchain pins', async () => {
    const setup = await load('actions/setup-verification/action.yml');
    const steps = setup.runs.steps;
    assert.equal(steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], 24);
    assert.ok(steps.some(step => step.run === 'npm ci'));
    const firefox = steps.find(step => step.id === 'firefox');
    const chrome = steps.find(step => step.id === 'chrome');
    assert.equal(firefox.with['firefox-version'], '${{ inputs.firefox-version }}');
    assert.equal(chrome.with['chrome-version'], '${{ inputs.chrome-version }}');
    const contract = steps.find(step => step.name === 'Export installed browser contracts');
    for (const browser of ['CHROME','FIREFOX']) {
        assert.equal(contract.env[`${browser}_VERSION`], '${{ steps.' + browser.toLowerCase() + '.outputs.' + browser.toLowerCase() + '-version }}');
        assert.match(contract.run, new RegExp(`BPB_EXPECT_${browser}_VERSION=`));
        assert.match(contract.run, new RegExp(`${browser}_BIN=`));
    }
    assert.ok(steps.some(step => step.run?.includes('verification-browser-identity.mjs --playwright-chromium')));
    assert.ok(steps.filter(step => step.uses).every(step => /@[a-f0-9]{40}$/.test(step.uses)));
});
