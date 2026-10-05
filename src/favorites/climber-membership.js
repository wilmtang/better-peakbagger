// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.js';
import * as I from './ignored-climbers.js';

// One coherent, read-only view for the profile controls. Subscribe first and
// discard superseded reads; an unavailable list must not permit a new add.
export const observeClimberMembership = (api, onState) => {
    const keys = [F.FAVORITES_KEY, F.BUDDY_CACHE_KEY, I.IGNORED_KEY, I.SYNC_KEY];
    let generation = 0, state = null, stopped = false;
    const refresh = async () => {
        const token = ++generation;
        try {
            const values = await api.storage.local.get(keys);
            if (stopped || token !== generation) return;
            const favorites = F.cleanFavorites(values[F.FAVORITES_KEY]);
            const raw = values[F.FAVORITES_KEY];
            const buddies = F.cleanBuddyCache(values[F.BUDDY_CACHE_KEY]);
            const ignored = I.readList(values[I.IGNORED_KEY]);
            const pending = values[I.SYNC_KEY]?.pending;
            const reserved = pending ? I.validateEntries(pending.result) : [];
            if (!ignored || !reserved || (raw !== undefined && (!raw || raw.schemaVersion !== F.SCHEMA_VERSION
                || !Array.isArray(raw.entries) || favorites.entries.length !== raw.entries.length))
                || (values[F.BUDDY_CACHE_KEY] != null && (!buddies
                    || !Array.isArray(values[F.BUDDY_CACHE_KEY].entries)
                    || buddies.entries.length !== values[F.BUDDY_CACHE_KEY].entries.length))) throw new Error();
            state = { favorites, buddies, ignored,
                blockedIds: new Set([...ignored.entries, ...reserved].map(entry => entry.cid)),
                pendingIds: new Set(reserved.map(entry => entry.cid)), error: '' };
            onState(state);
        } catch {
            if (!stopped && token === generation) onState({ ...state, error: "Couldn't load climber lists. Try again." });
        }
    };
    const changed = (changes, area) => {
        if (area === 'local' && keys.some(key => changes[key])) void refresh();
    };
    api.storage.onChanged.addListener(changed);
    void refresh();
    return { refresh, stop: () => { stopped = true; generation++; api.storage.onChanged.removeListener(changed); } };
};
