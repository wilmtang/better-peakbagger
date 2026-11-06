// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changedPolicyPaths, policySelection, typescriptPolicyViolations, isMechanicalTypeScriptReferenceUpdate } from '../../scripts/typescript-policy.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts/typescript-policy.mts');

test('only exact filename-reference upgrades can remain in existing JavaScript', () => {
    const before = "import { value } from './value.js';\nconst source = 'src/source.mjs';\n";
    const after = "import { value } from './value.ts';\nconst source = 'src/source.mts';\n";
    assert.equal(isMechanicalTypeScriptReferenceUpdate(before, after), true);
    for (const changed of [after + '// comment\n', after.replace('const source', 'let source'),
        after.replace('value.ts', 'other.ts'), before, after.replace('source.mts', 'source.mjs').replace('value.ts', 'value.js')]) {
        assert.equal(isMechanicalTypeScriptReferenceUpdate(before, changed), false);
    }
    assert.equal(isMechanicalTypeScriptReferenceUpdate(after, before), false);
});

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
    const base = git('rev-parse', 'HEAD');
    return { directory, git, write, base, close: () => rm(directory, { recursive: true, force: true }) };
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

test('staged checks reject both new and modified JavaScript while allowing untouched legacy files', async () => {
    const f = await fixture();
    try {
        assert.deepEqual(typescriptPolicyViolations(changedPolicyPaths({ kind: 'staged' }, f.directory)), []);
        await f.write('new.mjs');
        await f.write('legacy.js', 'export const value = 2;\n');
        f.git('add', '.');
        assert.deepEqual(typescriptPolicyViolations(changedPolicyPaths({ kind: 'staged' }, f.directory)),
            ['legacy.js', 'new.mjs']);
        // An unstaged restoration must not hide what would actually be committed.
        await f.write('legacy.js');
        assert.ok(typescriptPolicyViolations(changedPolicyPaths({ kind: 'staged' }, f.directory)).includes('legacy.js'));
    } finally { await f.close(); }
});

test('deleting or converting a legacy module is allowed, but moving it to another JavaScript path is not', async () => {
    const f = await fixture();
    try {
        f.git('mv', 'legacy.js', 'renamed.js');
        assert.deepEqual(typescriptPolicyViolations(changedPolicyPaths({ kind: 'staged' }, f.directory)), ['renamed.js']);
        f.git('mv', 'renamed.js', 'converted.ts');
        assert.deepEqual(typescriptPolicyViolations(changedPolicyPaths({ kind: 'staged' }, f.directory)), []);
        f.git('rm', '-f', 'converted.ts');
        assert.deepEqual(typescriptPolicyViolations(changedPolicyPaths({ kind: 'staged' }, f.directory)), []);
    } finally { await f.close(); }
});

test('NUL-delimited paths preserve whitespace, quotes and newlines', async () => {
    const f = await fixture();
    try {
        const file = 'scripts/two words "quoted"\nprobe.js';
        await f.write(file);
        f.git('add', '.');
        assert.deepEqual(typescriptPolicyViolations(changedPolicyPaths({ kind: 'staged' }, f.directory)), [file]);
    } finally { await f.close(); }
});

test('the staged CLI permits a reference upgrade but rejects additional caller changes', async () => {
    const f = await fixture();
    try {
        await f.write('caller.mjs', "import './legacy.js';\n");
        f.git('add', '.'); f.git('commit', '--quiet', '-m', 'legacy caller');
        f.git('mv', 'legacy.js', 'legacy.ts');
        await f.write('caller.mjs', "import './legacy.ts';\n"); f.git('add', '.');
        const run = () => spawnSync(process.execPath, [script, '--staged'], { cwd: f.directory, encoding: 'utf8' });
        const passed = run(); assert.equal(passed.status, 0, passed.stderr);
        await f.write('caller.mjs', "import './legacy.ts';\nconsole.log('changed');\n"); f.git('add', '.');
        const failed = run(); assert.equal(failed.status, 1); assert.match(failed.stderr, /caller\.mjs/);
    } finally { await f.close(); }
});

test('committed comparisons inspect the whole change even when the local hook was bypassed', async () => {
    const f = await fixture();
    try {
        await f.write('new.js');
        f.git('add', '.'); f.git('commit', '--quiet', '-m', 'bypass the local hook');
        const failed = spawnSync(process.execPath, [script, '--base', f.base], { cwd: f.directory, encoding: 'utf8' });
        assert.equal(failed.status, 1, failed.stdout + failed.stderr);
        assert.match(failed.stderr, /new\.js/);
        f.git('mv', 'new.js', 'new.ts'); f.git('commit', '--quiet', '-m', 'convert the module');
        const passed = spawnSync(process.execPath, [script, '--base', f.base], { cwd: f.directory, encoding: 'utf8' });
        assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    } finally { await f.close(); }
});

test('unknown arguments, missing revisions and initial-push comparisons cannot skip the guard', async () => {
    for (const args of [['--skip'], ['--base'], ['--base', ''], ['--staged', '--skip']]) {
        assert.throws(() => policySelection(args), /Usage:/);
    }
    const f = await fixture();
    try {
        assert.throws(() => changedPolicyPaths({ kind: 'committed', base: 'missing-revision' }, f.directory));
        assert.deepEqual(typescriptPolicyViolations(changedPolicyPaths({ kind: 'committed', base: '0'.repeat(40) },
            f.directory)), ['legacy.js']);
        const result = spawnSync(process.execPath, [script, '--base', 'missing-revision'],
            { cwd: f.directory, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not inspect/);
    } finally { await f.close(); }
});

test('the existing pre-commit hook preserves privacy-first ordering and CI checks the committed base', async () => {
    const hook = await readFile(path.join(root, '.githooks/pre-commit'), 'utf8');
    assert.ok(hook.indexOf('privacy-guard.mjs') < hook.indexOf('typescript-policy.mts'));
    assert.match(hook, /typescript-policy\.mts" --staged/);
    const workflow = await readFile(path.join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(workflow, /TYPESCRIPT_POLICY_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
    assert.match(workflow, /npm run check:typescript-policy -- --base "\$TYPESCRIPT_POLICY_BASE"/);
    const release = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(release, /npm run check:typescript-policy -- --base [0-9a-f]{40}/);
    const inventory = await readFile(path.join(root, 'scripts/README.md'), 'utf8');
    for (const file of (await readdir(path.join(root, 'scripts'))).filter(entry => entry.endsWith('.mts'))) {
        assert.ok(inventory.includes(`[${file}](${file})`), `missing TypeScript script inventory entry: ${file}`);
    }
});
