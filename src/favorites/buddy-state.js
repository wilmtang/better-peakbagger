// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const BUDDY_INTENTS_KEY = 'bpbBuddyIntents';
export const BUDDY_MESSAGE = 'CLIMBER_BUDDY_ACTION';
// Pending writes never expire into permission to Ignore or repeat a POST.
export const readBuddyIntents = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100 || value.some(entry => !entry
        || !Number.isSafeInteger(entry.cid) || entry.cid <= 0
        || !Number.isSafeInteger(entry.ownerCid) || entry.ownerCid <= 0
        || !['add', 'remove'].includes(entry.action) || typeof entry.name !== 'string'
        || !entry.name || entry.name.length > 200 || typeof entry.token !== 'string'
        || !entry.token || !Number.isInteger(entry.tabId)
        || !['prepared', 'dispatched', 'confirmed'].includes(entry.status)
        || typeof entry.checkOnly !== 'boolean' || !Number.isFinite(entry.leaseUntil))
        || new Set(value.map(entry => entry.cid)).size !== value.length
        || new Set(value.map(entry => entry.token)).size !== value.length) throw new Error('Pending buddy changes are unavailable. Try again.');
    return value;
};
