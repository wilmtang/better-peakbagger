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

test('the removed "minimum trip-report words" control is gone', async () => {
    const dom = await loadOptions({});
    assert.equal(el(dom, 'minwords'), null);
});

test('Strava prototype tests a token without saving it', async () => {
    const dom = await loadOptions({});
    const calls = [];
    dom.window.fetch = async (url, options) => {
        calls.push({ url, options });
        return url.endsWith('/athlete')
            ? { ok: true, status: 200, json: async () => ({ id: 7, firstname: 'Test' }) }
            : { ok: true, status: 200, json: async () => [{ name: 'Morning Hike' }] };
    };

    el(dom, 'strava-token').value = 'secret-test-token';
    el(dom, 'strava-test').click();
    await new Promise(r => dom.window.setTimeout(r, 10));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-test-token');
    assert.match(el(dom, 'strava-result').textContent, /Latest activity: Morning Hike/);
    assert.doesNotMatch(el(dom, 'strava-result').textContent, /secret-test-token/);
    assert.equal(el(dom, 'strava-token').value, '');
    assert.equal(dom.chrome._store.stravaToken, undefined);
});
