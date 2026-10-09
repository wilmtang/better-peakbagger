// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as nextTask } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { makeChromeStub, evalBundle, waitFor } from '../helpers/load-page.mjs';

const load = async ({ theme = 'light', cached = null, prepare = () => {} } = {}) => {
    const dom = new JSDOM('<html><body></body></html>', {
        url: 'https://panel.better-peakbagger.test', runScripts: 'outside-only',
    });
    dom.chrome = makeChromeStub({ bpbSettings: { theme } });
    dom.window.chrome = dom.chrome;
    if (cached) dom.window.localStorage.setItem('bpbThemePref', cached);
    prepare(dom);
    await evalBundle(dom.window, 'options/options-head.js');
    return dom;
};
const rendered = dom => dom.window.document.documentElement.dataset.bpbTheme;

test('an open panel follows stored light/dark preferences and updates its mirror', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    await waitFor(dom, () => dom.window.localStorage.getItem('bpbThemePref') === 'light');
    for (const theme of ['dark', 'light']) {
        await dom.chrome.storage.sync.set({ bpbSettings: { theme } });
        assert.equal(rendered(dom), theme);
        assert.equal(dom.window.localStorage.getItem('bpbThemePref'), theme);
    }
});

test('an old panel read cannot overwrite a later stored preference', async t => {
    let release;
    const dom = await load({ prepare: dom => {
        const get = dom.chrome.storage.sync.get;
        dom.chrome.storage.sync.get = async key => {
            const snapshot = await get(key);
            await new Promise(resolve => { release = resolve; });
            return snapshot;
        };
    } }); t.after(() => dom.window.close());
    await waitFor(dom, () => !!release);
    await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'dark' } });
    release();
    await nextTask(0); // Drain the released read's promise chain, not a timing gate.
    assert.equal(rendered(dom), 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
});

test('a failed panel read preserves an explicit pre-paint mirror', async t => {
    let warnings = 0;
    const dom = await load({ cached: 'dark', prepare: dom => {
        dom.window.console.warn = () => { warnings++; };
        dom.chrome.storage.sync.get = async () => { throw new Error('storage unavailable'); };
    } }); t.after(() => dom.window.close());
    await waitFor(dom, () => warnings === 1);
    assert.equal(rendered(dom), 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
    await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'light' } });
    assert.equal(rendered(dom), 'light');
});

for (const legacy of [false, true]) {
    test(`panel follows system changes only in system mode (${legacy ? 'legacy' : 'modern'} listener)`, async t => {
        let listener;
        const media = { matches: false, [legacy ? 'addListener' : 'addEventListener']: (...args) => { listener = args.at(-1); } };
        const dom = await load({ theme: 'system', prepare: dom => { dom.window.matchMedia = () => media; } });
        t.after(() => dom.window.close());
        await waitFor(dom, () => dom.window.localStorage.getItem('bpbThemePref') === 'system');
        media.matches = true; listener();
        assert.equal(rendered(dom), 'dark');
        assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'system');
        await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'light' } });
        listener();
        assert.equal(rendered(dom), 'light');
        await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'system' } });
        assert.equal(rendered(dom), 'dark');
    });
}
