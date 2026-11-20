// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://backcountry.onxmaps.com

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { prepareOnxImport, probeOnxImporter } from '../../src/onx/onx-import.ts';

const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>';

const run = async ({ url = 'https://backcountry.onxmaps.com/backcountry/map/content/import', body = '', ready = true } = {}) => {
    const dom = new FixtureDom(`<!doctype html><body>${body}</body>`, { url });
    const win = dom.window;
    const input = win.document.getElementById('add-files-input');
    if (input) {
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
    const expiresAt = Date.now() + 150;
    const probe = win.eval(`(${probeOnxImporter.toString()})({attemptId:"attempt-42",expiresAt:${expiresAt}})`);
    const result = probe.ok ? await win.eval(
        `(${prepareOnxImport.toString()})({gpx:${JSON.stringify(GPX)},filename:"peakbagger-42.gpx",attemptId:"attempt-42",documentNonce:${JSON.stringify(probe.documentNonce)},expiresAt:${expiresAt}})`,
    ) : probe;
    dom.window.close();
    return { result: structuredClone(result), clicks };
};

test('onX adapter supplies the exact GPX and leaves final Import untouched', async () => {
    const { result, clicks } = await run({ body: [
        '<input id="add-files-input" type="file" accept=".gpx,.kml">',
        '<button data-test="import-card-import-button" disabled>Import</button>',
    ].join('') });
    assert.equal(result.ok, true);
    assert.equal(result.supplied, true);
    assert.equal(result.code, 'prepared');
    assert.equal(result.attemptId, 'attempt-42');
    assert.ok(result.documentNonce);
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
    assert.equal(wrong.result.code, 'not-ready');
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
    assert.match(result.message, /Check onX before sending again/);
});

const importerBody = '<input id="add-files-input" type="file" accept=".gpx,.kml"><button data-test="import-card-import-button" disabled>Import</button>';
type Guarded = ReturnType<typeof guarded>;
const guarded = () => {
    const dom = new FixtureDom(importerBody, { url: 'https://backcountry.onxmaps.com/backcountry/map/content/import' });
    const win = dom.window;
    let deliveries = 0;
    const input = win.document.querySelector('input');
    input.addEventListener('change', () => { deliveries++; });
    const probe = (attemptId = 'attempt-first', expiresAt = Date.now() + 100) => structuredClone(win.eval(
        `(${probeOnxImporter.toString()})(${JSON.stringify({ attemptId, expiresAt })})`));
    const deliver = (ready: Record<string, unknown>, options: Record<string, unknown> = {}) => win.eval(`(${prepareOnxImport.toString()})(${JSON.stringify({
        gpx: GPX, filename: 'peakbagger-42.gpx', expiresAt: (win as unknown as { __bpbOnxDocument?: { expiresAt?: number } }).__bpbOnxDocument?.expiresAt,
        ...ready, ...options,
    })})`);
    return { dom, win, probe, deliver, get deliveries() { return deliveries; } };
};

test('queued delivery expires without supplying a file', async () => {
    const h = guarded();
    try {
        const ready = h.probe('attempt-first', Date.now() + 100);
        const result = await h.deliver(ready, { expiresAt: Date.now() - 1 });
        assert.equal(result.supplied, false);
        assert.equal(result.code, 'expired');
        assert.equal(h.deliveries, 0);
    } finally { h.dom.window.close(); }
});

test('delivery rejects a changed document, SPA route, replaced input and new preview', async () => {
    for (const change of [
        (h: Guarded) => { delete (h.win as unknown as { __bpbOnxDocument?: unknown }).__bpbOnxDocument; },
        (h: Guarded) => { h.win.history.replaceState({}, '', '/backcountry/map'); },
        (h: Guarded) => { h.win.document.querySelector('input').outerHTML = '<input id="add-files-input" type="file" accept=".gpx">'; },
        (h: Guarded) => { h.win.document.body.insertAdjacentHTML('beforeend', '<p data-test="file-item">Other file</p>'); },
        (h: Guarded) => { h.win.document.body.insertAdjacentHTML('beforeend', '<button data-test="upgrade-now-button">Upgrade</button>'); },
    ]) {
        const h = guarded();
        try {
            const ready = h.probe(); change(h);
            assert.equal((await h.deliver(ready)).supplied, false);
            assert.equal(h.deliveries, 0);
        } finally { h.dom.window.close(); }
    }
});

test('concurrent delivery and later preflight cannot reset a document delivery latch', async () => {
    const h = guarded();
    try {
        const ready = h.probe();
        const first = h.deliver(ready);
        const second = await h.deliver(ready);
        assert.equal(second.supplied, false);
        assert.equal(second.code, 'existing-preview');
        assert.equal(h.probe('attempt-second').code, 'existing-preview');
        assert.equal(h.deliveries, 1);
        assert.equal((await first).supplied, true);
    } finally { h.dom.window.close(); }
});
