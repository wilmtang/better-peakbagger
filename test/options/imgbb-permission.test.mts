// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions as untypedLoadOptions, registerCleanup } from '../helpers/options-helpers.mjs';
import { waitFor } from '../helpers/load-page.mjs';
import type { LoadPage, StubMessage } from '../helpers/page-types.mts';

registerCleanup();

const loadOptions = untypedLoadOptions as unknown as LoadPage;

// Firefox refuses permissions.request() once the click handler has awaited
// anything, including permissions.contains(). The request must be the first
// call the Save click makes.
test('Save key asks for the ImgBB permission before anything awaits', async () => {
    const order: string[] = [];
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.permissions = {
            contains: async () => { order.push('contains'); return false; },
            request: () => { order.push('request'); return Promise.resolve(true); },
        };
        chrome.runtime.sendMessage = async (message: StubMessage) => {
            if (message.type === 'PHOTO_IMGBB_SAVE_KEY') { order.push('save'); return { ok: true }; }
            return { ok: true, configured: false, permissionGranted: false };
        };
    } });
    const doc = dom.window.document;
    await waitFor(dom, () => /No key saved/.test(doc.getElementById('imgbb-key-status').textContent));
    doc.getElementById('imgbb-key').value = 'abcdef0123456789abcdef0123456789';
    order.length = 0;
    doc.getElementById('imgbb-key-save').click();
    assert.deepEqual(order, ['request'], 'the request runs synchronously inside the click');
    await waitFor(dom, () => /configured on this device/.test(doc.getElementById('imgbb-key-status').textContent));
    assert.deepEqual(order, ['request', 'save']);
});

test('a declined permission leaves the key unsaved with a way to retry', async () => {
    const saved: string[] = [];
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.permissions = { contains: async () => false, request: () => Promise.resolve(false) };
        chrome.runtime.sendMessage = async (message: StubMessage) => {
            if (message.type === 'PHOTO_IMGBB_SAVE_KEY') saved.push(String(message.key));
            return { ok: true, configured: false, permissionGranted: false };
        };
    } });
    const doc = dom.window.document;
    await waitFor(dom, () => /No key saved/.test(doc.getElementById('imgbb-key-status').textContent));
    doc.getElementById('imgbb-key').value = 'abcdef0123456789abcdef0123456789';
    doc.getElementById('imgbb-key-save').click();
    await waitFor(dom, () => /choose Save key again/.test(doc.getElementById('imgbb-key-status').textContent));
    assert.deepEqual(saved, []);
});
