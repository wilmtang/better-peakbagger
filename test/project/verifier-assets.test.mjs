// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { ENTRIES, COPY_FILES, VENDOR_COPY, GENERATED_FILES } from '../../scripts/build-config.mjs';

test('layout verification loads only assets declared by the build', async () => {
    const source = await readFile(new URL('../../scripts/verify-layout-stability.mjs', import.meta.url), 'utf8');
    const shipped = new Set([...ENTRIES.map(entry => entry.out), ...COPY_FILES.map(([, output]) => output),
        ...VENDOR_COPY.map(([, output]) => output), ...GENERATED_FILES]);
    const assets = [...source.matchAll(/\basset\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
    assert.ok(assets.length >= 5, 'the guard must inspect the verifier’s literal asset calls');
    for (const asset of assets) assert.ok(shipped.has(asset), `Layout verifier references an unshipped asset: ${asset}`);
});

test('the script inventory registers every current module exactly once', async () => {
    const source = await readFile(new URL('../../scripts/README.md', import.meta.url), 'utf8');
    const registered = [...source.matchAll(/\[([^\]]+\.mjs)\]\(([^)]+)\)/g)];
    for (const [, name, target] of registered) assert.equal(name, target, 'inventory links point to their named module');
    const names = registered.map(match => match[1]);
    assert.equal(new Set(names).size, names.length, 'a module belongs to one inventory group');
    const current = (await readdir(new URL('../../scripts/', import.meta.url))).filter(name => name.endsWith('.mjs'));
    assert.deepEqual(names.sort(), current.sort(), 'add or remove the matching inventory entry when scripts change');
});
