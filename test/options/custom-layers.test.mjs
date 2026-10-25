// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, registerCleanup, waitFor } from '../helpers/options-helpers.mjs';

registerCleanup();
const source = (digit, name) => ({ id: `custom:${digit}537a032-271c-4d11-9b8c-0edc566b47c1`, revision: 1, name, kind: 'raster',
    source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
    approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [] } });

test('Options reorders stable rows, guards pending/edge activation, preserves focus and uses registry revisions', async () => {
    const first = source('0', 'Topo'), second = source('1', 'Contours'), messages = [];
    let sources = [first, second], revision = 7, finish, failed = false;
    const dom = await loadOptions({ theme: 'dark' }, { prepareChrome(chrome) {
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'CUSTOM_OVERLAYS_GET') return { ok: true, registry: { schemaVersion: 1, revision, sources }, preferences: {} };
            if (message.type === 'CUSTOM_OVERLAYS_REORDER') {
                messages.push(message); await new Promise(resolve => { finish = resolve; });
                if (!failed) { failed = true; return { ok: false, error: 'Layer order could not be saved. Try again.' }; }
                sources = message.ids.map(id => sources.find(item => item.id === id)); revision++;
                return { ok: true, registry: { schemaVersion: 1, revision, sources }, preferences: {} };
            }
            return {};
        };
    } });
    const doc = dom.window.document; await waitFor(dom, () => doc.querySelectorAll('#custom-layer-list li').length === 2);
    const row = doc.querySelectorAll('#custom-layer-list li')[1], up = row.querySelector('.custom-layer-order button');
    up.focus(); up.click(); up.click(); assert.equal(messages.length, 1); assert.equal(messages[0].expectedRevision, 7);
    assert.strictEqual(doc.querySelectorAll('#custom-layer-list li')[1], row, 'pending write leaves rows anchored');
    finish(); await waitFor(dom, () => !doc.getElementById('status-error').hidden);
    assert.strictEqual(doc.querySelectorAll('#custom-layer-list li')[1], row, 'failed write preserves order');
    assert.strictEqual(doc.activeElement, up); assert.equal(up.getAttribute('aria-disabled'), 'false');
    up.click(); assert.equal(messages.length, 2); assert.equal(messages[1].expectedRevision, 7);
    finish(); await waitFor(dom, () => doc.querySelector('#custom-layer-list li') === row);
    assert.strictEqual(doc.activeElement, up); assert.equal(up.getAttribute('aria-disabled'), 'true');
    up.click(); assert.equal(messages.length, 2, 'edge control cannot reorder out of bounds');
    assert.equal(doc.documentElement.dataset.bpbTheme, 'dark');
    assert.match(doc.getElementById('custom-layer-order-status').textContent, /Contours moved to position 1 of 2/);
});
