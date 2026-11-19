// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { root } from '../../scripts/build-config.mts';
import { buildWxtBundles } from '../../scripts/wxt-build.mts';

test('the build CLI validates arguments when invoked through a symlinked checkout', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-wxt-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const checkout = path.join(directory, 'checkout');
    await symlink(root, checkout, 'junction');
    const cli = path.join(checkout, 'scripts/build.mts');
    const result = spawnSync(process.execPath, [cli, '--invalid'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Usage: node scripts\/build\.mts/);
});

test('the production WXT backend keeps source order and reads the manifest for each generation', async t => {
    const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-wxt-generation-')));
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
        const { inputPaths } = await buildWxtBundles({ outputDir, projectRoot, entries: [entry] });
        const absoluteInputs = inputPaths.map(file => path.normalize(file));
        assert.ok(absoluteInputs.includes(path.join(projectRoot, 'src', 'first.ts')));
        assert.ok(absoluteInputs.includes(path.join(projectRoot, 'src', 'second.ts')));
        assert.equal(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'), input);
        const order: string[] = [];
        runInNewContext(await readFile(path.join(outputDir, entry.out), 'utf8'), { order });
        assert.deepEqual(order, ['first', 'second']);
    }
    assert.equal(process.env.NODE_ENV, env, 'WXT did not change the caller environment');
});

test('the production WXT backend reports Svelte warnings on a successful build', async t => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'bpb-wxt-diagnostics-'));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    const source = path.join(projectRoot, 'src');
    await mkdir(source);
    await symlink(path.join(root, 'node_modules'), path.join(projectRoot, 'node_modules'), 'junction');
    await writeFile(path.join(source, 'fixture.svelte'), '<button>OK</button><style>.unused { color: red }</style>');
    await writeFile(path.join(source, 'entry.ts'), "import Fixture from './fixture.svelte'; globalThis.fixture = Fixture;\n");
    const { diagnostics } = await buildWxtBundles({ projectRoot, outputDir: path.join(projectRoot, 'candidate'),
        entries: [{ out: 'entry.js', sources: ['entry.ts'] }], manifestPath: null });
    assert.match(diagnostics, /css_unused_selector/);
    assert.match(diagnostics, /fixture\.svelte/);
});
