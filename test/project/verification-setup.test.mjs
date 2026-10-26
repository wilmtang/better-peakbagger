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
    assert.equal(job['runs-on'], 'ubuntu-24.04', 'fixture-only shards must leave macOS capacity for real extensions');
    assert.equal(job['timeout-minutes'], 15);
    assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
    assert.equal(job.needs, undefined, 'preflight must not serialize independent suite startup');
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
    assert.ok(geometry.run.includes('--${{ matrix.browser }}-only'));
    assert.ok(geometry.run.includes('--shard=${{ matrix.shard }}/4'));
    assert.ok(geometry.run.includes('--suite=portable'));
    const backups = ordinary.jobs['backup-layout'];
    assert.equal(backups['runs-on'], 'macos-15-intel');
    assert.deepEqual(backups.strategy.matrix.browser, ['chrome', 'firefox']);
    assert.equal(backups.needs, undefined);
    assert.ok(backups.steps.some(step => step.run?.includes('--suite=backups')));
    assert.ok(ordinary.jobs['chrome-required'].needs.includes('backup-layout'));
    assert.match(ordinary.jobs['chrome-required'].steps[0].run, /test "\$BACKUP_LAYOUT_RESULT" = success/);
    assert.equal(job.env.BPB_VERIFY_SCREENSHOTS, 'references');
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
    const surfaceJob = ordinary.jobs['peak-surfaces'];
    assert.equal(surfaceJob.needs, undefined, 'surface failures must not wait behind layout or preflight installation');
    assert.deepEqual(surfaceJob.strategy.matrix.browser, ['chrome', 'firefox']);
    assert.deepEqual(surfaceJob.strategy.matrix.surface, ['snow', 'cards', 'cards-placement', 'interactions']);
    assert.equal(surfaceJob.strategy['max-parallel'], 4);
    assert.equal(surfaceJob.strategy['fail-fast'], false);
    assert.ok(ordinary.jobs['chrome-required'].needs.includes('peak-surfaces'));
    assert.match(ordinary.jobs['chrome-required'].steps[0].run, /test "\$SURFACE_RESULT" = success/);
    const surfaces = surfaceJob.steps.find(step => step.name === 'Verify independent peak surface');
    assert.ok(surfaces, 'the required layout path must execute the newer surface matrices');
    assert.equal(surfaces.if, undefined);
    assert.equal(surfaces['continue-on-error'], undefined);
    assert.match(surfaces.run, /verify-ascent-weather\.mjs --"\$SURFACE"/);
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

test('the CI surface step selects the requested engine and preserves each verifier failure', async () => {
    const ordinary = await load('workflows/test.yml');
    const step = ordinary.jobs['peak-surfaces'].steps.find(step => step.name === 'Verify independent peak surface');
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-surface-ci-'));
    const executable = path.join(directory, 'node'), commands = path.join(directory, 'commands');
    try {
        await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BPB_SURFACE_COMMANDS"\nif [ "$2" = "$BPB_SURFACE_FAIL" ]; then exit 9; fi\n');
        await chmod(executable, 0o755);
        const modes = ['snow', 'cards', 'cards-placement', 'interactions'];
        for (const browser of ['chrome', 'firefox', 'missing']) for (const surface of [...modes, 'missing']) for (const fail of ['', `--${surface}`]) {
            await rm(commands, { force: true });
            const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', 'mkdir -p browser-evidence\n' + step.run], {
                cwd: directory, encoding: 'utf8', timeout: 5000,
                env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BROWSER: browser, SURFACE: surface,
                    BPB_SURFACE_COMMANDS: commands, BPB_SURFACE_FAIL: fail },
            });
            const calls = (await readFile(commands, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
            const valid = browser !== 'missing' && surface !== 'missing';
            assert.equal(result.status === 0, valid && !fail, result.stderr);
            assert.deepEqual(calls, valid ? [`scripts/verify-ascent-weather.mjs --${surface}${browser === 'firefox' ? ' --firefox' : ''}`] : []);
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

test('fast fixture preflight is independently required and installs only its selected engine', async () => {
    const ordinary = await load('workflows/test.yml');
    const job = ordinary.jobs['fixture-preflight'];
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.deepEqual(job.strategy.matrix.browser, ['chrome', 'firefox']);
    assert.ok(job.steps.some(step => step.run?.includes('fixture-preflight --${{ matrix.browser }}-only')));
    for (const name of ['fixture-preflight', 'layout']) {
        const setup = ordinary.jobs[name].steps.find(step => step.uses === './.github/actions/setup-verification');
        assert.equal(setup.with['fixture-browser'], '${{ matrix.browser }}');
        assert.equal(setup.with['firefox-version'], undefined);
        assert.equal(setup.with['chrome-version'], undefined);
    }
    assert.ok(ordinary.jobs['chrome-required'].needs.includes('fixture-preflight'));
    assert.match(ordinary.jobs['chrome-required'].steps[0].run, /test "\$PREFLIGHT_RESULT" = success/);
});

test('fixture setup rejects unknown engines and downloads only the selected browser', async () => {
    const setup = await load('actions/setup-verification/action.yml');
    const step = setup.runs.steps.find(value => value.name === 'Install fixture browser');
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-fixture-setup-'));
    try {
        const calls = path.join(directory, 'calls');
        await writeFile(path.join(directory, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BPB_FIXTURE_CALLS"\n');
        await chmod(path.join(directory, 'npx'), 0o755);
        for (const browser of ['chrome', 'firefox', 'typo']) {
            await rm(calls, { force: true });
            const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: directory,
                env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE_BROWSER: browser, BPB_FIXTURE_CALLS: calls }, encoding: 'utf8' });
            assert.equal(result.status === 0, browser !== 'typo');
            assert.equal(await readFile(calls, 'utf8').catch(() => ''), browser === 'typo' ? ''
                : `playwright install --with-deps ${browser === 'chrome' ? 'chromium' : 'firefox'}\n`);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});
