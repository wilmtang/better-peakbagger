// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The settings bridge is the only write path from the page MAIN world into
// chrome.storage. It must accept exactly the keys the GPX Analyzer owns and
// drop everything else, so page-world code can never flip feature gates or
// capture privacy options.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeChromeStub, waitFor, evalBundle } from '../helpers/load-page.mjs';

const loadBridge = async ({ failSet = false } = {}) => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    dom.chrome = makeChromeStub();
    if (failSet) dom.chrome.storage.sync.set = async () => { throw new Error('sync storage unavailable'); };
    dom.window.chrome = dom.chrome;
    dom.postedMessages = [];
    dom.window.postMessage = message => { dom.postedMessages.push(message); };
    await evalBundle(dom.window, 'content/ascent-bridge.js');
    return dom;
};

const sendToBridge = (dom, patch, requestId = 1) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window,
    origin: dom.window.location.origin,
    data: { __bpb: true, dir: 'toCS', kind: 'set', requestId, patch }
}));

test('the bridge writes only analyzer-owned settings keys', async () => {
    const dom = await loadBridge();
    sendToBridge(dom, {
        units: 'metric',
        mapRouteColor: '#123abc',
        enable3dMap: true,
        theme: 'dark',
        retainWaypoints: false,
        fillAscentDetails: false
    });
    await waitFor(dom, () => dom.chrome._store.bpbSettings);

    const stored = dom.chrome._store.bpbSettings;
    assert.equal(stored.units, 'metric');
    assert.equal(stored.mapRouteColor, '#123abc');
    assert.equal(stored.enable3dMap, false, 'page-world writes must not flip extension feature gates');
    assert.equal(stored.theme, 'system', 'page-world writes must not change the theme');
    assert.equal(stored.retainWaypoints, true, 'page-world writes must not change capture privacy options');
    assert.equal(stored.fillAscentDetails, true, 'page-world writes must not change capture autofill options');
    dom.window.close();
});

test('a patch containing no writable keys never reaches storage', async () => {
    const dom = await loadBridge();
    sendToBridge(dom, { enable3dMap: true, fillAscentDetails: false, fillTripInfo: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dom.chrome._store.bpbSettings, undefined);
    dom.window.close();
});

test('a failed settings write tells the page to roll back its optimistic patch', async () => {
    const dom = await loadBridge({ failSet: true });
    sendToBridge(dom, { units: 'metric' }, 17);
    await waitFor(dom, () => dom.postedMessages.some(message =>
        message.kind === 'setResult' && message.requestId === 17));

    assert.deepEqual(
        JSON.parse(JSON.stringify(
            dom.postedMessages.find(message => message.kind === 'setResult' && message.requestId === 17),
        )),
        { __bpb: true, dir: 'toPage', kind: 'setResult', requestId: 17, ok: false },
    );
    assert.equal(dom.chrome._store.bpbSettings, undefined);
    dom.window.close();
});
