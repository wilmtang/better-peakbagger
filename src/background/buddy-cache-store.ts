// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from '../favorites/favorite-climbers.ts';
import {
    BUDDY_CACHE_EPOCH_KEY,
    newBuddyCacheEpoch,
    type BuddyCacheEpoch,
    type BuddyCacheSnapshot,
} from '../favorites/buddy-cache.ts';
import { climberListLane } from './climber-list-policy.ts';
import { storageValue } from '../storage/storage-value.ts';

export interface BuddyCacheStorageArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface BuddyCacheStoreOptions {
    storage: BuddyCacheStorageArea;
    now?: () => number;
}

export type BuddyCacheActionResult =
    | { ok: true; snapshot: BuddyCacheSnapshot }
    | { ok: true; written: boolean }
    | { ok: false; error: { code: string; message: string } };

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const isBuddyCacheEpoch = (value: unknown): value is BuddyCacheEpoch => {
    const record = asRecord(value);
    return !!record
        && typeof record.version === 'string'
        && record.version.length > 0
        && record.version.length <= 100
        && typeof record.updatedAt === 'number'
        && Number.isFinite(record.updatedAt)
        && record.updatedAt >= 0;
};

export const createBuddyCacheStore = ({ storage, now = Date.now }: BuddyCacheStoreOptions) => {
    const run = climberListLane(storage);
    const action = (message: unknown): Promise<BuddyCacheActionResult> => run(async (): Promise<BuddyCacheActionResult> => {
        const values = await storage.get([BUDDY_CACHE_EPOCH_KEY, F.BUDDY_CACHE_KEY]);
        const rawEpoch = values[BUDDY_CACHE_EPOCH_KEY];
        if (rawEpoch !== undefined && !isBuddyCacheEpoch(rawEpoch)) {
            throw new Error('Your saved Buddy List state is unavailable. Try again.');
        }
        const epoch = rawEpoch ?? null;
        const rawMessage = asRecord(message);
        if (!rawMessage) throw new Error('Invalid Buddy List refresh.');
        const validObservation = (value: unknown): value is number | null =>
            value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now());
        if (rawMessage.phase === 'begin') {
            if (!validObservation(rawMessage.observedAt)) throw new Error('Invalid Buddy List refresh.');
            return { ok: true, snapshot: { version: epoch?.version ?? null, observedAt: rawMessage.observedAt } };
        }
        if (rawMessage.phase !== 'publish') throw new Error('Invalid Buddy List refresh.');
        const snapshot = asRecord(rawMessage.snapshot);
        if (!snapshot || !(snapshot.version === null || (typeof snapshot.version === 'string' && snapshot.version.length <= 100))
            || !validObservation(snapshot.observedAt)) throw new Error('Invalid Buddy List refresh.');
        const rawCache = asRecord(rawMessage.cache);
        const cache = F.cleanBuddyCache(rawMessage.cache);
        if (!cache || !rawCache || !Array.isArray(rawCache.entries) || cache.entries.length !== rawCache.entries.length) {
            throw new Error('The refreshed Buddy List is invalid.');
        }
        // Options may receive the exact cache already published by its helper
        // tab. Acknowledge that result without writing or advancing its epoch.
        if (storageValue.same(values[F.BUDDY_CACHE_KEY], cache)) return { ok: true, written: true };
        if (snapshot.version !== (epoch?.version ?? null)
            || (snapshot.observedAt !== null && epoch && snapshot.observedAt <= epoch.updatedAt)) {
            return { ok: true, written: false };
        }
        await storage.set({ [F.BUDDY_CACHE_KEY]: cache, [BUDDY_CACHE_EPOCH_KEY]: newBuddyCacheEpoch(now()) });
        return { ok: true, written: true };
    }).catch((error: unknown) => {
        const errorMessage = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : '';
        return {
            ok: false,
            error: { code: 'buddy-cache', message: errorMessage || 'Your Buddy List could not be saved. Try again.' },
        };
    });
    return { action };
};

export type BuddyCacheStore = ReturnType<typeof createBuddyCacheStore>;
