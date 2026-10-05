// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from '../favorites/favorite-climbers.js';
import * as I from '../favorites/ignored-climbers.js';

// Both lists, including sync reconciliation, share one short storage lane.
// A check in a separate queue could let concurrent favorite/ignore adds win.
const lanes = new WeakMap();
export const climberListLane = storage => {
    if (!lanes.has(storage)) {
        let tail = Promise.resolve();
        lanes.set(storage, operation => {
            const pending = tail.then(operation, operation);
            tail = pending.catch(() => {});
            return pending;
        });
    }
    return lanes.get(storage);
};
const unavailable = () => { throw Object.assign(new Error('Climber lists are unavailable. Try again.'), { code: 'storage' }); };
const conflict = (entries, message) => {
    const who = entries.length === 1 ? entries[0].name : `${entries[0].name} and ${entries.length - 1} other climber${entries.length === 2 ? '' : 's'}`;
    throw Object.assign(new Error(`${who}: ${message}`), { code: 'list-conflict' });
};

export const assertFavoriteMembership = async (storage, entries) => {
    if (!entries.length) return;
    const values = await storage.get([I.IGNORED_KEY, I.SYNC_KEY]);
    const ignored = I.readList(values[I.IGNORED_KEY]);
    if (!ignored) unavailable();
    const blocked = new Set(ignored.entries.map(entry => entry.cid));
    const ignoredConflicts = entries.filter(entry => blocked.has(entry.cid));
    if (ignoredConflicts.length) conflict(ignoredConflicts, 'Unignore before adding to favorites.');
    // Reserve IDs before a GitHub commit. A favorite added during the upload
    // must not make the later local reconciliation contradict the user's edit.
    const pending = values[I.SYNC_KEY]?.pending;
    if (pending) {
        const reserved = I.validateEntries(pending.result);
        if (!reserved) unavailable();
        for (const entry of reserved) blocked.add(entry.cid);
    }
    const conflicts = entries.filter(entry => blocked.has(entry.cid));
    if (conflicts.length) conflict(conflicts,
        'Finish or review the pending ignored-climber sync before adding to favorites.');
};

export const assertIgnoredMembership = async (storage, entries) => {
    if (!entries.length) return;
    const values = await storage.get([F.FAVORITES_KEY, F.BUDDY_CACHE_KEY]);
    const raw = values[F.FAVORITES_KEY];
    const favorites = F.cleanFavorites(raw);
    if (raw !== undefined && (!raw || raw.schemaVersion !== F.SCHEMA_VERSION
        || !Array.isArray(raw.entries) || favorites.entries.length !== raw.entries.length)) unavailable();
    const rawCache = values[F.BUDDY_CACHE_KEY];
    const buddies = F.cleanBuddyCache(rawCache);
    if (rawCache != null && (!buddies || !Array.isArray(rawCache.entries)
        || buddies.entries.length !== rawCache.entries.length)) unavailable();
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
