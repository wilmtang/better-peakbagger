// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards the site-wide dark theme's core invariant: whenever theme.js sets
// data-bpb-theme, the dark stylesheet it gates is actually present in the DOM.
// A violation (attribute set, sheet missing) is what renders the self-themed
// GPX chart dark on an otherwise-light page — the bug this test locks out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { makeChromeStub, evalBundle } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeBundle = await readFile(path.join(root, 'dist', 'content', 'theme.js'), 'utf8');
const STYLE_ID = 'bpb-site-dark';

// Load the bundled site-wide theme entry into a fresh jsdom with the given
// stored settings.
const loadTheme = async (settings = {}) => {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
        url: 'https://www.peakbagger.com/',
        runScripts: 'outside-only'
    });
    dom.chrome = makeChromeStub({ bpbSettings: settings });
    dom.window.chrome = dom.chrome;
    await evalBundle(dom.window, 'content/theme.js');
    // Let S.get().then(apply) reconcile.
    await new Promise(r => dom.window.setTimeout(r, 20));
    return dom;
};

const attr = dom => dom.window.document.documentElement.getAttribute('data-bpb-theme');
const sheet = dom => dom.window.document.getElementById(STYLE_ID);

test('theme=dark sets the attribute AND injects the dark stylesheet', async () => {
    const dom = await loadTheme({ theme: 'dark' });
    assert.equal(attr(dom), 'dark');
    assert.ok(sheet(dom), 'the dark <style> must be present when the theme is dark');
    assert.ok(sheet(dom).textContent.includes('data-bpb-theme="dark"'));
});

test('the sheet self-heals: a later apply() re-injects it if it went missing', async () => {
    const dom = await loadTheme({ theme: 'dark' });
    assert.ok(sheet(dom));

    // Simulate the sheet being lost (e.g. a page script cleared it) — the
    // attribute stays. The next settings-driven apply() must restore it.
    sheet(dom).remove();
    assert.equal(sheet(dom), null);

    await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'dark' } });
    await new Promise(r => dom.window.setTimeout(r, 20));

    assert.ok(sheet(dom), 'apply() should have re-injected the missing sheet');
    assert.equal(attr(dom), 'dark');
});

test('theme=light sets the attribute but the inert sheet is still present', async () => {
    const dom = await loadTheme({ theme: 'light' });
    assert.equal(attr(dom), 'light');
    // The sheet is scoped under [data-bpb-theme="dark"], so it is inert in light
    // mode — but injecting it up front is what makes later toggles flash-free.
    assert.ok(sheet(dom));
});

test('the bundled theme initializes in a Firefox-like isolated-world context', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
        url: 'https://www.peakbagger.com/',
        runScripts: 'outside-only'
    });
    const chrome = makeChromeStub({ bpbSettings: { theme: 'dark' } });

    // Firefox's isolated global is distinct from the page's Xray-wrapped
    // window. The self-contained bundle must work without publishing anything
    // onto the page global.
    const isolatedWorld = vm.createContext({
        window: dom.window,
        document: dom.window.document,
        localStorage: dom.window.localStorage,
        chrome,
        URL,
        console
    });
    vm.runInContext(themeBundle, isolatedWorld, { filename: 'content/theme.js' });
    await new Promise(resolve => setTimeout(resolve, 20));

    // The bundle runs in the isolated context (not the page window), so it
    // themes the shared document without leaking anything onto window.
    assert.equal(dom.window.BPBSettings, undefined, 'the page window is untouched');
    assert.equal(attr(dom), 'dark');
    assert.ok(sheet(dom), 'the theme must read its dependencies from the isolated global');
    dom.window.close();
});
