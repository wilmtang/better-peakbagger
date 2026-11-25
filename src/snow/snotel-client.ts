// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requestDeadline } from '../net/request-deadline.ts';
import { readBoundedResponseText, type BoundedReadableStream, type BoundedResponseLike } from '../net/bounded-text.ts';
import { rateLimitError, cancelResponseBody, type RateLimitError, type RateLimitResponseLike } from '../net/rate-limit.ts';
import { retryTransient, temporaryHttpStatus } from '../net/retry-transient.ts';
import {
    validateSnotelStations,
    validateSnotelData,
    type SnotelSeriesMap,
    type SnotelStation,
} from './snotel-data.ts';

const BASE = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/';
export const SNOTEL_CATALOG_KEY = 'bpbSnotelCatalogV1';
const CATALOG_TTL = 7 * 86400_000, DATA_TTL = 30 * 60_000;
const aborted = () => Object.assign(new Error('Cancelled.'), { name: 'AbortError' as const });

export interface SnotelResponseLike extends BoundedResponseLike, RateLimitResponseLike {
    ok: boolean;
    status: number;
    headers?: { get?(name: string): string | null } | null;
    body?: BoundedReadableStream | null;
    text?(): Promise<string>;
}

export type SnotelFetch = (url: string, init?: RequestInit) => Promise<SnotelResponseLike>;

export interface SnotelStorage {
    get(keys: string): Promise<Record<string, unknown> | null | undefined> | Record<string, unknown> | null | undefined;
    set(items: Record<string, unknown>): unknown;
}

export interface SnotelClientOptions {
    fetchFn?: SnotelFetch;
    now?: () => number;
    timeoutMs?: number;
    retryDelayMs?: number;
    storage?: SnotelStorage | null;
}

export interface SnotelStationsOptions {
    signal?: AbortSignal;
}

export interface SnotelObservationsOptions {
    signal?: AbortSignal;
    refresh?: boolean;
}

export interface SnotelObservations {
    hourly: SnotelSeriesMap;
    daily: SnotelSeriesMap;
    loadedAt: number;
}

export interface SnotelClient {
    stations(options?: SnotelStationsOptions): Promise<SnotelStation[]>;
    observations(station: { id: string; offset: number }, options?: SnotelObservationsOptions): Promise<SnotelObservations>;
    clear(): void;
}

interface CatalogFlight {
    controller: AbortController;
    readers: number;
    settled: boolean;
    promise: Promise<SnotelStation[]>;
}

export function createSnotelClient({
    fetchFn = globalThis.fetch,
    now = Date.now,
    timeoutMs = 15000,
    retryDelayMs = 350,
    storage,
}: SnotelClientOptions = {}): SnotelClient {
    let catalog: { stations: SnotelStation[]; expires: number } | null = null;
    let limited: (RateLimitError & { retryAt: number }) | null = null;
    let catalogFlight: CatalogFlight | null = null;
    const cache = new Map<string, { result: SnotelObservations; expires: number }>();

    const request = async (
        path: string,
        params: Record<string, string>,
        signal: AbortSignal | undefined,
        maxBytes: number,
    ): Promise<unknown> => {
        if (signal?.aborted) throw aborted();
        if (limited && limited.retryAt > now()) throw limited;
        const url = new URL(path, BASE);
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
        const deadline = requestDeadline.createRequestDeadline(timeoutMs);
        let rejectCancel: ((reason?: unknown) => void) | undefined;
        const cancelled = new Promise<never>((_, reject) => { rejectCancel = reject; });
        const cancel = () => { deadline.abort(); rejectCancel?.(aborted()); };
        signal?.addEventListener('abort', cancel, { once: true });
        const run = <T>(promise: Promise<T>): Promise<T> => deadline.run(Promise.race([promise, cancelled]));
        let response: SnotelResponseLike | undefined;
        try {
            response = await run(fetchFn(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
                cache: 'no-store', signal: deadline.signal }));
            if (response.status === 429) {
                const next = rateLimitError('NRCS', response, now());
                // Back off even if Retry-After is absent or hidden by CORS.
                const retryAt = next.retryAt ?? now() + 5 * 60_000;
                const nextLimited = Object.assign(next, { retryAt });
                limited = limited && limited.retryAt > nextLimited.retryAt ? limited : nextLimited;
                throw limited;
            }
            if (!response.ok) throw Object.assign(new Error('NRCS is unavailable. Try again in a few minutes.'), { transient: temporaryHttpStatus(response.status) });
            const text = await run(readBoundedResponseText(response, { maxBytes, maxChars: maxBytes, signal: deadline.signal, label: 'NRCS response' }));
            return JSON.parse(text) as unknown;
        } finally {
            cancelResponseBody(response);
            signal?.removeEventListener('abort', cancel); deadline.clear();
        }
    };

    const loadStations = async ({ signal }: SnotelStationsOptions = {}): Promise<SnotelStation[]> => {
        if (signal?.aborted) throw aborted();
        if (catalog && catalog.expires > now()) return catalog.stations;
        // Persist public station metadata only. No peak, route, query or observation
        // is included in this device-local, expiring catalog.
        const cacheDeadline = requestDeadline.createRequestDeadline(Math.min(timeoutMs, 1000));
        let rejectCache: ((reason?: unknown) => void) | undefined;
        const cacheCancelled = new Promise<never>((_, reject) => { rejectCache = reject; });
        const cancelCache = () => { rejectCache?.(aborted()); };
        signal?.addEventListener('abort', cancelCache, { once: true });
        try {
            const storedBag = await cacheDeadline.run(Promise.race([Promise.resolve(storage?.get(SNOTEL_CATALOG_KEY)), cacheCancelled]));
            const rawStored = storedBag?.[SNOTEL_CATALOG_KEY];
            if (signal?.aborted) throw aborted();
            if (rawStored && typeof rawStored === 'object') {
                const stored = rawStored as Record<string, unknown>;
                if (stored.version === 1 && typeof stored.fetchedAt === 'number' && Number.isFinite(stored.fetchedAt)
                    && stored.fetchedAt <= now() && stored.fetchedAt + CATALOG_TTL > now()) {
                    catalog = { stations: validateSnotelStations(stored.stations), expires: stored.fetchedAt + CATALOG_TTL };
                    return catalog.stations;
                }
            }
        } catch (error) { if (signal?.aborted) throw error; /* Invalid/unavailable cache falls back to the official API. */ }
        finally { cacheDeadline.clear(); signal?.removeEventListener('abort', cancelCache); }
        const body = await retryTransient(() => request('stations', { stationTriplets: '*:*:SNTL', elements: 'SNWD,WTEQ', durations: 'DAILY', activeOnly: 'true' }, signal, 2_000_000),
            { signal, delayMs: retryDelayMs });
        const validated = validateSnotelStations(body);
        if (signal?.aborted) throw aborted();
        catalog = { stations: validated, expires: now() + CATALOG_TTL };
        try { void Promise.resolve(storage?.set({ [SNOTEL_CATALOG_KEY]: { version: 1, fetchedAt: now(), stations: body } })).catch(() => {}); } catch { /* Page-memory cache still works. */ }
        return validated;
    };

    const stations = async ({ signal }: SnotelStationsOptions = {}): Promise<SnotelStation[]> => {
        if (signal?.aborted) throw aborted();
        if (catalog && catalog.expires > now()) return catalog.stations;
        let flight = catalogFlight;
        if (!flight || flight.controller.signal.aborted) {
            const controller = new AbortController();
            const activeFlight: CatalogFlight = {
                controller,
                readers: 0,
                settled: false,
                promise: Promise.resolve().then(() => loadStations({ signal: controller.signal })).finally(() => {
                    activeFlight.settled = true;
                    if (catalogFlight === activeFlight) catalogFlight = null;
                }),
            };
            catalogFlight = activeFlight;
            flight = activeFlight;
        }
        const activeFlight = flight;
        // Card and map own independent subscriptions. Only the last departure
        // cancels the shared disk/network flight, and abandoned flights can
        // never detach a newer one or populate its cache after cancellation.
        return new Promise<SnotelStation[]>((resolve, reject) => {
            let active = true;
            const finish = (settle: () => void) => {
                if (!active) return;
                active = false;
                signal?.removeEventListener('abort', cancel);
                if (--activeFlight.readers === 0 && !activeFlight.settled) {
                    if (catalogFlight === activeFlight) catalogFlight = null;
                    activeFlight.controller.abort();
                }
                settle();
            };
            const cancel = () => finish(() => reject(aborted()));
            activeFlight.readers++;
            signal?.addEventListener('abort', cancel, { once: true });
            activeFlight.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
            if (signal?.aborted) cancel();
        });
    };

    const observations = async (
        station: { id: string; offset: number },
        { signal, refresh = false }: SnotelObservationsOptions = {},
    ): Promise<SnotelObservations> => {
        if (signal?.aborted) throw aborted();
        const saved = cache.get(station.id);
        if (!refresh && saved && saved.expires > now()) return saved.result;
        if (!/^\d{1,8}:[A-Z]{2}:SNTL$/.test(station.id || '')) throw new Error('Invalid snow station.');
        // Sequential requests keep provider load bounded and stop immediately on
        // a refusal; an unavailable hourly endpoint must remain a visible error.
        const hourlyBody = await request('data', { stationTriplets: station.id, elements: 'SNWD,WTEQ', duration: 'HOURLY',
            beginDate: '-48', endDate: '0', periodRef: 'END', returnFlags: 'true', returnSuspectData: 'false' }, signal, 100_000);
        const hourly = validateSnotelData(hourlyBody, station, 'HOURLY', now());
        const dailyBody = await request('data', { stationTriplets: station.id, elements: 'SNWD,WTEQ', duration: 'DAILY',
            beginDate: '-7', endDate: '0', periodRef: 'END', returnFlags: 'true', returnSuspectData: 'false' }, signal, 100_000);
        const daily = validateSnotelData(dailyBody, station, 'DAILY', now());
        if (signal?.aborted) throw aborted();
        const result: SnotelObservations = { hourly, daily, loadedAt: now() };
        cache.delete(station.id); cache.set(station.id, { result, expires: now() + DATA_TTL });
        while (cache.size > 3) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        return result;
    };

    return { stations, observations, clear: () => {
        const flight = catalogFlight; catalogFlight = null;
        flight?.controller.abort();
        catalog = null; cache.clear();
    } };
}
