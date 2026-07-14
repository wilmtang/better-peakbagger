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
    const DEFAULTS = {
        units: 'auto', theme: 'system',
        // Which GPX-chart series is shown by default: 'both', or only
        // 'distance' / 'time'. A legend click can still reveal the hidden one
        // for the current view without changing this preference.
        chartDefaultSeries: 'both',
        mapRouteColor: '#d9483b', mapRouteWidth: 5,
        mapRouteCasingColor: '#ffffff', mapRouteCasingWidth: 9,
        // What the ascent filter's "Has beta" chip counts: an ascent
        // qualifies if it has any of the enabled signals.
        betaTr: true, betaTrMinWords: 1, betaGps: true, betaLink: true
    };

    const clampWords = value => {
        const words = parseInt(value, 10);
        return Number.isFinite(words) && words > 0 ? words : 1;
    };

    const cleanColor = (value, fallback) =>
        typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;

    const clampInteger = (value, min, max, fallback) => {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    };

    const clean = raw => {
        const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
        if (!['auto', 'imperial', 'metric'].includes(s.units)) s.units = DEFAULTS.units;
        if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = DEFAULTS.theme;
        if (!['both', 'distance', 'time'].includes(s.chartDefaultSeries)) s.chartDefaultSeries = DEFAULTS.chartDefaultSeries;
        s.mapRouteColor = cleanColor(s.mapRouteColor, DEFAULTS.mapRouteColor);
        s.mapRouteWidth = clampInteger(s.mapRouteWidth, 1, 12, DEFAULTS.mapRouteWidth);
        s.mapRouteCasingColor = cleanColor(s.mapRouteCasingColor, DEFAULTS.mapRouteCasingColor);
        s.mapRouteCasingWidth = clampInteger(s.mapRouteCasingWidth, 3, 20, DEFAULTS.mapRouteCasingWidth);
        s.mapRouteCasingWidth = Math.max(s.mapRouteCasingWidth, s.mapRouteWidth + 2);
        for (const key of ['betaTr', 'betaGps', 'betaLink']) {
            if (typeof s[key] !== 'boolean') s[key] = DEFAULTS[key];
        }
        // A "has beta" that matches nothing is never a valid state.
        if (!s.betaTr && !s.betaGps && !s.betaLink) {
            s.betaTr = s.betaGps = s.betaLink = true;
        }
        s.betaTrMinWords = clampWords(s.betaTrMinWords);
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
