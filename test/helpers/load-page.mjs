// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: load an ascent-list fixture into jsdom, stub chrome.storage,
// and eval the extension's isolated-world content scripts against it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(root, 'test', 'fixtures', 'peakascents');
export const PAGE_FIXTURES = path.join(root, 'test', 'fixtures', 'pages');

// Minimal in-memory chrome.storage.sync + onChanged, enough for settings.js.
export const makeChromeStub = (initial = {}, localInitial = {}) => {
    const store = { ...initial };
    const localStore = { ...localInitial };
    const listeners = new Set();
    const makeStorageArea = (values, area) => ({
        get: async key => ({ [key]: values[key] }),
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
    scripts = ['src/settings.js', 'src/ascent-filter.js'],
    fixtures = FIXTURES
} = {}) => {
    const html = await readFile(path.join(fixtures, fixture), 'utf8');
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
