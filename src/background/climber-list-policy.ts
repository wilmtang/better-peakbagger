// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from '../favorites/favorite-climbers.ts';
import * as I from '../favorites/ignored-climbers.ts';
import { BUDDY_INTENTS_KEY, readBuddyIntents } from '../favorites/buddy-state.ts';

export interface ClimberListStorage {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set?(items: Record<string, unknown>): Promise<void>;
}

export type ClimberListLane = <T>(operation: () => Promise<T> | T) => Promise<T>;

export interface ClimberListMember {
    cid: number;
    name: string;
}

export interface ClimberListPolicyError extends Error {
    code: 'storage' | 'list-conflict';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

// Both lists, including sync reconciliation, share one short storage lane.
// A check in a separate queue could let concurrent favorite/ignore adds win.
const lanes = new WeakMap<ClimberListStorage, ClimberListLane>();
export const climberListLane = (storage: ClimberListStorage): ClimberListLane => {
    const existing = lanes.get(storage);
    if (existing) return existing;
    let tail: Promise<unknown> = Promise.resolve();
    const lane: ClimberListLane = operation => {
        const pending = tail.then(operation, operation);
        tail = pending.catch(() => {});
        return pending;
    };
    lanes.set(storage, lane);
    return lane;
};
function unavailable(): never {
    const error: ClimberListPolicyError = Object.assign(
        new Error('Climber lists are unavailable. Try again.'),
        { code: 'storage' as const },
    );
    throw error;
}
function conflict(entries: readonly ClimberListMember[], message: string): never {
    const first = entries[0]!;
    const who = entries.length === 1
        ? first.name
        : `${first.name} and ${entries.length - 1} other climber${entries.length === 2 ? '' : 's'}`;
    const error: ClimberListPolicyError = Object.assign(
        new Error(`${who}: ${message}`),
        { code: 'list-conflict' as const },
    );
    throw error;
}

export const assertFavoriteMembership = async (
    storage: ClimberListStorage,
    entries: readonly ClimberListMember[],
): Promise<void> => {
    if (!entries.length) return;
    const values = await storage.get([I.IGNORED_KEY, I.SYNC_KEY]);
    const ignored = I.readList(values[I.IGNORED_KEY]);
    if (!ignored) unavailable();
    const blocked = new Set(ignored.entries.map(entry => entry.cid));
    const ignoredConflicts = entries.filter(entry => blocked.has(entry.cid));
    if (ignoredConflicts.length) conflict(ignoredConflicts, 'Unignore before adding to favorites.');
    // Reserve IDs before a GitHub commit. A favorite added during the upload
    // must not make the later local reconciliation contradict the user's edit.
    const syncState = values[I.SYNC_KEY];
    const pending = isRecord(syncState) ? syncState.pending : undefined;
    if (pending) {
        const reserved = I.validateEntries(isRecord(pending) ? pending.result : undefined);
        if (!reserved) unavailable();
        for (const entry of reserved) blocked.add(entry.cid);
    }
    const conflicts = entries.filter(entry => blocked.has(entry.cid));
    if (conflicts.length) conflict(conflicts,
        'Finish or review the pending ignored-climber sync before adding to favorites.');
};

export const assertIgnoredMembership = async (
    storage: ClimberListStorage,
    entries: readonly ClimberListMember[],
): Promise<void> => {
    if (!entries.length) return;
    const values = await storage.get([F.FAVORITES_KEY, F.BUDDY_CACHE_KEY, BUDDY_INTENTS_KEY]);
    const intents = readBuddyIntents(values[BUDDY_INTENTS_KEY]);
    const unresolved = entries.filter(entry => intents.some(intent => intent.cid === entry.cid));
    if (unresolved.length) conflict(unresolved, 'Check the pending buddy change before ignoring.');
    const raw = values[F.FAVORITES_KEY];
    const rawRecord = isRecord(raw) ? raw : null;
    const favorites = F.cleanFavorites(raw);
    if (raw !== undefined && (!rawRecord || rawRecord.schemaVersion !== F.SCHEMA_VERSION
        || !Array.isArray(rawRecord.entries) || favorites.entries.length !== rawRecord.entries.length)) unavailable();
    const rawCache = values[F.BUDDY_CACHE_KEY];
    const rawCacheRecord = isRecord(rawCache) ? rawCache : null;
    const buddies = F.cleanBuddyCache(rawCache);
    if (rawCache != null && (!buddies || !rawCacheRecord || !Array.isArray(rawCacheRecord.entries)
        || buddies.entries.length !== rawCacheRecord.entries.length)) unavailable();
    const protectedIds = new Set([...favorites.entries, ...(buddies?.entries || [])].map(entry => entry.cid));
    const conflicts = entries.filter(entry => protectedIds.has(entry.cid));
    if (conflicts.length) {
        const favoriteIds = new Set(favorites.entries.map(entry => entry.cid));
        const buddyIds = new Set((buddies?.entries || []).map(entry => entry.cid));
        const lists = [conflicts.some(entry => favoriteIds.has(entry.cid)) && 'favorites',
            conflicts.some(entry => buddyIds.has(entry.cid)) && 'your Buddy List'].filter(Boolean).join(' and ');
        conflict(conflicts, `Remove from ${lists} before ignoring.${buddyIds.size
            ? ' Refresh your Buddy List if it changed elsewhere.' : ''}`);
    }
};
