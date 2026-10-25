// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createTerrainWildfires } from './terrain-wildfires.js';
import { createOverlayTiles } from '../maps/map-overlay-tiles.js';
import { createSentinelSession } from '../maps/sentinel-session.js';
import { SENTINEL_ATTRIBUTION } from '../maps/sentinel-core.js';
import { OVERLAY_ATTRIBUTION, OVERLAY_MIN_ZOOM, rasterTileStatus } from '../maps/map-overlay-providers.js';
import { readLayerSnapshot, mergeLandCooldowns } from '../maps/map-layer-protocol.js';
import { createBCTileFetch } from '../maps/bc-land-client.js';
import { createCustomRenderer } from '../maps/custom-overlay-render.js';
import { createCustomParser } from '../maps/custom-overlay-parser.js';
import { readCustomRegistry } from '../maps/custom-overlay-schema.js';
import { createCustomClient, createCustomPool, customFailure } from '../maps/custom-overlay-client.js';
import { probeCustomSource } from '../maps/custom-overlay-probe.js';

// The authorized renderer searches its own catalog. No scene geometry, remote
// tile URLs or executable styles cross the page/frame boundary.
export function createTerrainOverlays({ map, maplibre, document: doc, post }) {
    let snapshot = null, scenes = [], sceneRevision = 0, landRevision = 0, sourceRevision = 0, disposed = false, registered = false;
    let sentinelStatus = {}, wildfireStatus = {}, wildfire = null;
    const rasterStatus = {};
    let custom = null, customParser = null, customGeneration = 0, customSignature = '';
    const customPool = createCustomPool(), customTasks = new Map(); let taskListener = false;
    const cancelCustomTasks = () => { for (const controller of customTasks.values()) controller.abort(); customTasks.clear(); };
    const updateCustom = next => {
        const signature = JSON.stringify([next.custom, next.customSession, next.customRevision, next.customReloads, next.customOpacity]);
        if (signature === customSignature) return;
        customSignature = signature; const generation = ++customGeneration;
        if (!next.custom?.length) { custom?.dispose(); custom = null; customParser?.dispose(); customParser = null; return; }
        const runtime = (globalThis.browser || globalThis.chrome)?.runtime;
        if (!runtime) return;
        void runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET', mapId: next.customSession }).then(reply => {
            if (disposed || generation !== customGeneration) return;
            const registry = reply?.ok && readCustomRegistry(reply.registry);
            if (!registry) return;
            if (!custom) {
                customParser = createCustomParser(runtime.getURL('custom-overlay/worker.js'));
                custom = createCustomRenderer({ win: doc.defaultView, map, maplibre, pool: customPool, parse: customParser.parse, onStatus(id, status) {
                    post('customLayerStatus', { id, status, revision: snapshot?.revision });
                } });
            }
            const selected = registry.sources.filter(source => next.custom.some(item => item.id === source.id && item.sourceRevision === source.revision && item.enabled));
            custom.update(selected, { ...reply.preferences, ...next.customOpacity }, next.customReloads);
        }).catch(() => {});
    };
    const loadingMessage = id => id === 'land' ? 'Loading public lands' : 'Loading slope shading';
    const reportRaster = (id, patch) => {
        rasterStatus[id] = { ...rasterStatus[id], ...patch };
        post('layerStatus', { id, revision: snapshot?.revision, ...rasterStatus[id] });
    };
    const layers = new Map(), protocol = 'bpb-overlay';
    const error = (id, failure) => {
        if (disposed || failure?.name === 'AbortError') return;
        if (snapshot && id !== 'land' && failure?.retryAt > Date.now()) snapshot.cooldowns[id] = Math.max(snapshot.cooldowns[id], failure.retryAt);
        if (id === 'sentinel') sentinel.tileError(failure);
        else if (id === 'land') return; // Aggregate outcomes retain other providers.
        else reportRaster(id, { pending: false, error: true, retry: true, retryAt: snapshot?.cooldowns[id] || failure?.retryAt,
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
        else {
            if (id === 'slope' && snapshot.cooldowns.slope > Date.now()) return;
            if (id === 'land') { snapshot.landCooldowns = activity.providerCooldowns || {}; snapshot.cooldowns.land = activity.retryAt || 0; }
            reportRaster(id, { ...rasterTileStatus(id, activity),
                retry: activity.error || activity.pending && rasterStatus[id]?.retry === true });
        }
    } });
    const tileProtocol = async (request, controller) => {
        const match = /^bpb-overlay:\/\/(sentinel|slope|land)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
        if (!match || disposed) throw new Error('Invalid overlay tile.');
        const [, id, revision, z, x, y] = match;
        if (id === 'sentinel' && Number(revision) !== sceneRevision || id === 'land' && Number(revision) !== landRevision) throw new DOMException('Cancelled.', 'AbortError');
        const canvas = tiles.canvas();
        await tiles.draw(id, { z: Number(z), x: Number(x), y: Number(y) }, canvas, controller.signal);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob || controller.signal.aborted || disposed || id === 'land' && Number(revision) !== landRevision) throw new DOMException('Cancelled.', 'AbortError');
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
            if (!state.enabled || state.opacity === 0 || id === 'land' && !snapshot.landTypes.length || id === 'sentinel' && !scenes.length) { remove(id); continue; }
            let source = layers.get(id);
            if (snapshot.cooldowns[id] > Date.now() && !source && !(id === 'land' && Object.keys(snapshot.landCooldowns).length)) continue;
            if (!source) {
                if (!registered) { maplibre.addProtocol(protocol, tileProtocol); registered = true; }
                source = `bpb-overlay-${id}-${++sourceRevision}`;
                map.addSource(source, { type: 'raster', tiles: [`${protocol}://${id}/${id === 'sentinel' ? sceneRevision : id === 'land' ? landRevision : 0}/{z}/{x}/{y}`],
                    tileSize: 256, minzoom: OVERLAY_MIN_ZOOM, maxzoom: id === 'sentinel' ? 14 : 15,
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
        replaceScenes(next) {
            scenes = next; sceneRevision++; tiles.setScenes(next);
            const source = layers.get('sentinel');
            // setTiles reloads the source while retaining renderable textures;
            // removing it would expose the basemap during every mosaic change.
            if (source) map.getSource(source)?.setTiles([`${protocol}://sentinel/${sceneRevision}/{z}/{x}/{y}`]);
            paint();
        },
        clearScenes() { remove('sentinel'); scenes = []; tiles.setScenes([]); },
        retryTiles() { if (tiles.retry('sentinel')) map.getSource(layers.get('sentinel'))?.setTiles([`${protocol}://sentinel/${sceneRevision}/{z}/{x}/{y}`]); },
        onStatus: status => { sentinelStatus = status; post('layerStatus', { id: 'sentinel', revision: snapshot?.revision, ...status }); },
        onCapture: target => { if (snapshot) snapshot.capture = target; post('layerCapture', { target }); },
    });
    const retainOverlays = () => {
        for (const id of ['slope', 'land', 'sentinel']) if (snapshot?.state[id].enabled && map.coveringTiles) tiles.retain(id,
            map.coveringTiles({ tileSize: 256, minzoom: OVERLAY_MIN_ZOOM, maxzoom: id === 'sentinel' ? 14 : 15 }).map(tile => tile.canonical));
    };
    return {
        async customTask(data) {
            if (data.action === 'cancel') { customTasks.get(data.requestId)?.abort(); return; }
            cancelCustomTasks();
            const controller = new AbortController(), runtime = (globalThis.browser || globalThis.chrome)?.runtime;
            if (!runtime || disposed) return;
            if (!taskListener) { map.on('movestart', cancelCustomTasks); taskListener = true; }
            customTasks.set(data.requestId, controller);
            const parser = createCustomParser(runtime.getURL('custom-overlay/worker.js'));
            const client = createCustomClient({ fetchImpl: doc.defaultView.fetch.bind(doc.defaultView), parse: parser.parse, pool: customPool });
            try {
                // Resolve only an editor-approved draft from this tab's worker registry.
                // Arbitrary page-supplied provider URLs never cross into this frame.
                const reply = await runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET', mapId: data.mapId });
                const registry = reply?.ok && readCustomRegistry(reply.registry);
                const source = registry?.sources.find(item => item.id === data.id && item.revision === data.sourceRevision);
                if (!source || controller.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
                const value = data.action === 'resolve' ? await client.resolve(source, controller.signal, false)
                    : await probeCustomSource(client, source, { center: map.getCenter(), zoom: map.getZoom() }, controller.signal, '3D');
                if (!controller.signal.aborted) post('customTaskReply', { requestId: data.requestId, mapId: data.mapId, reply: { ok: true, value } });
            } catch (failure) {
                post('customTaskReply', { requestId: data.requestId, mapId: data.mapId, reply: { ok: false, error: failure.name === 'AbortError' ? 'Test cancelled. The map or source changed.' : customFailure(failure) } });
            } finally { customTasks.delete(data.requestId); client.clear(); parser.dispose(); if (!customTasks.size && taskListener) { map.off('movestart', cancelCustomTasks); taskListener = false; } }
        },
        update(value) {
            const next = readLayerSnapshot(value); if (!next || snapshot && next.revision < snapshot.revision) return;
            const first = snapshot === null;
            if (snapshot) {
                for (const id of ['slope', 'sentinel']) next.cooldowns[id] = Math.max(snapshot.cooldowns[id], next.cooldowns[id]);
                next.landCooldowns = mergeLandCooldowns(snapshot.landCooldowns, next.landCooldowns);
            }
            snapshot = next;
            updateCustom(next);
            if (!wildfire && next.state.wildfire.enabled) wildfire = createTerrainWildfires({ map, maplibre, document: doc, onStatus: status => {
                wildfireStatus = status; post('layerStatus', { id: 'wildfire', revision: snapshot?.revision, ...status });
            } });
            wildfire?.update({ ...next.state.wildfire, retryAt: next.cooldowns.wildfire });
            if (next.state.wildfire.enabled && Object.keys(wildfireStatus).length) post('layerStatus', { id: 'wildfire', revision: next.revision, ...wildfireStatus });
            tiles.landCooldowns(next.landCooldowns);
            if (tiles.setLandTypes(next.landTypes)) { landRevision++; remove('land'); rasterStatus.land = {}; }
            for (const id of ['land', 'slope']) if (!next.state[id].enabled || next.state[id].opacity === 0) rasterStatus[id] = {};
            sentinel.cooldown(next.cooldowns.sentinel);
            if (next.state.sentinel.enabled && next.state.sentinel.opacity > 0) sentinel.activate(next.capture);
            else sentinel.deactivate();
            paint();
            retainOverlays();
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
            if (id === 'wildfire') { if (action === 'retry') wildfire?.retry(); return; }
            if (action === 'capture' && id === 'sentinel' && typeof capture === 'string') sentinel.select(capture);
            if (action === 'retry' && (id === 'sentinel' ? sentinelStatus.pending : rasterStatus[id]?.pending)) return;
            if (action === 'retry' && snapshot?.state[id]?.enabled && !(id === 'land' && !snapshot.landTypes.length) && snapshot.cooldowns[id] <= Date.now()) {
                if (id === 'sentinel') sentinel.retry(); else if (tiles.retry(id)) {
                    reportRaster(id, { pending: true, error: false, permission: false, retry: true, message: loadingMessage(id) });
                    const source = map.getSource(layers.get(id));
                    if (source?.setTiles) source.setTiles([`${protocol}://${id}/${id === 'land' ? landRevision : 0}/{z}/{x}/{y}`]);
                    else { remove(id); paint(); }
                }
            }
        },
        refresh() { custom?.refresh(); retainOverlays(); sentinel.refresh(); wildfire?.refresh(); },
        tileError(source, failure) {
            for (const [id, current] of layers) if (current === source && !(id === 'sentinel' ? sentinelStatus.error : rasterStatus[id]?.error)) error(id, failure);
        },
        menuOpen: () => snapshot?.menuOpen === true,
        suspend() { cancelCustomTasks(); customGeneration++; customSignature = ''; custom?.dispose(); custom = null; customParser?.dispose(); customParser = null; wildfire?.dispose(); wildfire = null; snapshot = null; sentinel.deactivate(); for (const id of [...layers.keys()]) remove(id); },
        basemapChanged() { paint(); wildfire?.paint(); },
        dispose() { disposed = true; cancelCustomTasks(); if (taskListener) { map.off('movestart', cancelCustomTasks); taskListener = false; } customGeneration++; custom?.dispose(); customParser?.dispose(); wildfire?.dispose(); wildfire = null; sentinel.dispose(); for (const id of [...layers.keys()]) remove(id); tiles.dispose(); if (registered) maplibre.removeProtocol(protocol); },
    };
}
