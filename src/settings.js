// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared settings core.
// Loaded into every isolated-world content script (theme, bridge, filter), the
// options page, and the background worker, where extension storage is
// available. It is NOT usable from the page MAIN world (the GPX analyzer),
// which reaches settings through the bridge (src/bridge.js) instead.
// Idempotent: safe to inject more than once into the same global.

(() => {
    if (globalThis.BPBSettings) return;

    const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
    const STORAGE_KEY = 'bpbSettings';
    const MAP_LAYERS = new Set(['L_CT', 'L_MT', 'L_FS', 'L_3D', 'L_SN', 'L_AG', 'L_OT', 'L_OS', 'L_AI', 'L_XX', 'B_B1', 'G_SA']);
    const DEFAULTS = {
        units: 'auto', theme: 'system',
        enable3dMap: false,
        retainWaypoints: true,
        fillTripInfo: true,
        fillWildernessNights: true,
        // Which GPX-chart series is shown by default: 'both', or only
        // 'distance' / 'time'. A legend click can still reveal the hidden one
        // for the current view without changing this preference.
        chartDefaultSeries: 'both',
        mapRouteColor: '#d9483b', mapRouteWidth: 5,
        mapRouteCasingColor: '#ffffff', mapRouteCasingWidth: 9,
        mapViewportWidth: 450, mapViewportHeight: 450,
        terrainCacheLimitMb: 256,
        rememberMapLayer: false, mapLastLayer: '',
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
        for (const key of ['enable3dMap', 'retainWaypoints', 'fillTripInfo', 'fillWildernessNights']) {
            if (typeof s[key] !== 'boolean') s[key] = DEFAULTS[key];
        }
        if (!['both', 'distance', 'time'].includes(s.chartDefaultSeries)) s.chartDefaultSeries = DEFAULTS.chartDefaultSeries;
        s.mapRouteColor = cleanColor(s.mapRouteColor, DEFAULTS.mapRouteColor);
        s.mapRouteWidth = clampInteger(s.mapRouteWidth, 1, 12, DEFAULTS.mapRouteWidth);
        s.mapRouteCasingColor = cleanColor(s.mapRouteCasingColor, DEFAULTS.mapRouteCasingColor);
        s.mapRouteCasingWidth = clampInteger(s.mapRouteCasingWidth, 3, 20, DEFAULTS.mapRouteCasingWidth);
        s.mapRouteCasingWidth = Math.max(s.mapRouteCasingWidth, s.mapRouteWidth + 2);
        // Width is a pixel dimension so the default exactly preserves
        // Peakbagger's original 450 px map. Values below the usable pixel
        // minimum also cover the short-lived pre-release percentage schema;
        // reset those to the original width instead of misreading 100% as
        // 320 px.
        const viewportWidth = parseInt(s.mapViewportWidth, 10);
        s.mapViewportWidth = Number.isFinite(viewportWidth) && viewportWidth >= 320
            ? Math.min(4096, viewportWidth)
            : DEFAULTS.mapViewportWidth;
        s.mapViewportHeight = clampInteger(s.mapViewportHeight, 240, 720, DEFAULTS.mapViewportHeight);
        s.terrainCacheLimitMb = clampInteger(s.terrainCacheLimitMb, 0, 2048, DEFAULTS.terrainCacheLimitMb);
        if (typeof s.rememberMapLayer !== 'boolean') s.rememberMapLayer = DEFAULTS.rememberMapLayer;
        if (!MAP_LAYERS.has(s.mapLastLayer)) s.mapLastLayer = DEFAULTS.mapLastLayer;
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
        return (globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    };

    globalThis.BPBSettings = { STORAGE_KEY, DEFAULTS, clean, get, set, subscribe, resolveTheme };
})();
