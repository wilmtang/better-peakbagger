// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { evalBundle, waitFor } from '../helpers/load-page.mjs';

test('custom source edits retain saved attribution without exposing attribution fields', async t => {
    const token = 'editor-test', origin = 'https://extension.example';
    const dom = new JSDOM(await readFile('src/maps/custom-overlay-editor.html', 'utf8'), {
        url: `${origin}/custom-overlay/editor.html#${token}`, runScripts: 'outside-only', pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const { window } = dom, saved = [];
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Saved topo', kind: 'raster',
        source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: 'Existing provider credit', url: 'https://maps.example.com/credits' },
        appearance: { opacity: 60, rules: [] } };
    const parent = { location: { pathname: '/options/options.html' }, postMessage() {} };
    Object.defineProperty(window, 'parent', { value: parent });
    window.chrome = { runtime: { getURL: path => `${origin}/${path}`, sendMessage: async message => {
        if (message.type === 'CUSTOM_OVERLAYS_GET') return { ok: true, registry: { schemaVersion: 1, revision: 1, sources: [source] } };
        if (message.type === 'CUSTOM_OVERLAYS_SAVE') { saved.push(JSON.parse(JSON.stringify(message.source))); return { ok: true }; }
        return { ok: true };
    } } };
    await evalBundle(window, 'custom-overlay/editor.js');
    const doc = window.document;
    assert.equal(doc.querySelectorAll('#attribution, #attribution-url, #attribution-label, #attribution-url-label').length, 0,
        'neither credit field nor its information control remains in Settings');
    const open = id => window.dispatchEvent(new window.MessageEvent('message', { source: parent, origin,
        data: { __bpbCustomOverlays: true, token, type: 'open', sourceId: id } }));
    open(source.id);
    await waitFor(dom, () => doc.getElementById('name').value === source.name);
    doc.getElementById('name').value = 'Renamed topo';
    doc.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(dom, () => saved.length === 1 && doc.getElementById('save').getAttribute('aria-disabled') === 'false');
    assert.deepEqual(saved[0].attribution, source.attribution, 'a routine edit must not erase the saved provider credit/link');
    assert.equal(saved[0].name, 'Renamed topo');

    open('');
    await waitFor(dom, () => doc.getElementById('name').value === '');
    doc.getElementById('name').value = 'New layer';
    doc.getElementById('url').value = 'https://tiles.example.com/{z}/{x}/{y}.png';
    doc.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(dom, () => saved.length === 2);
    assert.deepEqual(saved[1].attribution, { text: '' }, 'a new source must not inherit the previous source’s credit');
});
