// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared settings storage.
// Loaded into every isolated-world content script (theme, bridge, filter), the
// options page, and the background worker, where extension storage is
// available. It is NOT usable from the page MAIN world (the GPX analyzer),
// which reaches settings through the bridge (src/bridge.js) instead.
//
// The schema itself — defaults, bounds, and validators — lives in the pure
// src/settings-schema.js, which must load first (manifest script order /
// importScripts) and which the MAIN world loads directly. This file adds only
// chrome.storage access on top of it.

import { settingsSchema as Schema } from './settings-schema.js';

    const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
    const STORAGE_KEY = 'bpbSettings';
    const { DEFAULTS, clean } = Schema;

    // Resolve a theme preference to a concrete 'light' | 'dark'. This reads
    // matchMedia, so it stays out of the pure schema; only isolated-world and
    // extension-page surfaces use it, and they all reach it through here.
    const resolveTheme = theme => {
        if (theme === 'light' || theme === 'dark') return theme;
        return (globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    };

    const get = async () => {
        try {
            const res = await api.storage.sync.get(STORAGE_KEY);
            return clean(res && res[STORAGE_KEY]);
        } catch (e) {
            return { ...DEFAULTS };
        }
    };

    const set = async patch => {
        const next = clean({ ...(await get()), ...patch });
        try { await api.storage.sync.set({ [STORAGE_KEY]: next }); } catch (e) { /* storage unavailable */ }
        return next;
    };

    // Fires cb(settings) whenever the stored settings change (e.g. from the
    // options page or another tab). Returns an unsubscribe function.
    const subscribe = cb => {
        if (!api || !api.storage || !api.storage.onChanged) return () => {};
        const handler = (changes, area) => {
            if ((area === 'sync' || area === undefined) && changes[STORAGE_KEY]) {
                cb(clean(changes[STORAGE_KEY].newValue));
            }
        };
        api.storage.onChanged.addListener(handler);
        return () => api.storage.onChanged.removeListener(handler);
    };

    export const settings = { STORAGE_KEY, DEFAULTS, clean, get, set, subscribe, resolveTheme };

    // Transitional global bridge; removed in Step 8 once every consumer imports
    // { settings } directly. Does not clobber an existing binding so tests that
    // still stub globalThis.BPBSettings (map/terrain consumers, converted in
    // Step 5) keep control until those consumers import settings.
    if (!globalThis.BPBSettings) globalThis.BPBSettings = settings;
