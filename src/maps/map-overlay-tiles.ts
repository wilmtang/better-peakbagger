// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sentinelTileUrl } from './sentinel-core.ts';
import { overlayTileUrl, tileBounds, publicLandTileSources, mapOverlayCoverage, type OverlayTile } from './map-overlay-providers.ts';
import { drawAlbertaLand } from './canadian-land.ts';
import { requestDeadline } from '../net/request-deadline.ts';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.ts';
import { retryTransient, temporaryHttpStatus } from '../net/retry-transient.ts';
import { settingsSchema as Schema } from '../settings/settings-schema.ts';

export interface OverlayScene {
    id: string;
    bounds: number[];
}

export interface OverlayTileError extends Error {
    code?: string;
    status?: number;
    transient?: boolean;
    retryAt?: number;
    tileFailures?: OverlayTileError[];
}

export interface OverlayActivityState {
    pending: boolean;
    error: boolean;
    partial?: boolean;
    complete: boolean;
    permission?: boolean;
    retryAt?: number;
    providerCooldowns?: Record<string, number>;
}

export type OverlayBCTileFetch = (
    coordinates: OverlayTile,
    options: { signal: AbortSignal; landTypes: string[] },
) => Promise<Response>;

export interface OverlayTilesOptions {
    document: Document;
    fetchImpl?: typeof fetch;
    fetchBCTile?: OverlayBCTileFetch;
    onError?: (id: string, error: OverlayTileError) => void;
    onActivity?: (id: string, state: OverlayActivityState) => void;
    retryDelayMs?: number;
}

export interface OverlayTiles {
    setScenes(next: readonly OverlayScene[]): void;
    setLandTypes(value: unknown): boolean;
    cancel(id?: string): void;
    cooldown(id: string, retryAt: number | undefined): void;
    retry(id: string): boolean;
    failed(id: string, coordinates: OverlayTile): boolean;
    landCooldowns(value: Record<string, number> | null | undefined): void;
    forget(id: string, coordinates: OverlayTile): void;
    retain(id: string, coordinates: readonly OverlayTile[]): void;
    draw(id: string, coordinates: OverlayTile, canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<HTMLCanvasElement>;
    canvas(): HTMLCanvasElement;
    dispose(): void;
}

interface TileOutcome {
    state: 'pending' | 'loaded' | 'failed';
    partial?: boolean;
    failures?: OverlayTileError[];
}

interface ActivityBatch {
    outcomes: Map<string, TileOutcome>;
    signature?: string;
}

interface ActiveFlight {
    id: string;
    controller: AbortController;
}

interface QueueEntry {
    start(): void;
}

interface TileSource {
    url: string;
    provider?: string;
    kind?: string;
    bbox?: number[];
}

const abortError = () => new DOMException('Cancelled.', 'AbortError');
const tileKey = ({ z, x, y }: OverlayTile) => `${z}/${(x % 2 ** z + 2 ** z) % 2 ** z}/${y}`;
// A renderer lifetime owns bounded tile work. The browser cache may reuse public
// tiles; decoded images and scene mosaics never survive this owner.
export function createOverlayTiles({ document: doc, fetchImpl = globalThis.fetch, fetchBCTile,
    onError = () => {}, onActivity = () => {}, retryDelayMs = 350 }: OverlayTilesOptions): OverlayTiles {
    let scenes: OverlayScene[] = [], generation = 0, disposed = false;
    let landTypes = Schema.mapLandTypes();
    const flights = new Set<ActiveFlight>(), blocked = new Map<string, OverlayTileError>();
    const retainLimit = (key: string, error: OverlayTileError): OverlayTileError => {
        // Reuse the recorded error so earlier tile outcomes see an extended
        // deadline too. Land providers remain independent within a mixed tile.
        const limit = blocked.get(key) || error;
        limit.retryAt = Math.max(limit.retryAt || 0, error.retryAt || Date.now() + 300000);
        blocked.set(key, limit); return limit;
    };
    const activity = new Map<string, ActivityBatch>();
    const landCooldowns = () => Object.fromEntries(
        [...blocked]
            .filter(([key, error]) => key.startsWith('land:') && (error.retryAt ?? 0) > Date.now())
            .map(([key, error]) => [key.slice(5), error.retryAt!]),
    );
    const publish = (id: string, batch: ActivityBatch) => {
        if (disposed || activity.get(id) !== batch) return;
        const outcomes = [...batch.outcomes.values()];
        const missing = outcomes.some(item => item.state === 'failed'), loaded = outcomes.some(item => item.state === 'loaded' || item.partial);
        const pending = outcomes.some(item => item.state === 'pending');
        const failures = outcomes.flatMap(item => item.failures || []);
        const deadlines = failures.filter(error => (error.retryAt ?? 0) > Date.now()).map(error => error.retryAt!);
        const state: OverlayActivityState = { pending, error: missing, partial: missing && loaded, complete: !pending && !missing,
            ...(id === 'land' ? { permission: failures.some(error => error.code === 'bc-permission-required'),
                retryAt: !loaded && failures.length > 0 && deadlines.length === failures.length ? Math.min(...deadlines) : 0,
                providerCooldowns: landCooldowns() } : {}) };
        const signature = JSON.stringify(state); if (signature === batch.signature) return;
        batch.signature = signature; onActivity(id, state);
    };
    const queue: QueueEntry[] = []; let running = 0;
    const acquire = (signal: AbortSignal) => new Promise<() => void>((resolve, reject) => {
        const entry: QueueEntry = { start: () => { signal.removeEventListener('abort', abort); running++; resolve(() => { running--; queue.shift()?.start(); }); } };
        const abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(abortError()); };
        if (signal.aborted) { reject(abortError()); return; }
        if (running < 4) entry.start();
        else if (queue.length < 128) { queue.push(entry); signal.addEventListener('abort', abort, { once: true }); }
        else reject(new Error('Too many overlay tiles. Zoom in.'));
    });
    const abortFlights = (id?: string) => { for (const flight of flights) if (!id || flight.id === id) flight.controller.abort(); };
    const cancel = (id?: string) => {
        for (const key of [...activity.keys()]) if (!id || key === id) {
            activity.delete(key); if (!disposed) onActivity(key, { pending: false, error: false, complete: false });
        }
        abortFlights(id);
    };
    const bitmap = async (url: string, signal: AbortSignal, bcCoordinates: OverlayTile | undefined, selected: string[], id: string): Promise<ImageBitmap> => {
        const deadline = requestDeadline.createRequestDeadline();
        const abort = () => deadline.abort(); signal.addEventListener('abort', abort, { once: true });
        let response: Response | undefined;
        try {
            if (signal.aborted) throw abortError();
            response = await deadline.run(bcCoordinates && fetchBCTile
                ? fetchBCTile(bcCoordinates, { signal: deadline.signal ?? signal, landTypes: selected })
                : fetchImpl(url, { signal: deadline.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', ...(id === 'snow' ? { cache: 'no-cache' } : {}) }));
            if (response.status === 429) throw rateLimitError('Map service', response);
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw Object.assign(new Error('Map tiles unavailable.'),
                { status: response.status, transient: temporaryHttpStatus(response.status) });
            if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('Map tile too large.');
            const reader = response.body!.getReader(), chunks: BlobPart[] = []; let bytes = 0;
            try {
                while (true) {
                    const part = await deadline.run(reader.read());
                    if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > 4 * 1024 * 1024) throw new Error('Map tile too large.');
                    chunks.push(part.value);
                }
            } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
            if (signal.aborted) throw abortError();
            const image = await deadline.run(createImageBitmap(new Blob(chunks)).then(decoded => {
                if (deadline.expired || signal.aborted) { decoded.close(); throw abortError(); }
                return decoded;
            }));
            if (signal.aborted) { image.close(); throw abortError(); }
            if (image.width > 1024 || image.height > 1024) { image.close(); throw new Error('Map tile too large.'); }
            return image;
        } finally { cancelResponseBody(response); signal.removeEventListener('abort', abort); deadline.clear(); }
    };
    return {
        setScenes(next) { generation++; scenes = next.slice(0, 8); cancel('sentinel'); },
        setLandTypes(value) {
            const next = Schema.mapLandTypes(value);
            if (JSON.stringify(next) === JSON.stringify(landTypes)) return false;
            landTypes = next; cancel('land'); return true;
        },
        cancel,
        cooldown(id, retryAt) {
            if (typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > Date.now()) {
                retainLimit(id, Object.assign(new Error('Map service is busy.'), { code: 'rate-limit', retryAt }));
                abortFlights(id);
            }
        },
        retry(id) {
            if ((blocked.get(id)?.retryAt ?? 0) > Date.now()) return false;
            const previous = [...(activity.get(id)?.outcomes.values() || [])];
            if (id === 'land' && previous.length && previous.every(item => item.state === 'failed' && !item.partial
                && item.failures?.length && item.failures.every(error => (error.retryAt ?? 0) > Date.now()))) return false;
            blocked.delete(id);
            const outcomes = new Map([...(activity.get(id)?.outcomes || [])].filter(([, item]) => item.state === 'loaded'));
            activity.set(id, { outcomes }); abortFlights(id);
            return true;
        },
        failed(id, coordinates) { return activity.get(id)?.outcomes.get(tileKey(coordinates))?.state === 'failed'; },
        landCooldowns(value) {
            if (!value) return;
            for (const provider of ['us', 'bc', 'ab']) {
                const until = value[provider];
                if (typeof until === 'number' && until > Date.now() && until <= Date.now() + 86400000) {
                    retainLimit(`land:${provider}`, Object.assign(new Error('Land service is busy.'), { code: 'rate-limit', retryAt: until }));
                }
            }
        },
        forget(id, coordinates) { const batch = activity.get(id); if (batch?.outcomes?.delete(tileKey(coordinates))) publish(id, batch); },
        retain(id, coordinates) {
            const batch = activity.get(id); if (!batch?.outcomes) return;
            const keep = new Set(coordinates.map(tileKey));
            for (const key of batch.outcomes.keys()) if (!keep.has(key)) batch.outcomes.delete(key);
            publish(id, batch);
        },
        async draw(id, coordinates, canvas, signal) {
            if (disposed || signal?.aborted) throw abortError();
            const limit = blocked.get(id);
            if (limit && (limit.retryAt ?? 0) > Date.now()) throw limit;
            const controller = new AbortController(), flight: ActiveFlight = { id, controller }, revision = generation, selected = landTypes;
            const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); flights.add(flight);
            const batch = activity.get(id) || { outcomes: new Map<string, TileOutcome>() };
            const key = tileKey(coordinates), outcome: TileOutcome = { state: 'pending' };
            batch.outcomes.set(key, outcome);
            activity.set(id, batch); publish(id, batch);
            const working = doc.createElement('canvas'); working.width = working.height = 256;
            const context = working.getContext('2d')!;
            let release: (() => void) | undefined;
            try {
                release = await acquire(controller.signal);
                const [left, bottom, right, top] = tileBounds(coordinates);
                const west = left / 20037508.342789244 * 180, east = right / 20037508.342789244 * 180;
                const latitude = (value: number) => Math.atan(Math.sinh(value / 6378137)) * 180 / Math.PI;
                const south = latitude(bottom), north = latitude(top);
                const intersecting = scenes.filter(scene => {
                    const [w, s, e, n] = scene.bounds, shift = Math.round(((west + east) - (w + e)) / 720) * 360;
                    return n >= south && s <= north && e + shift >= west && w + shift <= east;
                });
                // Scenes are opaque source images with transparent no-data. Draw
                // all of them at full alpha, then let the engine fade this ONE
                // mosaic. Two overlapping scenes at 50% still mean 50%.
                const coverage = mapOverlayCoverage([west, south, east, north]) as Record<string, boolean> | null;
                const supported = coverage?.[id] !== false;
                const sources: TileSource[] = !supported ? [] : id === 'land' ? publicLandTileSources(coordinates, selected)
                    : (id === 'sentinel' ? intersecting.map(scene => sentinelTileUrl(scene.id)
                        .replace('{z}', String(coordinates.z)).replace('{x}', String(coordinates.x)).replace('{y}', String(coordinates.y)))
                        : [overlayTileUrl(id, coordinates)])
                        .map(url => ({ url }));
                const failures: OverlayTileError[] = []; let completed = 0;
                for (const source of sources) {
                    try {
                        const providerLimit = blocked.get(`land:${source.provider}`);
                        if (id === 'land' && providerLimit && (providerLimit.retryAt ?? 0) > Date.now()) throw providerLimit;
                        if (source.kind === 'parcels') {
                            const parcelCanvas = await retryTransient(async () => {
                                const tile = doc.createElement('canvas'); tile.width = tile.height = 256;
                                await drawAlbertaLand({ context: tile.getContext('2d')!, bbox: source.bbox!, fetchImpl, signal: controller.signal, landTypes: selected });
                                return tile;
                            }, { signal: controller.signal, delayMs: retryDelayMs });
                            context.drawImage(parcelCanvas, 0, 0);
                        } else {
                            const image = await retryTransient(() => bitmap(source.url, controller.signal, source.provider === 'bc' ? coordinates : undefined, selected, id),
                                { signal: controller.signal, delayMs: retryDelayMs });
                            try {
                                if (disposed || controller.signal.aborted || id === 'sentinel' && revision !== generation) throw abortError();
                                context.drawImage(image, 0, 0, 256, 256);
                            } finally { image.close(); }
                        }
                        completed++;
                    } catch (sourceError) {
                        const err = sourceError as OverlayTileError;
                        if (id !== 'land' || controller.signal.aborted || err?.name === 'AbortError') throw sourceError;
                        failures.push(err?.code === 'rate-limit' ? retainLimit(`land:${source.provider}`, err) : err);
                    }
                }
                if (controller.signal.aborted) throw abortError();
                if (failures.length && !completed) throw Object.assign(failures[0], { tileFailures: failures });
                const output = canvas.getContext('2d')!; output.clearRect(0, 0, 256, 256); output.drawImage(working, 0, 0);
                outcome.state = failures.length ? 'failed' : 'loaded'; outcome.partial = failures.length > 0; outcome.failures = failures;
                if (failures.length) onError(id, failures[0]);
                return canvas;
            } catch (error) {
                let err = error as OverlayTileError;
                if (!controller.signal.aborted && err?.name !== 'AbortError' && (!batch.outcomes || batch.outcomes.get(key) === outcome)) {
                    outcome.state = 'failed';
                    outcome.failures = err?.tileFailures || [err];
                    if (id !== 'land' && err?.code === 'rate-limit') { err = retainLimit(id, err); abortFlights(id); }
                    onError(id, err);
                }
                throw err;
            } finally {
                if (outcome.state === 'pending' && batch.outcomes.get(key) === outcome) batch.outcomes.delete(key);
                release?.(); flights.delete(flight); signal?.removeEventListener('abort', abort); publish(id, batch);
            }
        },
        canvas() { const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 256; return canvas; },
        dispose() { disposed = true; cancel(); scenes = []; blocked.clear(); },
    };
}
