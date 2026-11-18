// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUSTOM_LIMITS, customUrl, type CustomSource } from './custom-overlay-schema.ts';
import { requestDeadline } from '../net/request-deadline.ts';
import { rateLimitError } from '../net/rate-limit.ts';
import { validateCustomRaster } from './custom-overlay-raster.ts';
import { resolveCustomSourceDocument, type ResolveCustomSourceOptions } from './custom-overlay-source.ts';
import type { CustomGeoJsonCollection, CustomMvtResult, CustomParseRequest } from './custom-overlay-data.ts';
import type { CustomParseResult } from './custom-overlay-parser.ts';

export interface CustomPool {
    cooldowns: Map<string, number>;
    run<T>(work: () => Promise<T> | T, signal?: AbortSignal | null): Promise<T>;
}

export interface CustomRequestResult {
    bytes: ArrayBuffer;
    type: string;
    scope?: string;
    refresh?: unknown;
}

export interface CustomTileCoordinates {
    z: number;
    x: number;
    y: number;
}

export interface CustomRasterTileResult {
    image: ImageBitmap;
    lower: boolean;
    scale: number;
    x: number;
    y: number;
    features?: never;
    data?: never;
}

export interface CustomMvtTileResult extends CustomMvtResult {
    lower: boolean;
    image?: never;
}

export type CustomTileResult = CustomRasterTileResult | CustomMvtTileResult;

export interface CustomClientResolveResult {
    source: CustomSource;
    origins: string[];
    layers?: string[];
}

export type CustomParseFn = (data: CustomParseRequest, signal?: AbortSignal | null) => Promise<CustomParseResult>;

export interface CustomClientOptions {
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    pool?: CustomPool;
    parse?: CustomParseFn;
    bitmap?: (source: Blob) => Promise<ImageBitmap>;
}

export interface CustomClient {
    request(url: string, limit: number, signal?: AbortSignal | null, retry?: boolean, scope?: string, refresh?: unknown): Promise<CustomRequestResult>;
    resolve(input: CustomSource, signal?: AbortSignal | null, retry?: boolean, options?: ResolveCustomSourceOptions): Promise<CustomClientResolveResult>;
    tile(source: CustomSource, coordinates: CustomTileCoordinates, signal?: AbortSignal | null, fallback?: boolean, refresh?: unknown): Promise<CustomTileResult>;
    evict(scope?: string | null): void;
    clear(): void;
    geojson(source: CustomSource, signal?: AbortSignal | null, refresh?: unknown): Promise<CustomGeoJsonCollection>;
}

interface FlightEntry {
    controller: AbortController;
    users: number;
    scope: string;
    refresh: unknown;
    promise?: Promise<CustomRequestResult>;
}

interface CustomFailureLike {
    code?: unknown;
    status?: unknown;
    message?: unknown;
}

export const customFailure = (error: unknown): string => {
    const detail = (error && typeof error === 'object' ? error : null) as CustomFailureLike | null;
    if (detail?.code === 'approval') return 'Approve private map access in BPB, then choose Retry.';
    if (detail?.code === 'budget') return 'Private map request allowance reached. Wait before approving more.';
    if (detail?.code === 'permission') return 'Allow this provider in BPB Settings.';
    if (detail?.code === 'busy') return 'Other private map requests are running. Choose Retry when they finish.';
    if (detail?.code === 'access') return 'Check the URL and the provider’s CORS settings. The source must allow browser access from this map.';
    if (detail?.code === 'origins') return 'Review the tile provider hosts in Edit source before loading.';
    if (detail?.status === 401 || detail?.status === 403) return 'This source requires access. Use a public endpoint.';
    if (detail?.status === 404 || detail?.status === 410) return 'Some tiles are unavailable at this location or zoom.';
    if (detail?.code === 'rate-limit') return 'The provider is busy. Retry after its cooldown.';
    return typeof detail?.message === 'string' && detail.message ? detail.message : 'Couldn’t load this source.';
};

export function createCustomPool(): CustomPool {
    let running = 0;
    const queue: Array<{ start: () => void }> = [];
    const cooldowns = new Map<string, number>();
    const pump = () => {
        while (running < 4 && queue.length) {
            const task = queue.shift()!;
            task.start();
        }
    };
    return {
        cooldowns,
        run<T>(work: () => Promise<T> | T, signal?: AbortSignal | null): Promise<T> {
            return new Promise<T>((resolve, reject) => {
                let task: { start: () => void };
                const abort = () => {
                    const index = queue.indexOf(task);
                    if (index >= 0) {
                        queue.splice(index, 1);
                        reject(new DOMException('Cancelled.', 'AbortError'));
                    }
                };
                task = {
                    start() {
                        signal?.removeEventListener('abort', abort);
                        if (signal?.aborted) {
                            reject(new DOMException('Cancelled.', 'AbortError'));
                            return;
                        }
                        running++;
                        Promise.resolve().then(work).then(resolve, reject).finally(() => {
                            running--;
                            pump();
                        });
                    },
                };
                if (signal?.aborted) {
                    reject(new DOMException('Cancelled.', 'AbortError'));
                    return;
                }
                if (queue.length >= 64) {
                    reject(new Error('Too many overlay requests. Zoom in.'));
                    return;
                }
                queue.push(task);
                signal?.addEventListener('abort', abort, { once: true });
                pump();
            });
        },
    };
}

export function customPoolForWindow(win: Window): CustomPool {
    let owner: Window = win;
    try {
        if (win.top && win.top.location.origin === win.location.origin) owner = win.top;
    } catch { /* Separate origin retains its own bounded scheduler. */ }
    const key = Symbol.for('bpb.customOverlayPool');
    const host = owner as unknown as Record<symbol, CustomPool | undefined>;
    return host[key] || (host[key] = createCustomPool());
}

export function createCustomClient({
    fetchImpl = globalThis.fetch,
    pool = createCustomPool(),
    parse,
    bitmap = globalThis.createImageBitmap,
}: CustomClientOptions = {}): CustomClient {
    const cache = new Map<string, CustomRequestResult>();
    const flights = new Map<string, FlightEntry>();
    let cacheBytes = 0;

    const requestOnce = (
        url: string,
        limit: number,
        signal?: AbortSignal | null,
        retry = true,
        refresh: unknown = null,
    ): Promise<CustomRequestResult> => pool.run(async () => {
        if (!customUrl(url)) throw new Error('Invalid source URL.');
        const origin = new URL(url).origin;
        const cooldown = pool.cooldowns.get(origin);
        if (cooldown !== undefined && cooldown > Date.now()) {
            throw Object.assign(new Error('Provider cooldown.'), { code: 'rate-limit', retryAt: cooldown });
        }
        for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
            const deadline = requestDeadline.createRequestDeadline(CUSTOM_LIMITS.deadline);
            const abort = () => deadline.abort();
            signal?.addEventListener('abort', abort, { once: true });
            let response: Response | undefined;
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            try {
                if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
                try {
                    response = await deadline.run(fetchImpl(url, {
                        mode: 'cors',
                        credentials: 'omit',
                        redirect: 'error',
                        referrerPolicy: 'no-referrer',
                        ...(refresh ? { cache: 'no-cache' as const } : {}),
                        signal: deadline.signal,
                    }));
                } catch (error) {
                    const failure = error as { name?: unknown; code?: unknown } | null | undefined;
                    if (signal?.aborted || failure?.name === 'AbortError'
                        || (typeof failure?.code === 'string' && ['approval', 'budget', 'permission', 'busy', 'private-source', 'origins'].includes(failure.code))) {
                        throw error;
                    }
                    throw Object.assign(new Error('Couldn’t access this source.'), { code: 'access' });
                }
                if (response.status === 429) {
                    const error = rateLimitError('Custom map provider', response);
                    error.retryAt ??= Date.now() + 300000;
                    pool.cooldowns.set(origin, Math.max(pool.cooldowns.get(origin) || 0, error.retryAt));
                    throw error;
                }
                if (!response.ok) {
                    if (attempt === 0 && retry && [408, 500, 502, 503, 504].includes(response.status)) {
                        await response.body?.cancel();
                        continue;
                    }
                    throw Object.assign(new Error(`Source returned HTTP ${response.status}.`), { status: response.status });
                }
                if (Number(response.headers.get('content-length')) > limit) throw new Error('Source too large.');
                reader = response.body?.getReader();
                if (!reader) throw new Error('Empty source response.');
                const chunks: Uint8Array[] = [];
                let size = 0;
                while (true) {
                    const part = await deadline.run(reader.read());
                    if (part.done) break;
                    size += part.value.byteLength;
                    if (size > limit) throw new Error('Source too large.');
                    chunks.push(part.value);
                }
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                return { bytes: bytes.buffer, type: response.headers.get('content-type') || '' };
            } finally {
                if (reader) {
                    void reader.cancel().catch(() => {});
                    reader.releaseLock();
                } else {
                    void response?.body?.cancel().catch(() => {});
                }
                signal?.removeEventListener('abort', abort);
                deadline.clear();
            }
        }
        throw new Error('Couldn’t access this source.');
    }, signal);

    const request = async (
        url: string,
        limit: number,
        signal?: AbortSignal | null,
        retry = true,
        scope = '',
        refresh: unknown = null,
    ): Promise<CustomRequestResult> => {
        const key = `${scope}|${url}`;
        if (!retry) return requestOnce(url, limit, signal, false);
        if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
        const staleCache = cache.get(key);
        if (refresh && staleCache && staleCache.refresh !== refresh) {
            cacheBytes -= staleCache.bytes.byteLength;
            cache.delete(key);
        }
        const staleFlight = flights.get(key);
        if (refresh && staleFlight && staleFlight.refresh !== refresh) {
            staleFlight.controller.abort();
            flights.delete(key);
        }
        const cached = cache.get(key);
        if (cached) {
            cache.delete(key);
            cache.set(key, cached);
            if (cached.bytes.byteLength > limit) throw new Error('Source too large.');
            return { ...cached, bytes: cached.bytes.slice(0) };
        }
        let flight = flights.get(key);
        if (!flight) {
            flight = { controller: new AbortController(), users: 0, scope, refresh };
            const owner = flight;
            flight.promise = requestOnce(url, limit, owner.controller.signal, true, refresh).then(result => {
                if (owner.controller.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
                result.scope = scope;
                result.refresh = refresh;
                while (cacheBytes + result.bytes.byteLength > 8 * 1024 * 1024 && cache.size) {
                    const oldest = cache.keys().next().value!;
                    cacheBytes -= cache.get(oldest)!.bytes.byteLength;
                    cache.delete(oldest);
                }
                cache.set(key, result);
                cacheBytes += result.bytes.byteLength;
                return result;
            }).finally(() => {
                if (flights.get(key) === owner) flights.delete(key);
            });
            flights.set(key, flight);
        }
        flight.users++;
        let rejectAbort!: (reason?: unknown) => void;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const abort = () => rejectAbort(new DOMException('Cancelled.', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        try {
            const result = await Promise.race([flight.promise!, aborted]);
            if (result.bytes.byteLength > limit) throw new Error('Source too large.');
            return { ...result, bytes: result.bytes.slice(0) };
        } finally {
            signal?.removeEventListener('abort', abort);
            if (--flight.users === 0) flight.controller.abort();
        }
    };

    const resolve = async (
        input: CustomSource,
        signal?: AbortSignal | null,
        retry = true,
        options: ResolveCustomSourceOptions = {},
    ): Promise<CustomClientResolveResult> => {
        const url = input.kind === 'geojson'
            ? (options.inspect ? input.source.dataUrl : null)
            : input.source.metadataUrl;
        if (!url) return { source: input, origins: [] };
        const { bytes } = await request(
            url,
            input.kind === 'geojson' ? CUSTOM_LIMITS.geojson : CUSTOM_LIMITS.metadata,
            signal,
            retry,
            `${input.id}:${input.revision}`,
            options.refresh,
        );
        return resolveCustomSourceDocument(input, JSON.parse(new TextDecoder().decode(bytes)), options);
    };

    const tile = async (
        source: CustomSource,
        coordinates: CustomTileCoordinates,
        signal?: AbortSignal | null,
        fallback = true,
        refresh: unknown = null,
    ): Promise<CustomTileResult> => {
        if (source.kind === 'geojson') throw new Error('Invalid source kind.');
        const original = coordinates;
        const overzoom = Math.max(0, original.z - source.source.maxNativeZoom);
        for (let delta = overzoom; delta <= overzoom + (fallback ? 2 : 0) && original.z - delta >= source.source.minNativeZoom; delta++) {
            const scale = 2 ** delta, n = 2 ** (original.z - delta);
            const canonical = { z: original.z - delta, x: Math.floor(original.x / scale), y: Math.floor(original.y / scale) };
            const x = (canonical.x % n + n) % n, y = source.source.scheme === 'tms' ? n - 1 - canonical.y : canonical.y;
            const template = source.source.tiles[0];
            if (!template) throw Object.assign(new Error('Review source metadata.'), { code: 'origins' });
            const url = template.replaceAll('{z}', String(canonical.z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
            try {
                const result = await request(url, CUSTOM_LIMITS[source.kind], signal, fallback, `${source.id}:${source.revision}`, refresh);
                if (source.kind === 'raster') {
                    validateCustomRaster(result.bytes, result.type, source.source.tileSize);
                    const image = await bitmap(new Blob([result.bytes], { type: result.type }));
                    const size = source.source.tileSize;
                    if (image.width !== image.height || ![size, size * 2].includes(image.width)) {
                        image.close();
                        throw new Error('Unexpected tile dimensions.');
                    }
                    if (signal?.aborted) {
                        image.close();
                        throw new DOMException('Cancelled.', 'AbortError');
                    }
                    return { image, lower: delta > 0, scale, x: original.x - canonical.x * scale, y: original.y - canonical.y * scale };
                }
                if (!parse) throw new Error('Vector decoder unavailable.');
                const value = await parse({
                    kind: 'mvt',
                    bytes: result.bytes,
                    layers: [...new Set(source.appearance.rules.map(rule => rule.sourceLayer).filter((layer): layer is string => typeof layer === 'string'))],
                    transform: { scale, x: original.x - canonical.x * scale, y: original.y - canonical.y * scale },
                }, signal) as CustomMvtResult;
                signal?.throwIfAborted();
                return { ...value, lower: delta > 0 };
            } catch (error) {
                const status = (error as { status?: unknown } | null | undefined)?.status;
                if (typeof status !== 'number' || ![404, 410].includes(status)
                    || delta === overzoom + (fallback ? 2 : 0) || canonical.z === source.source.minNativeZoom) throw error;
            }
        }
        throw new Error('Tile is outside its zoom range.');
    };

    return {
        request,
        resolve,
        tile,
        evict(scope?: string | null) {
            for (const [key, result] of cache) {
                if (scope == null || result.scope === scope) {
                    cache.delete(key);
                    cacheBytes -= result.bytes.byteLength;
                }
            }
            for (const [key, flight] of flights) {
                if (scope == null || flight.scope === scope) {
                    flight.controller.abort();
                    flights.delete(key);
                }
            }
        },
        clear() {
            cache.clear();
            cacheBytes = 0;
            for (const flight of flights.values()) flight.controller.abort();
            flights.clear();
        },
        async geojson(source: CustomSource, signal?: AbortSignal | null, refresh: unknown = null): Promise<CustomGeoJsonCollection> {
            if (source.kind !== 'geojson') throw new Error('Invalid source URL.');
            if (!parse) throw new Error('Vector decoder unavailable.');
            const result = await request(source.source.dataUrl, CUSTOM_LIMITS.geojson, signal, true, `${source.id}:${source.revision}`, refresh);
            return await parse({ kind: 'geojson', bytes: result.bytes }, signal) as CustomGeoJsonCollection;
        },
    };
}

export function customTileAt(lat: number, lng: number, z: number): CustomTileCoordinates {
    const n = 2 ** z, latitude = Math.max(-85.051128, Math.min(85.051128, lat)) * Math.PI / 180;
    return {
        z,
        x: Math.floor(((lng + 180) / 360 * n % n + n) % n),
        y: Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * n))),
    };
}
