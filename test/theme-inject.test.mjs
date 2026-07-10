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
import { JSDOM } from 'jsdom';
import { makeChromeStub } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLE_ID = 'bpb-site-dark';

// Load the site-wide content scripts (settings -> site-dark-css -> theme) into a
// fresh jsdom, in manifest order, with the given stored settings.
const loadTheme = async (settings = {}) => {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
        url: 'https://www.peakbagger.com/',
        runScripts: 'outside-only'
    });
    dom.chrome = makeChromeStub({ bpbSettings: settings });
    dom.window.chrome = dom.chrome;
    for (const rel of ['src/settings.js', 'src/site-dark-css.js', 'src/theme.js']) {
        dom.window.eval(await readFile(path.join(root, rel), 'utf8'));
    }
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
