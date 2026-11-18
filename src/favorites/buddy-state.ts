// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export type BuddyAction = 'add' | 'remove';
export type BuddyIntentStatus = 'prepared' | 'dispatched' | 'confirmed';

export interface BuddyIntent {
    cid: number;
    ownerCid: number;
    action: BuddyAction;
    name: string;
    token: string;
    tabId: number;
    status: BuddyIntentStatus;
    checkOnly: boolean;
    leaseUntil: number;
}

export const BUDDY_INTENTS_KEY = 'bpbBuddyIntents';
export const BUDDY_MESSAGE = 'CLIMBER_BUDDY_ACTION';

const isBuddyIntent = (entry: unknown): entry is BuddyIntent => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.cid === 'number' && Number.isSafeInteger(item.cid) && item.cid > 0
        && typeof item.ownerCid === 'number' && Number.isSafeInteger(item.ownerCid) && item.ownerCid > 0
        && (item.action === 'add' || item.action === 'remove')
        && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 200
        && typeof item.token === 'string' && item.token.length > 0
        && typeof item.tabId === 'number' && Number.isInteger(item.tabId)
        && (item.status === 'prepared' || item.status === 'dispatched' || item.status === 'confirmed')
        && typeof item.checkOnly === 'boolean'
        && typeof item.leaseUntil === 'number' && Number.isFinite(item.leaseUntil);
};

// Pending writes never expire into permission to Ignore or repeat a POST.
export const readBuddyIntents = (value: unknown): BuddyIntent[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100 || value.some(entry => !isBuddyIntent(entry))) {
        throw new Error('Pending buddy changes are unavailable. Try again.');
    }
    const entries = value as BuddyIntent[];
    if (new Set(entries.map(entry => entry.cid)).size !== entries.length
        || new Set(entries.map(entry => entry.token)).size !== entries.length) {
        throw new Error('Pending buddy changes are unavailable. Try again.');
    }
    return entries;
};
