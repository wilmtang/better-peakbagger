// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — options page controller.

import { initOrderSettings } from './order-settings.ts';
import { settings as S } from '../src/settings/settings.ts';
import { terrainCache as TerrainCache } from '../src/terrain/terrain-cache.ts';
import { panelTheme as Theme } from '../src/theme/panel-theme.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';
import { initGithubBackup } from './github.ts';
import { initIgnoredBackup } from './ignored-backup.ts';
import { initFavoritesBackup } from './favorites-backup.ts';
import { initImgbbKey } from './imgbb.ts';
import { initSettingsBackup } from './settings-backup.ts';
import { initPhotoBackup } from './photos.ts';
import { initSectionNav } from '../src/ui/section-nav.ts';
import { initUnitSettings } from './unit-settings.ts';
import { initCustomLayers } from './custom-layers.ts';
import { initInstagramDisplay } from './instagram-display.ts';
import type { Settings, SettingsPatch } from './settings-patch-route.ts';

(() => {
    const extensionApi = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
    // Variable feedback belongs below controls, including in stacked rows.
    for (const id of ['terrain-cache-usage', 'settings-backup-github-status', 'favorites-github-status',
        'ignored-github-status', 'photos-github-status']) {
        const feedback = document.getElementById(id);
        if (feedback) feedback.closest('.row')?.append(feedback);
    }
    try {
        const registration: Promise<unknown> | undefined = extensionApi.runtime.sendMessage({ type: 'OPTIONS_TAB_REGISTER' });
        if (registration?.catch) void registration.catch(() => {});
    } catch { /* the worker will discover or create the tab on demand */ }
    const themeEl = document.getElementById('theme') as HTMLSelectElement;
    const showSunMoonEl = document.getElementById('show-sun-moon') as HTMLInputElement;
    const showWeatherEl = document.getElementById('show-weather') as HTMLInputElement;
    const showSummitCloudEl = document.getElementById('show-summit-cloud') as HTMLInputElement;
    const showSnotelEl = document.getElementById('show-snotel') as HTMLInputElement;
    const enable3dMapEl = document.getElementById('enable-3d-map') as HTMLInputElement;
    const enableGarminInboxEl = document.getElementById('enable-garmin-inbox') as HTMLInputElement;
    const enableReportEditorEl = document.getElementById('enable-report-editor') as HTMLInputElement;
    const reportEditorDependentEls = document.querySelectorAll<HTMLElement>('[data-report-editor-dependent]');
    const loadInstagramEl = document.getElementById('load-instagram-automatically') as HTMLInputElement;
    const addReportCreditEl = document.getElementById('add-report-credit') as HTMLInputElement;
    const removeGpxTimestampsEl = document.getElementById('remove-gpx-timestamps') as HTMLInputElement;
    const retainWaypointsEl = document.getElementById('retain-waypoints') as HTMLInputElement;
    const fillAscentDetailsEl = document.getElementById('fill-ascent-details') as HTMLInputElement;
    const fillTripInfoEl = document.getElementById('fill-trip-info') as HTMLInputElement;
    const fillWildernessNightsEl = document.getElementById('fill-wilderness-nights') as HTMLInputElement;
    const fillExternalUrlEl = document.getElementById('fill-external-url') as HTMLInputElement;
    const chartSeriesEl = document.getElementById('chart-series') as HTMLSelectElement;
    const mapRouteColorEl = document.getElementById('map-route-color') as HTMLInputElement;
    const mapRouteWidthEl = document.getElementById('map-route-width') as HTMLInputElement;
    const mapRouteCasingColorEl = document.getElementById('map-route-casing-color') as HTMLInputElement;
    const mapRouteCasingWidthEl = document.getElementById('map-route-casing-width') as HTMLInputElement;
    const mapRouteResetEl = document.getElementById('map-route-reset') as HTMLButtonElement;
    const mapViewportWidthEl = document.getElementById('map-viewport-width') as HTMLInputElement;
    const mapViewportHeightEl = document.getElementById('map-viewport-height') as HTMLInputElement;
    const mapViewportResetEl = document.getElementById('map-viewport-reset') as HTMLButtonElement;
    const terrainCacheRowEl = document.getElementById('terrain-cache-row') as HTMLElement;
    const terrainCacheLimitEl = document.getElementById('terrain-cache-limit') as HTMLInputElement;
    const terrainCacheUsageEl = document.getElementById('terrain-cache-usage') as HTMLElement;
    const rememberMapLayerEl = document.getElementById('remember-map-layer') as HTMLInputElement;
    const betaTrEl = document.getElementById('beta-tr') as HTMLInputElement;
    const betaTrWordsEl = document.getElementById('beta-tr-words') as HTMLInputElement;
    const betaGpsEl = document.getElementById('beta-gps') as HTMLInputElement;
    const betaLinkEl = document.getElementById('beta-link') as HTMLInputElement;
    const betaSortDateDescEl = document.getElementById('beta-sort-date-desc') as HTMLInputElement;
    const statusEl = document.getElementById('status') as HTMLElement;
    const statusErrorEl = document.getElementById('status-error') as HTMLElement;
    const statusErrorTextEl = document.getElementById('status-error-text') as HTMLElement;
    const statusErrorDismissEl = document.getElementById('status-error-dismiss') as HTMLElement;
    const aboutVersionEl = document.getElementById('about-version') as HTMLElement;

    // About section — version and store destination from the extension runtime.
    const manifest = extensionApi.runtime.getManifest();
    aboutVersionEl.textContent = `Version ${manifest.version}`;
    (document.getElementById('about-rate-us') as HTMLAnchorElement).href = extensionApi.runtime.getURL('').startsWith('moz-extension://')
        ? 'https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/reviews/'
        : 'https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn/reviews';

    const applyTheme = (theme: string): void => Theme.apply(theme);

    const { flash } = OptionsUtils.createStatusFlash({
        statusEl,
        statusErrorEl,
        statusErrorTextEl,
        statusErrorDismissEl,
    });
    initCustomLayers({ extensionApi, flash });
    initInstagramDisplay({ extensionApi, flash });

    const formatCacheBytes = (bytes: number): string => {
        if (bytes < 1024) return `${Math.max(0, Math.floor(bytes))} B`;
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        const megabytes = bytes / (1024 * 1024);
        return `${megabytes < 100 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
    };

    let cacheUsageRevision = 0;
    const refreshCacheUsage = async (): Promise<void> => {
        const revision = ++cacheUsageRevision;
        terrainCacheUsageEl.textContent = 'Checking current cache…';
        const usage = await TerrainCache.getUsage();
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

    const syncTerrainCacheVisibility = (enabled: boolean): void => {
        const show = enabled === true;
        const becameVisible = show && terrainCacheRowEl.hidden;
        terrainCacheRowEl.hidden = !show;
        if (becameVisible) void refreshCacheUsage();
        else if (!show) cacheUsageRevision++;
    };

    const syncReportEditorDependentVisibility = (enabled: boolean): void => {
        for (const element of reportEditorDependentEls) element.hidden = enabled !== true;
    };

    let confirmedSettings: Settings | null = null;
    let settingsRevision = 0;
    const populate = (settings: Settings): void => {
        confirmedSettings = { ...settings };
        unitSettings.populate(settings);
        themeEl.value = settings.theme;
        showSunMoonEl.checked = settings.showSunMoon;
        showWeatherEl.checked = settings.showWeather;
        showSummitCloudEl.checked = settings.showSummitCloud;
        showSnotelEl.checked = settings.showSnotel;
        enable3dMapEl.checked = settings.enable3dMap;
        enableGarminInboxEl.checked = settings.enableGarminInbox;
        enableReportEditorEl.checked = settings.enableReportEditor;
        syncReportEditorDependentVisibility(settings.enableReportEditor);
        loadInstagramEl.checked = settings.loadInstagramAutomatically;
        addReportCreditEl.checked = settings.addReportCredit;
        removeGpxTimestampsEl.checked = settings.removeGpxTimestamps;
        retainWaypointsEl.checked = settings.retainWaypoints;
        fillAscentDetailsEl.checked = settings.fillAscentDetails;
        fillTripInfoEl.checked = settings.fillTripInfo;
        fillWildernessNightsEl.checked = settings.fillWildernessNights;
        fillExternalUrlEl.checked = settings.fillExternalUrl;
        chartSeriesEl.value = settings.chartDefaultSeries;
        mapRouteColorEl.value = settings.mapRouteColor;
        mapRouteWidthEl.value = String(settings.mapRouteWidth);
        mapRouteCasingColorEl.value = settings.mapRouteCasingColor;
        mapRouteCasingWidthEl.min = String(settings.mapRouteWidth + 2);
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
        betaSortDateDescEl.checked = settings.betaSortDateDesc;
        orderSettings.populate(settings);
        favoritesBackup.populate(settings);
        settingsBackup.populate(settings);
        photoBackup.populate(settings);
        githubBackup.populate(settings);
        applyTheme(settings.theme);
    };

    let saveQueue: Promise<unknown> = Promise.resolve();
    const save = (patch: SettingsPatch): Promise<Settings> => {
        const revision = ++settingsRevision;
        const operation = saveQueue.then(async () => {
            const next = await S.set(patch);
            if (revision === settingsRevision) {
                confirmedSettings = { ...next };
                applyTheme(next.theme);
            }
            flash();
            return next;
        });
        saveQueue = operation.catch(() => {});
        // Every control is optimistic. Restore the authoritative values and
        // report the failure instead of leaving a toggle that never persisted.
        operation.catch(async () => {
            // A first interaction can fail before startup finishes. Its baseline
            // is useful for rollback only while no newer settings owner won.
            if (!confirmedSettings) {
                const initial = await initialSettings;
                if (revision === settingsRevision && !confirmedSettings) confirmedSettings = { ...initial };
            }
            if (revision === settingsRevision && confirmedSettings) populate(confirmedSettings);
            flash('Settings couldn’t be saved. Try again.', { error: true });
        });
        return operation;
    };

    const orderSettings = initOrderSettings({ save });
    const unitSettings = initUnitSettings({ save });

    // GitHub connection and ascent and TR backup setup own their panels together; the
    // options page drives GITHUB_AUTH_* messages and never sees the token.
    const githubBackup = initGithubBackup({ extensionApi, flash, save });
    // The custom-list workspace lives on its own page (options/favorites.html);
    // only its GitHub backup stays here, under Backup & sync.
    initIgnoredBackup({ extensionApi });
    const favoritesBackup = initFavoritesBackup({ extensionApi, flash, save });
    // Credentials stay out of synced settings. The exact Settings file route
    // supplies the ImgBB key and, after a separate opt-in, the GitHub token only
    // for an explicit manual transfer.
    const imgbbKey = initImgbbKey({ extensionApi, flash });
    const settingsBackup = initSettingsBackup({
        extensionApi,
        flash,
        save,
        refreshCredentials: imgbbKey.refresh,
    });
    const photoBackup = initPhotoBackup({ extensionApi, flash, save });

    themeEl.addEventListener('change', () => save({ theme: themeEl.value }));
    showSunMoonEl.addEventListener('change', () => save({ showSunMoon: showSunMoonEl.checked }));
    showWeatherEl.addEventListener('change', () => save({ showWeather: showWeatherEl.checked }));
    showSummitCloudEl.addEventListener('change', () => save({ showSummitCloud: showSummitCloudEl.checked }));
    showSnotelEl.addEventListener('change', () => save({ showSnotel: showSnotelEl.checked }));
    enable3dMapEl.addEventListener('change', () => {
        syncTerrainCacheVisibility(enable3dMapEl.checked);
        void save({ enable3dMap: enable3dMapEl.checked });
    });
    enableGarminInboxEl.addEventListener('change', () => save({ enableGarminInbox: enableGarminInboxEl.checked }));
    enableReportEditorEl.addEventListener('change', () => {
        syncReportEditorDependentVisibility(enableReportEditorEl.checked);
        void save({ enableReportEditor: enableReportEditorEl.checked });
    });
    addReportCreditEl.addEventListener('change', () => save({ addReportCredit: addReportCreditEl.checked }));
    removeGpxTimestampsEl.addEventListener('change', () => save({ removeGpxTimestamps: removeGpxTimestampsEl.checked }));
    retainWaypointsEl.addEventListener('change', () => save({ retainWaypoints: retainWaypointsEl.checked }));
    fillAscentDetailsEl.addEventListener('change', () => save({ fillAscentDetails: fillAscentDetailsEl.checked }));
    fillTripInfoEl.addEventListener('change', () => save({ fillTripInfo: fillTripInfoEl.checked }));
    fillWildernessNightsEl.addEventListener('change', () => save({ fillWildernessNights: fillWildernessNightsEl.checked }));
    fillExternalUrlEl.addEventListener('change', () => save({ fillExternalUrl: fillExternalUrlEl.checked }));
    chartSeriesEl.addEventListener('change', () => save({ chartDefaultSeries: chartSeriesEl.value }));
    mapRouteColorEl.addEventListener('change', () => save({ mapRouteColor: mapRouteColorEl.value }));
    mapRouteWidthEl.addEventListener('change', () => {
        save({ mapRouteWidth: parseInt(mapRouteWidthEl.value, 10) }).then(populate).catch(() => {});
    });
    mapRouteCasingColorEl.addEventListener('change', () => save({ mapRouteCasingColor: mapRouteCasingColorEl.value }));
    mapRouteCasingWidthEl.addEventListener('change', () => {
        save({ mapRouteCasingWidth: parseInt(mapRouteCasingWidthEl.value, 10) }).then(populate).catch(() => {});
    });
    mapRouteResetEl.addEventListener('click', () => {
        save({
            mapRouteColor: S.DEFAULTS.mapRouteColor,
            mapRouteWidth: S.DEFAULTS.mapRouteWidth,
            mapRouteCasingColor: S.DEFAULTS.mapRouteCasingColor,
            mapRouteCasingWidth: S.DEFAULTS.mapRouteCasingWidth,
        }).then(settings => {
            populate(settings);
            flash('Route appearance reset');
        }).catch(() => {});
    });
    mapViewportWidthEl.addEventListener('change', () => {
        save({ mapViewportWidth: parseInt(mapViewportWidthEl.value, 10) }).then(populate).catch(() => {});
    });
    mapViewportHeightEl.addEventListener('change', () => {
        save({ mapViewportHeight: parseInt(mapViewportHeightEl.value, 10) }).then(populate).catch(() => {});
    });
    terrainCacheLimitEl.addEventListener('change', () => {
        save({ terrainCacheLimitMb: parseInt(terrainCacheLimitEl.value, 10) }).then(populate).catch(() => {});
    });
    mapViewportResetEl.addEventListener('click', () => {
        save({
            mapViewportWidth: S.DEFAULTS.mapViewportWidth,
            mapViewportHeight: S.DEFAULTS.mapViewportHeight,
        }).then(settings => {
            populate(settings);
            flash('Map size reset');
        }).catch(() => {});
    });
    rememberMapLayerEl.addEventListener('change', () => save({
        rememberMapLayer: rememberMapLayerEl.checked,
        ...(!rememberMapLayerEl.checked && { mapLastLayer: '' }),
    }));

    // "Has beta" definition. An empty definition is never valid: block
    // unchecking the last signal instead of silently resetting later.
    const betaSignals: readonly [HTMLInputElement, (checked: boolean) => SettingsPatch][] = [
        [betaTrEl, betaTr => ({ betaTr })],
        [betaGpsEl, betaGps => ({ betaGps })],
        [betaLinkEl, betaLink => ({ betaLink })],
    ];
    for (const [el, toPatch] of betaSignals) {
        el.addEventListener('change', () => {
            if (!betaTrEl.checked && !betaGpsEl.checked && !betaLinkEl.checked) {
                el.checked = true;
                flash('Keep at least one signal checked', { error: true });
                return;
            }
            betaTrWordsEl.disabled = !betaTrEl.checked;
            void save(toPatch(el.checked));
        });
    }
    betaTrWordsEl.addEventListener('change', () => {
        const value = Math.max(1, parseInt(betaTrWordsEl.value, 10) || 1);
        betaTrWordsEl.value = String(value);
        void save({ betaTrMinWords: value });
    });
    // Independent of the "has beta" signals (it has no at-least-one invariant).
    loadInstagramEl.addEventListener('change', () => save({ loadInstagramAutomatically: loadInstagramEl.checked }));
    betaSortDateDescEl.addEventListener('change', () => save({ betaSortDateDesc: betaSortDateDescEl.checked }));

    // Keep in sync if changed elsewhere (another tab / an inline control).
    S.subscribe(settings => {
        settingsRevision++;
        populate(settings);
    });
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
    if (typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (): void => { if (themeEl.value === 'system') applyTheme('system'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }

    initSectionNav();

    const initialRevision = settingsRevision;
    const initialSettings: Promise<Settings> = S.get();
    void initialSettings.then(settings => {
        if (initialRevision === settingsRevision) populate(settings);
    });
})();
