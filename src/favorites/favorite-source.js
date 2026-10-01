// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.js';
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { ownerClimberId } from '../profile/profile-backup-core.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';

// One source policy for peak reports and full ascent lists. Empty is valid;
// unavailable is separate. Buddy caches are useful only for the current owner.
export const createFavoriteSource = ({ api, settings, doc, onState,
    fetchDocument = fetchPeakbaggerDocument } = {}) => {
    let mode = null, favorites = null, cache = null, error = '', loading = true;
    let generation = 0, requestGeneration = 0, controller = null, needed = false, stopped = false, paused = false;
    const owner = () => ownerClimberId(doc);
    const validCache = value => {
        const clean = F.cleanBuddyCache(value);
        return clean && owner() != null && clean.ownerCid === owner() ? clean : null;
    };
    const emit = () => onState({ mode, ids: F.favoriteSet(mode, favorites, validCache(cache)),
        available: mode === 'custom' ? favorites !== null : validCache(cache) !== null,
        loading, error, stale: mode === 'buddies' && !!validCache(cache) && !F.isFresh(cache) });
    const cancel = () => { requestGeneration++; controller?.abort(); controller = null; };
    const refresh = async ({ force = false, active = needed } = {}) => {
        needed = active;
        if (stopped || paused || mode !== 'buddies' || !needed || (F.isFresh(validCache(cache)) && !force)
            || controller || (error && !force)) return;
        const ownCid = owner();
        if (ownCid == null) { error = 'Sign in to Peakbagger to load your climbing buddies.'; loading = false; emit(); return; }
        const token = ++requestGeneration;
        controller = new AbortController(); loading = true; error = ''; emit();
        try {
            const result = await fetchDocument(F.buddyListUrl(ownCid, doc.location?.origin),
                { kind: 'buddies', signal: controller.signal });
            if (stopped || token !== requestGeneration || mode !== 'buddies' || ownCid !== owner()) return;
            if (result.kind !== 'ok' || ownerClimberId(result.document) !== ownCid) {
                throw new Error("Couldn't load your climbing buddies.");
            }
            const next = { ownerCid: ownCid, entries: F.parseBuddyDocument(result.document), fetchedAt: Date.now() };
            cache = next;
            await api.storage.local.set({ [F.BUDDY_CACHE_KEY]: next });
        } catch {
            if (token === requestGeneration) error = cache
                ? "Using your saved climbing buddies. Couldn't refresh them." : "Couldn't load your climbing buddies.";
        } finally {
            if (token === requestGeneration) { controller = null; loading = false; emit(); }
        }
    };
    const acceptFavorites = value => {
        if (value !== undefined && (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries))) {
            error = "Couldn't load your favorites."; return;
        }
        favorites = F.cleanFavorites(value);
    };
    const read = async () => {
        const token = ++generation;
        try {
            const [config, stored] = await Promise.all([settings.requireCurrent(),
                api.storage.local.get([F.FAVORITES_KEY, F.BUDDY_CACHE_KEY])]);
            if (stopped || token !== generation) return;
            const nextMode = Schema.favoritesSource(config.favoritesSource);
            if (mode !== nextMode) cancel();
            mode = nextMode; error = ''; acceptFavorites(stored[F.FAVORITES_KEY]);
            cache = validCache(stored[F.BUDDY_CACHE_KEY]); loading = false; emit(); void refresh();
        } catch {
            if (!stopped && token === generation) { loading = false; error = "Couldn't load climber lists."; emit(); }
        }
    };
    const changed = (changes, area) => {
        if (area !== 'local' || stopped) return;
        if (!changes[F.FAVORITES_KEY] && !changes[F.BUDDY_CACHE_KEY]) return;
        generation++;
        if (changes[F.FAVORITES_KEY]) acceptFavorites(changes[F.FAVORITES_KEY].newValue);
        if (changes[F.BUDDY_CACHE_KEY]) cache = validCache(changes[F.BUDDY_CACHE_KEY].newValue);
        emit();
        // A change during the initial read needs a new coherent snapshot.
        if (mode === null) void read();
    };
    api.storage.onChanged.addListener(changed);
    const unsubscribe = settings.subscribe(config => {
        const nextMode = Schema.favoritesSource(config.favoritesSource);
        if (mode !== nextMode) { cancel(); mode = nextMode; error = ''; void read(); }
    });
    const ready = read();
    return { ready, refresh, retry: () => read().then(() => refresh({ force: true })),
        pause: () => { paused = true; cancel(); loading = false; },
        resume: () => { paused = false; return read(); },
        stop: () => { stopped = true; generation++; cancel(); unsubscribe(); api.storage.onChanged.removeListener(changed); } };
};
