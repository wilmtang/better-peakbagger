// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeChromeStub, evalBundle, waitFor } from '../helpers/load-page.mjs';

const load = async bundle => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://www.peakbagger.com/peak.aspx?pid=1', runScripts: 'outside-only',
    });
    dom.chrome = makeChromeStub();
    dom.window.chrome = dom.chrome;
    dom.reads = [];
    dom.chrome.storage.sync.get = () => new Promise(resolve => dom.reads.push(settings => resolve({ bpbSettings: settings })));
    dom.messages = [];
    dom.window.postMessage = message => dom.messages.push(message);
    await evalBundle(dom.window, bundle);
    return dom;
};
const request = (dom, protocol) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window, origin: dom.window.location.origin,
    data: { [protocol]: true, dir: 'toCS', type: 'get' },
}));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('late initial theme reads cannot replace a newer preference or its pre-paint mirror', async t => {
    const dom = await load('content/theme.js'); t.after(() => dom.window.close());
    await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'dark' } });
    dom.reads[0]({ theme: 'light' }); await tick();
    assert.equal(dom.window.document.documentElement.dataset.bpbTheme, 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
    assert.ok(dom.window.document.getElementById('bpb-site-dark'));
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(dom, () => dom.reads.length === 2);
    dom.reads[1]({ theme: 'light' }); await tick();
    assert.equal(dom.window.document.documentElement.dataset.bpbTheme, 'light');
});

for (const [bundle, protocol] of [['content/peak-map-bridge.js', '__bpbPeakMap'],
    ['content/big-map-bridge.js', '__bpbBigMap']]) {
    test(`${bundle} drops reads superseded by a subscription or newer request`, async t => {
        const dom = await load(bundle); t.after(() => dom.window.close());
        request(dom, protocol);
        await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'dark', enable3dMap: false } });
        dom.reads[0]({ theme: 'light', enable3dMap: true }); await tick();
        assert.equal(dom.messages.length, 1);
        assert.equal(dom.messages[0].theme, 'dark');
        assert.equal(dom.messages[0].enable3dMap, false);
        request(dom, protocol); request(dom, protocol);
        dom.reads[2]({ theme: 'dark', enable3dMap: false }); await tick();
        dom.reads[1]({ theme: 'light', enable3dMap: true }); await tick();
        assert.equal(dom.messages.length, 2);
        assert.equal(dom.messages[1].enable3dMap, false);
    });
    test(`${bundle} rejects pre-pagehide reads and refreshes on BFCache restore`, async t => {
        const dom = await load(bundle); t.after(() => dom.window.close());
        request(dom, protocol);
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
        dom.reads[0]({ theme: 'light', enable3dMap: true }); await tick();
        assert.equal(dom.messages.length, 0);
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
        dom.reads[1]({ theme: 'dark', enable3dMap: false }); await tick();
        assert.equal(dom.messages.length, 1);
        assert.equal(dom.messages[0].theme, 'dark');
        assert.equal(dom.messages[0].enable3dMap, false);
    });
}
