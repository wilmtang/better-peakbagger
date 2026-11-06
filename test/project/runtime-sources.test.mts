// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AUTHORED_SOURCE_ROOTS } from '../../scripts/build-config.mts';
import { isRuntimeSource, runtimeSourceFiles, runtimeSources, sourceVariants } from '../helpers/runtime-sources.mts';

test('runtime discovery includes authored code and excludes declarations, generated and upstream files', () => {
    for (const name of ['src/maps/x.js','src/maps/x.ts','src/maps/x.svelte.ts','options/x.svelte','photos/x.tsx','popup/x.mts','src/x.cjs','src/x.cts']) {
        assert.equal(isRuntimeSource(name), true, name);
    }
    for (const name of ['src/x.d.ts','src/x.d.mts','src/x.d.cts','src/x.js.map','src/x.json','src/x.css',
        'src/vendor/x.ts','src/node_modules/x.ts','src/dist/x.js','third_party/x.js','browser-evidence/x.ts','dist/x.ts']) {
        assert.equal(isRuntimeSource(name), false, name);
    }
    assert.equal(isRuntimeSource('src\\vendor\\x.ts'), false);
});
test('discovery uses all build-owned roots, recursively, with deterministic paths and no test/fixture scan', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-runtime-sources-'));
    try {
        for (const entry of AUTHORED_SOURCE_ROOTS) {
            const domain = path.join(directory, entry, 'nested'); await mkdir(domain, {recursive:true});
            await writeFile(path.join(domain, 'feature.ts'), 'export const count: number = 1;');
            await writeFile(path.join(domain, 'card.svelte'), '<script lang="ts">const count: number = 1;</script>');
            await writeFile(path.join(domain, 'types.d.ts'), 'declare const ignored: number;');
        }
        for (const entry of ['test/fixtures', 'scripts', 'dist', 'src/vendor']) {
            await mkdir(path.join(directory, entry), {recursive:true});
            await writeFile(path.join(directory, entry, 'ignored.ts'), 'export const ignored = true;');
        }
        const files = await runtimeSourceFiles(directory);
        assert.deepEqual(files.map(file => path.relative(directory, file)), AUTHORED_SOURCE_ROOTS.flatMap(entry =>
            [path.join(entry,'nested/card.svelte'),path.join(entry,'nested/feature.ts')]).sort());
        const sources = await runtimeSources(directory);
        assert.equal(sources.length, AUTHORED_SOURCE_ROOTS.length * 2);
        assert.ok(sources.every(source => source.file.includes('/nested/') && source.variants.length === 2));
        await rm(path.join(directory, AUTHORED_SOURCE_ROOTS[0]), {recursive:true});
        await assert.rejects(runtimeSourceFiles(directory), {code:'ENOENT'});
    } finally {await rm(directory, {recursive:true, force:true});}
});
test('policy text retains original evidence and exposes typed declarations and calls inside TS and Svelte scripts', () => {
    for (const [file, text] of [
        ['options/view.tsx', 'const view = <button onClick={() => Settings.get<unknown>()}/>; let pref: string = "system";'],
        ['src/maps/feature.ts', "let pref: string = 'system'; Settings.get<unknown>();"],
        ['options/card.svelte', '<script lang="ts">let pref: string = "system"; Settings.get<unknown>();</script><button onclick={() => fetch("/x")}>Go</button>'],
    ]) {
        const variants = sourceVariants(file, text);
        assert.equal(variants[0], text);
        assert.match(variants[1], /let pref = ['"]system['"]/);
        assert.match(variants[1], /Settings\.get\(\)/);
        if (file.endsWith('.svelte')) assert.match(variants[1], /onclick=\{\(\) => fetch/);
    }
});
