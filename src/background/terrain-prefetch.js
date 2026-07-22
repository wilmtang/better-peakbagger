// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { terrainTiles as TerrainTiles } from '../terrain/terrain-tiles.js';
import { terrainCache as TerrainCache } from '../terrain/terrain-cache.js';
import { settings as Settings } from '../settings/settings.js';

const PREFETCH_RATE_MS = 15 * 1000;
const PREFETCH_TILE_CAP = 32;
const PREFETCH_CONCURRENCY = 4;
const PREFETCH_DEDUPE_TTL_MS = 10 * 60 * 1000;

export function createTerrainPrefetch({ isPeakbaggerSender, mapWithConcurrency, now }) {
    const lastByTab = new Map();
    const recentTiles = new Map();
    let cacheState = null;

    const validViewport = viewport => !!viewport
        && Number.isFinite(viewport.width) && viewport.width >= 100 && viewport.width <= 8192
        && Number.isFinite(viewport.height) && viewport.height >= 100 && viewport.height <= 8192;

    const tilesFor = (message, viewport) => {
        const bounds = message && message.bounds;
        if (bounds && typeof bounds === 'object'
            && [bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon].every(Number.isFinite)) {
            return TerrainTiles.tilesForView({
                bounds: {
                    minLat: bounds.minLat, minLon: bounds.minLon,
                    maxLat: bounds.maxLat, maxLon: bounds.maxLon
                },
                viewport, cap: PREFETCH_TILE_CAP
            });
        }
        if (Array.isArray(message.center) && message.center.length === 2
            && message.center.every(Number.isFinite) && Number.isFinite(message.zoom)) {
            return TerrainTiles.tilesForView({
                center: [message.center[0], message.center[1]], zoom: message.zoom,
                viewport, cap: PREFETCH_TILE_CAP
            });
        }
        return null;
    };

    const handle = async (message, sender) => {
        // A Peakbagger content script asking to warm the cache for a view it is
        // about to render; nothing else may drive worker-to-Mapterhorn traffic.
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return { ok: false, reason: 'forbidden' };
        }
        const settings = await Settings.get();
        // 3D enablement is the consent gate for contacting Mapterhorn; a zero
        // cache budget means there is nothing to warm.
        if (settings.enable3dMap !== true || !(settings.terrainCacheLimitMb > 0)) {
            return { ok: false, reason: 'disabled' };
        }
        if (!validViewport(message && message.viewport)) return { ok: false, reason: 'invalid' };

        const tiles = tilesFor(message, message.viewport);
        if (tiles === null) return { ok: false, reason: 'invalid' };
        if (!tiles.length) return { ok: true, tiles: 0 };

        // Charge only a well-formed request, so malformed bursts cannot lock a tab.
        const tabId = sender.tab.id;
        const nowMs = now();
        const last = lastByTab.get(tabId);
        if (Number.isFinite(last) && nowMs - last < PREFETCH_RATE_MS) {
            return { ok: false, reason: 'throttled' };
        }
        lastByTab.set(tabId, nowMs);

        const limitMb = settings.terrainCacheLimitMb;
        if (!cacheState || cacheState.limitMb !== limitMb) {
            cacheState = { limitMb, cache: TerrainCache.create({ limitMb }) };
        }

        for (const [key, expiry] of recentTiles) {
            if (expiry <= nowMs) recentTiles.delete(key);
        }
        const fresh = [];
        for (const tile of tiles) {
            const key = `${tile.z}/${tile.x}/${tile.y}`;
            if (recentTiles.has(key)) continue;
            recentTiles.set(key, nowMs + PREFETCH_DEDUPE_TTL_MS);
            fresh.push({ tile, key });
        }

        const warmed = await mapWithConcurrency(fresh, PREFETCH_CONCURRENCY, async ({ tile, key }) => {
            try {
                await cacheState.cache.load({ url: `bpb-dem://${tile.z}/${tile.x}/${tile.y}.webp` });
                return true;
            } catch {
                // Failed tiles remain retryable on a later prefetch.
                recentTiles.delete(key);
                return false;
            }
        });
        return { ok: true, tiles: warmed.filter(Boolean).length };
    };

    return {
        handle,
        forgetTab(tabId) { lastByTab.delete(tabId); }
    };
}
