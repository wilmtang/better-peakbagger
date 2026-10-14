// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    const job = ordinary.jobs.chrome;
    const geometry = job.steps.find(step => step.run?.includes('npm run verify:layout-stability'));
    assert.ok(geometry, 'state transitions must be checked beyond static manifest smoke');
    assert.equal(geometry.if, undefined);
    assert.equal(geometry['continue-on-error'], undefined);
    assert.equal(ordinary.defaults.run.shell, 'bash', 'pipefail must preserve a verifier failure through tee');
    assert.equal(geometry.env.BPB_JITTER_ARTIFACTS, 'browser-evidence/layout-stability');
    assert.match(geometry.run, /2>&1 \| tee browser-evidence\/layout-stability\.log/);
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(packageJson.scripts['verify:layout-stability'], 'npm run build && node scripts/verify-layout-stability.mjs');
    const verifier = await readFile(new URL('../../scripts/verify-layout-stability.mjs', import.meta.url), 'utf8');
    assert.match(verifier, /'weather-models':.*verifyPeakWeatherRefresh/,
        'ordinary CI must exercise summit model loading, not just hourly readings');
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
