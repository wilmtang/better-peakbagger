// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { ENTRIES, COPY_FILES, VENDOR_COPY, GENERATED_FILES } from '../../scripts/build-config.mts';

const inventoryEntries = (source: string) =>
    [...source.matchAll(/\[([^\]]+\.m[jt]s)\]\(([^)]+)\)/g)];
const scriptModules = (names: string[]) => names.filter(name => /\.m[jt]s$/.test(name));

test('script inventory discovery includes TypeScript tooling beside legacy modules', () => {
    const source = '[legacy.mjs](legacy.mjs)\n[typed.mts](typed.mts)\n[guide.md](guide.md)';
    assert.deepEqual(inventoryEntries(source).map(match => [match[1], match[2]]),
        [['legacy.mjs', 'legacy.mjs'], ['typed.mts', 'typed.mts']]);
    assert.deepEqual(scriptModules(['legacy.mjs', 'typed.mts', 'guide.md']), ['legacy.mjs', 'typed.mts']);
});

test('layout verification loads only assets declared by the build', async () => {
    const source = await readFile(new URL('../../scripts/verify-layout-stability.mts', import.meta.url), 'utf8');
    const shipped = new Set([...ENTRIES.map(entry => entry.out), ...COPY_FILES.map(([, output]) => output),
        ...VENDOR_COPY.map(([, output]) => output), ...GENERATED_FILES]);
    const assets = [...source.matchAll(/\basset\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
    assert.ok(assets.length >= 5, 'the guard must inspect the verifier’s literal asset calls');
    for (const asset of assets) assert.ok(shipped.has(asset), `Layout verifier references an unshipped asset: ${asset}`);
});

test('the script inventory registers every current module exactly once', async () => {
    const source = await readFile(new URL('../../scripts/README.md', import.meta.url), 'utf8');
    const registered = inventoryEntries(source);
    for (const [, name, target] of registered) assert.equal(name, target, 'inventory links point to their named module');
    const names = registered.map(match => match[1]);
    assert.equal(new Set(names).size, names.length, 'a module belongs to one inventory group');
    const current = scriptModules(await readdir(new URL('../../scripts/', import.meta.url)));
    assert.deepEqual(names.sort(), current.sort(), 'add or remove the matching inventory entry when scripts change');
});
