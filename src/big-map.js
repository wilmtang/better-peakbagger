// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — preserve Peakbagger's native Full Screen Map tracks and
// interactions while applying the user's preferred base route width, a matching
// white casing, and (on single-ascent maps) the preferred route color.
// Runs in MAIN world because the Leaflet map and layers are page-owned globals.

(() => {
    'use strict';

    const params = new URLSearchParams(location.search);
    const mapType = (params.get('t') || '').toUpperCase();
    if (!['A', 'G'].includes(mapType)) return;

    // Single-ascent maps ('A') show one track, so it is safe to recolor it to
    // the preferred route color. Group maps ('G') use color to tell climbers
    // apart, so only the width and the casing are applied there.
    const recolorTrack = mapType === 'A';

    const DEFAULT_STYLE = { color: '#d9483b', width: 5, casingColor: '#ffffff', casingWidth: 9 };
    const enhancedLayers = new WeakSet();
    // Our own casing underlays, keyed by the native track they sit behind, so
    // they are never mistaken for native tracks and are removed with them.
    const casings = new WeakMap();
    const casingLayers = new WeakSet();
    let routeStyle = { ...DEFAULT_STYLE };
    let activeMap = null;
    let retryTimer = null;

    const validColor = (value, fallback) =>
        typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    const validWidth = value => Number.isInteger(value) && value >= 1 && value <= 12 ? value : DEFAULT_STYLE.width;
    const validCasingWidth = (value, width) => Math.max(
        Number.isInteger(value) && value >= 3 && value <= 20 ? value : DEFAULT_STYLE.casingWidth,
        width + 2
    );

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
        const L = globalThis.L;
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
        const L = globalThis.L;
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

    const findMap = () => {
        const L = globalThis.L;
        if (!L) return null;
        for (const candidate of [globalThis.mapsPlaceholder, globalThis.map]) {
            if (!candidate || typeof candidate.eachLayer !== 'function' || typeof candidate.on !== 'function') continue;
            if (typeof L.Map !== 'function' || candidate instanceof L.Map) return candidate;
        }
        return null;
    };

    const bindMap = () => {
        const candidate = findMap();
        if (!candidate) return false;
        if (candidate !== activeMap) {
            activeMap = candidate;
            candidate.on('layeradd', event => queueMicrotask(() => applyStyle(event && event.layer)));
            if (typeof candidate.on === 'function') {
                candidate.on('layerremove', event => removeCasing(event && event.layer));
            }
        }
        applyAllStyles();
        return true;
    };

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbBigMap !== true || data.dir !== 'toPage') return;
        const width = validWidth(data.routeWidth);
        routeStyle = {
            color: validColor(data.routeColor, DEFAULT_STYLE.color),
            width,
            casingColor: validColor(data.casingColor, DEFAULT_STYLE.casingColor),
            casingWidth: validCasingWidth(data.casingWidth, width)
        };
        applyAllStyles();
    });

    window.postMessage({ __bpbBigMap: true, dir: 'toCS', type: 'get' }, location.origin);
    if (!bindMap()) {
        let attempts = 0;
        retryTimer = setInterval(() => {
            attempts++;
            if (bindMap() || attempts >= 20) {
                clearInterval(retryTimer);
                retryTimer = null;
            }
        }, 250);
    }
})();
