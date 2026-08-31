// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — serialized custom-favorites mutation boundary.
//
// Browser surfaces keep read-only storage subscriptions for live rendering,
// but every custom-list mutation is applied here in the single extension
// worker. Operation-style changes compose against the latest stored value;
// destructive replacements require the signature the user reviewed.

import { favoriteClimbers as F } from '../favorites/favorite-climbers.js';

const publicError = (code, message) => ({ code, message });

const invalid = (favorites, message = 'The favorites change was not valid.') => ({
    ok: false,
    error: publicError('invalid', message),
    favorites,
    signature: F.backupSignature(favorites),
});

const stale = favorites => ({
    ok: false,
    error: publicError(
        'stale',
        'Favorites changed in another tab. Review the updated list and try again.',
    ),
    favorites,
    signature: F.backupSignature(favorites),
});

const cleanCompleteFavorites = value => {
    const cleaned = F.cleanFavorites(value);
    return value
        && typeof value === 'object'
        && !Array.isArray(value)
        && value.schemaVersion === F.SCHEMA_VERSION
        && Array.isArray(value.entries)
        && value.entries.length <= F.LIMIT
        && cleaned.entries.length === value.entries.length
        ? cleaned
        : null;
};

const cleanAddedEntry = value => {
    if (!F.validEntry(value)) return null;
    return F.cleanFavorites({
        schemaVersion: F.SCHEMA_VERSION,
        entries: [value],
    }).entries[0] || null;
};

const cleanCid = value => {
    const cid = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(cid) && cid > 0 ? cid : null;
};

const cleanBuddyEntries = value => {
    if (!Array.isArray(value) || value.length > F.LIMIT) return null;
    const mirrored = F.mirrorBuddies(value, 0).entries;
    return mirrored.length === value.length
        ? mirrored.map(({ cid, name }) => ({ cid, name }))
        : null;
};

export const applyFavoritesMutation = (stored, mutation, now = Date.now()) => {
    const current = F.cleanFavorites(stored);
    if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
        return invalid(current);
    }

    let next = current;
    let details = { added: 0, removed: 0, skipped: 0 };
    switch (mutation.kind) {
    case 'add': {
        const entry = cleanAddedEntry(mutation.entry);
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
        const cid = cleanCid(mutation.cid);
        if (cid == null) return invalid(current);
        next = {
            schemaVersion: F.SCHEMA_VERSION,
            entries: current.entries.filter(entry => entry.cid !== cid),
        };
        details.removed = current.entries.length - next.entries.length;
        break;
    }
    case 'merge-buddies': {
        const entries = cleanBuddyEntries(mutation.entries);
        if (!entries) return invalid(current);
        next = F.mergeBuddies(current, entries, now);
        details.added = next.entries.length - current.entries.length;
        const missing = F.membershipChanges(current.entries, entries).added;
        details.skipped = missing - details.added;
        break;
    }
    case 'replace': {
        const replacement = cleanCompleteFavorites(mutation.favorites);
        if (!replacement || typeof mutation.expectedSignature !== 'string') {
            return invalid(current);
        }
        if (mutation.expectedSignature !== F.backupSignature(current)) return stale(current);
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

export const createFavoritesStore = ({ storage, now = Date.now } = {}) => {
    if (!storage?.get || !storage?.set) {
        throw new TypeError('Favorites storage must provide get() and set().');
    }
    let queue = Promise.resolve();

    const execute = async mutation => {
        const stored = await storage.get(F.FAVORITES_KEY);
        const result = applyFavoritesMutation(stored[F.FAVORITES_KEY], mutation, now());
        if (result.ok && result.changed) {
            await storage.set({ [F.FAVORITES_KEY]: result.favorites });
        }
        return result;
    };

    const mutate = mutation => {
        const operation = queue.then(() => execute(mutation), () => execute(mutation));
        queue = operation.catch(() => {});
        return operation.catch(() => ({
            ok: false,
            error: publicError('storage', 'Favorite climbers are unavailable. Try again.'),
        }));
    };

    return { mutate };
};

export const favoritesStore = {
    MESSAGE_TYPE: F.MUTATION_MESSAGE_TYPE,
    applyFavoritesMutation,
    createFavoritesStore,
};
