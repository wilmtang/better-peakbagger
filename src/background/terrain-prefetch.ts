// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { terrainTiles as TerrainTiles, type TileCoordinate, type TileViewport } from '../terrain/terrain-tiles.ts';
import { terrainCache as TerrainCache } from '../terrain/terrain-cache.ts';
import { settings as Settings } from '../settings/settings.ts';

type Sender = chrome.runtime.MessageSender;

const PREFETCH_RATE_MS = 15 * 1000;
const PREFETCH_TILE_CAP = 32;
const PREFETCH_CONCURRENCY = 4;
const PREFETCH_DEDUPE_TTL_MS = 10 * 60 * 1000;

export interface TerrainPrefetchSettings {
    enable3dMap?: boolean;
    terrainCacheLimitMb?: number;
}

export interface TerrainPrefetchCache {
    load(parameters: { url: string }): Promise<unknown>;
    close(): Promise<unknown>;
}

export type MapWithConcurrencyFn = <Item, Result>(
    items: Item[],
    concurrency: number,
    worker: (item: Item) => Promise<Result>,
) => Promise<Result[]>;

export interface TerrainPrefetchOptions {
    isPeakbaggerSender: (sender: Sender) => boolean;
    consumeActivation: (token: unknown, sender: Sender) => boolean;
    mapWithConcurrency: MapWithConcurrencyFn;
    now: () => number;
    getSettings?: () => Promise<TerrainPrefetchSettings>;
    createCache?: (limitMb: number) => TerrainPrefetchCache;
}

interface PrefetchMessage {
    bounds?: unknown;
    center?: unknown;
    zoom?: unknown;
    viewport?: unknown;
    activation?: unknown;
}

export type TerrainPrefetchResult =
    | { ok: true; tiles: number }
    | { ok: false; reason: 'forbidden' | 'activation' | 'disabled' | 'invalid' | 'throttled' };

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function createTerrainPrefetch({
    isPeakbaggerSender, consumeActivation, mapWithConcurrency, now,
    getSettings = () => Settings.get(),
    createCache = limitMb => TerrainCache.create({ limitMb }),
}: TerrainPrefetchOptions) {
    const lastByTab = new Map<number, number>();
    const recentTiles = new Map<string, number>();
    let cacheState: { limitMb: number; cache: TerrainPrefetchCache } | null = null;
    let cacheTransition: Promise<void> = Promise.resolve();

    const cacheForLimit = (limitMb: number | null): Promise<TerrainPrefetchCache | null> => {
        const transition = cacheTransition.then(async () => {
            if (cacheState?.limitMb === limitMb) return cacheState.cache;
            if (cacheState) await cacheState.cache.close();
            cacheState = limitMb === null ? null : { limitMb, cache: createCache(limitMb) };
            return cacheState?.cache || null;
        });
        cacheTransition = transition.then(() => {}, () => {});
        return transition;
    };

    const validViewport = (viewport: unknown): viewport is TileViewport => {
        if (!viewport || typeof viewport !== 'object') return false;
        const candidate = viewport as { width?: unknown; height?: unknown };
        return isFiniteNumber(candidate.width) && candidate.width >= 100 && candidate.width <= 8192
            && isFiniteNumber(candidate.height) && candidate.height >= 100 && candidate.height <= 8192;
    };

    const tilesFor = (message: PrefetchMessage, viewport: TileViewport): TileCoordinate[] | null => {
        const bounds = message.bounds;
        if (bounds && typeof bounds === 'object') {
            const candidate = bounds as { minLat?: unknown; minLon?: unknown; maxLat?: unknown; maxLon?: unknown };
            if (isFiniteNumber(candidate.minLat) && isFiniteNumber(candidate.minLon)
                && isFiniteNumber(candidate.maxLat) && isFiniteNumber(candidate.maxLon)) {
                return TerrainTiles.tilesForView({
                    bounds: {
                        minLat: candidate.minLat, minLon: candidate.minLon,
                        maxLat: candidate.maxLat, maxLon: candidate.maxLon,
                    },
                    viewport, cap: PREFETCH_TILE_CAP,
                });
            }
        }
        if (Array.isArray(message.center) && message.center.length === 2
            && isFiniteNumber(message.center[0]) && isFiniteNumber(message.center[1])
            && isFiniteNumber(message.zoom)) {
            return TerrainTiles.tilesForView({
                center: [message.center[0], message.center[1]], zoom: message.zoom,
                viewport, cap: PREFETCH_TILE_CAP,
            });
        }
        return null;
    };

    const handle = async (message: unknown, sender: Sender): Promise<TerrainPrefetchResult> => {
        // A Peakbagger content script asking to warm the cache for a view it is
        // about to render; nothing else may drive worker-to-Mapterhorn traffic.
        const tabId = sender?.tab?.id;
        if (!isPeakbaggerSender(sender) || typeof tabId !== 'number' || !Number.isInteger(tabId)) {
            return { ok: false, reason: 'forbidden' };
        }
        const req = (message && typeof message === 'object' ? message : {}) as PrefetchMessage;
        if (typeof consumeActivation !== 'function'
            || !consumeActivation(req.activation, sender)) {
            return { ok: false, reason: 'activation' };
        }
        const currentSettings = await getSettings();
        const limitMb = isFiniteNumber(currentSettings.terrainCacheLimitMb) ? currentSettings.terrainCacheLimitMb : 0;
        // 3D enablement is the consent gate for contacting Mapterhorn; a zero
        // cache budget means there is nothing to warm.
        if (currentSettings.enable3dMap !== true || !(limitMb > 0)) {
            await cacheForLimit(null);
            return { ok: false, reason: 'disabled' };
        }
        if (!validViewport(req.viewport)) return { ok: false, reason: 'invalid' };

        const tiles = tilesFor(req, req.viewport);
        if (tiles === null) return { ok: false, reason: 'invalid' };
        if (!tiles.length) return { ok: true, tiles: 0 };

        // Charge only a well-formed request, so malformed bursts cannot lock a tab.
        const nowMs = now();
        const last = lastByTab.get(tabId);
        if (typeof last === 'number' && Number.isFinite(last) && nowMs - last < PREFETCH_RATE_MS) {
            return { ok: false, reason: 'throttled' };
        }
        lastByTab.set(tabId, nowMs);

        const cache = await cacheForLimit(limitMb);
        if (!cache) return { ok: false, reason: 'disabled' };

        for (const [key, expiry] of recentTiles) {
            if (expiry <= nowMs) recentTiles.delete(key);
        }
        const fresh: { tile: TileCoordinate; key: string }[] = [];
        for (const tile of tiles) {
            const key = `${tile.z}/${tile.x}/${tile.y}`;
            if (recentTiles.has(key)) continue;
            recentTiles.set(key, nowMs + PREFETCH_DEDUPE_TTL_MS);
            fresh.push({ tile, key });
        }

        const warmed = await mapWithConcurrency(fresh, PREFETCH_CONCURRENCY, async ({ tile, key }) => {
            try {
                await cache.load({ url: `bpb-dem://${tile.z}/${tile.x}/${tile.y}.webp` });
                return true;
            } catch (error) {
                // Failed tiles remain retryable on a later prefetch — but a tile
                // the provider says does not exist will not appear on the next
                // hover either, and a peak in a region the archive does not cover
                // would otherwise re-request the same absent set every time the
                // toggle is hovered.
                if (!TerrainCache.isMissingTile(error)) recentTiles.delete(key);
                return false;
            }
        });
        return { ok: true, tiles: warmed.filter(Boolean).length };
    };

    return {
        handle,
        forgetTab(tabId: number): void { lastByTab.delete(tabId); },
    };
}

export type TerrainPrefetch = ReturnType<typeof createTerrainPrefetch>;
