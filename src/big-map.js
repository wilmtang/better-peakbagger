// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — preserve Peakbagger's native Full Screen Map tracks and
// interactions while applying the user's preferred base route width.
// Runs in MAIN world because the Leaflet map and layers are page-owned globals.

(() => {
    'use strict';

    const params = new URLSearchParams(location.search);
    const mapType = (params.get('t') || '').toUpperCase();
    if (!['A', 'G'].includes(mapType)) return;

    const DEFAULT_WIDTH = 5;
    const enhancedLayers = new WeakSet();
    let routeWidth = DEFAULT_WIDTH;
    let activeMap = null;
    let retryTimer = null;

    const validWidth = value => Number.isInteger(value) && value >= 1 && value <= 12 ? value : DEFAULT_WIDTH;

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

    const applyWidth = layer => {
        const L = globalThis.L;
        if (!activeMap || !L || !isNativeTrack(layer, L)) return;
        try { layer.setStyle({ weight: routeWidth }); } catch (error) { return; }
        if (enhancedLayers.has(layer) || typeof layer.on !== 'function') return;
        enhancedLayers.add(layer);

        // Peakbagger temporarily changes route styling during hover. Restore
        // only our base width after every native mouseout handler has run.
        layer.on('mouseout', () => queueMicrotask(() => {
            if (layer._map === activeMap) {
                try { layer.setStyle({ weight: routeWidth }); } catch (error) { /* The native layer may have been removed. */ }
            }
        }));
    };

    const applyAllWidths = () => {
        if (!activeMap || typeof activeMap.eachLayer !== 'function') return;
        try { activeMap.eachLayer(applyWidth); } catch (error) { /* A live Leaflet layer collection can change during iteration. */ }
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
            candidate.on('layeradd', event => queueMicrotask(() => applyWidth(event && event.layer)));
        }
        applyAllWidths();
        return true;
    };

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbBigMap !== true || data.dir !== 'toPage') return;
        routeWidth = validWidth(data.routeWidth);
        applyAllWidths();
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
