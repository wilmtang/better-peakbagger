// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — serialized custom-favorites mutation boundary.
//
// Browser surfaces keep read-only storage subscriptions for live rendering,
// but every custom-list mutation is applied here in the single extension
// worker. Operation-style changes compose against the latest stored value;
// destructive replacements require the signature the user reviewed.

import {
    favoriteClimbers as F,
    type BuddyEntry,
    type FavoriteClimberEntry,
    type FavoriteClimbersList,
} from '../favorites/favorite-climbers.ts';
import { climberListLane, assertFavoriteMembership } from './climber-list-policy.ts';

export interface FavoritesStoreError {
    code: string;
    message: string;
}

export interface FavoritesMutationDetails {
    added: number;
    removed: number;
    skipped: number;
}

export type FavoritesMutation =
    | { kind: 'add'; entry: FavoriteClimberEntry }
    | { kind: 'remove'; cid: number | string }
    | { kind: 'merge-buddies'; entries: BuddyEntry[] }
    | { kind: 'replace'; favorites: FavoriteClimbersList; expectedSignature: string };

export type FavoritesMutationResult =
    | {
        ok: true;
        changed: boolean;
        favorites: FavoriteClimbersList;
        signature: string;
        details: FavoritesMutationDetails;
    }
    | {
        ok: false;
        error: FavoritesStoreError;
        favorites?: FavoriteClimbersList;
        signature?: string;
    };

export interface FavoritesStorageArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface FavoritesStoreOptions {
    storage?: FavoritesStorageArea;
    now?: () => number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const publicError = (code: string, message: string): FavoritesStoreError => ({ code, message });

const invalid = (
    favorites: FavoriteClimbersList,
    message = 'The favorites change was not valid.',
): FavoritesMutationResult => ({
    ok: false,
    error: publicError('invalid', message),
    favorites,
    signature: F.backupSignature(favorites),
});

const stale = (favorites: FavoriteClimbersList): FavoritesMutationResult => ({
    ok: false,
    error: publicError(
        'stale',
        'Favorites changed in another tab. Review the updated list and try again.',
    ),
    favorites,
    signature: F.backupSignature(favorites),
});

const cleanCompleteFavorites = (value: unknown): FavoriteClimbersList | null => {
    const cleaned = F.cleanFavorites(value);
    const item = asRecord(value);
    return item
        && item.schemaVersion === F.SCHEMA_VERSION
        && Array.isArray(item.entries)
        && item.entries.length <= F.LIMIT
        && cleaned.entries.length === item.entries.length
        ? cleaned
        : null;
};

const cleanAddedEntry = (value: unknown): FavoriteClimberEntry | null => {
    if (!F.validEntry(value)) return null;
    return F.cleanFavorites({
        schemaVersion: F.SCHEMA_VERSION,
        entries: [value],
    }).entries[0] || null;
};

const cleanCid = (value: unknown): number | null => {
    const cid = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return typeof cid === 'number' && Number.isSafeInteger(cid) && cid > 0 ? cid : null;
};

const cleanBuddyEntries = (value: unknown): BuddyEntry[] | null => {
    if (!Array.isArray(value) || value.length > F.LIMIT) return null;
    const mirrored = F.mirrorBuddies(value, 0).entries;
    return mirrored.length === value.length
        ? mirrored.map(({ cid, name }) => ({ cid, name }))
        : null;
};

export const applyFavoritesMutation = (
    stored: unknown,
    mutation: unknown,
    now = Date.now(),
): FavoritesMutationResult => {
    // Only an absent key means an empty list. Normalizing an unreadable saved
    // value would turn the next ordinary edit into a destructive replacement.
    const current = stored === undefined ? F.cleanFavorites(stored) : cleanCompleteFavorites(stored);
    if (!current) return {
        ok: false,
        error: publicError('storage', 'Favorite climbers are unavailable. Your saved list was kept.'),
    };
    const rawMutation = asRecord(mutation);
    if (!rawMutation) {
        return invalid(current);
    }

    let next = current;
    let details: FavoritesMutationDetails = { added: 0, removed: 0, skipped: 0 };
    switch (rawMutation.kind) {
    case 'add': {
        const entry = cleanAddedEntry(rawMutation.entry);
        if (!entry) return invalid(current);
        if (current.entries.some(candidate => candidate.cid === entry.cid)) break;
        if (current.entries.length >= F.LIMIT) {
            return {
                ok: false,
                error: publicError(
                    'limit',
                    `Favorites can hold up to ${F.LIMIT.toLocaleString('en-US')} climbers.`,
                ),
                favorites: current,
                signature: F.backupSignature(current),
            };
        }
        next = {
            schemaVersion: F.SCHEMA_VERSION,
            entries: [entry, ...current.entries],
        };
        details.added = 1;
        break;
    }
    case 'remove': {
        const cid = cleanCid(rawMutation.cid);
        if (cid == null) return invalid(current);
        next = {
            schemaVersion: F.SCHEMA_VERSION,
            entries: current.entries.filter(entry => entry.cid !== cid),
        };
        details.removed = current.entries.length - next.entries.length;
        break;
    }
    case 'merge-buddies': {
        const entries = cleanBuddyEntries(rawMutation.entries);
        if (!entries) return invalid(current);
        next = F.mergeBuddies(current, entries, now);
        details.added = next.entries.length - current.entries.length;
        const missing = F.membershipChanges(current.entries, entries).added;
        details.skipped = missing - details.added;
        break;
    }
    case 'replace': {
        const replacement = cleanCompleteFavorites(rawMutation.favorites);
        if (!replacement || typeof rawMutation.expectedSignature !== 'string') {
            return invalid(current);
        }
        if (rawMutation.expectedSignature !== F.backupSignature(current)) return stale(current);
        next = replacement;
        details = { ...details, ...F.membershipChanges(current.entries, next.entries) };
        break;
    }
    default:
        return invalid(current);
    }

    const signature = F.backupSignature(next);
    return {
        ok: true,
        changed: signature !== F.backupSignature(current),
        favorites: next,
        signature,
        details,
    };
};

export const createFavoritesStore = ({ storage, now = Date.now }: FavoritesStoreOptions = {}) => {
    if (!storage?.get || !storage?.set) {
        throw new TypeError('Favorites storage must provide get() and set().');
    }
    const run = climberListLane(storage);

    const execute = async (mutation: unknown): Promise<FavoritesMutationResult> => {
        const stored = await storage.get(F.FAVORITES_KEY);
        const result = applyFavoritesMutation(stored[F.FAVORITES_KEY], mutation, now());
        if (result.ok) {
            const rawMutation = asRecord(mutation);
            const kind = rawMutation?.kind;
            if (kind === 'add' || kind === 'merge-buddies' || kind === 'replace') {
                const currentIds = new Set(F.cleanFavorites(stored[F.FAVORITES_KEY]).entries.map(entry => entry.cid));
                const added = kind === 'add' ? cleanAddedEntry(rawMutation?.entry) : null;
                const candidates = added
                    ? [added]
                    : kind === 'replace'
                        ? result.favorites.entries
                        : result.favorites.entries.filter(entry => !currentIds.has(entry.cid));
                await assertFavoriteMembership(storage, candidates);
            }
        }
        if (result.ok && result.changed) {
            await storage.set({ [F.FAVORITES_KEY]: result.favorites });
        }
        return result;
    };

    const mutate = (mutation: unknown): Promise<FavoritesMutationResult> => {
        return run(() => execute(mutation)).catch((error: unknown) => {
            const details = error && typeof error === 'object'
                ? error as { code?: unknown; message?: unknown }
                : null;
            const code = typeof details?.code === 'string' && details.code ? details.code : 'storage';
            const message = code === 'list-conflict' && typeof details?.message === 'string'
                ? details.message
                : 'Favorite climbers are unavailable. Try again.';
            return {
                ok: false,
                error: publicError(code, message),
            };
        });
    };

    return { mutate };
};

export type FavoritesStore = ReturnType<typeof createFavoritesStore>;

export const favoritesStore = {
    MESSAGE_TYPE: F.MUTATION_MESSAGE_TYPE,
    createFavoritesStore,
};
