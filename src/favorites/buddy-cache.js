// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const BUDDY_CACHE_MESSAGE = 'BUDDY_CACHE_UPDATE';
export const BUDDY_CACHE_EPOCH_KEY = 'bpbBuddyCacheEpoch';
export const newBuddyCacheEpoch = now => ({ version: crypto.randomUUID(), updatedAt: now });

const send = async (api, message) => {
    const response = await api.runtime.sendMessage({ type: BUDDY_CACHE_MESSAGE, ...message });
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message || 'Your Buddy List could not be saved. Try again.'),
        { code: 'storage', resource: 'buddies' });
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
