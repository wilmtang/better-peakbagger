// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
// @ts-expect-error js-yaml ships no declarations; parsed workflows are typed below.
import yaml from 'js-yaml';

import {
    evaluateProbeSuccess,
    formatProbeMarkdown,
    parseProbeArgs,
    PROBE_MODES,
    probeLaunchSpec,
    type ProbeReport,
} from '../../scripts/probe-chrome-extension-load.mts';
import { chromeLaunchOptions, PEAKBAGGER_HOST_RULE } from '../../scripts/verification-launch.mts';

type WorkflowStep = {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
};

test('probe argument parser accepts valid flags and rejects unknown or duplicate inputs before launching', () => {
    assert.deepEqual(parseProbeArgs([]), {
        modes: [...PROBE_MODES],
        output: null,
        headed: false,
        requireAll: false,
    });
    assert.deepEqual(parseProbeArgs([
        '--mode=cdp-load-unpacked',
        '--output=browser-evidence/probe.json',
        '--headed',
        '--require-all',
    ]), {
        modes: ['cdp-load-unpacked'],
        output: 'browser-evidence/probe.json',
        headed: true,
        requireAll: true,
    });
    for (const bad of [
        ['--unknown'],
        ['--mode=firefox'],
        ['--mode=all', '--mode=cli-default'],
        ['--output='],
        ['--output=a.json', '--output=b.json'],
        ['--headed', '--headed'],
        ['--require-all', '--require-all'],
    ]) {
        assert.throws(() => parseProbeArgs(bad), /Usage: node scripts\/probe-chrome-extension-load\.mts/);
    }

    const script = fileURLToPath(new URL('../../scripts/probe-chrome-extension-load.mts', import.meta.url));
    const cli = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', timeout: 5_000 });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /Usage: node scripts\/probe-chrome-extension-load\.mts/);
});

test('probe launch specs separate baseline CLI loading, --disable-extensions removal and pipe CDP loading', () => {
    const baseline = probeLaunchSpec('cli-default', '/tmp/dist', {
        trustArgs: ['--trust-cert'],
        hosts: [PEAKBAGGER_HOST_RULE],
    });
    assert.equal(baseline.cdpLoadPath, null);
    assert.deepEqual(chromeLaunchOptions(baseline.launch), {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [
            '--trust-cert',
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1',
            '--disable-extensions-except=/tmp/dist',
            '--load-extension=/tmp/dist',
        ],
    });

    const withoutDisable = probeLaunchSpec('cli-ignore-disable-extensions', '/tmp/dist');
    assert.equal(withoutDisable.cdpLoadPath, null);
    assert.deepEqual(withoutDisable.launch.ignoreDefaultArgs, [
        '--disable-extensions',
        '--enable-unsafe-swiftshader',
    ]);

    const cdp = probeLaunchSpec('cdp-load-unpacked', '/tmp/dist', { headed: true, chromeBinary: '/opt/chrome' });
    assert.equal(cdp.cdpLoadPath, '/tmp/dist');
    assert.deepEqual(chromeLaunchOptions(cdp.launch), {
        executablePath: '/opt/chrome',
        headless: false,
        viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--disable-extensions', '--enable-unsafe-swiftshader'],
        args: [
            '--enable-unsafe-extension-debugging',
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1',
        ],
    });
});

test('probe success evaluation and Markdown summary distinguish partial and strict outcomes', () => {
    assert.equal(evaluateProbeSuccess([], false), false);
    assert.equal(evaluateProbeSuccess([{ passed: false }, { passed: true }], false), true);
    assert.equal(evaluateProbeSuccess([{ passed: false }, { passed: true }], true), false);
    assert.equal(evaluateProbeSuccess([{ passed: true }, { passed: true }], true), true);

    const report: ProbeReport = {
        platform: 'linux',
        arch: 'x64',
        nodeVersion: 'v24.0.0',
        headed: false,
        requireAll: false,
        overallPassed: true,
        results: [{
            mode: 'cdp-load-unpacked',
            passed: true,
            durationMs: 420,
            browserVersion: '156.0.8078.4',
            extensionId: 'abcdefghijklmnopabcdefghijklmnop',
            cdpExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
            cdpError: null,
            registry: {
                totalRecords: 1,
                id: 'abcdefghijklmnopabcdefghijklmnop',
                location: 'UNPACKED',
                registryStatus: 'ENABLED',
                disableReasons: [],
                manifestVersion: 3,
                pathMatches: true,
            },
            registryRawRecords: 1,
            contentScript: { injected: true, theme: 'light', mapLinks: true },
            worker: { ok: true, workerStarted: true, extensionIdMatch: true, error: null },
            browserLogs: [],
            error: null,
        }],
    };
    const markdown = formatProbeMarkdown(report);
    assert.match(markdown, /\*\*PASS\*\*/);
    assert.match(markdown, /`cdp-load-unpacked` \| PASS \| 156\.0\.8078\.4 \| UNPACKED \(ENABLED\)/);
});

test('manual Linux Chrome probe workflow stays isolated to workflow_dispatch with pinned actions', async () => {
    const raw = await readFile(
        new URL('../../.github/workflows/probe-linux-chrome-extension.yml', import.meta.url),
        'utf8',
    );
    const workflow = yaml.load(raw) as {
        on: Record<string, unknown>;
        permissions: Record<string, string>;
        defaults: { run: { shell: string } };
        jobs: { probe: { 'runs-on': string; steps: WorkflowStep[] } };
    };
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(workflow.defaults.run.shell, 'bash');
    assert.equal(workflow.jobs.probe['runs-on'], 'ubuntu-24.04');

    const steps = workflow.jobs.probe.steps;
    const setup = steps.find(step => step.uses === './.github/actions/setup-verification');
    assert.equal(setup?.with?.['chrome-version'], 'current');
    assert.ok(
        steps
            .filter(step => step.uses && !step.uses.startsWith('./'))
            .every(step => /@[a-f0-9]{40}$/.test(step.uses!)),
        'all external actions must stay SHA-pinned',
    );
    const probeStep = steps.find(step => step.name === 'Probe Chrome unpacked-extension loading');
    assert.ok(probeStep?.run);
    assert.doesNotMatch(probeStep.run, /\$\{\{/, 'inputs must pass through env rather than shell interpolation');
    const upload = steps.find(step => step.name === 'Upload probe report and logs');
    assert.equal(upload?.if, 'always()');
});
