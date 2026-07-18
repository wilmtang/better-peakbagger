// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: load a Peakbagger fixture into jsdom, stub chrome.storage, and
// run the extension against it by evaluating the *built* content-script bundles
// (dist/…) — the same self-contained IIFE files the browser loads. Evaluating
// the shipped bundle keeps the harness faithful across the ES-module migration:
// bundle output is an IIFE whether the source modules are IIFEs or ES modules,
// so a test names the page's bundles rather than a hand-kept list of src files.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(root, 'test', 'fixtures', 'peakascents');
export const PAGE_FIXTURES = path.join(root, 'test', 'fixtures', 'pages');
export const DIST = path.join(root, 'dist');

// Evaluate one or more built bundles (dist-relative paths) into a window or
// vm-style context, in order. `npm test` runs `npm run build` first (pretest),
// so dist/ is always current.
export const evalBundle = async (target, ...bundles) => {
    for (const rel of bundles) {
        target.eval(await readFile(path.join(DIST, rel), 'utf8'));
    }
};

// Minimal in-memory chrome.storage.sync + onChanged, enough for settings.js.
export const makeChromeStub = (initial = {}, localInitial = {}) => {
    const store = { ...initial };
    const localStore = { ...localInitial };
    const listeners = new Set();
    const makeStorageArea = (values, area) => ({
        get: async key => (key === null ? { ...values } : { [key]: values[key] }),
        set: async obj => {
            const changes = {};
            for (const [key, value] of Object.entries(obj)) {
                changes[key] = { oldValue: values[key], newValue: value };
                values[key] = value;
            }
            for (const fn of listeners) fn(changes, area);
        },
        remove: async key => {
            const keys = Array.isArray(key) ? key : [key];
            const changes = {};
            for (const item of keys) {
                if (!(item in values)) continue;
                changes[item] = { oldValue: values[item], newValue: undefined };
                delete values[item];
            }
            if (Object.keys(changes).length) for (const fn of listeners) fn(changes, area);
        }
    });
    return {
        _store: store,
        _localStore: localStore,
        storage: {
            sync: makeStorageArea(store, 'sync'),
            local: makeStorageArea(localStore, 'local'),
            onChanged: {
                addListener: fn => listeners.add(fn),
                removeListener: fn => listeners.delete(fn)
            }
        },
        // A built content-script bundle carries every module the page injects,
        // so idle siblings (e.g. ascent-draft) touch chrome.runtime at load even
        // when the test only drives one feature. Mirror the page's full chrome.
        runtime: {
            id: 'test-extension',
            sendMessage: async () => undefined,
            onMessage: { addListener: () => {}, removeListener: () => {} }
        }
    };
};

export const waitFor = async (dom, predicate, ms = 5000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > ms) throw new Error('waitFor timed out');
        await new Promise(resolve => dom.window.setTimeout(resolve, 5));
    }
};

export const loadPage = async (fixture, {
    url,
    settings = {},
    bundles = ['content/ascent-filter.js'],
    fixtures = FIXTURES,
    prepare = null
} = {}) => {
    const html = await readFile(path.join(fixtures, fixture), 'utf8');
    // pretendToBeVisual provides requestAnimationFrame, which the bundled
    // editor libraries (ProseMirror, CodeMirror) schedule their work through.
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    // The same libraries measure the DOM through layout APIs jsdom does not
    // implement; zero-size answers are fine because no test asserts geometry.
    const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    dom.window.Range.prototype.getClientRects = () => [];
    dom.window.Range.prototype.getBoundingClientRect = zeroRect;
    if (!dom.window.document.elementFromPoint) {
        dom.window.document.elementFromPoint = () => null;
    }
    dom.chrome = makeChromeStub({ bpbSettings: settings });
    dom.window.chrome = dom.chrome;
    if (prepare) prepare(dom);
    await evalBundle(dom.window, ...bundles);
    return dom;
};

// Shorthand: load and wait for the filter bar to be injected.
export const loadPageWithBar = async (fixture, opts) => {
    const dom = await loadPage(fixture, opts);
    await waitFor(dom, () => dom.window.document.getElementById('pbaf-bar'));
    return dom;
};
