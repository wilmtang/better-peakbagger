// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { MAX_ALLTRAILS_GPX_BYTES, prepareAlltrailsImport } from '../../src/alltrails/alltrails-import.js';

const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>';

test('AllTrails handoff uses the published 20 MB decimal byte cap', () => {
    assert.equal(MAX_ALLTRAILS_GPX_BYTES, 20_000_000);
});

const run = async ({
    url = 'https://www.alltrails.com/explore/custom-routes/new',
    ready = true,
    before = '',
    gpx = GPX,
    inputLabel = 'hidden file upload',
    delayedInput = false,
    inputDelayMs = 25,
    duplicateInput = false,
    portal = false,
    portalClass = 'dz-hidden-input',
    accept = '.gpx,.GPX,.fit',
} = {}) => {
    const dom = new JSDOM(`<!doctype html><body>${before}<button id="open">Upload a route</button></body>`, {
        url,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const win = dom.window;
    // Measure fixture deadlines against scheduled timer time. A busy runner
    // can resume a 100 ms poll after the entire 150 ms fixture budget passes.
    let clockMs = 0;
    const schedule = win.setTimeout.bind(win);
    win.Date.now = () => clockMs;
    win.setTimeout = (callback, delay) => {
        const dueAt = clockMs + delay;
        return schedule(() => {
            clockMs = Math.max(clockMs, dueAt);
            callback();
        }, delay);
    };
    win.HTMLElement.prototype.getClientRects = () => [{ width: 1, height: 1 }];
    win.DataTransfer = class {
        constructor() {
            const files = [];
            this.items = { add: file => files.push(file) };
            this.files = files;
        }
    };
    let uploadClicks = 0;
    let handoffs = 0;
    let received;
    win.document.getElementById('open').addEventListener('click', () => {
        const dialog = win.document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<h2>Upload a route</h2>';
        const input = win.document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        if (inputLabel) input.setAttribute('aria-label', inputLabel);
        Object.defineProperty(input, 'files', { value: [], writable: true });
        input.addEventListener('change', () => {
            handoffs++;
            received = input.files[0];
            if (!ready) return;
            input.remove();
            dialog.insertAdjacentHTML('beforeend', [
                '<div title="peakbagger-42.gpx">peakbagger-42.gpx</div>',
                '<button id="upload">Upload</button>',
            ].join(''));
            dialog.querySelector('#upload').addEventListener('click', () => { uploadClicks++; });
        });
        win.document.body.append(dialog);
        const mount = () => {
            const parent = portal ? win.document.body : dialog;
            if (portal) input.className = portalClass;
            parent.append(input);
            if (duplicateInput) parent.append(input.cloneNode());
        };
        if (delayedInput) win.setTimeout(mount, inputDelayMs);
        else mount();
    });
    const result = await win.eval(
        `(${prepareAlltrailsImport.toString()})({gpx:${JSON.stringify(gpx)},filename:"peakbagger-42.gpx",timeoutMs:150})`,
    );
    const receivedText = received ? await new Promise(resolve => {
        const reader = new win.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsText(received);
    }) : null;
    dom.window.close();
    return { result: structuredClone(result), uploadClicks, handoffs, receivedText };
};

test('AllTrails adapter supplies the exact GPX and leaves final Upload untouched', async () => {
    const { result, uploadClicks } = await run();
    assert.deepEqual(result, {
        ok: true,
        supplied: true,
        code: 'prepared',
        message: 'Ready in AllTrails. Review the route and click Upload.',
    });
    assert.equal(uploadClicks, 0);
});

for (const options of [
    { inputLabel: 'hidden file upload', delayedInput: true },
    { inputLabel: null, delayedInput: false },
    { inputLabel: 'Browse files', delayedInput: false },
    { portal: true, delayedInput: true },
    { portal: true, before: '<input type="file" class="dz-hidden-input" accept=".gpx">' },
]) {
    test(`AllTrails accepts its scoped GPX control: ${JSON.stringify(options)}`, async () => {
        const { result, handoffs, receivedText, uploadClicks } = await run({
            ...options,
        });
        assert.equal(result.code, 'prepared');
        assert.equal(handoffs, 1);
        assert.equal(receivedText, GPX);
        assert.equal(uploadClicks, 0);
    });
}

test('AllTrails fixture still rejects an input mounted beyond its polling deadline', async () => {
    const { result, handoffs, uploadClicks } = await run({ delayedInput: true, inputDelayMs: 250 });
    assert.equal(result.code, 'importer-unavailable');
    assert.equal(result.supplied, false);
    assert.equal(handoffs, 0);
    assert.equal(uploadClicks, 0);
});

test('AllTrails does not supply an ambiguous or non-GPX file control', async () => {
    for (const options of [{ duplicateInput: true }, { accept: 'image/*' },
        { portal: true, duplicateInput: true }, { portal: true, accept: 'image/*' }]) {
        const { result, handoffs, uploadClicks } = await run(options);
        assert.equal(result.code, 'ambiguous-input');
        assert.equal(result.supplied, false);
        assert.equal(handoffs, 0);
        assert.equal(uploadClicks, 0);
    }
});

test('AllTrails never borrows an unrelated body-level file input', async () => {
    const { result, handoffs } = await run({ portal: true, portalClass: 'unrelated',
        before: '<input type="file" class="dz-hidden-input" accept=".gpx">' });
    assert.equal(result.code, 'importer-unavailable');
    assert.equal(result.supplied, false);
    assert.equal(handoffs, 0);
});

test('AllTrails adapter sends no file when page identity or importer state is ambiguous', async () => {
    const wrong = await run({ url: 'https://www.alltrails.com/explore' });
    assert.equal(wrong.result.code, 'wrong-page');
    assert.equal(wrong.result.supplied, false);

    const existing = await run({ before: '<div role="dialog"><h2>Upload a route</h2></div>' });
    assert.equal(existing.result.code, 'existing-preview');
    assert.equal(existing.result.supplied, false);
});

test('AllTrails adapter rejects a GPX above 20 million bytes before opening the uploader', async () => {
    const { result, uploadClicks } = await run({ gpx: 'x'.repeat(MAX_ALLTRAILS_GPX_BYTES + 1) });
    assert.equal(result.code, 'invalid-payload');
    assert.equal(result.supplied, false);
    assert.equal(uploadClicks, 0);
});

test('AllTrails adapter reports an unconfirmed post-supply state without uploading', async () => {
    const { result, uploadClicks } = await run({ ready: false });
    assert.equal(result.code, 'handoff-unconfirmed');
    assert.equal(result.supplied, true);
    assert.match(result.message, /Check this AllTrails tab before sending again/);
    assert.equal(uploadClicks, 0);
});
