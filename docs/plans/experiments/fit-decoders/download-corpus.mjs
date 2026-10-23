// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
assert.equal(process.argv.length, 3, 'Usage: node download-corpus.mjs /temporary-evaluation-root');
const root = path.resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(new URL('./corpus-manifest.json', import.meta.url)));
assert.equal(manifest.length, 12);
await mkdir(path.join(root, 'corpus'), { recursive: true });
for (const item of manifest) {
    assert.equal(path.basename(item.file), item.file);
    const url = new URL(item.url);
    assert.equal(url.origin, 'https://raw.githubusercontent.com');
    assert(url.pathname.startsWith('/ThomasKuehne/FIT-test-files/69d2c723230a55e2a3a5c46d3e80e1bc253109fd/'));
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert(response.ok, `Corpus request failed: HTTP ${response.status}`);
    const chunks = []; let size = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            assert(size <= item.bytes, 'Corpus response exceeds pinned size');
            chunks.push(value);
        }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks, size);
    assert.equal(size, item.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    await writeFile(path.join(root, 'corpus', item.file), bytes);
}
await writeFile(path.join(root, 'corpus-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Downloaded and hash-verified ${manifest.length} public FIT files.`);
