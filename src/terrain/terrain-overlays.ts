// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Map as MapLibreMap, RasterTileSource } from 'maplibre-gl';
import { createTerrainWildfires } from './terrain-wildfires.ts';
import { createOverlayTiles } from '../maps/map-overlay-tiles.js';
import { createSentinelSession } from '../maps/sentinel-session.js';
import { SNOW_DEPTH_MAX_ZOOM } from '../maps/snow-depth.js';
import { SENTINEL_ATTRIBUTION } from '../maps/sentinel-core.js';
import { OVERLAY_ATTRIBUTION, OVERLAY_MIN_ZOOM, rasterTileStatus } from '../maps/map-overlay-providers.ts';
import { readLayerSnapshot, mergeLandCooldowns } from '../maps/map-layer-protocol.ts';
import { createBCTileFetch } from '../maps/bc-land-client.js';
import { createCustomRenderer } from '../maps/custom-overlay-render.js';
import { createCustomParser } from '../maps/custom-overlay-parser.js';
import { readCustomRegistry } from '../maps/custom-overlay-schema.js';
import { createCustomClient, createCustomPool, customFailure } from '../maps/custom-overlay-client.js';
import { probeCustomSource } from '../maps/custom-overlay-probe.js';

// The authorized renderer searches its own catalog. No scene geometry, remote
// tile URLs or executable styles cross the page/frame boundary.
type Snapshot = NonNullable<ReturnType<typeof readLayerSnapshot>>;
type RasterId = 'land' | 'snow' | 'slope';
type Failure = { code?: string; retryAt?: number | null; name?: string; message?: string };
interface OverlayOptions {
    map: MapLibreMap; maplibre: typeof import('maplibre-gl'); document: Document;
    post(type: string, detail?: Record<string, unknown>): void;
}
export function createTerrainOverlays({ map, maplibre, document: doc, post }: OverlayOptions) {
    let snapshot: Snapshot | null = null, scenes: unknown[] = [], sceneRevision = 0, landRevision = 0, sourceRevision = 0, disposed = false, registered = false;
    let sentinelStatus: Record<string, unknown> = {}, wildfireStatus: Record<string, unknown> = {}, wildfire: ReturnType<typeof createTerrainWildfires> | null = null;
    const rasterStatus: Record<string, Record<string, unknown>> = {};
    let custom: ReturnType<typeof createCustomRenderer> | null = null, customParser: ReturnType<typeof createCustomParser> | null = null, customGeneration = 0, customSignature = '', customOpacitySignature = '', customApplied: { selected: never[]; preferences: Record<string, unknown> } | null = null;
    const customPool = createCustomPool(), customTasks = new Map(); let taskListener = false;
    const cancelCustomTasks = () => { for (const controller of customTasks.values()) controller.abort(); customTasks.clear(); };
    const updateCustom = (next: Snapshot) => {
        const signature = JSON.stringify([next.custom, next.customSession, next.customRevision, next.customReloads]);
        const opacity = JSON.stringify(next.customOpacity), opacityChanged = opacity !== customOpacitySignature;
        customOpacitySignature = opacity;
        if (signature === customSignature) {
            // A slider applies directly; only what selects or reloads a source needs the worker.
            if (opacityChanged && customApplied) custom?.update(customApplied.selected, { ...customApplied.preferences, ...next.customOpacity }, next.customReloads);
            else custom?.report();
            return;
        }
        customSignature = signature; customApplied = null; const generation = ++customGeneration;
        if (!next.custom?.length) { custom?.dispose(); custom = null; customParser?.dispose(); customParser = null; return; }
        const runtime = (globalThis.browser || globalThis.chrome)?.runtime;
        if (!runtime) return;
        void runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET', mapId: next.customSession }).then(reply => {
            if (disposed || generation !== customGeneration) return;
            const registry = reply?.ok && readCustomRegistry(reply.registry);
            if (!registry) return;
            if (!custom) {
                customParser = createCustomParser(runtime.getURL('custom-overlay/worker.js'));
                custom = createCustomRenderer({ win: doc.defaultView, map, maplibre, pool: customPool, parse: customParser.parse, onStatus(id: string, status: unknown) {
                    post('customLayerStatus', { id, status, revision: snapshot?.revision });
                } });
            }
            const selected = registry.sources.filter((source: { id: string; revision: number }) => next.custom.some(item => item.id === source.id && item.sourceRevision === source.revision && item.enabled)) as never[];
            customApplied = { selected, preferences: reply.preferences };
            // A slider may have moved while the worker answered.
            custom.update(selected, { ...reply.preferences, ...snapshot?.customOpacity }, next.customReloads);
        }).catch(() => {});
    };
    const loadingMessage = (id: string) => id === 'land' ? 'Loading public lands' : id === 'snow' ? 'Loading snow depth' : 'Loading slope shading';
    const reportRaster = (id: string, patch: Record<string, unknown>) => {
        rasterStatus[id] = { ...rasterStatus[id], ...patch };
        post('layerStatus', { id, revision: snapshot?.revision, ...rasterStatus[id] });
    };
    const layers = new Map(), protocol = 'bpb-overlay';
    const error = (id: string, failure: Failure) => {
        if (disposed || failure?.name === 'AbortError') return;
        if (snapshot && id !== 'land' && (failure?.retryAt ?? 0) > Date.now()) snapshot.cooldowns[id] = Math.max(snapshot.cooldowns[id], failure.retryAt!);
        if (id === 'sentinel') sentinel.tileError(failure);
        else if (id === 'land') return; // Aggregate outcomes retain other providers.
        else reportRaster(id, { pending: false, error: true, retry: true, retryAt: snapshot?.cooldowns[id] || failure?.retryAt,
            permission: failure?.code === 'bc-permission-required',
            message: failure?.code === 'bc-permission-required' ? 'Allow BC parcel maps.'
                : failure?.code === 'rate-limit' ? 'Map service is busy. Try again later.' : 'Some map tiles are unavailable. Retry.' });
    };
    // This packaged extension frame can call the worker. MAIN-world Leaflet
    // maps use the isolated bridge instead; privileged APIs stay out of them.
    const fetchBCTile = createBCTileFetch((message: unknown) => ((globalThis as unknown as { browser?: typeof chrome }).browser || globalThis.chrome).runtime.sendMessage(message));
    const tiles = createOverlayTiles({ document: doc, fetchBCTile, onError: error, onActivity(id: string, activity: { error?: boolean; pending?: boolean; providerCooldowns?: Record<string, number>; retryAt?: number }) {
        if (disposed || !snapshot?.state[id]?.enabled || snapshot.state[id].opacity === 0) return;
        if (id === 'sentinel') sentinel.tileActivity(activity);
        else {
            if (['slope', 'snow'].includes(id) && snapshot.cooldowns[id] > Date.now()) return;
            if (id === 'land') { snapshot.landCooldowns = activity.providerCooldowns || {}; snapshot.cooldowns.land = activity.retryAt || 0; }
            reportRaster(id, { ...rasterTileStatus(id, activity),
                retry: activity.error || activity.pending && rasterStatus[id]?.retry === true });
        }
    } } as never);
    const tileProtocol = async (request: { url: string }, controller: AbortController) => {
        const match = /^bpb-overlay:\/\/(sentinel|snow|slope|land)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
        if (!match || disposed) throw new Error('Invalid overlay tile.');
        const [, id, revision, z, x, y] = match;
        if (id === 'sentinel' && Number(revision) !== sceneRevision || id === 'land' && Number(revision) !== landRevision) throw new DOMException('Cancelled.', 'AbortError');
        const canvas = tiles.canvas();
        await tiles.draw(id, { z: Number(z), x: Number(x), y: Number(y) }, canvas, controller.signal);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob || controller.signal.aborted || disposed || id === 'land' && Number(revision) !== landRevision) throw new DOMException('Cancelled.', 'AbortError');
        return { data: await (blob as Blob).arrayBuffer() };
    };
    const remove = (id: string) => {
        const source = layers.get(id);
        if (source && map.getLayer(source)) map.removeLayer(source);
        if (source && map.getSource(source)) map.removeSource(source);
        layers.delete(id); tiles.cancel(id);
    };
    const beforeVectors = () => map.getLayersOrder().find(id => map.getLayer(id)?.type === 'symbol'
        || ['bpb-route', 'bpb-peaks', 'bpb-highlight'].some(prefix => id.startsWith(prefix)));
    let reorder = false;
    const paint = () => {
        if (!snapshot || disposed) return;
        for (const id of ['sentinel', 'land', 'snow', 'slope']) {
            const state = snapshot.state[id];
            if (!state.enabled || state.opacity === 0 || id === 'land' && !snapshot.landTypes.length || id === 'sentinel' && !scenes.length) { remove(id); continue; }
            let source = layers.get(id);
            if (snapshot.cooldowns[id] > Date.now() && !source && !(id === 'land' && Object.keys(snapshot.landCooldowns).length)) continue;
            if (!source) {
                if (!registered) { maplibre.addProtocol(protocol, tileProtocol); registered = true; }
                source = `bpb-overlay-${id}-${++sourceRevision}`;
                map.addSource(source, { type: 'raster', tiles: [`${protocol}://${id}/${id === 'sentinel' ? sceneRevision : id === 'land' ? landRevision : 0}/{z}/{x}/{y}`],
                    tileSize: 256, minzoom: OVERLAY_MIN_ZOOM, maxzoom: id === 'sentinel' ? 14 : id === 'snow' ? SNOW_DEPTH_MAX_ZOOM : 15,
                    attribution: id === 'sentinel' ? SENTINEL_ATTRIBUTION : OVERLAY_ATTRIBUTION[id as RasterId] });
                const before = beforeVectors(); reorder = true;
                map.addLayer({ id: source, source, type: 'raster', paint: { 'raster-opacity': state.opacity / 100, 'raster-fade-duration': 0, ...(id === 'snow' ? { 'raster-resampling': 'nearest' } : {}) } }, before);
                layers.set(id, source);
                if (id !== 'sentinel') reportRaster(id, { pending: true, error: false, permission: false, retryAt: 0, retry: rasterStatus[id]?.retry === true, message: loadingMessage(id) });
            }
            map.setPaintProperty(source, 'raster-opacity', state.opacity / 100);
        }
        // Adding a previously disabled lower overlay, or a basemap's symbols,
        // must retain fixed order. Nothing else can change it.
        if (!reorder) return;
        reorder = false;
        const before = beforeVectors();
        if (before) for (const id of ['sentinel', 'land', 'snow', 'slope']) {
            const source = layers.get(id);
            if (source) map.moveLayer(source, before);
        }
    };
    const sentinel = (createSentinelSession as (options: unknown) => ReturnType<typeof createSentinelSession>)({ readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() + 1 }),
        replaceScenes(next: unknown[]) {
            scenes = next; sceneRevision++; tiles.setScenes(next);
            const source = layers.get('sentinel');
            // setTiles reloads the source while retaining renderable textures;
            // removing it would expose the basemap during every mosaic change.
            if (source) map.getSource<RasterTileSource>(source)?.setTiles([`${protocol}://sentinel/${sceneRevision}/{z}/{x}/{y}`]);
            paint();
        },
        clearScenes() { remove('sentinel'); scenes = []; tiles.setScenes([]); },
        retryTiles() { if (tiles.retry('sentinel')) map.getSource<RasterTileSource>(layers.get('sentinel')!)?.setTiles([`${protocol}://sentinel/${sceneRevision}/{z}/{x}/{y}`]); },
        onStatus: (status: Record<string, unknown>) => { sentinelStatus = status; post('layerStatus', { id: 'sentinel', revision: snapshot?.revision, ...status }); },
        onCapture: ((target: Snapshot['capture']) => { if (snapshot) snapshot.capture = target; post('layerCapture', { target }); }) as never,
    });
    const retainOverlays = () => {
        for (const id of ['slope', 'land', 'snow', 'sentinel']) if (snapshot?.state[id].enabled && map.coveringTiles) tiles.retain(id,
            map.coveringTiles({ tileSize: 256, minzoom: OVERLAY_MIN_ZOOM, maxzoom: id === 'sentinel' ? 14 : id === 'snow' ? SNOW_DEPTH_MAX_ZOOM : 15 }).map(tile => tile.canonical));
    };
    return {
        async customTask(data: { requestId: string; mapId: string; action: string; id: string; sourceRevision: number }) {
            if (data.action === 'cancel') { customTasks.get(data.requestId)?.abort(); return; }
            cancelCustomTasks();
            const controller = new AbortController(), runtime = (globalThis.browser || globalThis.chrome)?.runtime;
            if (!runtime || disposed) return;
            if (!taskListener) { map.on('movestart', cancelCustomTasks); taskListener = true; }
            customTasks.set(data.requestId, controller);
            const parser = createCustomParser(runtime.getURL('custom-overlay/worker.js'));
            const client = createCustomClient({ fetchImpl: doc.defaultView!.fetch.bind(doc.defaultView), parse: parser.parse, pool: customPool });
            try {
                // Resolve only an editor-approved draft from this tab's worker registry.
                // Arbitrary page-supplied provider URLs never cross into this frame.
                const reply = await runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET', mapId: data.mapId });
                const registry = reply?.ok && readCustomRegistry(reply.registry);
                const source = registry?.sources.find((item: { id: string; revision: number }) => item.id === data.id && item.revision === data.sourceRevision);
                if (!source || controller.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
                const value = data.action === 'resolve' ? await client.resolve(source, controller.signal, false)
                    : await probeCustomSource(client, source, { center: map.getCenter(), zoom: map.getZoom() }, controller.signal, '3D');
                if (!controller.signal.aborted) post('customTaskReply', { requestId: data.requestId, mapId: data.mapId, reply: { ok: true, value } });
            } catch (failure) {
                post('customTaskReply', { requestId: data.requestId, mapId: data.mapId, reply: { ok: false, error: (failure as Failure).name === 'AbortError' ? 'Test cancelled. The map or source changed.' : customFailure(failure) } });
            } finally { customTasks.delete(data.requestId); client.clear(); parser.dispose(); if (!customTasks.size && taskListener) { map.off('movestart', cancelCustomTasks); taskListener = false; } }
        },
        update(value: unknown) {
            const next = readLayerSnapshot(value); if (!next || snapshot && next.revision < snapshot.revision) return;
            const first = snapshot === null;
            if (snapshot) {
                for (const id of ['slope', 'snow', 'sentinel']) next.cooldowns[id] = Math.max(snapshot.cooldowns[id], next.cooldowns[id]);
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
            tiles.cooldown('snow', next.cooldowns.snow);
            if (tiles.setLandTypes(next.landTypes)) { landRevision++; remove('land'); rasterStatus.land = {}; }
            for (const id of ['land', 'snow', 'slope']) if (!next.state[id].enabled || next.state[id].opacity === 0) rasterStatus[id] = {};
            sentinel.cooldown(next.cooldowns.sentinel);
            if (next.state.sentinel.enabled && next.state.sentinel.opacity > 0) sentinel.activate(next.capture);
            else sentinel.deactivate();
            paint();
            retainOverlays();
            // A response can settle while a newer opacity/menu snapshot is in
            // transit. Reattach the current provider model to the accepted
            // revision so the outer menu cannot remain stuck in pending.
            post('layerStatus', { id: 'sentinel', revision: next.revision, ...sentinelStatus });
            for (const id of ['land', 'snow', 'slope']) if (next.state[id].enabled) {
                if (next.cooldowns[id] > Date.now()) reportRaster(id, { pending: false, error: true, permission: false, retry: true,
                    retryAt: next.cooldowns[id], message: 'Map service is busy. Try again later.' });
                else if (Object.keys(rasterStatus[id] || {}).length) reportRaster(id, {});
            }
            return first;
        },
        action({ id, action, capture }: { id: string; action?: string; capture?: unknown }) {
            if (id === 'wildfire') { if (action === 'retry') wildfire?.retry(); return; }
            if (action === 'capture' && id === 'sentinel' && typeof capture === 'string') sentinel.select(capture);
            if (action === 'retry' && (id === 'sentinel' ? sentinelStatus.pending : rasterStatus[id]?.pending)) return;
            if (action === 'retry' && snapshot?.state[id]?.enabled && !(id === 'land' && !snapshot.landTypes.length) && snapshot.cooldowns[id] <= Date.now()) {
                if (id === 'sentinel') sentinel.retry(); else if (tiles.retry(id)) {
                    reportRaster(id, { pending: true, error: false, permission: false, retry: true, message: loadingMessage(id) });
                    const source = map.getSource<RasterTileSource>(layers.get(id)!);
                    if (source?.setTiles) source.setTiles([`${protocol}://${id}/${id === 'land' ? landRevision : 0}/{z}/{x}/{y}`]);
                    else { remove(id); paint(); }
                }
            }
        },
        refresh() { custom?.refresh(); retainOverlays(); sentinel.refresh(); wildfire?.refresh(); paint(); }, // paint revives an overlay whose cooldown has passed.
        tileError(source: string, failure: Failure | undefined) {
            for (const [id, current] of layers) if (current === source && !(id === 'sentinel' ? sentinelStatus.error : rasterStatus[id]?.error)) error(id, failure as Failure);
        },
        menuOpen: () => snapshot?.menuOpen === true,
        suspend() { cancelCustomTasks(); customGeneration++; customSignature = ''; customOpacitySignature = ''; customApplied = null; custom?.dispose(); custom = null; customParser?.dispose(); customParser = null; wildfire?.dispose(); wildfire = null; snapshot = null; sentinel.deactivate(); for (const id of [...layers.keys()]) remove(id); },
        basemapChanged() { reorder = true; paint(); wildfire?.paint(); },
        dispose() { disposed = true; cancelCustomTasks(); if (taskListener) { map.off('movestart', cancelCustomTasks); taskListener = false; } customGeneration++; custom?.dispose(); customParser?.dispose(); wildfire?.dispose(); wildfire = null; sentinel.dispose(); for (const id of [...layers.keys()]) remove(id); tiles.dispose(); if (registered) maplibre.removeProtocol(protocol); },
    };
}
