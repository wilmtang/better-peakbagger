// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure settings schema: defaults, bounds, and validators.
// This file intentionally has no DOM or extension-API dependency, so unlike
// src/settings.js it can also load in the page MAIN world (the GPX analyzer and
// Full Screen/Peak map coordinators) and in the extension-owned terrain frame.
//
// Those surfaces receive settings over window.postMessage, which crosses a
// trust boundary, so they must re-validate rather than trust the sender. They
// re-validate with *these* functions so a bound or default cannot silently
// diverge between the storage writer and the page-world readers — the same
// reason the shared geometry lives in src/gpx-metrics.js.
//
// src/settings.js owns storage access and layers it on top of this module.

    const MAP_LAYERS = new Set(['L_CT', 'L_MT', 'L_FS', 'L_3D', 'L_SN', 'L_AG', 'L_OT', 'L_OS', 'L_AI', 'L_XX', 'B_B1', 'G_SA']);

    // The one definition of the extension's route look. Every surface that
    // draws or validates a route resolves through ROUTE_STYLE and BOUNDS.
    const ROUTE_STYLE = { color: '#d9483b', width: 5, casingColor: '#ffffff', casingWidth: 9 };
    const VIEWPORT = { width: 450, height: 450 };
    const BOUNDS = {
        routeWidth: { min: 1, max: 12 },
        routeCasingWidth: { min: 3, max: 20 },
        viewportWidth: { min: 320, max: 4096 },
        viewportHeight: { min: 240, max: 720 },
        terrainCacheLimitMb: { min: 0, max: 2048 }
    };

    const DEFAULTS = {
        units: 'auto', theme: 'system',
        enable3dMap: false,
        retainWaypoints: true,
        fillAscentDetails: true,
        fillTripInfo: true,
        fillWildernessNights: true,
        // Put the captured Garmin/Strava activity link into the ascent form's
        // "URL Link to External Trip Report" field when it is empty.
        fillExternalUrl: true,
        // Which GPX-chart series is shown by default: 'both', or only
        // 'distance' / 'time'. A legend click can still reveal the hidden one
        // for the current view without changing this preference.
        chartDefaultSeries: 'both',
        // Trip-report editor on the ascent add/edit form, and the last mode
        // the user wrote in ('plain' is the untouched native textarea).
        enableReportEditor: true,
        addReportCredit: false,
        reportEditorMode: 'rich',
        // GitHub ascent backup. The feature gate is an ordinary synced boolean
        // like the others; the token and chosen repo deliberately do NOT live
        // in this schema (they must never sync) — src/github-auth.js owns those
        // in storage.local. `autoGithubBackup` performs the push without the
        // per-save click once the manual path is enabled.
        enableGithubBackup: false,
        autoGithubBackup: false,
        mapRouteColor: ROUTE_STYLE.color, mapRouteWidth: ROUTE_STYLE.width,
        mapRouteCasingColor: ROUTE_STYLE.casingColor, mapRouteCasingWidth: ROUTE_STYLE.casingWidth,
        mapViewportWidth: VIEWPORT.width, mapViewportHeight: VIEWPORT.height,
        terrainCacheLimitMb: 512,
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

    const routeColor = value => cleanColor(value, ROUTE_STYLE.color);
    const routeCasingColor = value => cleanColor(value, ROUTE_STYLE.casingColor);
    const routeWidth = value =>
        clampInteger(value, BOUNDS.routeWidth.min, BOUNDS.routeWidth.max, ROUTE_STYLE.width);
    // The casing only reads as a casing when it is wider than the line it sits
    // behind, so the route width raises this floor regardless of the setting.
    const routeCasingWidth = (value, width) => Math.max(
        clampInteger(value, BOUNDS.routeCasingWidth.min, BOUNDS.routeCasingWidth.max, ROUTE_STYLE.casingWidth),
        width + 2
    );

    // Width is a pixel dimension so the default exactly preserves Peakbagger's
    // original 450 px map. Values below the usable pixel minimum also cover the
    // short-lived pre-release percentage schema; reset those to the original
    // width instead of misreading 100% as 320 px. Oversized values still clamp.
    const viewportWidth = value => {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= BOUNDS.viewportWidth.min
            ? Math.min(BOUNDS.viewportWidth.max, parsed)
            : VIEWPORT.width;
    };
    const viewportHeight = value =>
        clampInteger(value, BOUNDS.viewportHeight.min, BOUNDS.viewportHeight.max, VIEWPORT.height);

    const terrainCacheLimitMb = value => clampInteger(
        value, BOUNDS.terrainCacheLimitMb.min, BOUNDS.terrainCacheLimitMb.max, DEFAULTS.terrainCacheLimitMb
    );

    // Resolve an untrusted { color, width, casingColor, casingWidth } into a
    // drawable route style. Callers whose field names differ (the BigMap
    // bridge's wire shape, the stored mapRoute* settings) adapt at the call.
    const routeStyle = source => {
        const width = routeWidth(source && source.width);
        return {
            color: routeColor(source && source.color),
            width,
            casingColor: routeCasingColor(source && source.casingColor),
            casingWidth: routeCasingWidth(source && source.casingWidth, width)
        };
    };

    const routeStyleFromSettings = settings => routeStyle({
        color: settings && settings.mapRouteColor,
        width: settings && settings.mapRouteWidth,
        casingColor: settings && settings.mapRouteCasingColor,
        casingWidth: settings && settings.mapRouteCasingWidth
    });

    const viewportSizeFromSettings = settings => ({
        width: viewportWidth(settings && settings.mapViewportWidth),
        height: viewportHeight(settings && settings.mapViewportHeight)
    });

    const clean = raw => {
        const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
        if (!['auto', 'imperial', 'metric'].includes(s.units)) s.units = DEFAULTS.units;
        if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = DEFAULTS.theme;
        for (const key of ['enable3dMap', 'retainWaypoints', 'fillAscentDetails', 'fillTripInfo', 'fillWildernessNights', 'fillExternalUrl', 'enableReportEditor', 'addReportCredit', 'enableGithubBackup', 'autoGithubBackup']) {
            if (typeof s[key] !== 'boolean') s[key] = DEFAULTS[key];
        }
        // Auto-backup is meaningless without the feature enabled; never let it
        // stand on its own.
        if (!s.enableGithubBackup) s.autoGithubBackup = false;
        if (!['both', 'distance', 'time'].includes(s.chartDefaultSeries)) s.chartDefaultSeries = DEFAULTS.chartDefaultSeries;
        if (!['rich', 'markdown', 'plain'].includes(s.reportEditorMode)) s.reportEditorMode = DEFAULTS.reportEditorMode;
        s.mapRouteColor = routeColor(s.mapRouteColor);
        s.mapRouteWidth = routeWidth(s.mapRouteWidth);
        s.mapRouteCasingColor = routeCasingColor(s.mapRouteCasingColor);
        s.mapRouteCasingWidth = routeCasingWidth(s.mapRouteCasingWidth, s.mapRouteWidth);
        s.mapViewportWidth = viewportWidth(s.mapViewportWidth);
        s.mapViewportHeight = viewportHeight(s.mapViewportHeight);
        s.terrainCacheLimitMb = terrainCacheLimitMb(s.terrainCacheLimitMb);
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

    const API = {
        MAP_LAYERS,
        ROUTE_STYLE,
        VIEWPORT,
        BOUNDS,
        DEFAULTS,
        clean,
        routeColor,
        routeCasingColor,
        routeWidth,
        routeCasingWidth,
        routeStyle,
        routeStyleFromSettings,
        viewportWidth,
        viewportHeight,
        viewportSizeFromSettings,
        terrainCacheLimitMb
    };

    export const settingsSchema = API;
