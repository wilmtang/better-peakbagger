// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { probeImageDownload, waitForImageDownload, type ImageDownloadIo } from '../../scripts/image-download-completion.mts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const name = 'firefox-verification-topo-topo.png';

test('a final-name placeholder satisfies the old filename gate but not completed image readiness', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bpb-image-download-'));
    try {
        const file = path.join(directory, name);
        await writeFile(file, Buffer.alloc(0));
        const historical = (await readdir(directory)).find(value => /-topo\.(png|jpg)$/.test(value));
        assert.equal(historical, name);
        assert.equal((await readFile(path.join(directory, historical!))).length, 0,
            'the original filename-only postcondition accepts the observed zero-byte defect');
        assert.deepEqual(await probeImageDownload(directory), { state: 'pending', reason: 'incomplete image', name, bytes: 0 });
        await writeFile(file, png.subarray(0, -12));
        assert.equal((await probeImageDownload(directory)).state, 'pending');
        await writeFile(file, png);
        const ready = await probeImageDownload(directory);
        assert.equal(ready.state, 'ready');
        if (ready.state === 'ready') assert.deepEqual(ready.bytes, png);
        await writeFile(`${file}.part`, png);
        assert.deepEqual(await probeImageDownload(directory), { state: 'pending', reason: 'partial file' });
        await unlink(`${file}.part`);
        assert.equal((await probeImageDownload(directory)).state, 'ready');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('polling waits through partial states and returns the exact buffer it accepted without rereading', async () => {
    const stages = [Buffer.alloc(0), png.subarray(0, -1), png];
    let reads = 0;
    const io: ImageDownloadIo = { list: async () => [name], read: async () => stages[reads++] };
    const result = await waitForImageDownload('/fixture', io);
    assert.equal(reads, 3);
    assert.equal(result.name, name);
    assert.equal(result.bytes, png);
});

test('rename disappearance is pending while unexpected read or directory errors settle immediately', async () => {
    const missing = Object.assign(new Error('renaming'), { code: 'ENOENT' });
    assert.equal((await probeImageDownload('/fixture', { list: async () => [name], read: async () => { throw missing; } })).state, 'pending');
    for (const stage of ['list', 'read']) {
        const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        let calls = 0;
        const io: ImageDownloadIo = {
            list: async () => { if (stage === 'list') { calls++; throw failure; } return [name]; },
            read: async () => { calls++; throw failure; },
        };
        await assert.rejects(waitForImageDownload('/fixture', io), error => error === failure);
        assert.equal(calls, 1, 'fatal filesystem errors are not retried by generic polling');
    }
});

test('completion evidence rejects missing markers and unrelated filenames without claiming decoding', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('<html>'), png.subarray(0, -1), png.subarray(1)]) {
        assert.equal((await probeImageDownload('/fixture', { list: async () => [name], read: async () => bytes })).state, 'pending');
    }
    assert.equal((await probeImageDownload('/fixture', { list: async () => ['unrelated.png'], read: async () => { throw new Error('must not read'); } })).state, 'pending');
    const jpegMarkers = Buffer.from('ffd8ffe00000ffd9', 'hex');
    assert.equal((await probeImageDownload('/fixture', { list: async () => ['fixture-topo.jpg'], read: async () => jpegMarkers })).state, 'ready');
});
