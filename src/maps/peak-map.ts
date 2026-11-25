// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — add the shared 3D terrain view to a Peak page's embedded
// Dynamic Map. Runs in MAIN world to inspect the page-owned, same-origin
// MasterMap frame while settings and the renderer remain extension-isolated.

import { isPeakbaggerPageOrigin } from '../peakbagger/peakbagger-origin.ts';
import { settingsSchema as Schema } from '../settings/settings-schema.ts';
import { themeResolve as ThemeResolve } from '../theme/theme-resolve.ts';
import { terrainBasemap, type LeafletTileLayer } from '../terrain/terrain-basemap.ts';
import { peakMarkers } from './peak-markers.ts';
import { terrainCompass as TerrainCompass } from '../terrain/terrain-compass.ts';
import { terrainCoordinator as TerrainCoordinator } from '../terrain/terrain-coordinator.ts';
import { terrainFailure as TerrainFailure } from '../terrain/terrain-failure.ts';
import { mountainTime as MountainTime } from '../time/mountain-time.ts';
import { sunState as SunState } from '../sun/sun-state.ts';
import { sunCalculator as SunCalculator } from '../sun/sun-calculator.ts';
import { pageLifecycle as PageLifecycle } from '../ui/page-lifecycle.ts';
import { mapViewport as MapViewport } from '../gpx/map-viewport.ts';

interface NativeLeafletMap {
    eachLayer?: unknown;
    on?: unknown;
    _layers?: Record<string, LeafletTileLayer | null | undefined>;
    hasLayer?(layer: LeafletTileLayer): boolean;
}

type NativeMapWindow = Window & {
    mapsPlaceholder?: NativeLeafletMap;
    map?: NativeLeafletMap;
    L?: { Browser?: { retina?: boolean } };
    [code: string]: unknown;
};

// Kept as an IIFE for early-exit control flow (no page map → nothing to do);
// dependencies are ES imports and the module publishes no globals.
(() => {
    'use strict';

    const initialIframe = document.querySelector<HTMLIFrameElement>('iframe#Gmap');
    if (!initialIframe || !initialIframe.parentNode) return;
    let iframe: HTMLIFrameElement = initialIframe;

    const fullMapLink = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(link => {
        try {
            const url = new URL(link.href, location.href);
            return (url.origin === location.origin || isPeakbaggerPageOrigin(url.origin))
                && /\/map\/bigmap\.aspx$/i.test(url.pathname)
                && (url.searchParams.get('t') || '').toUpperCase() === 'P';
        } catch (error) { return false; }
    });
    if (!fullMapLink) return;

    let mapUrl: URL;
    try { mapUrl = new URL(fullMapLink.href, location.href); } catch (error) { return; }
    const finiteParam = (name: string) => {
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

    const markerImage = document.querySelector<HTMLImageElement>('img[src*="MainPeak" i]');
    const markerText = markerImage && markerImage.nextSibling && markerImage.nextSibling.textContent;
    const fallbackName = document.querySelector('h1')?.textContent;
    const keyColImage = markerImage?.nextElementSibling;
    let legendName = String(markerText || fallbackName || '').replace(/\u00a0/g, ' ');
    // The Key Col annotation starts in this text node but continues after its
    // icon. Strip that opening delimiter only at the actual icon boundary.
    if (keyColImage?.tagName === 'IMG' && /\/thinmagentasquare\.gif(?:$|[?#])/i.test((keyColImage as HTMLImageElement).src)) {
        legendName = legendName.replace(/\s+\(\s*$/, '');
    }
    const peakName = legendName
        .replace(/\s+\((?:Climbed!|Unclimbed!)\)\s*$/i, '')
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
    // Warm the DEM cache on explicit intent to open 3D (toggle hover/focus),
    // throttled so a lingering cursor posts at most one hint per window.
    const TERRAIN_PREFETCH_THROTTLE_MS = 15 * 1000;
    let terrainPrefetchAt = 0;

    // Keep Peak sizing separate from the GPX preference. Restore it before
    // mounting, so the asynchronous settings bridge cannot jump the page.
    const VIEWPORT_KEY = 'pbPeakMapViewport.v1';
    const configuredHeight = iframe.getAttribute('height');
    const defaultSize = {
        // The native percentage iframe has a content-box border. Including
        // that border in the wrapper's width would widen its table by 4px,
        // then snap the table back on the first drag.
        width: Schema.viewportWidth(iframe.clientWidth || iframe.getBoundingClientRect().width || Schema.DEFAULTS.mapViewportWidth),
        height: Schema.viewportHeight(/^\d+(?:\.\d+)?(?:px)?$/i.test(configuredHeight || '')
            ? parseFloat(configuredHeight!) : 425),
    };
    let initialSize = defaultSize;
    try {
        const saved = JSON.parse(localStorage.getItem(VIEWPORT_KEY) || 'null') as { width?: unknown; height?: unknown } | null;
        if (Number.isFinite(saved?.width) && Number.isFinite(saved?.height)) {
            initialSize = { width: Schema.viewportWidth(saved!.width), height: Schema.viewportHeight(saved!.height) };
        }
    } catch { /* Missing or unavailable page-local preferences preserve the native size. */ }
    // Bound the resize boundary itself: native tables can stay wider than the
    // window. Centering inside this region then tracks window changes smoothly
    // and pointer resizing cannot request space beyond the visible region.
    const mapRegion = document.createElement('div');
    mapRegion.className = 'bpb-peak-map-region';
    iframe.before(mapRegion);
    mapRegion.append(iframe);
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
    let terrainCoordinator: ReturnType<typeof TerrainCoordinator.create> | null = null;
    const viewport = MapViewport.create({
        iframe,
        size: initialSize,
        bounds: {
            minWidth: Schema.BOUNDS.viewportWidth.min,
            maxWidth: Schema.BOUNDS.viewportWidth.max,
            minHeight: Schema.BOUNDS.viewportHeight.min,
            maxHeight: Schema.BOUNDS.viewportHeight.max,
        },
        railHeight: coarsePointer ? 44 : 16,
        targetSize: coarsePointer ? 44 : 24,
        persistDelayMs: 400,
        onPersist: size => {
            try { localStorage.setItem(VIEWPORT_KEY, JSON.stringify(size)); }
            catch { /* Resizing remains available when storage is blocked. */ }
        },
        onInvalidated: () => terrainCoordinator?.position(),
    });
    const mount = viewport.element;
    mount.className = 'bpb-terrain-mount-peak';
    const resizeHandle = mount.querySelector<HTMLElement>('#bpb-map-resize-handle')!;
    resizeHandle.title = 'Drag to resize map. Double-click to reset.';
    resizeHandle.addEventListener('dblclick', () => {
        viewport.applySize(defaultSize);
        try { localStorage.removeItem(VIEWPORT_KEY); } catch { /* Optional preference. */ }
    });

    const sunState = SunState.create();
    const sunZone = MountainTime.resolve(lat, lon);
    let sunCalculator: ReturnType<typeof SunCalculator.create> | null = null;
    const renderSun = (state: ReturnType<typeof sunState.get>) => sunCalculator?.render(state);
    const setSunBearing = (bearing: number | null) => sunCalculator?.setMapBearing(
        sunState.setMapBearing(typeof bearing === 'number' && Number.isFinite(bearing) ? bearing : 0)
    );
    sunCalculator = SunCalculator.create({
        // Keep the native map, marker legend and full-screen link together.
        // The panel belongs after the entire map cell's native content.
        mount: iframe.closest('td') || mapRegion.parentElement,
        mode: 'peak',
        onDateChange: date => renderSun(sunState.setPeakDate(date)),
        onMinuteChange: minute => renderSun(sunState.setPreviewMinute(minute)),
    });
    if (sunCalculator) {
        sunCalculator.element.hidden = true;
        renderSun(sunState.setPeakSubject({ lat, lon, zone: sunZone }));
    }

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

    const effectiveTheme = () => ThemeResolve.resolve(terrainThemePref);
    const postTerrain = (type: string, detail: Record<string, unknown> = {}) => window.postMessage({
        __bpbTerrain: true, dir: 'toCS', type, ...detail
    }, location.origin);
    const peaksResponder = peakMarkers.createTerrainResponder({
        getIframeSrc: () => iframe.src,
        post: postTerrain,
    });
    const terrainFailureNotice = TerrainFailure.createNotice({ container: mount, toggle: terrainToggle });

    const restoreNativeMap = () => {
        iframe.style.visibility = 'visible';
        iframe.removeAttribute('aria-hidden');
    };

    const resolveMapContext = () => {
        try {
            const win = iframe.contentWindow as unknown as NativeMapWindow | null;
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
        let select: HTMLSelectElement | null = null;
        try { select = iframe.contentDocument && iframe.contentDocument.getElementById('selmap') as HTMLSelectElement | null; }
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

    const positionTerrainToggle = ({ state }: { state: string }) => {
        // Keep one anchor through loading, 3D and return to 2D. The shared CSS
        // reserves the terrain controls; unusually tall native attribution can
        // raise that anchor in both modes, never only after a mode switch.
        const bottom = measureNative2dZoomTop();
        terrainToggle.style.bottom = bottom != null && bottom > 0
            ? `max(var(--bpb-terrain-toggle-bottom), ${Math.round(bottom + TERRAIN_TOGGLE_GAP)}px)`
            : '';
        terrainCompass.position();
        // On the shortest map, the right-aligned station control leaves no
        // room above 2D for the compass. Keep it beside 2D in that case.
        const compass = terrainCompass.element;
        compass.style.right = '';
        const snowToggle = mount.querySelector<HTMLElement>('.bpb-snow-map-toggle');
        if (state === 'active' && snowToggle && !snowToggle.hidden) {
            const snowRect = snowToggle.getBoundingClientRect(), compassRect = compass.getBoundingClientRect();
            if (compassRect.top < snowRect.bottom + 8) {
                compass.style.bottom = getComputedStyle(terrainToggle).bottom;
                compass.style.right = `${Math.round(mount.getBoundingClientRect().right - terrainToggle.getBoundingClientRect().left + 8)}px`;
            }
        }
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
            cacheLimitMb: Schema.terrainCacheLimitMb(terrainCacheLimitMb),
            snowStations: []
        };
    };

    const coordinator = TerrainCoordinator.create({
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
        showFailure: reason => terrainFailureNotice.show(reason as Parameters<typeof terrainFailureNotice.show>[0]),
        setFailureTheme: value => terrainFailureNotice.setTheme(value),
        onView: setSunBearing,
        theme: effectiveTheme,
        position: positionTerrainToggle
    });
    terrainCoordinator = coordinator;

    // Hovering or focusing the idle 3D toggle is explicit intent to open 3D, so
    // it stays inside the same consent scope: warm the DEM cache for this peak's
    // already-validated center and zoom. Never on page load, never when 3D off.
    const maybePrefetchTerrain = () => {
        if (!coordinator.isIdle() || !terrainEnabled) return;
        const nowMs = Date.now();
        if (nowMs - terrainPrefetchAt < TERRAIN_PREFETCH_THROTTLE_MS) return;
        terrainPrefetchAt = nowMs;
        postTerrain('prefetch', {
            center: [lat, lon],
            zoom: focusZoom,
            viewport: { width: window.innerWidth, height: window.innerHeight }
        });
    };
    terrainToggle.addEventListener('pointerenter', maybePrefetchTerrain);
    terrainToggle.addEventListener('focus', maybePrefetchTerrain);

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data as Record<string, unknown> | null | undefined;
        if (!data || data.__bpbTerrain !== true || data.dir !== 'toPage') return;
        if (data.type === 'consentResult' && terrainConsentPending) {
            terrainConsentPending = false;
            if (data.enabled === true) coordinator.start(true);
        } else if (data.type === 'peaksRequest' && !coordinator.isIdle()) {
            peaksResponder.answer(data as Parameters<typeof peaksResponder.answer>[0]);
        } else coordinator.handleMessage(data as Parameters<typeof coordinator.handleMessage>[0]);
    });

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data as Record<string, unknown> | null | undefined;
        if (!data || data.__bpbPeakMap !== true || data.dir !== 'toPage') return;
        const settings = Schema.clean({
            enable3dMap: data.enable3dMap,
            showSunMoon: data.showSunMoon,
            theme: data.theme,
            terrainCacheLimitMb: data.terrainCacheLimitMb
        });
        terrainEnabled = settings.enable3dMap;
        terrainThemePref = settings.theme;
        terrainCacheLimitMb = settings.terrainCacheLimitMb;
        sunCalculator?.setTheme(effectiveTheme());
        if (sunCalculator) sunCalculator.element.hidden = !settings.showSunMoon;
        if (!terrainEnabled && !coordinator.isIdle()) coordinator.stop();
        if (coordinator.isActive()) postTerrain('update', { theme: effectiveTheme() });
        coordinator.update();
        if (terrainEnabled && terrainConsentPending && coordinator.isIdle()) {
            terrainConsentPending = false;
            coordinator.start();
        }
    });

    const handleIframeLoad = () => {
        peaksResponder.reset();
        viewport.scheduleInvalidate();
    };
    iframe.addEventListener('load', handleIframeLoad);

    coordinator.update();
    sunCalculator?.setTheme(effectiveTheme());
    PageLifecycle.create({
        onSuspend: () => {
            if (coordinator.isOpen() && !coordinator.isActive()) {
                coordinator.reset();
            }
        },
        onResume: () => {
            const nextIframe = document.querySelector<HTMLIFrameElement>('iframe#Gmap');
            if (nextIframe && nextIframe !== iframe) {
                if (coordinator.isOpen()) coordinator.reset();
                iframe.removeEventListener('load', handleIframeLoad);
                iframe.style.visibility = 'visible';
                iframe.removeAttribute('aria-hidden');
                iframe = nextIframe;
                viewport.attach(iframe);
                iframe.addEventListener('load', handleIframeLoad);
            }
            handleIframeLoad();
            renderSun(sunState.get());
            coordinator.update();
            coordinator.position();
            window.postMessage({ __bpbPeakMap: true, dir: 'toCS', type: 'get' }, location.origin);
        },
        onDispose: () => {
            if (coordinator.isOpen()) coordinator.reset();
            iframe.removeEventListener('load', handleIframeLoad);
            viewport.dispose();
            sunState.resetSubject();
            sunCalculator?.dispose();
            sunCalculator = null;
        },
    });
    window.postMessage({ __bpbPeakMap: true, dir: 'toCS', type: 'get' }, location.origin);
})();
