// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateLayerFetch } from '../../src/maps/custom-private-client.js';
const url = 'https://relay.bpb.example/custom:0537a032-271c-4d11-9b8c-0edc566b47c1/1/tile/2/1/1';
test('private resources never reach native fetch and cross only as typed resource coordinates', async () => {
    let native = 0;const messages = [];
    const fetch = createPrivateLayerFetch({ fallback: async () => { native++;return new Response('public'); },send: async message => { messages.push(message);return { ok: true, bytes: btoa('png'),contentType: 'image/png' }; } });
    assert.equal(await (await fetch(url)).text(), 'png');assert.equal(native, 0);assert.deepEqual(messages[0].coordinates, { z: 2, x: 1, y: 1 });assert(!JSON.stringify(messages[0]).includes('https:'));
    await assert.rejects(fetch(url + '?api_key=forged'));await assert.rejects(fetch(url.replace('/1/1', '/99/1')));assert.equal(native, 0);
    assert.equal(await (await fetch('https://public.example.com/tile.png')).text(), 'public');assert.equal(native, 1);
});
test('private cancellation is prompt, carries only its own request ID, and retains bounded error status for parent-tile fallback', async () => {
    const messages = [], controller = new AbortController();
    const fetch = createPrivateLayerFetch({ send: async message => { messages.push(message);if (message.type === 'CUSTOM_PRIVATE_CANCEL') return { ok: true };return new Promise(() => {}); } });
    const result = fetch(url, { signal: controller.signal });controller.abort();await assert.rejects(result, { name: 'AbortError' });
    assert.equal(messages[1].type, 'CUSTOM_PRIVATE_CANCEL');assert.equal(messages[1].requestId, messages[0].requestId);
    const missing = createPrivateLayerFetch({ send: async () => ({ ok: false,code: 'private-source',status: 404,error: 'Private source unavailable.' }) });
    await assert.rejects(missing(url), error => error.status === 404 && error.code === 'private-source');
});
