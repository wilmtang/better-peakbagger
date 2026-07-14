// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drives the real options page (options.html + settings.js + options.js) in
// jsdom against a chrome.storage stub, so the settings UI is exercised end to
// end without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadOptions = async (settings = {}) => {
    const html = await readFile(path.join(root, 'options', 'options.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'chrome-extension://bpb/options/options.html',
        runScripts: 'outside-only'
    });
    dom.chrome = makeChromeStub({ bpbSettings: settings });
    dom.window.chrome = dom.chrome;
    dom.window.eval(await readFile(path.join(root, 'src', 'settings.js'), 'utf8'));
    dom.window.eval(await readFile(path.join(root, 'options', 'options.js'), 'utf8'));
    await new Promise(r => dom.window.setTimeout(r, 20)); // S.get().then(populate)
    return dom;
};

const el = (dom, id) => dom.window.document.getElementById(id);

test('chart-series select populates from the stored setting', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'time' });
    assert.equal(el(dom, 'chart-series').value, 'time');
});

test('changing chart-series saves it to chrome.storage', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'both' });
    const sel = el(dom, 'chart-series');
    sel.value = 'distance';
    sel.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.chartDefaultSeries, 'distance');
});

test('an invalid chartDefaultSeries is cleaned to the default', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'bogus' });
    assert.equal(el(dom, 'chart-series').value, 'both');
});

test('map route appearance populates, enforces a visible casing, and saves edits', async () => {
    const dom = await loadOptions({
        mapRouteColor: '#2457A7',
        mapRouteWidth: 8,
        mapRouteCasingColor: 'not-a-color',
        mapRouteCasingWidth: 4
    });

    assert.equal(el(dom, 'map-route-color').value, '#2457a7');
    assert.equal(el(dom, 'map-route-width').value, '8');
    assert.equal(el(dom, 'map-route-casing-color').value, '#ffffff');
    assert.equal(el(dom, 'map-route-casing-width').value, '10');

    const routeWidth = el(dom, 'map-route-width');
    routeWidth.value = '11';
    routeWidth.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapRouteWidth, 11);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingWidth, 13);

    const casingColor = el(dom, 'map-route-casing-color');
    casingColor.value = '#efe8d5';
    casingColor.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingColor, '#efe8d5');
});

test('the removed "minimum trip-report words" control is gone', async () => {
    const dom = await loadOptions({});
    assert.equal(el(dom, 'minwords'), null);
});
