// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { prepareOnxImport } from '../../src/onx/onx-import.js';

const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>';

const run = async ({ url = 'https://backcountry.onxmaps.com/backcountry/map/content/import', body = '', ready = true } = {}) => {
    const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url, runScripts: 'outside-only' });
    const win = dom.window;
    win.DataTransfer = class {
        constructor() {
            const files = [];
            this.items = { add: file => files.push(file) };
            this.files = files;
        }
    };
    const input = win.document.getElementById('add-files-input');
    if (input) {
        Object.defineProperty(input, 'files', { value: [], writable: true });
        input.addEventListener('change', () => {
            if (!ready) return;
            const item = win.document.createElement('div');
            item.dataset.test = 'file-item';
            win.document.body.append(item);
            win.document.querySelector('[data-test="import-card-import-button"]').disabled = false;
        });
    }
    const clicks = { import: 0 };
    win.document.querySelector('[data-test="import-card-import-button"]')
        ?.addEventListener('click', () => { clicks.import++; });
    const result = await win.eval(
        `(${prepareOnxImport.toString()})({gpx:${JSON.stringify(GPX)},filename:"peakbagger-42.gpx",timeoutMs:150})`,
    );
    dom.window.close();
    return { result: structuredClone(result), clicks };
};

test('onX adapter supplies the exact GPX and leaves final Import untouched', async () => {
    const { result, clicks } = await run({ body: [
        '<input id="add-files-input" type="file" accept=".gpx,.kml">',
        '<button data-test="import-card-import-button" disabled>Import</button>',
    ].join('') });
    assert.deepEqual(result, {
        ok: true,
        supplied: true,
        code: 'prepared',
        message: 'Ready in onX. Review the file and click Import.',
    });
    assert.equal(clicks.import, 0);
});

test('onX adapter sends no file when membership or page identity is wrong', async () => {
    const membership = await run({ body: '<button data-test="upgrade-now-button">Upgrade now</button>' });
    assert.equal(membership.result.code, 'membership-required');
    assert.equal(membership.result.supplied, false);

    const wrong = await run({
        url: 'https://backcountry.onxmaps.com/hunt/map/content/import',
        body: '<input id="add-files-input" type="file" accept=".gpx">',
    });
    assert.equal(wrong.result.code, 'wrong-page');
    assert.equal(wrong.result.supplied, false);
});

test('onX adapter reports an unconfirmed post-supply state without retrying itself', async () => {
    const { result } = await run({
        ready: false,
        body: [
            '<input id="add-files-input" type="file" accept=".gpx,.kml">',
            '<button data-test="import-card-import-button" disabled>Import</button>',
        ].join(''),
    });
    assert.equal(result.code, 'handoff-unconfirmed');
    assert.equal(result.supplied, true);
    assert.match(result.message, /Check this onX tab before sending again/);
});
