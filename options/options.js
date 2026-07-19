// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — options page controller.

import { settings as S } from '../src/settings.js';
import { terrainCache as TerrainCache } from '../src/terrain-cache.js';
import { optionsTheme as Theme } from './theme.js';
import { initGithubBackup } from './github.js';

(() => {
    'use strict';
    const extensionApi = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
    const unitsEl = document.getElementById('units');
    const themeEl = document.getElementById('theme');
    const enable3dMapEl = document.getElementById('enable-3d-map');
    const enableReportEditorEl = document.getElementById('enable-report-editor');
    const retainWaypointsEl = document.getElementById('retain-waypoints');
    const fillAscentDetailsEl = document.getElementById('fill-ascent-details');
    const fillTripInfoEl = document.getElementById('fill-trip-info');
    const fillWildernessNightsEl = document.getElementById('fill-wilderness-nights');
    const chartSeriesEl = document.getElementById('chart-series');
    const mapRouteColorEl = document.getElementById('map-route-color');
    const mapRouteWidthEl = document.getElementById('map-route-width');
    const mapRouteCasingColorEl = document.getElementById('map-route-casing-color');
    const mapRouteCasingWidthEl = document.getElementById('map-route-casing-width');
    const mapViewportWidthEl = document.getElementById('map-viewport-width');
    const mapViewportHeightEl = document.getElementById('map-viewport-height');
    const mapViewportResetEl = document.getElementById('map-viewport-reset');
    const terrainCacheRowEl = document.getElementById('terrain-cache-row');
    const terrainCacheLimitEl = document.getElementById('terrain-cache-limit');
    const terrainCacheUsageEl = document.getElementById('terrain-cache-usage');
    const rememberMapLayerEl = document.getElementById('remember-map-layer');
    const betaTrEl = document.getElementById('beta-tr');
    const betaTrWordsEl = document.getElementById('beta-tr-words');
    const betaGpsEl = document.getElementById('beta-gps');
    const betaLinkEl = document.getElementById('beta-link');
    const statusEl = document.getElementById('status');

    const applyTheme = theme => Theme.apply(theme);

    let statusTimer = null;
    const flash = (msg = 'Saved') => {
        statusEl.textContent = msg;
        statusEl.classList.add('show');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1200);
    };

    const formatCacheBytes = bytes => {
        if (bytes < 1024) return `${Math.max(0, Math.floor(bytes))} B`;
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        const megabytes = bytes / (1024 * 1024);
        return `${megabytes < 100 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
    };

    let cacheUsageRevision = 0;
    const refreshCacheUsage = async () => {
        const revision = ++cacheUsageRevision;
        terrainCacheUsageEl.textContent = 'Checking current cache…';
        const usage = TerrainCache && typeof TerrainCache.getUsage === 'function'
            ? await TerrainCache.getUsage()
            : null;
        if (revision !== cacheUsageRevision || terrainCacheRowEl.hidden) return;

        if (!usage || (usage.unmeasuredEntries > 0 && usage.bytes === 0)) {
            terrainCacheUsageEl.textContent = 'Current cache size unavailable';
        } else if (usage.bytes === 0) {
            terrainCacheUsageEl.textContent = 'Current cache: Empty';
        } else {
            const qualifier = usage.unmeasuredEntries > 0 ? 'at least ' : '';
            terrainCacheUsageEl.textContent = `Current cache: ${qualifier}${formatCacheBytes(usage.bytes)}`;
        }
    };

    const syncTerrainCacheVisibility = enabled => {
        const show = enabled === true;
        const becameVisible = show && terrainCacheRowEl.hidden;
        terrainCacheRowEl.hidden = !show;
        if (becameVisible) void refreshCacheUsage();
        else if (!show) cacheUsageRevision++;
    };

    const populate = settings => {
        unitsEl.value = settings.units;
        themeEl.value = settings.theme;
        enable3dMapEl.checked = settings.enable3dMap;
        enableReportEditorEl.checked = settings.enableReportEditor;
        retainWaypointsEl.checked = settings.retainWaypoints;
        fillAscentDetailsEl.checked = settings.fillAscentDetails;
        fillTripInfoEl.checked = settings.fillTripInfo;
        fillWildernessNightsEl.checked = settings.fillWildernessNights;
        chartSeriesEl.value = settings.chartDefaultSeries;
        mapRouteColorEl.value = settings.mapRouteColor;
        mapRouteWidthEl.value = String(settings.mapRouteWidth);
        mapRouteCasingColorEl.value = settings.mapRouteCasingColor;
        mapRouteCasingWidthEl.value = String(settings.mapRouteCasingWidth);
        mapViewportWidthEl.value = String(settings.mapViewportWidth);
        mapViewportHeightEl.value = String(settings.mapViewportHeight);
        terrainCacheLimitEl.value = String(settings.terrainCacheLimitMb);
        syncTerrainCacheVisibility(settings.enable3dMap);
        rememberMapLayerEl.checked = settings.rememberMapLayer;
        betaTrEl.checked = settings.betaTr;
        betaTrWordsEl.value = String(settings.betaTrMinWords);
        betaTrWordsEl.disabled = !settings.betaTr;
        betaGpsEl.checked = settings.betaGps;
        betaLinkEl.checked = settings.betaLink;
        githubBackup.populate(settings);
        applyTheme(settings.theme);
    };

    let saveQueue = Promise.resolve();
    const save = patch => {
        saveQueue = saveQueue.then(async () => {
            const next = await S.set(patch);
            applyTheme(next.theme);
            flash();
            return next;
        });
        return saveQueue;
    };

    // GitHub backup setup owns its own panel; it drives the background worker
    // through GITHUB_AUTH_* messages and never sees the token.
    const githubBackup = initGithubBackup({ extensionApi, flash, save });

    unitsEl.addEventListener('change', () => save({ units: unitsEl.value }));
    themeEl.addEventListener('change', () => save({ theme: themeEl.value }));
    enable3dMapEl.addEventListener('change', () => {
        syncTerrainCacheVisibility(enable3dMapEl.checked);
        save({ enable3dMap: enable3dMapEl.checked });
    });
    enableReportEditorEl.addEventListener('change', () => save({ enableReportEditor: enableReportEditorEl.checked }));
    retainWaypointsEl.addEventListener('change', () => save({ retainWaypoints: retainWaypointsEl.checked }));
    fillAscentDetailsEl.addEventListener('change', () => save({ fillAscentDetails: fillAscentDetailsEl.checked }));
    fillTripInfoEl.addEventListener('change', () => save({ fillTripInfo: fillTripInfoEl.checked }));
    fillWildernessNightsEl.addEventListener('change', () => save({ fillWildernessNights: fillWildernessNightsEl.checked }));
    chartSeriesEl.addEventListener('change', () => save({ chartDefaultSeries: chartSeriesEl.value }));
    mapRouteColorEl.addEventListener('change', () => save({ mapRouteColor: mapRouteColorEl.value }));
    mapRouteWidthEl.addEventListener('change', () => save({ mapRouteWidth: mapRouteWidthEl.value }).then(populate));
    mapRouteCasingColorEl.addEventListener('change', () => save({ mapRouteCasingColor: mapRouteCasingColorEl.value }));
    mapRouteCasingWidthEl.addEventListener('change', () => save({ mapRouteCasingWidth: mapRouteCasingWidthEl.value }).then(populate));
    mapViewportWidthEl.addEventListener('change', () => save({ mapViewportWidth: mapViewportWidthEl.value }).then(populate));
    mapViewportHeightEl.addEventListener('change', () => save({ mapViewportHeight: mapViewportHeightEl.value }).then(populate));
    terrainCacheLimitEl.addEventListener('change', () => save({ terrainCacheLimitMb: terrainCacheLimitEl.value }).then(populate));
    mapViewportResetEl.addEventListener('click', () => {
        save({
            mapViewportWidth: S.DEFAULTS.mapViewportWidth,
            mapViewportHeight: S.DEFAULTS.mapViewportHeight
        }).then(settings => {
            populate(settings);
            flash('Map size reset');
        });
    });
    rememberMapLayerEl.addEventListener('change', () => save({
        rememberMapLayer: rememberMapLayerEl.checked,
        ...(!rememberMapLayerEl.checked && { mapLastLayer: '' })
    }));

    // "Has beta" definition. An empty definition is never valid: block
    // unchecking the last signal instead of silently resetting later.
    const betaSignals = [[betaTrEl, 'betaTr'], [betaGpsEl, 'betaGps'], [betaLinkEl, 'betaLink']];
    for (const [el, key] of betaSignals) {
        el.addEventListener('change', () => {
            if (!betaTrEl.checked && !betaGpsEl.checked && !betaLinkEl.checked) {
                el.checked = true;
                flash('Keep at least one signal checked');
                return;
            }
            betaTrWordsEl.disabled = !betaTrEl.checked;
            save({ [key]: el.checked });
        });
    }
    betaTrWordsEl.addEventListener('change', () => {
        const value = Math.max(1, parseInt(betaTrWordsEl.value, 10) || 1);
        betaTrWordsEl.value = String(value);
        save({ betaTrMinWords: value });
    });

    // Keep in sync if changed elsewhere (another tab / an inline control).
    S.subscribe(settings => populate(settings));
    if (extensionApi.storage && extensionApi.storage.onChanged && TerrainCache) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[TerrainCache.INDEX_KEY] && !terrainCacheRowEl.hidden) {
                void refreshCacheUsage();
            }
        });
    }
    window.addEventListener('focus', () => {
        if (!terrainCacheRowEl.hidden) void refreshCacheUsage();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !terrainCacheRowEl.hidden) void refreshCacheUsage();
    });

    // Reflect the system theme live while "Follow system" is selected.
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (themeEl.value === 'system') applyTheme('system'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }

    S.get().then(populate);
})();
