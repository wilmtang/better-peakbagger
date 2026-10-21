// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createOverlayTiles } from '../maps/map-overlay-tiles.js';
import { createSentinelSession } from '../maps/sentinel-session.js';
import { SENTINEL_ATTRIBUTION } from '../maps/sentinel-core.js';
import { OVERLAY_ATTRIBUTION } from '../maps/map-overlay-providers.js';
import { readLayerSnapshot } from '../maps/map-layer-protocol.js';
import { createBCTileFetch } from '../maps/bc-land-client.js';

// The authorized renderer searches its own catalog. No scene geometry, remote
// tile URLs or executable styles cross the page/frame boundary.
export function createTerrainOverlays({ map, maplibre, document: doc, post }) {
    let snapshot = null, scenes = [], sceneRevision = 0, sourceRevision = 0, disposed = false, registered = false;
    let sentinelStatus = {};
    const rasterStatus = {};
    const loadingMessage = id => id === 'land' ? 'Loading public lands' : 'Loading slope shading';
    const reportRaster = (id, patch) => {
        rasterStatus[id] = { ...rasterStatus[id], ...patch };
        post('layerStatus', { id, revision: snapshot?.revision, ...rasterStatus[id] });
    };
    const layers = new Map(), protocol = 'bpb-overlay';
    const error = (id, failure) => {
        if (disposed || failure?.name === 'AbortError') return;
        if (snapshot && failure?.retryAt > Date.now()) snapshot.cooldowns[id] = failure.retryAt;
        if (id === 'sentinel') sentinel.tileError(failure);
        else reportRaster(id, { pending: false, error: true, retry: true, retryAt: failure?.retryAt,
            permission: failure?.code === 'bc-permission-required',
            message: failure?.code === 'bc-permission-required' ? 'Allow BC parcel maps.'
                : failure?.code === 'rate-limit' ? 'Map service is busy. Try again later.' : 'Some map tiles are unavailable. Retry.' });
    };
    // This packaged extension frame can call the worker. MAIN-world Leaflet
    // maps use the isolated bridge instead; privileged APIs stay out of them.
    const fetchBCTile = createBCTileFetch(message => (globalThis.browser || globalThis.chrome).runtime.sendMessage(message));
    const tiles = createOverlayTiles({ document: doc, fetchBCTile, onError: error, onActivity(id, activity) {
        if (disposed || !snapshot?.state[id]?.enabled || snapshot.state[id].opacity === 0) return;
        if (id === 'sentinel') sentinel.tileActivity(activity);
        else if (!activity.error && (activity.pending || activity.complete)) reportRaster(id, { pending: activity.pending,
            ...(activity.pending || activity.complete ? { error: false, permission: false, retryAt: 0,
                retry: activity.pending && rasterStatus[id]?.retry === true, message: activity.pending ? loadingMessage(id) : '' } : {}) });
    } });
    const tileProtocol = async (request, controller) => {
        const match = /^bpb-overlay:\/\/(sentinel|slope|land)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
        if (!match || disposed) throw new Error('Invalid overlay tile.');
        const [, id, revision, z, x, y] = match;
        if (id === 'sentinel' && Number(revision) !== sceneRevision) throw new DOMException('Cancelled.', 'AbortError');
        const canvas = tiles.canvas();
        await tiles.draw(id, { z: Number(z), x: Number(x), y: Number(y) }, canvas, controller.signal);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob || controller.signal.aborted || disposed) throw new DOMException('Cancelled.', 'AbortError');
        return { data: await blob.arrayBuffer() };
    };
    const remove = id => {
        const source = layers.get(id);
        if (source && map.getLayer(source)) map.removeLayer(source);
        if (source && map.getSource(source)) map.removeSource(source);
        layers.delete(id); tiles.cancel(id);
    };
    const beforeVectors = () => map.getStyle().layers.find(layer => layer.type === 'symbol'
        || ['bpb-route', 'bpb-peaks', 'bpb-highlight'].some(prefix => layer.id.startsWith(prefix)))?.id;
    const paint = () => {
        if (!snapshot || disposed) return;
        for (const id of ['sentinel', 'land', 'slope']) {
            const state = snapshot.state[id];
            if (!state.enabled || state.opacity === 0 || id === 'sentinel' && !scenes.length) { remove(id); continue; }
            let source = layers.get(id);
            if (snapshot.cooldowns[id] > Date.now() && !source) continue;
            if (!source) {
                if (!registered) { maplibre.addProtocol(protocol, tileProtocol); registered = true; }
                source = `bpb-overlay-${id}-${++sourceRevision}`;
                map.addSource(source, { type: 'raster', tiles: [`${protocol}://${id}/${id === 'sentinel' ? sceneRevision : 0}/{z}/{x}/{y}`],
                    tileSize: 256, minzoom: 8, maxzoom: id === 'sentinel' ? 14 : 15,
                    attribution: id === 'sentinel' ? SENTINEL_ATTRIBUTION : OVERLAY_ATTRIBUTION[id] });
                const before = beforeVectors();
                map.addLayer({ id: source, source, type: 'raster', paint: { 'raster-opacity': state.opacity / 100, 'raster-fade-duration': 0 } }, before);
                layers.set(id, source);
                if (id !== 'sentinel') reportRaster(id, { pending: true, error: false, permission: false, retryAt: 0, retry: rasterStatus[id]?.retry === true, message: loadingMessage(id) });
            }
            map.setPaintProperty(source, 'raster-opacity', state.opacity / 100);
        }
        // Adding a previously disabled lower overlay must retain fixed order.
        for (const id of ['sentinel', 'land', 'slope']) {
            const source = layers.get(id), before = beforeVectors();
            if (source && before) map.moveLayer(source, before);
        }
    };
    const sentinel = createSentinelSession({ readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() + 1 }),
        replaceScenes(next) { remove('sentinel'); scenes = next; sceneRevision++; tiles.setScenes(next); paint(); },
        clearScenes() { remove('sentinel'); scenes = []; tiles.setScenes([]); },
        onStatus: status => { sentinelStatus = status; post('layerStatus', { id: 'sentinel', revision: snapshot?.revision, ...status }); },
        onCapture: target => { if (snapshot) snapshot.capture = target; post('layerCapture', { target }); },
    });
    return {
        update(value) {
            const next = readLayerSnapshot(value); if (!next || snapshot && next.revision < snapshot.revision) return;
            const first = snapshot === null;
            snapshot = next;
            for (const id of ['land', 'slope']) if (!next.state[id].enabled || next.state[id].opacity === 0) rasterStatus[id] = {};
            sentinel.cooldown(next.cooldowns.sentinel);
            if (next.state.sentinel.enabled && next.state.sentinel.opacity > 0) sentinel.activate(next.capture);
            else sentinel.deactivate();
            paint();
            // A response can settle while a newer opacity/menu snapshot is in
            // transit. Reattach the current provider model to the accepted
            // revision so the outer menu cannot remain stuck in pending.
            post('layerStatus', { id: 'sentinel', revision: next.revision, ...sentinelStatus });
            for (const id of ['land', 'slope']) if (next.state[id].enabled) {
                if (next.cooldowns[id] > Date.now()) reportRaster(id, { pending: false, error: true, permission: false, retry: true,
                    retryAt: next.cooldowns[id], message: 'Map service is busy. Try again later.' });
                else if (Object.keys(rasterStatus[id] || {}).length) reportRaster(id, {});
            }
            return first;
        },
        action({ id, action, capture }) {
            if (action === 'capture' && id === 'sentinel' && typeof capture === 'string') sentinel.select(capture);
            if (action === 'retry' && (id === 'sentinel' ? sentinelStatus.pending : rasterStatus[id]?.pending)) return;
            if (action === 'retry' && snapshot?.state[id]?.enabled && snapshot.cooldowns[id] <= Date.now() && tiles.retry(id)) {
                if (id === 'sentinel') sentinel.retry(); else { reportRaster(id, { pending: true, error: false, permission: false, retry: true, message: loadingMessage(id) }); remove(id); paint(); }
            }
        },
        refresh() { sentinel.refresh(); },
        tileError(source, failure) { for (const [id, current] of layers) if (current === source) error(id, failure); },
        menuOpen: () => snapshot?.menuOpen === true,
        suspend() { snapshot = null; sentinel.deactivate(); for (const id of [...layers.keys()]) remove(id); },
        basemapChanged: paint,
        dispose() { disposed = true; sentinel.dispose(); for (const id of [...layers.keys()]) remove(id); tiles.dispose(); if (registered) maplibre.removeProtocol(protocol); },
    };
}
