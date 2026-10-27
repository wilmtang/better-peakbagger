// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { evalBundle, waitFor } from '../helpers/load-page.mjs';

async function newEditor(t, fetcher) {
    const origin = 'https://extension.example', token = 'auto-editor', saved = [];
    const dom = new JSDOM(await readFile('src/maps/custom-overlay-editor.html', 'utf8'), {
        url: `${origin}/custom-overlay/editor.html#${token}`, runScripts: 'outside-only', pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const win = dom.window, parent = { location: { pathname: '/options/options.html' }, postMessage() {} };
    Object.defineProperty(win, 'parent', { value: parent });win.TextDecoder = TextDecoder;win.fetch = fetcher;
    win.chrome = { runtime: { getURL: path => `${origin}/${path}`, sendMessage: async message => {
        if (message.type === 'CUSTOM_OVERLAYS_GET') return { ok: true, registry: { schemaVersion: 1, revision: saved.length, sources: saved.slice(-1) } };
        if (message.type === 'CUSTOM_OVERLAYS_SAVE') { saved.push(JSON.parse(JSON.stringify(message.source)));return { ok: true }; }
        return { ok: true };
    } } };
    await evalBundle(win, 'custom-overlay/editor.js');
    win.dispatchEvent(new win.MessageEvent('message', { source: parent, origin, data: { __bpbCustomOverlays: true, token, type: 'open', sourceId: '' } }));
    await waitFor(dom, () => win.document.activeElement?.id === 'name');
    const fill = (id, value) => { const input = win.document.getElementById(id);input.value = value;input.dispatchEvent(new win.Event('input', { bubbles: true })); };
    const save = () => win.document.getElementById('form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    return { dom, win, doc: win.document, saved, fill, save };
}

test('new overlays put source configuration and appearance inside collapsed Advanced', async t => {
    const dom = new JSDOM(await readFile('src/maps/custom-overlay-editor.html', 'utf8'));
    t.after(() => dom.window.close());
    const doc = dom.window.document, advanced = doc.getElementById('advanced');
    assert.equal(advanced.open, false);
    for (const id of ['kind', 'format', 'tile-fields', 'bounds', 'appearance']) {
        assert(advanced.contains(doc.getElementById(id)), `${id} should not crowd the initial name-and-URL form`);
    }
});

test('name and JSON URL alone save detected raster, vector and GeoJSON sources with Advanced closed', async t => {
    const cases = [
        { kind: 'raster', data: { tilejson: '3.0.0', minzoom: 2, maxzoom: 14, scheme: 'tms', bounds: [-124, 44, -120, 49], tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'] } },
        { kind: 'mvt', data: { tilejson: '3.0.0', tiles: ['https://tiles.example.com/{z}/{x}/{y}.pbf'], vector_layers: [{ id: 'trails' }] } },
        { kind: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 47] } }] } },
    ];
    for (const entry of cases) await t.test(entry.kind, async t => {
        let calls = 0;const editor = await newEditor(t, async () => { calls++;return new Response(JSON.stringify(entry.data)); });
        editor.fill('name', 'Only name and URL');editor.fill('url', 'https://tiles.example.com/source.json');
        assert.equal(calls, 0, 'typing a URL must not contact its provider');editor.save();
        await waitFor(editor.dom, () => editor.saved.length === 1);
        const source = editor.saved[0];assert.equal(source.kind, entry.kind);assert.equal(source.name, 'Only name and URL');
        assert.equal(editor.doc.getElementById('advanced').open, false);assert.equal(calls, 1, 'detection reads only the supplied document');
        if (entry.kind === 'raster') { assert.equal(source.source.minNativeZoom, 2);assert.equal(source.source.maxNativeZoom, 14);assert.equal(source.source.scheme, 'tms');assert.deepEqual(source.source.bounds, entry.data.bounds); }
        if (entry.kind === 'mvt') assert(source.appearance.rules.every(rule => rule.sourceLayer === 'trails'));
        if (entry.kind === 'geojson') assert.deepEqual(source.appearance.rules.map(rule => rule.geometry), ['point']);
    });
});

test('editing the URL during source detection cancels Save and prevents stale auto-fill', async t => {
    let release;
    const editor = await newEditor(t, () => new Promise(resolve => { release = resolve; }));
    editor.fill('name', 'Keep my edit');editor.fill('url', 'https://tiles.example.com/old.json');editor.save();
    await waitFor(editor.dom, () => !!release);
    editor.fill('url', 'https://tiles.example.com/{z}/{x}/{y}.png');
    release(new Response(JSON.stringify({ tilejson: '3.0.0', minzoom: 8, maxzoom: 10, tiles: ['https://tiles.example.com/old/{z}/{x}/{y}.pbf'], vector_layers: [{ id: 'stale' }] })));
    await waitFor(editor.dom, () => editor.doc.getElementById('save').getAttribute('aria-disabled') === 'false');
    assert.equal(editor.saved.length, 0);assert.equal(editor.doc.getElementById('minimum').value, '0');
    assert.equal(editor.doc.getElementById('url').value, 'https://tiles.example.com/{z}/{x}/{y}.png');
    editor.save();await waitFor(editor.dom, () => editor.saved.length === 1);assert.equal(editor.saved[0].kind, 'raster');
});

test('ambiguous vector layers require one explicit choice and manual source settings survive detection', async t => {
    const editor = await newEditor(t, async () => new Response(JSON.stringify({ tilejson: '3.0.0', minzoom: 2, maxzoom: 14, scheme: 'tms',
        tiles: ['https://tiles.example.com/{z}/{x}/{y}.pbf'], vector_layers: [{ id: 'roads' }, { id: 'trails' }] })));
    editor.fill('name', 'My choice');editor.fill('url', 'https://tiles.example.com/source.json');
    editor.fill('maximum', '12');editor.fill('scheme', 'xyz');editor.fill('bounds', '-123, 45, -122, 47');editor.save();
    await waitFor(editor.dom, () => editor.doc.getElementById('save').getAttribute('aria-disabled') === 'false');
    assert.equal(editor.saved.length, 0);assert.equal(editor.doc.getElementById('advanced').open, true);
    const layer = editor.doc.querySelector('[id$="-sourceLayer"]');editor.fill(layer.id, 'trails');layer.dispatchEvent(new editor.win.Event('change', { bubbles: true }));
    editor.save();await waitFor(editor.dom, () => editor.saved.length === 1);
    assert(editor.saved[0].appearance.rules.every(rule => rule.sourceLayer === 'trails'));assert.equal(editor.saved[0].source.maxNativeZoom, 12);
    assert.equal(editor.saved[0].source.scheme, 'xyz');assert.deepEqual(editor.saved[0].source.bounds, [-123, 45, -122, 47]);
});

test('failed detection retains the name and URL and a subsequent Save can retry', async t => {
    let fail = true;const editor = await newEditor(t, async () => {
        if (fail) throw new Error('network unavailable');
        return new Response(JSON.stringify({ tilejson: '3.0.0', tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'] }));
    });
    editor.fill('name', 'Retain this');editor.fill('url', 'https://tiles.example.com/source.json');editor.save();
    await waitFor(editor.dom, () => editor.doc.getElementById('save').getAttribute('aria-disabled') === 'false');
    assert.equal(editor.saved.length, 0);assert.equal(editor.doc.getElementById('name').value, 'Retain this');
    assert.equal(editor.doc.getElementById('url').value, 'https://tiles.example.com/source.json');assert.equal(editor.doc.getElementById('advanced').open, false);
    fail = false;editor.save();await waitFor(editor.dom, () => editor.saved.length === 1);
});

test('explicit type and format allow manual saving when the metadata endpoint cannot be checked', async t => {
    let calls = 0;const editor = await newEditor(t, async () => { calls++;throw new Error('provider allows only the map origin'); });
    editor.fill('name', 'Manual fallback');editor.fill('url', 'https://tiles.example.com/source.json');
    editor.fill('kind', 'raster');editor.fill('format', 'tilejson');editor.save();
    await waitFor(editor.dom, () => editor.saved.length === 1);
    assert.equal(calls, 0);assert.equal(editor.saved[0].source.metadataUrl, 'https://tiles.example.com/source.json');
});

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
    assert.equal(doc.getElementById('advanced').open, true, 'Edit must expose saved settings without a second hidden step');
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
