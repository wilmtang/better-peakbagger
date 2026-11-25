// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from '../favorites/favorite-climbers.ts';
import {
    BUDDY_INTENTS_KEY,
    readBuddyIntents,
    type BuddyAction,
    type BuddyIntent,
} from '../favorites/buddy-state.ts';
import { climberListLane, assertFavoriteMembership } from './climber-list-policy.ts';
import { applyFavoritesMutation } from './favorites-store.ts';
import { BUDDY_CACHE_EPOCH_KEY, newBuddyCacheEpoch } from '../favorites/buddy-cache.ts';

export interface BuddyStorageArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface BuddyStoreSettings {
    favoritesSource?: unknown;
    removeFavoriteWhenBuddyRemoved?: unknown;
}

export interface BuddyStoreOptions {
    storage: BuddyStorageArea;
    settings: () => Promise<BuddyStoreSettings>;
    now?: () => number;
    token?: () => string;
}

export interface BuddySender {
    tab?: { id?: number | null } | null;
}

export type BuddyActionResult =
    | { ok: true; token?: string; checkOnly?: boolean; warning?: string }
    | { ok: false; error: { code: string; message: string } };

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const isBuddyAction = (value: unknown): value is BuddyAction =>
    value === 'add' || value === 'remove';

export const createBuddyStore = ({
    storage,
    settings,
    now = Date.now,
    token = () => crypto.randomUUID(),
}: BuddyStoreOptions) => {
    const run = climberListLane(storage);
    const action = (message: unknown, sender?: BuddySender | null): Promise<BuddyActionResult> => run(async (): Promise<BuddyActionResult> => {
        const values = await storage.get([BUDDY_INTENTS_KEY, F.BUDDY_CACHE_KEY, F.FAVORITES_KEY]);
        const intents = readBuddyIntents(values[BUDDY_INTENTS_KEY]);
        const rawMessage = asRecord(message);
        if (!rawMessage) throw new Error('Invalid buddy action.');
        if (rawMessage.phase === 'begin') {
            const { cid, ownerCid, name, action: intent } = rawMessage;
            const tabId = sender?.tab?.id;
            if (typeof cid !== 'number' || !Number.isSafeInteger(cid) || cid <= 0
                || typeof ownerCid !== 'number' || !Number.isSafeInteger(ownerCid) || ownerCid <= 0
                || cid === ownerCid || !isBuddyAction(intent) || typeof name !== 'string'
                || !name.trim() || name.length > F.NAME_LIMIT
                || typeof tabId !== 'number' || !Number.isInteger(tabId)) {
                throw new Error('Invalid buddy change.');
            }
            const pending = intents.find(entry => entry.cid === cid);
            if (pending && pending.leaseUntil > now()) throw new Error('Buddy change is in progress in another tab. Check status shortly.');
            if (pending && pending.ownerCid !== ownerCid) throw new Error('Sign in to the original account to check the pending buddy change.');
            const recovered = pending && !(pending.status === 'confirmed' && pending.action !== intent && !rawMessage.checkOnly)
                ? pending
                : null;
            const recovering = Boolean(recovered);
            if (!recovering && intent === 'add' && !rawMessage.checkOnly) await assertFavoriteMembership(storage, [{ cid, name }]);
            if (!pending && intents.length >= 100) throw new Error('Check pending buddy changes before adding more.');
            const entry: BuddyIntent = {
                cid,
                ownerCid,
                name,
                action: recovered ? recovered.action : intent,
                token: token(),
                tabId,
                status: recovered ? recovered.status : 'prepared',
                leaseUntil: now() + 60000,
                checkOnly: recovering || !!rawMessage.checkOnly,
            };
            await storage.set({ [BUDDY_INTENTS_KEY]: [...intents.filter(item => item.cid !== cid), entry] });
            return { ok: true, token: entry.token, checkOnly: entry.checkOnly };
        }
        const entry = intents.find(item => item.token === rawMessage.token && item.tabId === sender?.tab?.id);
        if (!entry) throw new Error('This buddy change is obsolete. Check status again.');
        const rest = intents.filter(item => item !== entry);
        if (rawMessage.phase === 'dispatch') {
            if (entry.checkOnly || entry.status !== 'prepared' || entry.leaseUntil <= now()) throw new Error('Check status before trying another buddy change.');
            if (entry.action === 'add') await assertFavoriteMembership(storage, [entry]);
            await storage.set({ [BUDDY_INTENTS_KEY]: [...rest, { ...entry, status: 'dispatched' }] });
        } else if (rawMessage.phase === 'failed') {
            await storage.set({ [BUDDY_INTENTS_KEY]: entry.status !== 'prepared' || rawMessage.dispatched
                ? [...rest, { ...entry, status: entry.status === 'confirmed' ? 'confirmed' : 'dispatched', leaseUntil: 0 }] : rest });
        } else if (rawMessage.phase === 'complete') {
            if (typeof rawMessage.buddy !== 'boolean') throw new Error('Buddy status is unavailable.');
            const cache = F.cleanBuddyCache(values[F.BUDDY_CACHE_KEY]);
            const rawCacheValue = values[F.BUDDY_CACHE_KEY];
            const rawCache = asRecord(rawCacheValue);
            if (rawCacheValue != null && (!cache || !rawCache || !Array.isArray(rawCache.entries)
                || cache.entries.length !== rawCache.entries.length)) {
                throw new Error('Refresh your saved Buddy List, then check buddy status.');
            }
            const entries = cache?.ownerCid === entry.ownerCid ? cache.entries.filter(item => item.cid !== entry.cid) : [];
            if (rawMessage.buddy) entries.push({ cid: entry.cid, name: entry.name });
            const patch: Record<string, unknown> = {
                [BUDDY_CACHE_EPOCH_KEY]: newBuddyCacheEpoch(now()),
                [F.BUDDY_CACHE_KEY]: {
                    ownerCid: entry.ownerCid,
                    entries,
                    // A target profile proves only this target; it cannot refresh
                    // the age or completeness of the full Buddy report cache.
                    fetchedAt: cache?.ownerCid === entry.ownerCid ? cache.fetchedAt : 0,
                },
            };
            let warning = '';
            const config = await settings().catch(() => {
                warning = 'Buddy change saved. Favorites could not be updated; check buddy status to retry.';
                return null;
            });
            if (rawMessage.buddy === (entry.action === 'add') && config?.favoritesSource === 'custom'
                && (rawMessage.buddy || config.removeFavoriteWhenBuddyRemoved)) {
                const mutation = rawMessage.buddy
                    ? { kind: 'add', entry: { cid: entry.cid, name: entry.name, source: 'buddy', addedAt: now() } }
                    : { kind: 'remove', cid: entry.cid };
                const result = applyFavoritesMutation(values[F.FAVORITES_KEY], mutation, now());
                try {
                    const rawValue = values[F.FAVORITES_KEY];
                    const rawRecord = asRecord(rawValue);
                    if (rawValue !== undefined && (!rawRecord || rawRecord.schemaVersion !== F.SCHEMA_VERSION
                        || !Array.isArray(rawRecord.entries)
                        || F.cleanFavorites(rawValue).entries.length !== rawRecord.entries.length)) {
                        throw new Error('Favorites are unavailable.');
                    }
                    if (!result.ok) throw new Error(result.error.message);
                    if (rawMessage.buddy) await assertFavoriteMembership(storage, [entry]);
                    patch[F.FAVORITES_KEY] = result.favorites;
                } catch { warning = 'Buddy change saved. Favorites could not be updated; check buddy status to retry.'; }
            }
            patch[BUDDY_INTENTS_KEY] = warning ? [...rest, { ...entry, status: 'confirmed', leaseUntil: 0 }] : rest;
            await storage.set(patch);
            return { ok: true, warning };
        } else throw new Error('Invalid buddy action.');
        return { ok: true };
    }).catch((error: unknown) => {
        const errorMessage = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : '';
        return {
            ok: false,
            error: { code: 'buddy', message: errorMessage || 'Buddy changes are unavailable. Try again.' },
        };
    });
    return { action };
};

export type BuddyStore = ReturnType<typeof createBuddyStore>;
