// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ENTRIES, COPY_FILES, VENDOR_COPY, GENERATED_FILES } from '../../scripts/build-config.mjs';

test('layout verification loads only assets declared by the build', async () => {
    const source = await readFile(new URL('../../scripts/verify-layout-stability.mjs', import.meta.url), 'utf8');
    const shipped = new Set([...ENTRIES.map(entry => entry.out), ...COPY_FILES.map(([, output]) => output),
        ...VENDOR_COPY.map(([, output]) => output), ...GENERATED_FILES]);
    const assets = [...source.matchAll(/\basset\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
    assert.ok(assets.length >= 5, 'the guard must inspect the verifier’s literal asset calls');
    for (const asset of assets) assert.ok(shipped.has(asset), `Layout verifier references an unshipped asset: ${asset}`);
});
