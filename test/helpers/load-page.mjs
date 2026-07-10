// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: load a PeakAscents fixture into jsdom, stub chrome.storage,
// and eval the extension's isolated-world content scripts against it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(root, 'test', 'fixtures', 'peakascents');

// Minimal in-memory chrome.storage.sync + onChanged, enough for settings.js.
export const makeChromeStub = (initial = {}) => {
    const store = { ...initial };
    const listeners = new Set();
    return {
        _store: store,
        storage: {
            sync: {
                get: async key => ({ [key]: store[key] }),
                set: async obj => {
                    const changes = {};
                    for (const [k, v] of Object.entries(obj)) {
                        changes[k] = { oldValue: store[k], newValue: v };
                        store[k] = v;
                    }
                    for (const fn of listeners) fn(changes, 'sync');
                }
            },
            onChanged: {
                addListener: fn => listeners.add(fn),
                removeListener: fn => listeners.delete(fn)
            }
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

export const loadPage = async (fixture, { url, settings = {}, scripts = ['src/settings.js', 'src/ascent-filter.js'] } = {}) => {
    const html = await readFile(path.join(FIXTURES, fixture), 'utf8');
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    dom.chrome = makeChromeStub({ bpbSettings: settings });
    dom.window.chrome = dom.chrome;
    for (const rel of scripts) {
        dom.window.eval(await readFile(path.join(root, rel), 'utf8'));
    }
    return dom;
};

// Shorthand: load and wait for the filter bar to be injected.
export const loadPageWithBar = async (fixture, opts) => {
    const dom = await loadPage(fixture, opts);
    await waitFor(dom, () => dom.window.document.getElementById('pbaf-bar'));
    return dom;
};
