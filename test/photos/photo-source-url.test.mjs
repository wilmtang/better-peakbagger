// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPhotoSourceUrl } from '../../src/photos/photo-source-url.js';

test('clicked remote images are bounded and fetched without credentials or referrer', async () => {
    let options;
    const file = await readPhotoSourceUrl('https://images.example/ridge.png', {
        maxBytes: 16,
        fetchFn: async (_url, init) => { options = init; return new Response('pixels', { headers: { 'content-type': 'image/png' } }); },
    });
    assert.equal(await file.text(), 'pixels');
    assert.equal(file.name, 'ridge.png');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
});

test('insecure sources, HTML responses, empty files and dishonest size headers are refused', async () => {
    for (const url of ['http://images.example/a.png', 'https://user:secret@images.example/a.png']) {
        await assert.rejects(readPhotoSourceUrl(url, { maxBytes: 4, fetchFn: () => { throw new Error('must not fetch'); } }), /HTTPS/);
    }
    for (const response of [new Response('oops'), new Response('', { headers: { 'content-type': 'image/png' } }), new Response('oversized', { headers: { 'content-type': 'image/png', 'content-length': '1' } })]) {
        await assert.rejects(readPhotoSourceUrl('https://images.example/a.png', { maxBytes: 4, fetchFn: async () => response }));
    }
});
