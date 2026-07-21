// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — add the shared 3D terrain view to a Peak page's embedded
// Dynamic Map. Runs in MAIN world to inspect the page-owned, same-origin
// MasterMap frame while settings and the renderer remain extension-isolated.

import { settingsSchema as Schema } from './settings-schema.js';
import { terrainBasemap } from './terrain-basemap.js';
import { peakMarkers } from './peak-markers.js';
import { terrainCompass as TerrainCompass } from './terrain-compass.js';
import { terrainCoordinator as TerrainCoordinator } from './terrain-coordinator.js';
import { terrainFailure as TerrainFailure } from './terrain-failure.js';

// Kept as an IIFE for early-exit control flow (no page map → nothing to do);
// dependencies are ES imports and the module publishes no globals.
(() => {
    'use strict';

    const PEAKBAGGER_ORIGIN = /^https?:\/\/(?:www\.)?peakbagger\.com(?::\d+)?$/i;

    const iframe = document.querySelector('iframe#Gmap');
    if (!iframe || !iframe.parentNode) return;

    const fullMapLink = Array.from(document.querySelectorAll('a[href]')).find(link => {
        try {
            const url = new URL(link.href, location.href);
            return (url.origin === location.origin || PEAKBAGGER_ORIGIN.test(url.origin))
                && /\/map\/bigmap\.aspx$/i.test(url.pathname)
                && (url.searchParams.get('t') || '').toUpperCase() === 'P';
        } catch (error) { return false; }
    });
    if (!fullMapLink) return;

    let mapUrl;
    try { mapUrl = new URL(fullMapLink.href, location.href); } catch (error) { return; }
    const finiteParam = name => {
        const raw = mapUrl.searchParams.get(name);
        return raw !== null && raw.trim() !== '' ? Number(raw) : NaN;
    };
    const lat = finiteParam('cy');
    const lon = finiteParam('cx');
    const nativeZoom = finiteParam('z');
    const pagePid = Number(new URL(location.href).searchParams.get('pid'));
    const mapPid = Number(mapUrl.searchParams.get('d'));
    if (!Number.isFinite(lat) || Math.abs(lat) > 85.0511287
        || !Number.isFinite(lon) || Math.abs(lon) > 180
        || !Number.isFinite(nativeZoom) || nativeZoom < 0 || nativeZoom > 19
        || !Number.isInteger(pagePid) || pagePid === 0 || Math.abs(pagePid) > 1e9
        || !Number.isInteger(mapPid) || mapPid !== pagePid) return;

    const markerImage = document.querySelector('img[src*="MainPeak" i]');
    const markerText = markerImage && markerImage.nextSibling && markerImage.nextSibling.textContent;
    const fallbackName = document.querySelector('h1')?.textContent;
    const peakName = String(markerText || fallbackName || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+\([^)]*\).*$/, '')
        .trim()
        .slice(0, 120);
    if (!peakName || /[\u0000-\u001f\u007f]/.test(peakName)) return;

    const markerSrc = markerImage ? markerImage.src : '';
    const peakState = /mainpeakgreencircle\.gif(?:$|[?#])/i.test(markerSrc)
        ? 'climbed'
        : /mainpeakpinkcircle\.gif(?:$|[?#])/i.test(markerSrc) ? 'unclimbed' : 'unknown';
    // Leaflet uses 256px tiles while MapLibre's camera uses 512px tiles; one
    // zoom level lower preserves the Dynamic Map's visible ground area.
    const focusZoom = Math.max(0, Math.min(18, nativeZoom - 1));
    const focusPeak = { id: pagePid, name: peakName, lat, lon, state: peakState };

    const TERRAIN_TOGGLE_GAP = 8;
    let terrainEnabled = false;
    let terrainThemePref = Schema.DEFAULTS.theme;
    let terrainCacheLimitMb = Schema.DEFAULTS.terrainCacheLimitMb;
    let terrainConsentPending = false;
    let peaksClient = null;
    let peaksClientResolved = false;
    // Warm the DEM cache on explicit intent to open 3D (toggle hover/focus),
    // throttled so a lingering cursor posts at most one hint per window.
    const TERRAIN_PREFETCH_THROTTLE_MS = 15 * 1000;
    let terrainPrefetchAt = 0;

    const mount = document.createElement('div');
    mount.id = 'bpb-map-viewport';
    mount.className = 'bpb-terrain-mount-peak';
    const configuredHeight = iframe.getAttribute('height');
    mount.style.height = /^\d+(?:\.\d+)?(?:px)?$/i.test(configuredHeight || '')
        ? `${parseFloat(configuredHeight)}px`
        : '425px';
    iframe.parentNode.insertBefore(mount, iframe);
    mount.append(iframe);

    const terrainToggle = document.createElement('button');
    terrainToggle.id = 'bpb-terrain-toggle';
    terrainToggle.className = 'bpb-map-3d-toggle';
    terrainToggle.type = 'button';
    terrainToggle.setAttribute('aria-pressed', 'false');
    mount.append(terrainToggle);

    // A Google-Maps-style compass just above the toggle, shown only in 3D.
    const terrainCompass = TerrainCompass.create({
        container: mount,
        toggle: terrainToggle,
        onReset: () => postTerrain('resetNorth')
    });

    const prefersDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const effectiveTheme = () => (terrainThemePref === 'light' || terrainThemePref === 'dark')
        ? terrainThemePref
        : (prefersDark() ? 'dark' : 'light');
    const postTerrain = (type, detail = {}) => window.postMessage({
        __bpbTerrain: true, dir: 'toCS', type, ...detail
    }, location.origin);
    const terrainFailureNotice = TerrainFailure.createNotice({ container: mount, toggle: terrainToggle });

    // Hovering or focusing the idle 3D toggle is explicit intent to open 3D, so
    // it stays inside the same consent scope: warm the DEM cache for this peak's
    // already-validated center and zoom. Never on page load, never when 3D off.
    const maybePrefetchTerrain = () => {
        if (!terrainCoordinator.isIdle() || !terrainEnabled) return;
        const nowMs = Date.now();
        if (nowMs - terrainPrefetchAt < TERRAIN_PREFETCH_THROTTLE_MS) return;
        terrainPrefetchAt = nowMs;
        postTerrain('prefetch', {
            center: [lat, lon],
            zoom: focusZoom,
            viewport: { width: window.innerWidth, height: window.innerHeight }
        });
    };

    const restoreNativeMap = () => {
        iframe.style.visibility = 'visible';
        iframe.removeAttribute('aria-hidden');
    };

    const resolveMapContext = () => {
        try {
            const win = iframe.contentWindow;
            if (!win) return null;
            for (const map of [win.mapsPlaceholder, win.map]) {
                if (map && typeof map.eachLayer === 'function' && typeof map.on === 'function') return { win, map };
            }
        } catch (error) { /* A replaced or cross-origin frame cannot provide a drape. */ }
        return null;
    };

    const terrainBasemaps = () => {
        const B = terrainBasemap;
        if (!B) return { basemap: null, basemaps: [] };
        const context = resolveMapContext();
        let select = null;
        try { select = iframe.contentDocument && iframe.contentDocument.getElementById('selmap'); }
        catch (error) { select = null; }
        return {
            basemap: context ? B.active(context.win, context.map, select) : null,
            basemaps: B.enumerate(select)
        };
    };

    const measureNative2dZoomTop = () => {
        try {
            const zoom = iframe.contentDocument && iframe.contentDocument.querySelector('.leaflet-control-zoom');
            const zoomRect = zoom && zoom.getBoundingClientRect();
            const iframeRect = iframe.getBoundingClientRect();
            const mountRect = mount.getBoundingClientRect();
            if (!zoomRect || !(zoomRect.height > 0)) return null;
            return mountRect.bottom - (iframeRect.top + zoomRect.top);
        } catch (error) { return null; }
    };

    const positionTerrainToggle = ({ state, navTop }) => {
        let bottom = null;
        if (state === 'active') {
            const frame = document.getElementById('bpb-terrain-frame');
            if (frame && navTop != null) {
                bottom = Math.max(0, mount.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom)
                    + navTop;
            }
        } else {
            bottom = measureNative2dZoomTop();
        }
        terrainToggle.style.bottom = bottom != null && bottom > 0
            ? `${Math.round(bottom + TERRAIN_TOGGLE_GAP)}px`
            : '';
        terrainCompass.position();
        terrainFailureNotice.position();
    };

    const buildTerrainInit = () => {
        const { basemap, basemaps } = terrainBasemaps();
        return {
            focus: [lat, lon],
            focusZoom,
            focusPeak,
            theme: effectiveTheme(),
            basemap,
            basemaps,
            cacheLimitMb: Schema.terrainCacheLimitMb(terrainCacheLimitMb)
        };
    };

    const terrainCoordinator = TerrainCoordinator.create({
        toggle: terrainToggle,
        compass: terrainCompass,
        isEnabled: () => terrainEnabled,
        idleUi: () => ({
            disabled: false,
            title: 'View this peak on 3D terrain',
            ariaLabel: 'Show 3D terrain'
        }),
        buildInit: buildTerrainInit,
        nativeMap: () => resolveMapContext()?.map,
        hideNativeMap: () => {
            iframe.style.visibility = 'hidden';
            iframe.setAttribute('aria-hidden', 'true');
        },
        restoreNativeMap,
        post: postTerrain,
        requestConsent: () => {
            if (terrainConsentPending) return;
            terrainConsentPending = true;
            postTerrain('requestConsent');
        },
        clearFailure: () => terrainFailureNotice.clear(),
        showFailure: reason => terrainFailureNotice.show(reason),
        setFailureTheme: value => terrainFailureNotice.setTheme(value),
        theme: effectiveTheme,
        position: positionTerrainToggle
    });
    terrainToggle.addEventListener('pointerenter', maybePrefetchTerrain);
    terrainToggle.addEventListener('focus', maybePrefetchTerrain);

    const answerPeaksRequest = data => {
        const requestId = data.requestId;
        if (!Number.isFinite(requestId)) return;
        if (!peaksClientResolved) {
            peaksClientResolved = true;
            peaksClient = peakMarkers
                ? peakMarkers.createClient(iframe.src)
                : null;
        }
        if (!peaksClient) {
            postTerrain('peaks', { requestId, peaks: [], unavailable: true });
            return;
        }
        peaksClient.request(data.bounds).then(peaks => {
            if (peaks) postTerrain('peaks', { requestId, peaks });
        });
    };

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbTerrain !== true || data.dir !== 'toPage') return;
        if (data.type === 'consentResult' && terrainConsentPending) {
            terrainConsentPending = false;
            if (data.enabled === true) terrainCoordinator.start(true);
        } else if (data.type === 'peaksRequest' && !terrainCoordinator.isIdle()) {
            answerPeaksRequest(data);
        } else terrainCoordinator.handleMessage(data);
    });

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbPeakMap !== true || data.dir !== 'toPage') return;
        const settings = Schema.clean({
            enable3dMap: data.enable3dMap,
            theme: data.theme,
            terrainCacheLimitMb: data.terrainCacheLimitMb
        });
        terrainEnabled = settings.enable3dMap;
        terrainThemePref = settings.theme;
        terrainCacheLimitMb = settings.terrainCacheLimitMb;
        if (!terrainEnabled && !terrainCoordinator.isIdle()) terrainCoordinator.stop();
        if (terrainCoordinator.isActive()) postTerrain('update', { theme: effectiveTheme() });
        terrainCoordinator.update();
        if (terrainEnabled && terrainConsentPending && terrainCoordinator.isIdle()) {
            terrainConsentPending = false;
            terrainCoordinator.start();
        }
    });

    window.addEventListener('resize', () => terrainCoordinator.position());
    iframe.addEventListener('load', () => {
        peaksClient = null;
        peaksClientResolved = false;
        terrainCoordinator.position();
    });

    terrainCoordinator.update();
    window.postMessage({ __bpbPeakMap: true, dir: 'toCS', type: 'get' }, location.origin);
})();
