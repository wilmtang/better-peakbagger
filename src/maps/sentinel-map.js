// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SENTINEL_CODE, SENTINEL_NAME, SENTINEL_ATTRIBUTION, sentinelTileUrl } from './sentinel-core.js';
import { createSentinelLayer } from './sentinel-layer.js';
import { pageLifecycle } from '../ui/page-lifecycle.js';

// MasterMap owns Leaflet and the native picker. Intercept only our option;
// native choices still run Peakbagger's own handler. Its basemap remains under
// our opaque imagery as a fallback, and routes/markers are never removed.
export const installSentinelMap = (ownerWindow = window) => {
    const doc = ownerWindow.document;
    let binding = null;
    let polling = null;
    const unbind = () => {
        if (!binding) return;
        binding.select.removeEventListener('change', binding.change, true);
        binding.map.off('moveend', binding.refresh);
        binding.observer?.disconnect();
        binding.layer.dispose();
        binding.control.remove();
        binding.option.remove();
        binding = null;
    };
    const bind = () => {
        const map = ownerWindow.mapsPlaceholder;
        const L = ownerWindow.L;
        const select = doc.getElementById('selmap');
        if (!map || !L?.tileLayer || !L?.control || !L?.DomEvent || !map.getBounds || !map.getZoom || !map.on || !map.off || !select?.options) return false;
        if (binding?.map === map && binding.select === select) return true;
        unbind();
        const option = doc.createElement('option');
        option.value = SENTINEL_CODE;
        option.textContent = SENTINEL_NAME;
        select.append(option);
        let tiles = [];
        let position = () => {};
        const clearScenes = () => {
            for (const tile of tiles) map.removeLayer(tile);
            tiles = [];
            position();
        };
        const layer = createSentinelLayer({ document: doc, readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() }),
            fetchImpl: ownerWindow.fetch.bind(ownerWindow), clearScenes,
            onCaptureChange: capture => {
                if (capture) option.dataset.bpbSentinelCapture = JSON.stringify(capture);
                else delete option.dataset.bpbSentinelCapture;
            },
            replaceScenes: scenes => {
                clearScenes();
                for (const scene of scenes) {
                    const tile = L.tileLayer(sentinelTileUrl(scene.id), { tileSize: 256, maxNativeZoom: 14,
                        maxZoom: 24, zIndex: 250, attribution: SENTINEL_ATTRIBUTION, crossOrigin: 'anonymous',
                        // Leaflet wraps tile bounds into [-180, 180]. A scene
                        // crossing that seam cannot use one unwrapped rectangle.
                        ...(scene.bounds[0] >= -180 && scene.bounds[2] <= 180
                            ? { bounds: [[scene.bounds[1], scene.bounds[0]], [scene.bounds[3], scene.bounds[2]]] } : {}) });
                    tile.on('tileerror', () => { if (tiles.includes(tile)) layer.tileError(); });
                    tiles.push(tile);
                    tile.addTo(map);
                }
                position();
            } });
        const control = L.control({ position: 'bottomleft' });
        control.onAdd = () => {
            L.DomEvent.disableClickPropagation(layer.element);
            L.DomEvent.disableScrollPropagation(layer.element);
            return layer.element;
        };
        control.addTo(map);
        const container = map.getContainer?.();
        position = () => {
            const attribution = container?.querySelector('.leaflet-control-attribution');
            layer.element.style.marginBottom = `${10 + Math.ceil(attribution?.getBoundingClientRect().height || 0)}px`;
        };
        const observer = typeof ownerWindow.ResizeObserver === 'function' ? new ownerWindow.ResizeObserver(position) : null;
        if (container) {
            observer?.observe(container);
            const attribution = container.querySelector('.leaflet-control-attribution');
            if (attribution) observer?.observe(attribution);
        }
        const change = event => {
            if (select.value === SENTINEL_CODE) {
                event.stopImmediatePropagation();
                layer.activate();
            } else layer.deactivate();
        };
        const refresh = () => layer.refresh();
        select.addEventListener('change', change, true);
        map.on('moveend', refresh);
        binding = { map, select, option, control, layer, change, refresh, observer };
        return true;
    };
    const stop = () => { if (polling !== null) clearInterval(polling); polling = null; };
    const start = () => {
        stop();
        if (bind()) return;
        const started = Date.now();
        polling = setInterval(() => { if (bind() || Date.now() - started >= 30000) stop(); }, 250);
    };
    const lifecycle = pageLifecycle.create({ ownerWindow,
        onSuspend: () => { stop(); binding?.layer.deactivate(); },
        onResume: () => { start(); if (binding?.select.value === SENTINEL_CODE) binding.layer.activate(); },
        onDispose: () => { stop(); unbind(); } });
    start();
    return { dispose: () => lifecycle.dispose() };
};

if (typeof window !== 'undefined') installSentinelMap();
