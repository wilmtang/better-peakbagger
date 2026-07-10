// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared settings core.
// Loaded into every isolated-world content script (theme, bridge, filter) and
// the options page, where chrome.storage is available. It is NOT usable from
// the page MAIN world (the GPX analyzer), which reaches settings through the
// bridge (src/bridge.js) instead. Idempotent: safe to inject more than once
// into the same isolated world.

(() => {
    if (window.BPBSettings) return;

    const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
    const STORAGE_KEY = 'bpbSettings';
    const DEFAULTS = { units: 'auto', theme: 'system', defaultMinTrWords: 1 };

    const clean = raw => {
        const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
        if (!['auto', 'imperial', 'metric'].includes(s.units)) s.units = DEFAULTS.units;
        if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = DEFAULTS.theme;
        const words = parseInt(s.defaultMinTrWords, 10);
        s.defaultMinTrWords = Number.isFinite(words) && words > 0 ? words : 1;
        return s;
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

    // Resolve a theme preference to a concrete 'light' | 'dark'.
    const resolveTheme = theme => {
        if (theme === 'light' || theme === 'dark') return theme;
        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    };

    window.BPBSettings = { STORAGE_KEY, DEFAULTS, clean, get, set, subscribe, resolveTheme };
})();
