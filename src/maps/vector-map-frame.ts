// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as maplibre from 'maplibre-gl';
import type { Map as MapLibreMap, RequestParameters, StyleSpecification } from 'maplibre-gl';
import { terrainStyle } from '../terrain/terrain-style.ts';
import type { VectorStyle } from '../terrain/terrain-style.ts';
import { isPeakbaggerPageOrigin } from '../peakbagger/peakbagger-origin.js';
import { VECTOR_MESSAGE, readVectorView, readVectorPaint, vectorBasemap } from './vector-basemap.ts';
import type { VectorView } from './vector-basemap.ts';
import { vectorMapAvailability, vectorMapReadyToPublish } from './vector-map-availability.ts';
import { VECTOR_PROTOCOL, createVectorMapRequest, vectorRequestUrl } from './vector-map-request.ts';
import { readRetryAt } from '../net/rate-limit.js';

let map: MapLibreMap | null = null, parentOrigin: string | null = null, attempted = false, disposed = false, timer: ReturnType<typeof setTimeout> | null = null, view: VectorView | null = null, settledView: string | null = null, lastSize = '', lastCamera = '';
let active = false, style: VectorStyle | null = null, revision = 0, generation: number | null = null;
let capturing = false, captureAgain = false;
let drawRequested = false;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const requests = new Set<AbortController>();
const post = (type: string, detail: Record<string, unknown> = {}, transfer: Transferable[] = []) => {
    if (parentOrigin) parent.postMessage({ [VECTOR_MESSAGE]: true, dir: 'fromFrame', type, generation, ...detail }, parentOrigin, transfer);
};
const requestDraw = () => {
    if (!active || disposed || !map || drawRequested) return;
    drawRequested = true; post('renderNeeded');
};
// MapLibre also defers style loading with rAF. This dedicated rendering
// document uses the visible parent's clock for all of its animation work,
// rather than leaving style restoration on a throttled hidden-frame clock.
window.requestAnimationFrame = callback => {
    const id = ++nextFrame; frames.set(id, callback); requestDraw(); return id;
};
window.cancelAnimationFrame = id => frames.delete(id);
const publishPaint = () => {
    if (capturing) { captureAgain = true; return; }
    const canvas = map!.getCanvas(), width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    if (!readVectorPaint({ view, width, height })) { fail(); return; }
    if (timer === null) timer = setTimeout(fail, 15000);
    const camera = structuredClone(view), owner = generation, renderer = map;
    capturing = true;
    let snapshot;
    // Capture inside render, while the WebGL drawing buffer is still valid.
    try { snapshot = createImageBitmap(canvas); } catch (error) { capturing = false; fail(error); return; }
    void snapshot.then(bitmap => {
        if (disposed || !active || generation !== owner || map !== renderer) {
            bitmap.close(); captureAgain = true; return;
        }
        if (JSON.stringify(view) !== JSON.stringify(camera) || canvas.clientWidth !== width || canvas.clientHeight !== height) captureAgain = true;
        try {
            const key = JSON.stringify([camera, width, height]);
            if (key !== settledView) { settledView = key; post('loaded', { view: camera }); }
            post('painted', { bitmap, view: camera, width, height }, [bitmap]); clearTimeout(timer!); timer = null;
        }
        catch (error) { bitmap.close(); fail(error); }
    }, error => { if (!disposed && active && generation === owner) fail(error); }).finally(() => {
        capturing = false;
        const again = captureAgain; captureAgain = false;
        if (again) requestDraw();
    });
};
const release = () => {
    active = false; drawRequested = false; revision++; clearTimeout(timer!); timer = null;
    for (const controller of requests) controller.abort(); requests.clear();
    map?.stop?.(); map?.setStyle({ version: 8, sources: {}, layers: [] }, { diff: false });
};
const dispose = () => { disposed = true; active = false; revision++; clearTimeout(timer!); for (const controller of requests) controller.abort(); requests.clear(); map?.remove(); map = null; frames.clear(); };
const fail = (error?: unknown) => { if (!disposed) { post('error', { retryAt: readRetryAt((error as { retryAt?: number } | undefined)?.retryAt) }); dispose(); } };
const update = () => {
    if (!active || !map || !view) return;
    const container = document.getElementById('map'), size = `${container!.clientWidth}/${container!.clientHeight}`, camera = JSON.stringify(view);
    if (size !== lastSize) { lastSize = size; map.resize(); }
    if (camera !== lastCamera) { lastCamera = camera; map.jumpTo({ center: [view.center[1], view.center[0]], zoom: view.zoom, bearing: 0, pitch: 0 }); }
    requestDraw();
};
const settled = (progressive = false) => {
    if (disposed || !active || !map || !progressive && !map.areTilesLoaded()) return;
    try {
        const availability = vectorMapAvailability(map);
        if (progressive && !vectorMapReadyToPublish(map, view!.center)) return;
        if (availability.requested && !availability.usable) {
            console.warn('Better Peakbagger vector map: No usable viewport tiles.'); fail(); return;
        }
        if (progressive) publishPaint();
    } catch (error) { console.warn('Better Peakbagger vector map:', (error as Error).message); fail(); }
};
window.addEventListener('message', async event => {
    const data = event.data;
    if (disposed || event.source !== parent || !isPeakbaggerPageOrigin(event.origin)
        || !data || data[VECTOR_MESSAGE] !== true || data.dir !== 'toFrame'
        || parentOrigin && event.origin !== parentOrigin) return;
    if (data.type === 'release' && attempted) { release(); return; }
    if (data.type === 'render' && active && data.generation === generation) {
        drawRequested = false;
        const callbacks = [...frames];
        const timestamp = performance.now();
        try {
            for (const [id, callback] of callbacks) if (frames.delete(id)) callback(timestamp);
            // A render that completed during capture still needs a fresh
            // snapshot, even when MapLibre has no animation callback left.
            if (!callbacks.length) map!.redraw();
            if (frames.size) requestDraw();
        } catch (error) { fail(error); }
        return;
    }
    if (data.type === 'view' && attempted) { view = readVectorView(data.view) || view; update(); return; }
    const validGeneration = Number.isSafeInteger(data.generation) && data.generation > 0;
    if (data.type === 'resume' && map && !active && validGeneration && readVectorView(data.view)) {
        const owner = ++revision;
        generation = data.generation; view = readVectorView(data.view);
        try {
            const ext = (globalThis as unknown as { browser?: typeof chrome }).browser || globalThis.chrome;
            const reply = await ext.runtime.sendMessage({ type: 'VECTOR_MAP_ACTIVATION_CONSUME', token: data.activation, action: 'init' });
            if (disposed || owner !== revision) return;
            if (reply?.ok !== true) { fail(); return; }
            active = true; settledView = null; lastSize = ''; lastCamera = '';
            timer = setTimeout(fail, 15000); map!.setStyle(style as unknown as StyleSpecification, { diff: false }); update();
        } catch (error) { if (owner === revision) fail(error); }
        return;
    }
    const basemap = vectorBasemap(data.basemap);
    if (data.type !== 'init' || attempted || !validGeneration || !readVectorView(data.view) || !basemap) return;
    attempted = true; parentOrigin = event.origin; generation = data.generation; view = readVectorView(data.view);
    timer = setTimeout(() => { console.warn('Better Peakbagger vector map: Initialization timed out.'); fail(); }, 15000);
    try {
        const ext = (globalThis as unknown as { browser?: typeof chrome }).browser || globalThis.chrome;
        const reply = await ext.runtime.sendMessage({ type: 'VECTOR_MAP_ACTIVATION_CONSUME', token: data.activation, action: 'init' });
        if (disposed) return;
        if (reply?.ok !== true) { fail(); return; }
        const raw = await terrainStyle.createVectorStyleLoader({ styleUrl: basemap.styleUrl, basemap }).load();
        style = terrainStyle.renderingStyle(raw, { basemap });
        if (disposed) return;
        active = true;
        maplibre.setWorkerUrl(ext.runtime.getURL('vendor/maplibre-gl-worker.mjs'));
        const request = createVectorMapRequest({ basemap, onRateLimit: fail });
        maplibre.addProtocol(VECTOR_PROTOCOL, (parameters, controller) => {
            if (!active) return Promise.reject(Object.assign(new Error('Vector map inactive.'), { name: 'AbortError' }));
            requests.add(controller);
            return request(parameters, controller).finally(() => requests.delete(controller));
        });
        map = new maplibre.Map({ container: document.getElementById('map')!, style: style as unknown as StyleSpecification,
            center: [view!.center[1], view!.center[0]], zoom: view!.zoom, minZoom: -1, maxZoom: 23,
            // Leaflet owns the camera, including world views and polar edges.
            // Fitting this overscanned frame to Mercator bounds shifts geometry.
            transformConstrain: (center, zoom) => ({ center, zoom }),
            interactive: false, attributionControl: false, fadeDuration: 0, zoomLevelsToOverscale: undefined,
            transformRequest(url) {
                return { url: vectorRequestUrl(url, basemap), credentials: 'omit', referrerPolicy: 'no-referrer' } as unknown as RequestParameters;
            },
        });
        map.on('error', error => { console.warn('Better Peakbagger vector map:', error.error?.message || 'Map resource unavailable.'); });
        map.once('load', () => settled());
        // A tile error can satisfy MapLibre's one-time load event before all
        // other tiles settle. Idle must also finish that initial transaction.
        map.on('idle', () => settled());
        // A slow secondary tile must not withhold already painted cartography.
        // Only render can publish progressive output; idle still judges a
        // settled outage and restores the native map after later failures.
        map.on('render', () => settled(true));
        map.getCanvas().addEventListener('webglcontextlost', fail);
        update();
    } catch (error) { if (!disposed) { console.warn('Better Peakbagger vector map:', (error as Error).message); fail(error); } }
});
window.addEventListener('pagehide', dispose);
// No preconnect, provider fetch or renderer exists until a one-use worker
// capability issued after a trusted basemap choice has been consumed.
parent.postMessage({ [VECTOR_MESSAGE]: true, dir: 'fromFrame', type: 'ready' }, '*');
