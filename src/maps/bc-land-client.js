// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settingsSchema as Schema } from '../settings/settings-schema.js';

export function readBCTileCoordinates(value) {
    if (!value || ![value.z, value.x, value.y].every(Number.isSafeInteger) || value.z < 8 || value.z > 15
        || value.y < 0 || value.y >= 2 ** value.z || Math.abs(value.x) > 8 * 2 ** value.z) return null;
    const n = 2 ** value.z; return { z: value.z, x: (value.x % n + n) % n, y: value.y };
}
export function createBCTileFetch(send) {
    return async (coordinates, { signal, landTypes }) => {
        const requestId = crypto.randomUUID();
        let rejectAbort;
        const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
        const abort = () => {
            void Promise.resolve(send({ type: 'BC_LAND_TILE_CANCEL', requestId })).catch(() => {});
            rejectAbort(new DOMException('Cancelled.', 'AbortError'));
        };
        if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
        signal.addEventListener('abort', abort, { once: true });
        try {
            const reply = await Promise.race([send({ type: 'BC_LAND_TILE_GET', coordinates: readBCTileCoordinates(coordinates), landTypes: Schema.mapLandTypes(landTypes), requestId }), cancelled]);
            if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
            if (!reply?.ok && reply?.code === 'rate-limit') throw Object.assign(new Error('BC map service is busy. Try again later.'), {
                code: 'rate-limit', retryAt: Number.isFinite(reply.retryAt) && reply.retryAt > Date.now() && reply.retryAt < Date.now() + 86400000 ? reply.retryAt : Date.now() + 300000,
            });
            if (!reply?.ok && reply?.code === 'temporary') throw Object.assign(new Error('BC map service is temporarily unavailable.'), { transient: true });
            if (!reply?.ok) throw Object.assign(new Error(reply?.code === 'bc-permission-required' ? 'Allow BC parcel maps.' : 'BC parcels unavailable. Retry.'),
                { code: reply?.code === 'bc-permission-required' ? 'bc-permission-required' : 'tile-unavailable' });
            if (typeof reply.image !== 'string' || reply.image.length > 1400000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.image)) throw new Error('Invalid BC map tile.');
            return new Response(Uint8Array.from(atob(reply.image), character => character.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
        } finally { signal.removeEventListener('abort', abort); }
    };
}
// MAIN-world maps relay coordinates and allowlisted classes, never provider queries.
export function createPageBCTileFetch(win) {
    const pending = new Map();
    const send = message => {
        win.postMessage({ __bpbMapLayers: true, dir: 'toCS', type: 'bcTile', message }, win.location.origin);
        if (message.type === 'BC_LAND_TILE_CANCEL') {
            pending.delete(message.requestId); return Promise.resolve({ ok: true });
        }
        return new Promise(resolve => pending.set(message.requestId, resolve));
    };
    const receive = event => {
        if (event.source !== win || event.origin !== win.location.origin || event.data?.__bpbMapLayers !== true
            || event.data.dir !== 'toPage' || event.data.type !== 'bcTileReply') return;
        const resolve = pending.get(event.data.requestId); if (!resolve) return;
        pending.delete(event.data.requestId); resolve(event.data.reply);
    };
    win.addEventListener('message', receive);
    const fetchTile = createBCTileFetch(send);
    fetchTile.dispose = () => {
        for (const [requestId, resolve] of pending) { void send({ type: 'BC_LAND_TILE_CANCEL', requestId }); resolve({ ok: false }); }
        pending.clear(); win.removeEventListener('message', receive);
    };
    return fetchTile;
}
