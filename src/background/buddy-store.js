// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from '../favorites/favorite-climbers.js';
import { BUDDY_INTENTS_KEY, readBuddyIntents } from '../favorites/buddy-state.js';
import { climberListLane, assertFavoriteMembership } from './climber-list-policy.js';
import { applyFavoritesMutation } from './favorites-store.js';
import { BUDDY_CACHE_EPOCH_KEY, newBuddyCacheEpoch } from '../favorites/buddy-cache.js';

export const createBuddyStore = ({ storage, settings, now = Date.now, token = () => crypto.randomUUID() }) => {
    const run = climberListLane(storage);
    const action = (message, sender) => run(async () => {
        const values = await storage.get([BUDDY_INTENTS_KEY, F.BUDDY_CACHE_KEY, F.FAVORITES_KEY]);
        const intents = readBuddyIntents(values[BUDDY_INTENTS_KEY]);
        if (message.phase === 'begin') {
            const { cid, ownerCid, name, action: intent } = message;
            if (!Number.isSafeInteger(cid) || cid <= 0 || !Number.isSafeInteger(ownerCid) || ownerCid <= 0
                || cid === ownerCid || !['add', 'remove'].includes(intent) || typeof name !== 'string'
                || !name.trim() || name.length > F.NAME_LIMIT) throw new Error('Invalid buddy change.');
            const pending = intents.find(entry => entry.cid === cid);
            if (pending && pending.leaseUntil > now()) throw new Error('Buddy change is in progress in another tab. Check status shortly.');
            if (pending && pending.ownerCid !== ownerCid) throw new Error('Sign in to the original account to check the pending buddy change.');
            const recovering = !!pending && !(pending.status === 'confirmed' && pending.action !== intent && !message.checkOnly);
            if (!recovering && intent === 'add' && !message.checkOnly) await assertFavoriteMembership(storage, [{ cid, name }]);
            if (!pending && intents.length >= 100) throw new Error('Check pending buddy changes before adding more.');
            const entry = { cid, ownerCid, name, action: recovering ? pending.action : intent, token: token(),
                tabId: sender.tab.id, status: recovering ? pending.status : 'prepared', leaseUntil: now() + 60000,
                checkOnly: recovering || !!message.checkOnly };
            await storage.set({ [BUDDY_INTENTS_KEY]: [...intents.filter(item => item.cid !== cid), entry] });
            return { ok: true, token: entry.token, checkOnly: entry.checkOnly };
        }
        const entry = intents.find(item => item.token === message.token && item.tabId === sender.tab.id);
        if (!entry) throw new Error('This buddy change is obsolete. Check status again.');
        const rest = intents.filter(item => item !== entry);
        if (message.phase === 'dispatch') {
            if (entry.checkOnly || entry.status !== 'prepared' || entry.leaseUntil <= now()) throw new Error('Check status before trying another buddy change.');
            if (entry.action === 'add') await assertFavoriteMembership(storage, [entry]);
            await storage.set({ [BUDDY_INTENTS_KEY]: [...rest, { ...entry, status: 'dispatched' }] });
        } else if (message.phase === 'failed') {
            await storage.set({ [BUDDY_INTENTS_KEY]: entry.status !== 'prepared' || message.dispatched
                ? [...rest, { ...entry, status: entry.status === 'confirmed' ? 'confirmed' : 'dispatched', leaseUntil: 0 }] : rest });
        } else if (message.phase === 'complete') {
            if (typeof message.buddy !== 'boolean') throw new Error('Buddy status is unavailable.');
            const cache = F.cleanBuddyCache(values[F.BUDDY_CACHE_KEY]);
            const rawCache = values[F.BUDDY_CACHE_KEY];
            if (rawCache != null && (!cache || !Array.isArray(rawCache.entries)
                || cache.entries.length !== rawCache.entries.length)) {
                throw new Error('Refresh your saved Buddy List, then check buddy status.');
            }
            const entries = cache?.ownerCid === entry.ownerCid ? cache.entries.filter(item => item.cid !== entry.cid) : [];
            if (message.buddy) entries.push({ cid: entry.cid, name: entry.name });
            const patch = { [BUDDY_CACHE_EPOCH_KEY]: newBuddyCacheEpoch(now()),
                [F.BUDDY_CACHE_KEY]: { ownerCid: entry.ownerCid, entries,
                // A target profile proves only this target; it cannot refresh
                // the age or completeness of the full Buddy report cache.
                    fetchedAt: cache?.ownerCid === entry.ownerCid ? cache.fetchedAt : 0 } };
            let warning = '';
            const config = await settings().catch(() => {
                warning = 'Buddy change saved. Favorites could not be updated; check buddy status to retry.';
                return null;
            });
            if (message.buddy === (entry.action === 'add') && config?.favoritesSource === 'custom'
                && (message.buddy || config.removeFavoriteWhenBuddyRemoved)) {
                const mutation = message.buddy ? { kind: 'add', entry: { cid: entry.cid, name: entry.name,
                    source: 'buddy', addedAt: now() } } : { kind: 'remove', cid: entry.cid };
                const result = applyFavoritesMutation(values[F.FAVORITES_KEY], mutation, now());
                try {
                    const raw = values[F.FAVORITES_KEY];
                    if (raw !== undefined && (!raw || raw.schemaVersion !== F.SCHEMA_VERSION
                        || !Array.isArray(raw.entries) || F.cleanFavorites(raw).entries.length !== raw.entries.length)) {
                        throw new Error('Favorites are unavailable.');
                    }
                    if (!result.ok) throw new Error(result.error.message);
                    if (message.buddy) await assertFavoriteMembership(storage, [entry]);
                    patch[F.FAVORITES_KEY] = result.favorites;
                } catch { warning = 'Buddy change saved. Favorites could not be updated; check buddy status to retry.'; }
            }
            patch[BUDDY_INTENTS_KEY] = warning ? [...rest, { ...entry, status: 'confirmed', leaseUntil: 0 }] : rest;
            await storage.set(patch);
            return { ok: true, warning };
        } else throw new Error('Invalid buddy action.');
        return { ok: true };
    }).catch(error => ({ ok: false, error: { code: 'buddy', message: error.message || 'Buddy changes are unavailable. Try again.' } }));
    return { action };
};
