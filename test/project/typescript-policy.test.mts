// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { policySelection, trackedPolicyPaths, typescriptPolicyViolations } from '../../scripts/typescript-policy.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts/typescript-policy.mts');

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-typescript-policy-'));
    const git = (...args: string[]) => execFileSync('git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
        '-c', 'user.name=Policy fixture', '-c', 'user.email=policy@example.test',
        ...args,
    ], { cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const write = async (file: string, contents = 'export const value = 1;\n') => {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), contents);
    };
    git('init', '--quiet');
    await write('legacy.js');
    git('add', '.');
    git('commit', '--quiet', '-m', 'baseline');
    const check = (args: string[], cwd = directory, env = process.env) =>
        spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
    return { directory, git, write, check, close: () => rm(directory, { recursive: true, force: true }) };
}

test('authored JavaScript is rejected across all surfaces with only generated/upstream exclusions', () => {
    const forbidden = ['src/a.js', 'options/a.mjs', 'popup/a.cjs', 'photos/a.jsx',
        'scripts/a.mjs', 'test/fixtures/a.js', 'docs/plans/evidence/a.mjs',
        'store-assets/a.js', 'eslint.config.mjs', 'other/a.JS'];
    assert.deepEqual(typescriptPolicyViolations([...forbidden, 'src/a.ts', 'scripts/a.mts',
        'dist/a.js', 'node_modules/a.js', 'web-ext-artifacts/a.js', 'browser-evidence/a.js',
        'third_party/a.js', 'src/a.js.map', 'README.md']), [...forbidden].sort());
    assert.deepEqual(typescriptPolicyViolations(['third_party-lookalike/a.js']), ['third_party-lookalike/a.js']);
});

test('the staged guard rejects unchanged tracked JavaScript even after its working copy is removed', async () => {
    const f = await fixture();
    try {
        const unchanged = f.check([]);
        assert.equal(unchanged.status, 1, unchanged.stdout + unchanged.stderr);
        assert.match(unchanged.stderr, /legacy\.js/);

        await rm(path.join(f.directory, 'legacy.js'));
        const unstagedDeletion = f.check(['--staged']);
        assert.equal(unstagedDeletion.status, 1, unstagedDeletion.stdout + unstagedDeletion.stderr);
        assert.match(unstagedDeletion.stderr, /legacy\.js/);

        f.git('add', '-u');
        const stagedDeletion = f.check(['--staged']);
        assert.equal(stagedDeletion.status, 0, stagedDeletion.stdout + stagedDeletion.stderr);
    } finally { await f.close(); }
});

test('the staged index and committed tree are checked independently', async () => {
    const f = await fixture();
    try {
        f.git('mv', 'legacy.js', 'renamed.js');
        assert.deepEqual(typescriptPolicyViolations(trackedPolicyPaths('staged', f.directory)), ['renamed.js']);
        f.git('mv', 'renamed.js', 'converted.ts');
        assert.equal(f.check(['--staged']).status, 0);
        const committedLegacy = f.check(['--committed']);
        assert.equal(committedLegacy.status, 1, committedLegacy.stdout + committedLegacy.stderr);
        assert.match(committedLegacy.stderr, /legacy\.js/);

        f.git('commit', '--quiet', '-m', 'convert the module');
        await f.write('untracked.mjs');
        assert.equal(f.check(['--staged']).status, 0, 'an untracked file is outside the Git snapshot');
        f.git('add', 'untracked.mjs');
        const stagedJavaScript = f.check(['--staged']);
        assert.equal(stagedJavaScript.status, 1);
        assert.match(stagedJavaScript.stderr, /untracked\.mjs/);
        assert.equal(f.check(['--committed']).status, 0);
    } finally { await f.close(); }
});

test('both modes scan the repository root when invoked from a subdirectory', async () => {
    const f = await fixture();
    try {
        await f.write('nested/checked.mts');
        const nested = path.join(f.directory, 'nested');
        const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
        for (const mode of ['--staged', '--committed']) {
            const rejected = f.check([mode], nested, env);
            assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
            assert.match(rejected.stderr, /legacy\.js/);
        }
    } finally { await f.close(); }
});

test('both modes accept tracked generated output and upstream JavaScript', async () => {
    const f = await fixture();
    try {
        f.git('rm', 'legacy.js');
        await f.write('dist/background.js');
        await f.write('third_party/vendor.mjs');
        f.git('add', '-f', 'dist/background.js', 'third_party/vendor.mjs');
        const staged = f.check(['--staged']);
        assert.equal(staged.status, 0, staged.stdout + staged.stderr);
        f.git('commit', '--quiet', '-m', 'retain excluded output and vendor files');
        const committed = f.check(['--committed']);
        assert.equal(committed.status, 0, committed.stdout + committed.stderr);
    } finally { await f.close(); }
});

test('NUL-delimited paths preserve whitespace, quotes and newlines', async () => {
    const f = await fixture();
    try {
        f.git('rm', 'legacy.js');
        const file = 'scripts/two words "quoted"\nprobe.js';
        await f.write(file);
        f.git('add', '.');
        assert.deepEqual(typescriptPolicyViolations(trackedPolicyPaths('staged', f.directory)), [file]);
        const result = f.check(['--staged']);
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(JSON.stringify(file)));
    } finally { await f.close(); }
});

test('unknown arguments and unavailable Git snapshots fail closed', async () => {
    assert.equal(policySelection([]), 'staged');
    assert.equal(policySelection(['--staged']), 'staged');
    assert.equal(policySelection(['--committed']), 'committed');
    for (const args of [['--skip'], ['--base', 'HEAD'], ['--committed', 'HEAD'], ['--staged', '--skip']]) {
        assert.throws(() => policySelection(args), /Usage:/);
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-typescript-policy-no-head-'));
    try {
        execFileSync('git', ['init', '--quiet'], { cwd: directory });
        const result = spawnSync(process.execPath, [script, '--committed'], { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not inspect the requested Git snapshot/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pre-commit scans after privacy, and both CI and release require the committed policy', async () => {
    const hook = await readFile(path.join(root, '.githooks/pre-commit'), 'utf8');
    assert.ok(hook.indexOf('privacy-guard.mts') < hook.indexOf('typescript-policy.mts'));
    assert.match(hook, /typescript-policy\.mts" --staged/);
    const workflow = await readFile(path.join(root, '.github/workflows/test.yml'), 'utf8');
    const release = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
    for (const file of [workflow, release]) {
        assert.match(file, /npm run check:typescript-policy -- --committed/);
    }
    const inventory = await readFile(path.join(root, 'scripts/README.md'), 'utf8');
    for (const file of (await readdir(path.join(root, 'scripts'))).filter(entry => entry.endsWith('.mts'))) {
        assert.ok(inventory.includes(`[${file}](${file})`), `missing TypeScript script inventory entry: ${file}`);
    }
});
