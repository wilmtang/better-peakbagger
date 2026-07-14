// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — options page controller.

(() => {
    'use strict';
    const S = window.BPBSettings;
    const root = document.documentElement;
    const unitsEl = document.getElementById('units');
    const themeEl = document.getElementById('theme');
    const retainWaypointsEl = document.getElementById('retain-waypoints');
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
    const rememberMapLayerEl = document.getElementById('remember-map-layer');
    const betaTrEl = document.getElementById('beta-tr');
    const betaTrWordsEl = document.getElementById('beta-tr-words');
    const betaGpsEl = document.getElementById('beta-gps');
    const betaLinkEl = document.getElementById('beta-link');
    const statusEl = document.getElementById('status');

    const applyTheme = theme => root.setAttribute('data-bpb-theme', S.resolveTheme(theme));

    let statusTimer = null;
    const flash = (msg = 'Saved') => {
        statusEl.textContent = msg;
        statusEl.classList.add('show');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1200);
    };

    const populate = settings => {
        unitsEl.value = settings.units;
        themeEl.value = settings.theme;
        retainWaypointsEl.checked = settings.retainWaypoints;
        fillTripInfoEl.checked = settings.fillTripInfo;
        fillWildernessNightsEl.checked = settings.fillWildernessNights;
        chartSeriesEl.value = settings.chartDefaultSeries;
        mapRouteColorEl.value = settings.mapRouteColor;
        mapRouteWidthEl.value = String(settings.mapRouteWidth);
        mapRouteCasingColorEl.value = settings.mapRouteCasingColor;
        mapRouteCasingWidthEl.value = String(settings.mapRouteCasingWidth);
        mapViewportWidthEl.value = String(settings.mapViewportWidth);
        mapViewportHeightEl.value = String(settings.mapViewportHeight);
        rememberMapLayerEl.checked = settings.rememberMapLayer;
        betaTrEl.checked = settings.betaTr;
        betaTrWordsEl.value = String(settings.betaTrMinWords);
        betaTrWordsEl.disabled = !settings.betaTr;
        betaGpsEl.checked = settings.betaGps;
        betaLinkEl.checked = settings.betaLink;
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

    unitsEl.addEventListener('change', () => save({ units: unitsEl.value }));
    themeEl.addEventListener('change', () => save({ theme: themeEl.value }));
    retainWaypointsEl.addEventListener('change', () => save({ retainWaypoints: retainWaypointsEl.checked }));
    fillTripInfoEl.addEventListener('change', () => save({ fillTripInfo: fillTripInfoEl.checked }));
    fillWildernessNightsEl.addEventListener('change', () => save({ fillWildernessNights: fillWildernessNightsEl.checked }));
    chartSeriesEl.addEventListener('change', () => save({ chartDefaultSeries: chartSeriesEl.value }));
    mapRouteColorEl.addEventListener('change', () => save({ mapRouteColor: mapRouteColorEl.value }));
    mapRouteWidthEl.addEventListener('change', () => save({ mapRouteWidth: mapRouteWidthEl.value }).then(populate));
    mapRouteCasingColorEl.addEventListener('change', () => save({ mapRouteCasingColor: mapRouteCasingColorEl.value }));
    mapRouteCasingWidthEl.addEventListener('change', () => save({ mapRouteCasingWidth: mapRouteCasingWidthEl.value }).then(populate));
    mapViewportWidthEl.addEventListener('change', () => save({ mapViewportWidth: mapViewportWidthEl.value }).then(populate));
    mapViewportHeightEl.addEventListener('change', () => save({ mapViewportHeight: mapViewportHeightEl.value }).then(populate));
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

    // Reflect the system theme live while "Follow system" is selected.
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (themeEl.value === 'system') applyTheme('system'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }

    S.get().then(populate);
})();
