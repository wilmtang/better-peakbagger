// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The browser DOM tier's selection and wiring. Running it needs browsers, so
// `npm test` checks only what can be checked without launching one.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { domSelection, loadDomSuites, runDomTier } from '../../scripts/dom-tier.mts';
import { verificationPlan } from '../../scripts/verify.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('DOM tier selection defaults to both engines and rejects anything it would not run', () => {
    assert.deepEqual(domSelection([], root), { engines: ['chrome', 'firefox'], filter: null, dist: path.join(root, 'dist') });
    assert.deepEqual(domSelection(['firefox', '--case', 'scroll', '--dist', 'tmp/copy'], root),
        { engines: ['firefox'], filter: 'scroll', dist: path.join(root, 'tmp/copy') });
    for (const args of [['safari'], ['chrome', 'chrome'], ['--case'], ['--case', '--dist'], ['--retries', '2'], ['--headed']]) {
        assert.throws(() => domSelection(args, root), /Unknown DOM tier argument/, args.join(' '));
    }
});

test('an empty DOM tier selection fails before any browser launches', async () => {
    await assert.rejects(runDomTier(['--case', 'no case has this name'], [{ name: 'fixture', cases: [{ name: 'only', run: async () => {} }] }]),
        /No DOM tier case matches/);
});

test('DOM tier suites are discovered, outside the npm test glob, and wired into verify and required CI', async () => {
    const suites = await loadDomSuites();
    assert.ok(suites.length > 0 && suites.every(suite => suite.cases.length > 0));
    const files = await readdir(path.join(root, 'test', 'dom'));
    assert.ok(files.every(file => file.endsWith('.dom.mts')), files.join(', '));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.doesNotMatch(pkg.scripts.test, /\.dom\./, 'the tier needs browsers, so npm test must not collect it');
    assert.match(pkg.scripts.test, /test\/\*\*\/\*\.test\.mts/);
    assert.deepEqual(verificationPlan(['dom', 'firefox']),
        { build: true, commands: [[path.join(root, 'scripts', 'verify-dom.mts'), 'firefox']] });
    const workflow = await readFile(path.join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(workflow, /npm run verify -- dom \$\{\{ matrix\.browser \}\}/);
    const aggregate = workflow.slice(workflow.indexOf('  chrome-required:'));
    assert.match(aggregate, /needs:[\s\S]*- dom-tier/);
    assert.match(aggregate, /test "\$DOM_TIER_RESULT" = success/);
});
