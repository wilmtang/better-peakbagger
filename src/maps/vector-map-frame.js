// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as maplibre from 'maplibre-gl';
import { terrainStyle } from '../terrain/terrain-style.js';
import { isPeakbaggerPageOrigin } from '../peakbagger/peakbagger-origin.js';
import { VECTOR_BASEMAP, VECTOR_MESSAGE, readVectorView } from './vector-basemap.js';

let map = null, parentOrigin = null, attempted = false, disposed = false, timer = null, view = null;
const post = type => {
    if (parentOrigin) parent.postMessage({ [VECTOR_MESSAGE]: true, dir: 'fromFrame', type }, parentOrigin);
};
const dispose = () => { disposed = true; clearTimeout(timer); map?.remove(); map = null; };
const fail = () => { if (!disposed) { post('error'); dispose(); } };
const update = () => {
    if (!map || !view) return;
    map.resize(); map.jumpTo({ center: [view.center[1], view.center[0]], zoom: view.zoom, bearing: 0, pitch: 0 });
};
window.addEventListener('message', async event => {
    const data = event.data;
    if (disposed || event.source !== parent || !isPeakbaggerPageOrigin(event.origin)
        || !data || data[VECTOR_MESSAGE] !== true || data.dir !== 'toFrame'
        || parentOrigin && event.origin !== parentOrigin) return;
    if (data.type === 'view' && attempted) { view = readVectorView(data.view) || view; update(); return; }
    if (data.type !== 'init' || attempted || !readVectorView(data.view)) return;
    attempted = true; parentOrigin = event.origin; view = readVectorView(data.view);
    timer = setTimeout(fail, 15000);
    try {
        const ext = globalThis.browser || globalThis.chrome;
        const reply = await ext.runtime.sendMessage({ type: 'VECTOR_MAP_ACTIVATION_CONSUME', token: data.activation, action: 'init' });
        if (disposed) return;
        if (reply?.ok !== true) { fail(); return; }
        const style = await terrainStyle.createVectorStyleLoader({ styleUrl: VECTOR_BASEMAP.styleUrl }).load();
        if (disposed) return;
        maplibre.setWorkerUrl(ext.runtime.getURL('vendor/maplibre-gl-worker.mjs'));
        let errors = false, vectorTile = false;
        map = new maplibre.Map({ container: document.getElementById('map'), style,
            center: [view.center[1], view.center[0]], zoom: view.zoom, minZoom: -1, maxZoom: 23,
            // Leaflet owns the camera, including world views and polar edges.
            // Fitting this overscanned frame to Mercator bounds shifts geometry.
            transformConstrain: (center, zoom) => ({ center, zoom }),
            interactive: false, attributionControl: false, fadeDuration: 0, zoomLevelsToOverscale: undefined,
            transformRequest(url) {
                if (!terrainStyle.providerUrl(url)) throw new Error('Unapproved vector map provider.');
                return { url, credentials: 'omit', referrerPolicy: 'no-referrer' };
            },
        });
        map.on('error', error => { errors = true; console.warn('Better Peakbagger vector map:', error.error?.message || 'Map resource unavailable.'); });
        map.on('sourcedata', dataEvent => {
            if (dataEvent.source?.type === 'vector' && dataEvent.tile?.state === 'loaded') vectorTile = true;
        });
        map.once('load', () => {
            if (disposed) return;
            if (errors && !vectorTile) { fail(); return; }
            clearTimeout(timer); post('loaded');
        });
        map.getCanvas().addEventListener('webglcontextlost', fail);
        update();
    } catch (error) { if (!disposed) { console.warn('Better Peakbagger vector map:', error.message); fail(); } }
});
window.addEventListener('pagehide', dispose);
// No preconnect, provider fetch or renderer exists until a one-use worker
// capability issued after a trusted basemap choice has been consumed.
parent.postMessage({ [VECTOR_MESSAGE]: true, dir: 'fromFrame', type: 'ready' }, '*');
