// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { prepareCaltopoImport, MAX_CALTOPO_GPX_BYTES } from '../../src/caltopo/caltopo-import.js';

const GPX = '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>';
const run = async ({ url = 'https://caltopo.com/map.html', before = '', duplicate = false,
    ready = true, empty = false, gpx = GPX, filename = 'peakbagger-42.gpx', repeat = false } = {}) => {
    const dom = new JSDOM(`<div id="page_left"><div class="action-button-js"><img src="/static/images/import.svg">Import</div></div>${before}`, {
        url, runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const win = dom.window;
    win.HTMLElement.prototype.getClientRects = function () { return this.style.display === 'none' ? [] : [{}]; };
    win.DataTransfer = class {
        constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
    };
    let handoffs = 0, imports = 0, received;
    win.document.querySelector('.action-button-js').onclick = () => {
        const panel = win.document.createElement('div'); panel.className = 'yui-panel';
        panel.innerHTML = '<div class="hd">Importer</div><input id="file" type="file"><button>Import</button>';
        const input = panel.querySelector('input');
        Object.defineProperty(input, 'files', { writable: true, value: [] });
        panel.querySelector('button').onclick = () => { throw new Error('adapter must not click Import'); };
        input.onchange = () => {
            received = input.files[0]; handoffs++;
            if (!ready) return;
            panel.style.display = 'none';
            const preview = win.document.createElement('div'); preview.className = 'yui-panel';
            preview.innerHTML = '<div class="hd">Import Data</div><table><tbody>'
                + (empty ? '' : '<tr><td><input type="checkbox" checked><input type="text" value="Saved ascent"></td></tr>')
                + '</tbody></table><button>Import</button>';
            preview.querySelector('button').onclick = () => imports++;
            win.document.body.append(preview);
        };
        if (duplicate) panel.append(input.cloneNode());
        win.document.body.append(panel);
    };
    const args = JSON.stringify({ gpx, filename, timeoutMs: 100 });
    const invoke = () => win.eval(`(${prepareCaltopoImport.toString()})(${args})`);
    const result = structuredClone(await invoke());
    const second = repeat ? structuredClone(await invoke()) : null;
    const text = received ? await new Promise(resolve => {
        const reader = new win.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(received);
    }) : null;
    win.close();
    return { result, second, handoffs, imports, text };
};

test('CalTopo receives the exact file and stops at its populated object review', async () => {
    const r = await run({ repeat: true });
    assert.equal(r.result.code, 'prepared');
    assert.equal(r.result.supplied, true);
    assert.equal(r.text, GPX);
    assert.equal(r.handoffs, 1);
    assert.equal(r.imports, 0);
    assert.equal(r.second.code, 'existing-preview');
});

test('CalTopo rejects wrong origins, saved maps, queries, and invalid payloads before supply', async () => {
    for (const options of [{ url: 'https://example.com/map.html' }, { url: 'https://caltopo.com/m/ABCD' },
        { url: 'https://caltopo.com/map.html?id=ABCD' }, { filename: 'other.gpx' },
        { gpx: 'x'.repeat(MAX_CALTOPO_GPX_BYTES + 1) }]) {
        const r = await run(options);
        assert.equal(r.result.ok, false); assert.equal(r.handoffs, 0); assert.equal(r.imports, 0);
    }
});

test('CalTopo refuses existing previews and ambiguous file controls', async () => {
    for (const options of [{ before: '<div class="yui-panel"><div class="hd">Import Data</div></div>' },
        { before: '<div class="yui-panel"><div class="hd">Importer</div></div>' }, { duplicate: true }]) {
        const r = await run(options);
        assert.equal(r.result.ok, false); assert.equal(r.result.supplied, false); assert.equal(r.handoffs, 0);
    }
});

test('CalTopo treats empty or stalled reviews as uncertain and never supplies twice', async () => {
    for (const options of [{ empty: true }, { ready: false }]) {
        const r = await run({ ...options, repeat: true });
        assert.equal(r.result.code, 'handoff-unconfirmed'); assert.equal(r.result.supplied, true);
        assert.match(r.result.message, /Check this CalTopo tab/);
        assert.equal(r.handoffs, 1); assert.equal(r.imports, 0);
        assert.equal(r.second.ok, false);
    }
});
