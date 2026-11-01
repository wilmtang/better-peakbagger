// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as maplibre from 'maplibre-gl';
import { terrainStyle } from '../terrain/terrain-style.js';
import { isPeakbaggerPageOrigin } from '../peakbagger/peakbagger-origin.js';
import { VECTOR_MESSAGE, readVectorView, vectorBasemap } from './vector-basemap.js';
import { vectorMapAvailability } from './vector-map-availability.js';
import { VECTOR_PROTOCOL, createVectorMapRequest, vectorRequestUrl } from './vector-map-request.js';
import { readRetryAt } from '../net/rate-limit.js';

let map = null, parentOrigin = null, attempted = false, disposed = false, timer = null, view = null, settledView = null;
const post = (type, detail = {}) => {
    if (parentOrigin) parent.postMessage({ [VECTOR_MESSAGE]: true, dir: 'fromFrame', type, ...detail }, parentOrigin);
};
const dispose = () => { disposed = true; clearTimeout(timer); map?.remove(); map = null; };
const fail = error => { if (!disposed) { post('error', { retryAt: readRetryAt(error?.retryAt) }); dispose(); } };
const update = () => {
    if (!map || !view) return;
    map.resize(); map.jumpTo({ center: [view.center[1], view.center[0]], zoom: view.zoom, bearing: 0, pitch: 0 });
};
const settled = () => {
    if (disposed || !map?.areTilesLoaded()) return;
    try {
        const availability = vectorMapAvailability(map);
        if (availability.requested && !availability.usable) {
            console.warn('Better Peakbagger vector map: No usable viewport tiles.'); fail(); return;
        }
        clearTimeout(timer);
        const key = JSON.stringify([view, map.getCanvas().clientWidth, map.getCanvas().clientHeight]);
        if (key !== settledView) { settledView = key; post('loaded', { view }); }
    } catch (error) { console.warn('Better Peakbagger vector map:', error.message); fail(); }
};
window.addEventListener('message', async event => {
    const data = event.data;
    if (disposed || event.source !== parent || !isPeakbaggerPageOrigin(event.origin)
        || !data || data[VECTOR_MESSAGE] !== true || data.dir !== 'toFrame'
        || parentOrigin && event.origin !== parentOrigin) return;
    if (data.type === 'view' && attempted) { view = readVectorView(data.view) || view; update(); return; }
    const basemap = vectorBasemap(data.basemap);
    if (data.type !== 'init' || attempted || !readVectorView(data.view) || !basemap) return;
    attempted = true; parentOrigin = event.origin; view = readVectorView(data.view);
    timer = setTimeout(() => { console.warn('Better Peakbagger vector map: Initialization timed out.'); fail(); }, 15000);
    try {
        const ext = globalThis.browser || globalThis.chrome;
        const reply = await ext.runtime.sendMessage({ type: 'VECTOR_MAP_ACTIVATION_CONSUME', token: data.activation, action: 'init' });
        if (disposed) return;
        if (reply?.ok !== true) { fail(); return; }
        const style = await terrainStyle.createVectorStyleLoader({ styleUrl: basemap.styleUrl, basemap }).load();
        if (disposed) return;
        maplibre.setWorkerUrl(ext.runtime.getURL('vendor/maplibre-gl-worker.mjs'));
        maplibre.addProtocol(VECTOR_PROTOCOL, createVectorMapRequest({ basemap, onRateLimit: fail }));
        map = new maplibre.Map({ container: document.getElementById('map'), style,
            center: [view.center[1], view.center[0]], zoom: view.zoom, minZoom: -1, maxZoom: 23,
            // Leaflet owns the camera, including world views and polar edges.
            // Fitting this overscanned frame to Mercator bounds shifts geometry.
            transformConstrain: (center, zoom) => ({ center, zoom }),
            interactive: false, attributionControl: false, fadeDuration: 0, zoomLevelsToOverscale: undefined,
            transformRequest(url) {
                return { url: vectorRequestUrl(url, basemap), credentials: 'omit', referrerPolicy: 'no-referrer' };
            },
        });
        map.on('error', error => { console.warn('Better Peakbagger vector map:', error.error?.message || 'Map resource unavailable.'); });
        map.once('load', settled);
        // A tile error can satisfy MapLibre's one-time load event before all
        // other tiles settle. Idle must also finish that initial transaction.
        map.on('idle', settled);
        map.getCanvas().addEventListener('webglcontextlost', fail);
        update();
    } catch (error) { if (!disposed) { console.warn('Better Peakbagger vector map:', error.message); fail(error); } }
});
window.addEventListener('pagehide', dispose);
// No preconnect, provider fetch or renderer exists until a one-use worker
// capability issued after a trusted basemap choice has been consumed.
parent.postMessage({ [VECTOR_MESSAGE]: true, dir: 'fromFrame', type: 'ready' }, '*');
