// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.ts';
import * as I from './ignored-climbers.ts';
import { BUDDY_INTENTS_KEY, readBuddyIntents, type BuddyIntent } from './buddy-state.ts';

export type ClimberFavoritesList = ReturnType<typeof F.cleanFavorites>;
export type ClimberBuddyCache = ReturnType<typeof F.cleanBuddyCache>;
export type ClimberIgnoredList = NonNullable<ReturnType<typeof I.readList>>;

export interface ClimberMembershipLoadedState {
    favorites: ClimberFavoritesList;
    buddies: ClimberBuddyCache;
    ignored: ClimberIgnoredList;
    buddyIntents: BuddyIntent[];
    blockedIds: Set<number>;
    pendingIds: Set<number>;
    error: string;
}

export type ClimberMembershipState =
    | ClimberMembershipLoadedState
    | (Partial<ClimberMembershipLoadedState> & { error: string });

export interface ClimberMembershipStorageApi {
    storage: {
        local: {
            get(keys: string[]): Promise<Record<string, unknown>>;
        };
        onChanged: {
            addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
            removeListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
        };
    };
}

export interface ClimberMembershipObserver {
    refresh(): Promise<void>;
    stop(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

// One coherent, read-only view for the profile controls. Subscribe first and
// discard superseded reads; an unavailable list must not permit a new add.
export const observeClimberMembership = (
    api: ClimberMembershipStorageApi,
    onState: (state: ClimberMembershipState) => void,
): ClimberMembershipObserver => {
    const keys = [F.FAVORITES_KEY, F.BUDDY_CACHE_KEY, I.IGNORED_KEY, I.SYNC_KEY, BUDDY_INTENTS_KEY];
    let generation = 0;
    let state: ClimberMembershipLoadedState | null = null;
    let stopped = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
        clearTimeout(expiryTimer); expiryTimer = undefined;
        const token = ++generation;
        try {
            const values = await api.storage.local.get(keys);
            if (stopped || token !== generation) return;
            const raw = values[F.FAVORITES_KEY];
            const favorites = F.cleanFavorites(raw);
            const rawBuddies = values[F.BUDDY_CACHE_KEY];
            const buddies = F.cleanBuddyCache(rawBuddies);
            const ignored = I.readList(values[I.IGNORED_KEY]);
            const syncRecord = isRecord(values[I.SYNC_KEY]) ? values[I.SYNC_KEY] : null;
            const pending = syncRecord?.pending;
            const reserved = pending ? I.validateEntries(isRecord(pending) ? pending.result : undefined) : [];
            if (!ignored || !reserved || (raw !== undefined && (!isRecord(raw) || raw.schemaVersion !== F.SCHEMA_VERSION
                || !Array.isArray(raw.entries) || favorites.entries.length !== raw.entries.length))
                || (rawBuddies != null && (!buddies || !isRecord(rawBuddies)
                    || !Array.isArray(rawBuddies.entries)
                    || buddies.entries.length !== rawBuddies.entries.length))) throw new Error();
            const nextState: ClimberMembershipLoadedState = {
                favorites,
                buddies,
                ignored,
                buddyIntents: readBuddyIntents(values[BUDDY_INTENTS_KEY]),
                blockedIds: new Set([...ignored.entries, ...reserved].map(entry => entry.cid)),
                pendingIds: new Set(reserved.map(entry => entry.cid)),
                error: '',
            };
            state = nextState;
            onState(nextState);
            // Expiry permits a status-only check, never an ignored addition.
            // Publish that transition even if no tab writes storage.
            const deadlines = nextState.buddyIntents.filter(entry => entry.leaseUntil > Date.now())
                .map(entry => entry.leaseUntil - Date.now());
            if (!stopped && token === generation && deadlines.length) {
                expiryTimer = setTimeout(() => { void refresh(); },
                    Math.min(2147483647, Math.max(1, Math.min(...deadlines) + 1)));
            }
        } catch {
            if (!stopped && token === generation) {
                onState(state
                    ? { ...state, error: "Couldn't load climber lists. Try again." }
                    : { error: "Couldn't load climber lists. Try again." });
            }
        }
    };
    const changed = (changes: Record<string, unknown>, area: string): void => {
        if (area === 'local' && keys.some(key => changes[key])) void refresh();
    };
    api.storage.onChanged.addListener(changed);
    void refresh();
    return {
        refresh,
        stop: () => {
            stopped = true;
            generation++;
            clearTimeout(expiryTimer);
            api.storage.onChanged.removeListener(changed);
        },
    };
};
