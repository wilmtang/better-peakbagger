// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { root } from '../../scripts/build-config.mts';
import { buildBundles } from '../../scripts/vite-build.mts';

test('the build CLI validates arguments when invoked through a symlinked checkout', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-vite-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const checkout = path.join(directory, 'checkout');
    await symlink(root, checkout, 'junction');
    const cli = path.join(checkout, 'scripts/build.mts');
    const result = spawnSync(process.execPath, [cli, '--invalid'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Usage: node scripts\/build\.mts/);
});

test('the production Vite backend keeps source order and reads the manifest for each generation', async t => {
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-vite-generation-')));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    const outputDir = path.join(projectRoot, 'candidate');
    const manifest = path.join(projectRoot, 'manifest.json');
    const env = process.env.NODE_ENV;
    await mkdir(path.join(projectRoot, 'src'));
    for (const marker of ['first', 'second']) {
        await writeFile(path.join(projectRoot, 'src', `${marker}.ts`), `globalThis.order.push('${marker}');\n`);
    }
    const entry = { out: 'content/start-head.js', sources: ['first.ts', 'second.ts'] };

    for (const name of ['First extension', 'Edited extension']) {
        const input = JSON.stringify({ manifest_version: 3, name, version: '1.0.0' }, null, 4) + '\n';
        await writeFile(manifest, input);
        const { inputPaths } = await buildBundles({ outputDir, projectRoot, entries: [entry] });
        const absoluteInputs = inputPaths.map(file => path.normalize(file));
        assert.ok(absoluteInputs.includes(path.join(projectRoot, 'src', 'first.ts')));
        assert.ok(absoluteInputs.includes(path.join(projectRoot, 'src', 'second.ts')));
        assert.equal(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'), input);
        const order: string[] = [];
        runInNewContext(await readFile(path.join(outputDir, entry.out), 'utf8'), { order });
        assert.deepEqual(order, ['first', 'second']);
    }
    assert.equal(process.env.NODE_ENV, env, 'the build did not change the caller environment');
});

test('the production Vite backend reports Svelte warnings on a successful build', async t => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'bpb-vite-diagnostics-'));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    const source = path.join(projectRoot, 'src');
    await mkdir(source);
    await symlink(path.join(root, 'node_modules'), path.join(projectRoot, 'node_modules'), 'junction');
    await writeFile(path.join(source, 'fixture.svelte'), '<button>OK</button><style>.unused { color: red }</style>');
    await writeFile(path.join(source, 'entry.ts'), "import Fixture from './fixture.svelte'; globalThis.fixture = Fixture;\n");
    const { diagnostics } = await buildBundles({ projectRoot, outputDir: path.join(projectRoot, 'candidate'),
        entries: [{ out: 'entry.js', sources: ['entry.ts'] }], manifestPath: null });
    assert.match(diagnostics, /css_unused_selector/);
    assert.match(diagnostics, /fixture\.svelte/);
});

test('a generation refuses shipped code that discloses the local checkout path', async t => {
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-vite-local-path-')));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src', 'entry.ts'), `globalThis.where = ${JSON.stringify(projectRoot)};\n`);
    await assert.rejects(buildBundles({ projectRoot, outputDir: path.join(projectRoot, 'candidate'), minify: true,
        entries: [{ out: 'entry.js', sources: ['entry.ts'] }], manifestPath: null }), /contains the local path/);
});

test('module frames name bundled sources relative to the project root', async t => {
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-vite-frame-')));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src', 'shared.ts'), 'export const value = Math.random();\n');
    await writeFile(path.join(projectRoot, 'src', 'frame.ts'), "import { value } from './shared.ts';\nglobalThis.frame = value;\n");
    const outputDir = path.join(projectRoot, 'candidate');
    await buildBundles({ projectRoot, outputDir, minify: true, manifestPath: null,
        entries: [{ out: 'frame.js', sources: ['frame.ts'], format: 'esm' }] });
    const code = await readFile(path.join(outputDir, 'frame.js'), 'utf8');
    assert.doesNotMatch(code, /\.\.\//, 'module region comments must not climb out of the project');
});

test('an unresolved bare import fails the generation instead of shipping a global reference', async t => {
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-vite-unresolved-')));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src', 'entry.ts'), "import { value } from 'not-a-real-package-bpb';\nglobalThis.value = value;\n");
    await assert.rejects(buildBundles({ projectRoot, outputDir: path.join(projectRoot, 'candidate'), manifestPath: null,
        entries: [{ out: 'entry.js', sources: ['entry.ts'] }] }), /not-a-real-package-bpb/);
});

test('a failed entry stops the generation before it returns, and restores NODE_ENV', async t => {
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-vite-failure-')));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src', 'broken.ts'), 'globalThis.broken = (;\n');
    const entries = [{ out: 'broken.js', sources: ['broken.ts'] }];
    for (let index = 0; index < 24; index++) {
        await writeFile(path.join(projectRoot, 'src', `good-${index}.ts`), `globalThis.good${index} = ${index};\n`);
        entries.push({ out: `good-${index}.js`, sources: [`good-${index}.ts`] });
    }
    const outputDir = path.join(projectRoot, 'candidate');
    const env = Object.hasOwn(process.env, 'NODE_ENV') ? process.env.NODE_ENV : undefined;
    await assert.rejects(buildBundles({ projectRoot, outputDir, manifestPath: null, entries, concurrency: 4 }));
    assert.equal(process.env.NODE_ENV, env, 'the failed generation restored the caller environment');
    const written = await readdir(outputDir).catch(() => []);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await readdir(outputDir).catch(() => []), written, 'no build writes after the generation returned');
    // Only builds already in flight beside the failed entry may have written (a bundle and its map each).
    assert.ok(written.length <= 3 * 2, `remaining entries were not started after the failure: ${written.length} files`);
});

test('a release generation also refuses the builder home directory', async t => {
    const home = (await import('node:os')).homedir();
    // The guard skips one-segment homes such as /root, which bundled text
    // could contain legitimately.
    if (home.split(/[/\\]/).filter(Boolean).length < 2) return t.skip(`home directory ${home} is not guarded`);
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-vite-home-')));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src', 'entry.ts'), `globalThis.home = ${JSON.stringify(`${home}/notes.txt`)};\n`);
    const build = (minify: boolean) => buildBundles({ projectRoot, outputDir: path.join(projectRoot, `out-${minify}`), minify,
        manifestPath: null, entries: [{ out: 'entry.js', sources: ['entry.ts'] }] });
    await assert.rejects(build(true), /contains the local path/);
    await build(false);
});
