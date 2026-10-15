// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { peakbaggerError } from '../peakbagger/peakbagger-error.js';

export const BUDDY_CACHE_MESSAGE = 'BUDDY_CACHE_UPDATE';
export const BUDDY_CACHE_EPOCH_KEY = 'bpbBuddyCacheEpoch';
export const newBuddyCacheEpoch = now => ({ version: crypto.randomUUID(), updatedAt: now });

const send = async (api, message) => {
    const failure = (code, cause) => peakbaggerError.exception(peakbaggerError.failure(code, { resource: 'buddies', cause }));
    let response;
    try { response = await api.runtime.sendMessage({ type: BUDDY_CACHE_MESSAGE, ...message }); }
    catch (cause) { throw failure('buddy-cache-unavailable', cause); }
    // An older loaded worker returns null for an unknown route. Never treat
    // that (or a disconnected transport) as proof that a storage write failed.
    if (typeof response?.ok !== 'boolean') throw failure('buddy-cache-unavailable', response);
    if (!response.ok) throw failure(message.phase === 'begin' ? 'buddy-cache-read' : 'storage', response.error);
    const valid = message.phase === 'begin'
        ? response.snapshot && (response.snapshot.version === null || typeof response.snapshot.version === 'string')
            && response.snapshot.observedAt === message.observedAt
        : typeof response.written === 'boolean';
    if (!valid) throw failure('buddy-cache-unavailable', response);
    return response;
};

// Take the snapshot before starting a request. Rendered reports additionally
// carry navigation time: the response may predate this content-script context.
export const beginBuddyCacheRead = async (api, observedAt = null) =>
    (await send(api, { phase: 'begin', observedAt })).snapshot;
export const publishBuddyCache = async (api, snapshot, cache) => {
    const response = await send(api, { phase: 'publish', snapshot, cache });
    if (!response.written) throw Object.assign(new Error('Your Buddy List changed during refresh. Refresh again.'),
        { code: 'buddy-cache-stale', resource: 'buddies' });
};
