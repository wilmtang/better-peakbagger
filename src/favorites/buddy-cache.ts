// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { peakbaggerError, type PeakbaggerErrorCode } from '../peakbagger/peakbagger-error.ts';

export const BUDDY_CACHE_MESSAGE = 'BUDDY_CACHE_UPDATE';
export const BUDDY_CACHE_EPOCH_KEY = 'bpbBuddyCacheEpoch';

export interface BuddyCacheEpoch {
    version: string;
    updatedAt: number;
}

export interface BuddyCacheSnapshot {
    version: string | null;
    observedAt: number | null;
}

export type BuddyCacheMessage =
    | { phase: 'begin'; observedAt: number | null }
    | { phase: 'publish'; snapshot: BuddyCacheSnapshot; cache: unknown };

export type BuddyCacheWireMessage = { type: typeof BUDDY_CACHE_MESSAGE } & BuddyCacheMessage;

export interface BuddyCacheRuntimeApi {
    runtime: {
        sendMessage(message: BuddyCacheWireMessage): Promise<unknown>;
    };
}

interface BuddyCacheBeginResponse {
    ok: true;
    snapshot: BuddyCacheSnapshot;
}

interface BuddyCachePublishResponse {
    ok: true;
    written: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const isSnapshot = (value: unknown, observedAt: number | null): value is BuddyCacheSnapshot =>
    isRecord(value)
    && (value.version === null || typeof value.version === 'string')
    && value.observedAt === observedAt;

export const newBuddyCacheEpoch = (now: number): BuddyCacheEpoch => ({
    version: crypto.randomUUID(),
    updatedAt: now,
});

async function send(api: BuddyCacheRuntimeApi, message: { phase: 'begin'; observedAt: number | null }): Promise<BuddyCacheBeginResponse>;
async function send(api: BuddyCacheRuntimeApi, message: { phase: 'publish'; snapshot: BuddyCacheSnapshot; cache: unknown }): Promise<BuddyCachePublishResponse>;
async function send(
    api: BuddyCacheRuntimeApi,
    message: BuddyCacheMessage,
): Promise<BuddyCacheBeginResponse | BuddyCachePublishResponse> {
    const failure = (code: PeakbaggerErrorCode, cause: unknown) =>
        peakbaggerError.exception(peakbaggerError.failure(code, { resource: 'buddies', cause }));
    let response: unknown;
    try { response = await api.runtime.sendMessage({ type: BUDDY_CACHE_MESSAGE, ...message }); }
    catch (cause) { throw failure('buddy-cache-unavailable', cause); }
    // An older loaded worker returns null for an unknown route. Never treat
    // that (or a disconnected transport) as proof that a storage write failed.
    if (!isRecord(response) || typeof response.ok !== 'boolean') throw failure('buddy-cache-unavailable', response);
    if (!response.ok) throw failure(message.phase === 'begin' ? 'buddy-cache-read' : 'storage', response.error);
    if (message.phase === 'begin') {
        if (!isSnapshot(response.snapshot, message.observedAt)) throw failure('buddy-cache-unavailable', response);
        return { ok: true, snapshot: response.snapshot };
    }
    if (typeof response.written !== 'boolean') throw failure('buddy-cache-unavailable', response);
    return { ok: true, written: response.written };
}

// Take the snapshot before starting a request. Rendered reports additionally
// carry navigation time: the response may predate this content-script context.
export const beginBuddyCacheRead = async (
    api: BuddyCacheRuntimeApi,
    observedAt: number | null = null,
): Promise<BuddyCacheSnapshot> =>
    (await send(api, { phase: 'begin', observedAt })).snapshot;

export const publishBuddyCache = async (
    api: BuddyCacheRuntimeApi,
    snapshot: BuddyCacheSnapshot,
    cache: unknown,
): Promise<void> => {
    const response = await send(api, { phase: 'publish', snapshot, cache });
    if (!response.written) {
        throw Object.assign(new Error('Your Buddy List changed during refresh. Refresh again.'),
            { code: 'buddy-cache-stale', resource: 'buddies' });
    }
};
