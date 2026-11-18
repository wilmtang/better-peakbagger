// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    favoriteClimbers as F,
    type BuddyCache,
    type FavoriteClimbersList,
} from './favorite-climbers.ts';
import { settingsSchema as Schema } from '../settings/settings-schema.ts';
import { ownerClimberId } from '../profile/profile-backup-core.ts';
import {
    fetchPeakbaggerDocument,
    type FetchPeakbaggerDocumentOptions,
    type PeakbaggerDocumentResult,
} from '../peakbagger/peakbagger-request.ts';
import {
    peakbaggerError,
    type PeakbaggerErrorLike,
    type PeakbaggerFailure,
} from '../peakbagger/peakbagger-error.ts';
import { beginBuddyCacheRead, publishBuddyCache, type BuddyCacheRuntimeApi } from './buddy-cache.ts';

export type FavoriteSourceMode = 'buddies' | 'custom';

export interface FavoriteSourceState {
    mode: FavoriteSourceMode | null;
    ids: Set<number>;
    available: boolean;
    loading: boolean;
    error: string;
    errorCode: string;
    retrying: boolean;
    accountRequired: boolean;
    stale: boolean;
}

export interface FavoriteSourceStorageChange {
    newValue?: unknown;
    oldValue?: unknown;
}

export interface FavoriteSourceExtensionApi extends BuddyCacheRuntimeApi {
    storage: {
        local: {
            get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
            set?(items: Record<string, unknown>): Promise<void>;
        };
        onChanged: {
            addListener(listener: (changes: Record<string, FavoriteSourceStorageChange>, areaName: string) => void): void;
            removeListener(listener: (changes: Record<string, FavoriteSourceStorageChange>, areaName: string) => void): void;
        };
    };
}

export interface FavoriteSourceSettingsLike {
    requireCurrent(): Promise<{ favoritesSource?: unknown }>;
    subscribe(cb: (settings: { favoritesSource?: unknown }) => void): () => void;
}

export type FavoriteSourceDocumentResult =
    | { kind: 'ok'; document: Document }
    | { kind: Exclude<PeakbaggerDocumentResult['kind'], 'ok'>; error: PeakbaggerErrorLike | PeakbaggerFailure };

export type FavoriteSourceFetchDocument = (
    url: string,
    options?: FetchPeakbaggerDocumentOptions,
) => Promise<FavoriteSourceDocumentResult>;

export interface CreateFavoriteSourceOptions {
    api: FavoriteSourceExtensionApi;
    settings: FavoriteSourceSettingsLike;
    doc: Document;
    onState: (state: FavoriteSourceState) => void;
    fetchDocument?: FavoriteSourceFetchDocument;
}

export interface FavoriteSourceController {
    ready: Promise<void>;
    refresh(options?: { force?: boolean; active?: boolean }): Promise<void>;
    retry(): Promise<void>;
    reconcile(): void;
    pause(): void;
    resume(): Promise<void>;
    stop(): void;
}

const failureCode = (failure: unknown): string =>
    failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string'
        ? failure.code : '';

const failureMessage = (failure: unknown): string =>
    failure instanceof Error ? failure.message
        : failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string'
            ? failure.message : '';

const toMode = (value: unknown): FavoriteSourceMode =>
    Schema.favoritesSource(value) === 'custom' ? 'custom' : 'buddies';

// One source policy for peak reports and full ascent lists. Empty is valid;
// unavailable is separate. Buddy caches are useful only for the current owner.
export const createFavoriteSource = ({ api, settings, doc, onState,
    fetchDocument = fetchPeakbaggerDocument }: CreateFavoriteSourceOptions): FavoriteSourceController => {
    let mode: FavoriteSourceMode | null = null;
    let favorites: FavoriteClimbersList | null = null;
    let cache: BuddyCache | null = null;
    let error = '';
    let loading = true;
    let errorCode = '';
    let retrying = false;
    let generation = 0;
    let requestGeneration = 0;
    let controller: AbortController | null = null;
    let needed = false;
    let stopped = false;
    let paused = false;
    const owner = (): number | null => ownerClimberId(doc);
    const validCache = (value: unknown): BuddyCache | null => {
        const clean = F.cleanBuddyCache(value);
        return clean && owner() != null && clean.ownerCid === owner() ? clean : null;
    };
    const emit = (): void => onState({ mode, ids: F.favoriteSet(mode, favorites, validCache(cache)),
        available: mode === 'custom' ? favorites !== null : validCache(cache) !== null,
        loading, error, errorCode, retrying,
        accountRequired: ['account-required', 'signed-out'].includes(errorCode),
        stale: mode === 'buddies' && !!validCache(cache) && !F.isFresh(cache) });
    const cancel = (): void => { requestGeneration++; controller?.abort(); controller = null; };
    const refresh = async ({ force = false, active = needed }: { force?: boolean; active?: boolean } = {}): Promise<void> => {
        needed = active;
        if (stopped || paused || mode !== 'buddies' || !needed || (F.isFresh(validCache(cache)) && !force)
            || controller || (error && !force)) return;
        const ownCid = owner();
        if (ownCid == null) {
            error = 'Your Peakbagger account could not be verified on this page.';
            errorCode = 'account-required'; loading = false; emit(); return;
        }
        const token = ++requestGeneration;
        const beforeRead = generation;
        controller = new AbortController(); loading = true;
        if (!retrying) { error = ''; errorCode = ''; }
        emit();
        try {
            const snapshot = await beginBuddyCacheRead(api);
            if (stopped || token !== requestGeneration) return;
            const result = await fetchDocument(F.buddyListUrl(ownCid, doc.location?.origin) ?? '',
                { kind: 'buddies', signal: controller.signal });
            if (stopped || token !== requestGeneration || mode !== 'buddies' || ownCid !== owner()) return;
            if (result.kind !== 'ok') {
                throw peakbaggerError.exception(result.error);
            }
            if (ownerClimberId(result.document) !== ownCid) {
                throw new Error('The Buddy List belongs to a different Peakbagger account.');
            }
            const next: BuddyCache = { ownerCid: ownCid, entries: F.parseBuddyDocument(result.document), fetchedAt: Date.now() };
            const beforePublish = generation;
            error = ''; errorCode = '';
            try { await publishBuddyCache(api, snapshot, next); }
            catch (failure: unknown) {
                if (failureCode(failure) !== 'storage') throw failure;
                if (beforeRead === generation && token === requestGeneration) cache = next;
                error = 'Your Buddy List loaded, but Better Peakbagger could not save it. Try again.';
                errorCode = 'storage';
                return;
            }
            // A storage notification may already carry an even newer result.
            if (beforePublish === generation && token === requestGeneration) cache = next;
        } catch (failure: unknown) {
            if (token === requestGeneration) {
                const message = failureMessage(failure);
                error = validCache(cache)
                    ? `Using your saved Buddy List (saved climbing buddies). ${message}` : message;
                errorCode = failureCode(failure) || 'unavailable';
            }
        } finally {
            if (token === requestGeneration) { controller = null; loading = false; emit(); }
        }
    };
    const acceptFavorites = (value: unknown): void => {
        const obj = value && typeof value === 'object' ? value as Record<string, unknown> : null;
        if (value !== undefined && (!obj || obj.schemaVersion !== 1 || !Array.isArray(obj.entries))) {
            error = "Couldn't load your favorites."; errorCode = 'storage'; return;
        }
        favorites = F.cleanFavorites(value);
    };
    const read = async ({ preserveError = false }: { preserveError?: boolean } = {}): Promise<void> => {
        const token = ++generation;
        try {
            const [config, stored] = await Promise.all([settings.requireCurrent(),
                api.storage.local.get([F.FAVORITES_KEY, F.BUDDY_CACHE_KEY])]);
            if (stopped || token !== generation) return;
            const nextMode = toMode(config.favoritesSource);
            const changedMode = mode !== nextMode;
            if (changedMode) cancel();
            mode = nextMode;
            if (!preserveError || changedMode || mode === 'custom') { error = ''; errorCode = ''; }
            acceptFavorites(stored[F.FAVORITES_KEY]);
            cache = F.cleanBuddyCache(stored[F.BUDDY_CACHE_KEY]); loading = false; emit(); void refresh();
        } catch {
            if (!stopped && token === generation) { loading = false; error = "Couldn't load climber lists."; errorCode = 'storage'; emit(); }
        }
    };
    const changed = (changes: Record<string, FavoriteSourceStorageChange>, area: string): void => {
        if (area !== 'local' || stopped) return;
        if (!changes[F.FAVORITES_KEY] && !changes[F.BUDDY_CACHE_KEY]) return;
        generation++;
        if (changes[F.FAVORITES_KEY]) acceptFavorites(changes[F.FAVORITES_KEY].newValue);
        if (changes[F.BUDDY_CACHE_KEY]) cache = F.cleanBuddyCache(changes[F.BUDDY_CACHE_KEY].newValue);
        emit();
        // A change during the initial read needs a new coherent snapshot.
        if (mode === null) void read();
    };
    api.storage.onChanged.addListener(changed);
    const unsubscribe = settings.subscribe(config => {
        const nextMode = toMode(config.favoritesSource);
        if (mode !== nextMode) { cancel(); mode = nextMode; error = ''; errorCode = ''; void read(); }
    });
    const retry = async (): Promise<void> => {
        if (stopped || retrying) return;
        retrying = true; emit();
        try { await read({ preserveError: true }); await refresh({ force: true }); }
        finally { retrying = false; emit(); }
    };
    const ready = read();
    return { ready, refresh, retry,
        reconcile: () => { emit(); void refresh(); },
        pause: () => { paused = true; cancel(); loading = false; },
        resume: () => { paused = false; return read(); },
        stop: () => { stopped = true; generation++; cancel(); unsubscribe(); api.storage.onChanged.removeListener(changed); } };
};
