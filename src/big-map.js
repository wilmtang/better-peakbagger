// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — preserve Peakbagger's native Full Screen Map tracks and
// interactions while applying the user's preferred base route width, a matching
// white casing, and (on single-ascent maps) the preferred route color.
// Runs in MAIN world because the Leaflet map and layers are page-owned globals.

import { settingsSchema as Schema } from './settings-schema.js';
import { gpxMetrics } from './gpx-metrics.js';
import { terrainBasemap } from './terrain-basemap.js';
import { peakMarkers } from './peak-markers.js';

// Kept as an IIFE for early-exit control flow (non-Full-Screen-Map pages);
// dependencies are ES imports and the module publishes no globals.
(() => {
    'use strict';

    const params = new URLSearchParams(location.search);
    const mapType = (params.get('t') || '').toUpperCase();
    if (!['A', 'G'].includes(mapType)) return;

    // Single-ascent maps ('A') show one track, so it is safe to recolor it to
    // the preferred route color. Group maps ('G') use color to tell climbers
    // apart, so only the width and the casing are applied there.
    const recolorTrack = mapType === 'A';

    const DEFAULT_STYLE = Schema.ROUTE_STYLE;
    const enhancedLayers = new WeakSet();
    // Our own casing underlays, keyed by the native track they sit behind, so
    // they are never mistaken for native tracks and are removed with them.
    const casings = new WeakMap();
    const casingLayers = new WeakSet();
    let routeStyle = { ...DEFAULT_STYLE };
    let activeMap = null;
    // The Leaflet map (and its L) can live in a same-origin child iframe, so
    // remember the window that owns them to build casings in the same realm.
    let activeMapWin = null;
    let retryTimer = null;

    // Peakbagger colors each group-map track to tell climbers apart. Read that
    // native color as #rrggbb so the 3D view can keep tracks distinct; #rgb and
    // rgb() forms are normalized, anything else returns null (frame falls back).
    const nativeTrackColor = layer => {
        const raw = layer && layer.options && typeof layer.options.color === 'string' ? layer.options.color.trim() : '';
        if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
        if (/^#[0-9a-f]{3}$/i.test(raw)) return '#' + raw.slice(1).split('').map(c => c + c).join('').toLowerCase();
        const rgb = raw.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
        if (rgb && rgb.slice(1).every(n => Number(n) <= 255)) {
            return '#' + rgb.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('');
        }
        return null;
    };

    const trackStyle = () => recolorTrack
        ? { color: routeStyle.color, weight: routeStyle.width }
        : { weight: routeStyle.width };

    const containsLine = latLngs => {
        if (!Array.isArray(latLngs) || !latLngs.length) return false;
        if (latLngs.length >= 2 && latLngs.every(point => point
            && Number.isFinite(point.lat) && Number.isFinite(point.lng))) return true;
        return latLngs.some(containsLine);
    };

    const isNativeTrack = (layer, L) => {
        if (!layer || typeof layer.setStyle !== 'function' || typeof layer.getLatLngs !== 'function') return false;
        if (typeof L.Polyline !== 'function' || !(layer instanceof L.Polyline)) return false;
        if ((typeof L.Polygon === 'function' && layer instanceof L.Polygon) || layer.options?.fill === true) return false;
        if (!containsLine(layer.getLatLngs())) return false;

        // Group maps can create transient line-shaped hover effects. The ten
        // actual route layers are interactive (Peakbagger documents hover and
        // click behavior); effects are not. Requiring native handlers keeps us
        // from flattening the highlight style while still leaving those
        // handlers completely owned by Peakbagger.
        if (mapType === 'G') {
            const events = layer._events;
            if (!events || !events.mouseover || (!events.click && !layer._popup)) return false;
        }
        return true;
    };

    // A white (configurable) underlay traced along the native track, sitting
    // beneath it so the colored line reads as a cased route — the same effect
    // the embedded ascent map builds with a second polyline.
    const ensureCasing = layer => {
        const L = activeMapWin && activeMapWin.L;
        if (!L || typeof L.Polyline !== 'function') return;
        let casing = casings.get(layer);
        if (casing) {
            try { casing.setStyle({ color: routeStyle.casingColor, weight: routeStyle.casingWidth }); }
            catch (error) { /* The casing may already have been removed. */ }
            return;
        }
        try {
            casing = new L.Polyline(layer.getLatLngs(), {
                color: routeStyle.casingColor,
                weight: routeStyle.casingWidth,
                opacity: 0.92,
                interactive: false,
                lineCap: 'round',
                lineJoin: 'round'
            });
        } catch (error) { return; }
        casingLayers.add(casing);
        casings.set(layer, casing);
        try { activeMap.addLayer(casing); } catch (error) {
            casings.delete(layer);
            return;
        }
        // Keep every casing beneath the native tracks and markers.
        if (typeof casing.bringToBack === 'function') {
            try { casing.bringToBack(); } catch (error) { /* Pane not ready; render order still favors native tracks. */ }
        }
    };

    const removeCasing = layer => {
        const casing = casings.get(layer);
        if (!casing) return;
        casings.delete(layer);
        if (activeMap && typeof activeMap.removeLayer === 'function') {
            try { activeMap.removeLayer(casing); } catch (error) { /* Already discarded with its map. */ }
        }
    };

    const applyStyle = layer => {
        const L = activeMapWin && activeMapWin.L;
        // Never treat our own casing as a native track to widen or re-case.
        if (!activeMap || !L || casingLayers.has(layer) || !isNativeTrack(layer, L)) return;
        try { layer.setStyle(trackStyle()); } catch (error) { return; }
        ensureCasing(layer);
        if (enhancedLayers.has(layer) || typeof layer.on !== 'function') return;
        enhancedLayers.add(layer);

        // Peakbagger temporarily changes route styling during hover. Restore
        // our base style after every native mouseout handler has run.
        layer.on('mouseout', () => queueMicrotask(() => {
            if (layer._map === activeMap) {
                try { layer.setStyle(trackStyle()); } catch (error) { /* The native layer may have been removed. */ }
            }
        }));
    };

    const applyAllStyles = () => {
        if (!activeMap || typeof activeMap.eachLayer !== 'function') return;
        try { activeMap.eachLayer(applyStyle); } catch (error) { /* A live Leaflet layer collection can change during iteration. */ }
    };

    // The Full Screen page (BigMap.aspx) is a shell whose Leaflet map and tracks
    // live in a same-origin MasterMap.aspx child iframe; other layouts may keep
    // them in this window. Return whichever context actually exposes the map so
    // the casing is built in the frame that owns the tracks — the previous
    // code only checked this window and so never found the Full Screen tracks.
    const findMapIframe = () =>
        document.querySelector('iframe#if, iframe[src*="MasterMap.aspx" i], iframe[src*="mastermap.aspx" i]');

    const resolveMapContext = () => {
        const candidates = [];
        const iframe = findMapIframe();
        try { if (iframe && iframe.contentWindow) candidates.push(iframe.contentWindow); }
        catch (error) { /* A cross-origin frame is not ours to read. */ }
        candidates.push(window);

        for (const win of candidates) {
            let L;
            try { L = win.L; } catch (error) { continue; }
            if (!L || typeof L.Map !== 'function') continue;
            for (const map of [win.mapsPlaceholder, win.map]) {
                if (map && typeof map.eachLayer === 'function' && typeof map.on === 'function'
                    && map instanceof L.Map) return { win, map };
            }
        }
        return null;
    };

    const bindMap = () => {
        const context = resolveMapContext();
        if (!context) return false;
        if (context.map !== activeMap) {
            activeMap = context.map;
            activeMapWin = context.win;
            activeMap.on('layeradd', event => queueMicrotask(() => { applyStyle(event && event.layer); updateTerrainToggle(); }));
            activeMap.on('layerremove', event => { removeCasing(event && event.layer); updateTerrainToggle(); });
        }
        applyAllStyles();
        updateTerrainToggle();
        return true;
    };

    // === 3D terrain (Full Screen) ===
    // A floating 3D/2D toggle over the native map, mirroring the ascent GPX
    // analyzer. The route geometry comes from the native Leaflet tracks; the
    // renderer, drape specs, and DEM cache are shared with the ascent page via
    // the extension-owned terrain frame (src/terrain-map.js + terrain/). Group
    // maps carry each track's native color into 3D so climbers stay
    // distinguishable (single-ascent maps use one preferred color); the shared
    // width and casing apply to both. Markers/peaks are not carried into 3D.
    const TERRAIN_LOAD_TIMEOUT_MS = 17000;
    let terrainEnabled = false;
    let terrainThemePref = 'system';
    let terrainCacheLimitMb = Schema.DEFAULTS.terrainCacheLimitMb;
    let terrainState = 'idle';
    let terrainConsentPending = false;
    let terrainMount = null;
    let terrainToggle = null;
    let terrainLoadTimer = null;
    let terrainNavTop = null;
    const TERRAIN_TOGGLE_GAP = 8;

    // Float the toggle just above the zoom stack of whichever map is showing:
    // the 3D frame reports its stack height (cross-origin), the native 2D zoom is
    // measured directly. A null result leaves the CSS fallback offset in place.
    const measureNative2dZoomTop = () => {
        try {
            const doc = activeMapWin && activeMapWin.document;
            const zoom = doc && doc.querySelector('.leaflet-control-zoom');
            const zoomRect = zoom && zoom.getBoundingClientRect();
            if (!zoomRect || !(zoomRect.height > 0)) return null;
            let top = zoomRect.top;
            if (activeMapWin !== window) {
                const iframe = findMapIframe();
                if (iframe) top += iframe.getBoundingClientRect().top;
            }
            return window.innerHeight - top;
        } catch (error) {
            return null;
        }
    };
    const positionTerrainToggle = () => {
        if (!terrainToggle) return;
        let bottom = null;
        if (terrainState === 'active') {
            const frame = document.getElementById('bpb-terrain-frame');
            if (frame && terrainNavTop != null) {
                // The mount is a full-viewport fixed overlay, so the frame bottom
                // is the viewport bottom and navTop is viewport-relative already.
                const inset = Math.max(0, window.innerHeight - frame.getBoundingClientRect().bottom);
                bottom = inset + terrainNavTop;
            }
        } else {
            bottom = measureNative2dZoomTop();
        }
        terrainToggle.style.bottom = bottom != null && bottom > 0 ? `${Math.round(bottom + TERRAIN_TOGGLE_GAP)}px` : '';
    };

    const prefersDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const effectiveTheme = () => (terrainThemePref === 'light' || terrainThemePref === 'dark')
        ? terrainThemePref
        : (prefersDark() ? 'dark' : 'light');

    const postTerrain = (type, detail = {}) => window.postMessage({
        __bpbTerrain: true, dir: 'toCS', type, ...detail
    }, location.origin);

    const clearTerrainLoadTimer = () => {
        if (terrainLoadTimer !== null) {
            clearTimeout(terrainLoadTimer);
            terrainLoadTimer = null;
        }
    };

    // The element that shows the native 2D map: the same-origin MasterMap child
    // iframe when the map lives there, else the top-window map container.
    const nativeMapElement = () =>
        (activeMapWin && activeMapWin !== window && findMapIframe())
        || document.getElementById('map')
        || findMapIframe();

    const restoreNativeMap = () => {
        const element = nativeMapElement();
        if (!element) return;
        element.style.visibility = 'visible';
        element.removeAttribute('aria-hidden');
    };

    // Native GPS tracks (single-ascent: one; group: up to ten) flattened into
    // [[lat, lon], …] segments, reduced to the shared point/segment budget. On
    // group maps each segment carries its track's native color (parallel to
    // segments) so 3D can keep climbers apart the way the 2D map does; single-
    // ascent maps recolor to the preferred color, so colors stay null there.
    const collectRoute = () => {
        if (!activeMap || !activeMapWin || typeof activeMap.eachLayer !== 'function') return { segments: [], colors: [] };
        const L = activeMapWin.L;
        if (!L) return { segments: [], colors: [] };
        const segments = [];
        const colors = [];
        const pushLatLngs = (latLngs, color) => {
            if (!Array.isArray(latLngs) || !latLngs.length) return;
            if (latLngs.every(point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng))) {
                if (latLngs.length >= 2) { segments.push(latLngs.map(point => [point.lat, point.lng])); colors.push(color); }
                return;
            }
            latLngs.forEach(part => pushLatLngs(part, color));
        };
        try {
            activeMap.eachLayer(layer => {
                if (casingLayers.has(layer) || !isNativeTrack(layer, L)) return;
                const color = mapType === 'G' ? nativeTrackColor(layer) : null;
                try { pushLatLngs(layer.getLatLngs(), color); } catch (error) { /* layer may be mid-removal */ }
            });
        } catch (error) { /* a live Leaflet layer collection can change during iteration */ }
        const limited = gpxMetrics ? gpxMetrics.limitMapRouteSegments(segments) : segments;
        // The reducer keeps segment order 1:1, or returns [] when it drops the
        // whole overlay; only then do the parallel colors fall out of alignment.
        return limited.length === segments.length ? { segments: limited, colors } : { segments: limited, colors: [] };
    };

    const terrainBasemaps = () => {
        const B = terrainBasemap;
        if (!B) return { basemap: null, basemaps: [] };
        let select = null;
        try { select = activeMapWin && activeMapWin.document && activeMapWin.document.getElementById('selmap'); }
        catch (error) { select = null; }
        return { basemap: B.active(activeMapWin, activeMap, select), basemaps: B.enumerate(select) };
    };

    const ensureTerrainToggle = () => {
        if (terrainToggle) return;
        // The mount is a fixed overlay that hosts the toggle (always clickable)
        // and, once activated, the full-bleed terrain frame; clicks otherwise
        // pass through to the native 2D map. The bridge mounts the frame here.
        terrainMount = document.createElement('div');
        terrainMount.id = 'bpb-map-viewport';
        terrainMount.className = 'bpb-terrain-mount-fullscreen';
        terrainToggle = document.createElement('button');
        terrainToggle.id = 'bpb-terrain-toggle';
        terrainToggle.className = 'bpb-map-3d-toggle';
        terrainToggle.type = 'button';
        terrainToggle.setAttribute('aria-pressed', 'false');
        terrainToggle.addEventListener('click', () => {
            if (terrainState === 'active') { stopTerrain(); return; }
            if (terrainState !== 'idle') return;
            if (!terrainEnabled) {
                if (terrainConsentPending || !collectRoute().segments.length) return;
                terrainConsentPending = true;
                postTerrain('requestConsent');
                return;
            }
            startTerrain();
        });
        terrainMount.append(terrainToggle);
        document.body.append(terrainMount);
    };

    const updateTerrainToggle = () => {
        ensureTerrainToggle();
        terrainMount.hidden = false;
        terrainToggle.dataset.theme = effectiveTheme();
        terrainToggle.classList.remove('bpb-map-3d-toggle-loading');
        terrainToggle.removeAttribute('aria-busy');
        if (terrainState === 'loading') {
            terrainToggle.disabled = true;
            terrainToggle.textContent = '3D';
            terrainToggle.classList.add('bpb-map-3d-toggle-loading');
            terrainToggle.setAttribute('aria-busy', 'true');
            terrainToggle.title = 'Loading 3D terrain…';
            terrainToggle.setAttribute('aria-label', 'Loading 3D terrain');
            terrainToggle.setAttribute('aria-pressed', 'false');
        } else if (terrainState === 'active') {
            terrainToggle.disabled = false;
            terrainToggle.textContent = '2D';
            terrainToggle.title = 'Return to the 2D map';
            terrainToggle.setAttribute('aria-label', 'Return to the 2D map');
            terrainToggle.setAttribute('aria-pressed', 'true');
        } else {
            const hasRoute = collectRoute().segments.length > 0;
            terrainToggle.disabled = !hasRoute;
            terrainToggle.textContent = '3D';
            terrainToggle.title = hasRoute ? 'View this route on 3D terrain' : 'Available once the map has a GPS track';
            terrainToggle.setAttribute('aria-label', hasRoute ? 'Show 3D terrain' : '3D terrain available once the map has a GPS track');
            terrainToggle.setAttribute('aria-pressed', 'false');
        }
        positionTerrainToggle();
    };

    const failTerrain = () => {
        clearTerrainLoadTimer();
        terrainState = 'idle';
        restoreNativeMap();
        postTerrain('destroy');
        updateTerrainToggle();
    };

    const startTerrain = (consentGranted = false) => {
        if ((!consentGranted && !terrainEnabled) || terrainState !== 'idle') return;
        const { segments: routeSegments, colors: routeColors } = collectRoute();
        if (!routeSegments.length) return;
        terrainState = 'loading';
        updateTerrainToggle();
        const { basemap, basemaps } = terrainBasemaps();
        postTerrain('init', {
            routeSegments,
            routeColors,
            routeStyle: { ...routeStyle },
            theme: effectiveTheme(),
            basemap,
            basemaps,
            cacheLimitMb: Schema.terrainCacheLimitMb(terrainCacheLimitMb)
        });
        terrainLoadTimer = setTimeout(() => { if (terrainState === 'loading') failTerrain(); }, TERRAIN_LOAD_TIMEOUT_MS);
    };

    const stopTerrain = () => {
        clearTerrainLoadTimer();
        terrainState = 'idle';
        restoreNativeMap();
        postTerrain('destroy');
        updateTerrainToggle();
    };

    // The 3D frame asks for Peakbagger's peak dots as its camera settles; the
    // request is served by the same-origin PLLBB feed the native 2D map uses,
    // with the parameters read from the MasterMap iframe URL. Group maps have
    // no peak feed natively, so they answer `unavailable` once and the frame
    // stops asking.
    let peaksClient = null;
    let peaksClientResolved = false;
    const answerPeaksRequest = data => {
        const requestId = data.requestId;
        if (!Number.isFinite(requestId)) return;
        if (!peaksClientResolved) {
            peaksClientResolved = true;
            const iframe = findMapIframe();
            peaksClient = peakMarkers && iframe
                ? peakMarkers.createClient(iframe.src)
                : null;
        }
        if (!peaksClient) {
            postTerrain('peaks', { requestId, peaks: [], unavailable: true });
            return;
        }
        peaksClient.request(data.bounds).then(peaks => {
            // A superseded request resolves null and stays silent; the newer
            // request answers instead.
            if (peaks) postTerrain('peaks', { requestId, peaks });
        });
    };

    // Replies from the extension-owned terrain frame (via the isolated-world
    // bridge). Same protocol as the ascent page.
    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbTerrain !== true || data.dir !== 'toPage') return;
        if (data.type === 'consentResult' && terrainConsentPending) {
            terrainConsentPending = false;
            if (data.enabled === true) startTerrain(true);
            return;
        }
        if (data.type === 'peaksRequest' && terrainState !== 'idle') {
            answerPeaksRequest(data);
            return;
        }
        if (data.type === 'loaded' && terrainState === 'loading') {
            clearTerrainLoadTimer();
            terrainState = 'active';
            terrainNavTop = Number.isFinite(data.navTop) ? data.navTop : null;
            const element = nativeMapElement();
            if (element) {
                element.style.visibility = 'hidden';
                element.setAttribute('aria-hidden', 'true');
            }
            updateTerrainToggle();
        } else if (data.type === 'metrics' && terrainState === 'active') {
            if (Number.isFinite(data.navTop)) terrainNavTop = data.navTop;
            positionTerrainToggle();
        } else if (data.type === 'error' && terrainState === 'loading') {
            failTerrain();
        }
    });

    window.addEventListener('resize', () => positionTerrainToggle());

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbBigMap !== true || data.dir !== 'toPage') return;
        // The bridge's wire shape, re-validated through the shared schema: this
        // message crosses into the page world, so the sender is not trusted.
        routeStyle = Schema.routeStyle({
            color: data.routeColor,
            width: data.routeWidth,
            casingColor: data.casingColor,
            casingWidth: data.casingWidth
        });
        terrainEnabled = data.enable3dMap === true;
        terrainThemePref = data.theme;
        if (Number.isInteger(data.terrainCacheLimitMb)) terrainCacheLimitMb = data.terrainCacheLimitMb;
        applyAllStyles();
        if (!terrainEnabled && (terrainState === 'loading' || terrainState === 'active')) stopTerrain();
        // Keep an open 3D view in sync with a live style/theme change.
        if (terrainState === 'active') postTerrain('update', { routeStyle: { ...routeStyle }, theme: effectiveTheme() });
        updateTerrainToggle();
        if (terrainEnabled && terrainConsentPending && terrainState === 'idle') {
            terrainConsentPending = false;
            startTerrain();
        }
    });

    // The map iframe loads and initialises Leaflet after this script runs, so
    // poll until it is ready.
    const startBinding = () => {
        if (retryTimer || bindMap()) return;
        let attempts = 0;
        retryTimer = setInterval(() => {
            attempts++;
            if (bindMap() || attempts >= 40) {
                clearInterval(retryTimer);
                retryTimer = null;
            }
        }, 250);
    };

    window.postMessage({ __bpbBigMap: true, dir: 'toCS', type: 'get' }, location.origin);
    // Re-bind when the map iframe (re)loads so a freshly built Leaflet map is
    // re-cased; the old map and its casings are discarded with the frame.
    const mapFrame = findMapIframe();
    if (mapFrame) {
        mapFrame.addEventListener('load', () => {
            if (retryTimer) {
                clearInterval(retryTimer);
                retryTimer = null;
            }
            activeMap = null;
            activeMapWin = null;
            startBinding();
        });
    }
    startBinding();
})();
