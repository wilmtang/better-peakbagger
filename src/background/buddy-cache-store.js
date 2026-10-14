// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from '../favorites/favorite-climbers.js';
import { BUDDY_CACHE_EPOCH_KEY, newBuddyCacheEpoch } from '../favorites/buddy-cache.js';
import { climberListLane } from './climber-list-policy.js';
import { storageValue } from '../storage/storage-value.js';

export const createBuddyCacheStore = ({ storage, now = Date.now }) => {
    const run = climberListLane(storage);
    const action = message => run(async () => {
        const values = await storage.get([BUDDY_CACHE_EPOCH_KEY, F.BUDDY_CACHE_KEY]);
        const epoch = values[BUDDY_CACHE_EPOCH_KEY];
        if (epoch !== undefined && (!epoch || typeof epoch.version !== 'string' || !epoch.version
            || epoch.version.length > 100 || !Number.isFinite(epoch.updatedAt) || epoch.updatedAt < 0)) {
            throw new Error('Your saved Buddy List state is unavailable. Try again.');
        }
        const validObservation = value => value === null || Number.isFinite(value) && value >= 0 && value <= now();
        if (message.phase === 'begin') {
            if (!validObservation(message.observedAt)) throw new Error('Invalid Buddy List refresh.');
            return { ok: true, snapshot: { version: epoch?.version ?? null, observedAt: message.observedAt } };
        }
        if (message.phase !== 'publish') throw new Error('Invalid Buddy List refresh.');
        const snapshot = message.snapshot;
        if (!snapshot || !(snapshot.version === null || typeof snapshot.version === 'string' && snapshot.version.length <= 100)
            || !validObservation(snapshot.observedAt)) throw new Error('Invalid Buddy List refresh.');
        const cache = F.cleanBuddyCache(message.cache);
        if (!cache || !Array.isArray(message.cache.entries) || cache.entries.length !== message.cache.entries.length) {
            throw new Error('The refreshed Buddy List is invalid.');
        }
        // Options may receive the exact cache already published by its helper
        // tab. Acknowledge that result without writing or advancing its epoch.
        if (storageValue.same(values[F.BUDDY_CACHE_KEY], cache)) return { ok: true, written: true };
        if (snapshot.version !== (epoch?.version ?? null)
            || snapshot.observedAt !== null && epoch && snapshot.observedAt <= epoch.updatedAt) {
            return { ok: true, written: false };
        }
        await storage.set({ [F.BUDDY_CACHE_KEY]: cache, [BUDDY_CACHE_EPOCH_KEY]: newBuddyCacheEpoch(now()) });
        return { ok: true, written: true };
    }).catch(error => ({ ok: false, error: { code: 'buddy-cache', message: error.message || 'Your Buddy List could not be saved. Try again.' } }));
    return { action };
};
