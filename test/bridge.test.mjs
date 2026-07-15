// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The settings bridge is the only write path from the page MAIN world into
// chrome.storage. It must accept exactly the keys the GPX Analyzer owns and
// drop everything else, so page-world code can never flip feature gates or
// capture privacy options.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub, waitFor } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadBridge = async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        runScripts: 'outside-only'
    });
    dom.chrome = makeChromeStub();
    dom.window.chrome = dom.chrome;
    dom.window.eval(await readFile(path.join(root, 'src', 'settings.js'), 'utf8'));
    dom.window.eval(await readFile(path.join(root, 'src', 'bridge.js'), 'utf8'));
    return dom;
};

const sendToBridge = (dom, patch) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window,
    origin: dom.window.location.origin,
    data: { __bpb: true, dir: 'toCS', kind: 'set', patch }
}));

test('the bridge writes only analyzer-owned settings keys', async () => {
    const dom = await loadBridge();
    sendToBridge(dom, {
        units: 'metric',
        mapRouteColor: '#123abc',
        enable3dMap: true,
        theme: 'dark',
        retainWaypoints: false
    });
    await waitFor(dom, () => dom.chrome._store.bpbSettings);

    const stored = dom.chrome._store.bpbSettings;
    assert.equal(stored.units, 'metric');
    assert.equal(stored.mapRouteColor, '#123abc');
    assert.equal(stored.enable3dMap, false, 'page-world writes must not flip extension feature gates');
    assert.equal(stored.theme, 'system', 'page-world writes must not change the theme');
    assert.equal(stored.retainWaypoints, true, 'page-world writes must not change capture privacy options');
    dom.window.close();
});

test('a patch containing no writable keys never reaches storage', async () => {
    const dom = await loadBridge();
    sendToBridge(dom, { enable3dMap: true, fillTripInfo: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dom.chrome._store.bpbSettings, undefined);
    dom.window.close();
});
