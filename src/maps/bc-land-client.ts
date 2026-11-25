// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settingsSchema as Schema } from '../settings/settings-schema.ts';

export interface BCTileCoordinates {
    z: number;
    x: number;
    y: number;
}

export interface BCTileFetchOptions {
    signal: AbortSignal;
    landTypes?: unknown;
}

export type BCTileMessage =
    | { type: 'BC_LAND_TILE_GET'; coordinates: BCTileCoordinates | null; landTypes: string[]; requestId: string }
    | { type: 'BC_LAND_TILE_CANCEL'; requestId: string };

export interface BCTileReply {
    ok?: boolean;
    code?: string;
    retryAt?: number;
    image?: string;
}

export type BCTileSend = (message: BCTileMessage) => Promise<unknown>;

export type BCTileFetch = ((coordinates: unknown, options: BCTileFetchOptions) => Promise<Response>) & {
    dispose?: () => void;
};

export function readBCTileCoordinates(value: unknown): BCTileCoordinates | null {
    if (!value || typeof value !== 'object') return null;
    const { z, x, y } = value as { z?: unknown; x?: unknown; y?: unknown };
    if (![z, x, y].every(Number.isSafeInteger)
        || (z as number) < 8 || (z as number) > 15
        || (y as number) < 0 || (y as number) >= 2 ** (z as number)
        || Math.abs(x as number) > 8 * 2 ** (z as number)) return null;
    const zoom = z as number;
    const n = 2 ** zoom;
    return { z: zoom, x: ((x as number) % n + n) % n, y: y as number };
}

export function createBCTileFetch(send: BCTileSend): (coordinates: unknown, options: BCTileFetchOptions) => Promise<Response> {
    return async (coordinates, { signal, landTypes }) => {
        const requestId = crypto.randomUUID();
        let rejectAbort!: (reason?: unknown) => void;
        const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const abort = (): void => {
            void Promise.resolve(send({ type: 'BC_LAND_TILE_CANCEL', requestId })).catch(() => {});
            rejectAbort(new DOMException('Cancelled.', 'AbortError'));
        };
        if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
        signal.addEventListener('abort', abort, { once: true });
        try {
            const reply = await Promise.race([
                send({
                    type: 'BC_LAND_TILE_GET',
                    coordinates: readBCTileCoordinates(coordinates),
                    landTypes: Schema.mapLandTypes(landTypes),
                    requestId,
                }),
                cancelled,
            ]) as BCTileReply | null | undefined;
            if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
            if (!reply?.ok && reply?.code === 'rate-limit') {
                const retryAt = typeof reply.retryAt === 'number' && Number.isFinite(reply.retryAt)
                    && reply.retryAt > Date.now() && reply.retryAt < Date.now() + 86400000
                    ? reply.retryAt
                    : Date.now() + 300000;
                throw Object.assign(new Error('BC map service is busy. Try again later.'), {
                    code: 'rate-limit',
                    retryAt,
                });
            }
            if (!reply?.ok && reply?.code === 'temporary') {
                throw Object.assign(new Error('BC map service is temporarily unavailable.'), { transient: true });
            }
            if (!reply?.ok) {
                throw Object.assign(
                    new Error(reply?.code === 'bc-permission-required' ? 'Allow BC parcel maps.' : 'BC parcels unavailable. Retry.'),
                    { code: reply?.code === 'bc-permission-required' ? 'bc-permission-required' : 'tile-unavailable' }
                );
            }
            if (typeof reply.image !== 'string' || reply.image.length > 1400000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.image)) {
                throw new Error('Invalid BC map tile.');
            }
            return new Response(
                Uint8Array.from(atob(reply.image), character => character.charCodeAt(0)),
                { headers: { 'content-type': 'image/png' } }
            );
        } finally {
            signal.removeEventListener('abort', abort);
        }
    };
}

// MAIN-world maps relay coordinates and allowlisted classes, never provider queries.
export function createPageBCTileFetch(win: Window): ((coordinates: unknown, options: BCTileFetchOptions) => Promise<Response>) & { dispose(): void } {
    const pending = new Map<string, (reply: BCTileReply) => void>();
    const send = (message: BCTileMessage): Promise<BCTileReply> => {
        win.postMessage({ __bpbMapLayers: true, dir: 'toCS', type: 'bcTile', message }, win.location.origin);
        if (message.type === 'BC_LAND_TILE_CANCEL') {
            pending.delete(message.requestId);
            return Promise.resolve({ ok: true });
        }
        return new Promise<BCTileReply>(resolve => pending.set(message.requestId, resolve));
    };
    const receive = (event: MessageEvent): void => {
        const data = event.data as {
            __bpbMapLayers?: unknown;
            dir?: unknown;
            type?: unknown;
            requestId?: unknown;
            reply?: BCTileReply;
        } | null | undefined;
        if (event.source !== win || event.origin !== win.location.origin
            || data?.__bpbMapLayers !== true || data.dir !== 'toPage' || data.type !== 'bcTileReply'
            || typeof data.requestId !== 'string') return;
        const resolve = pending.get(data.requestId);
        if (!resolve) return;
        pending.delete(data.requestId);
        resolve(data.reply || { ok: false });
    };
    win.addEventListener('message', receive);
    const fetchTile = createBCTileFetch(send) as ((coordinates: unknown, options: BCTileFetchOptions) => Promise<Response>) & { dispose(): void };
    fetchTile.dispose = () => {
        for (const [requestId, resolve] of pending) {
            void send({ type: 'BC_LAND_TILE_CANCEL', requestId });
            resolve({ ok: false });
        }
        pending.clear();
        win.removeEventListener('message', receive);
    };
    return fetchTile;
}
