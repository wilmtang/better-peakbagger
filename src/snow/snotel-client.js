// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.js';
import { retryTransient, temporaryHttpStatus } from '../net/retry-transient.js';
import { validateSnotelStations, validateSnotelData } from './snotel-data.js';

const BASE = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/';
export const SNOTEL_CATALOG_KEY = 'bpbSnotelCatalogV1';
const CATALOG_TTL = 7 * 86400_000, DATA_TTL = 30 * 60_000;
const aborted = () => Object.assign(new Error('Cancelled.'), { name: 'AbortError' });

export function createSnotelClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000, retryDelayMs = 350, storage } = {}) {
    let catalog = null, limited = null, catalogFlight = null;
    const cache = new Map();
    const request = async (path, params, signal, maxBytes) => {
        if (signal?.aborted) throw aborted();
        if (limited?.retryAt > now()) throw limited;
        const url = new URL(path, BASE);
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
        const deadline = requestDeadline.createRequestDeadline(timeoutMs);
        let rejectCancel;
        const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
        const cancel = () => { deadline.abort(); rejectCancel(aborted()); };
        signal?.addEventListener('abort', cancel, { once: true });
        const run = promise => deadline.run(Promise.race([promise, cancelled]));
        let response;
        try {
            response = await run(fetchFn(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
                cache: 'no-store', signal: deadline.signal }));
            if (response.status === 429) {
                limited = rateLimitError('NRCS', response, now());
                // Back off even if Retry-After is absent or hidden by CORS.
                limited.retryAt ??= now() + 5 * 60_000;
                throw limited;
            }
            if (!response.ok) throw Object.assign(new Error('NRCS is unavailable. Try again in a few minutes.'), { transient: temporaryHttpStatus(response.status) });
            const text = await run(readBoundedResponseText(response, { maxBytes, maxChars: maxBytes, signal: deadline.signal, label: 'NRCS response' }));
            return JSON.parse(text);
        } finally {
            cancelResponseBody(response);
            signal?.removeEventListener('abort', cancel); deadline.clear();
        }
    };
    const loadStations = async ({ signal } = {}) => {
        if (signal?.aborted) throw aborted();
        if (catalog && catalog.expires > now()) return catalog.stations;
        // Persist public station metadata only. No peak, route, query or observation
        // is included in this device-local, expiring catalog.
        const cacheDeadline = requestDeadline.createRequestDeadline(Math.min(timeoutMs, 1000));
        let rejectCache;
        const cacheCancelled = new Promise((_, reject) => { rejectCache = reject; });
        const cancelCache = () => { rejectCache(aborted()); };
        signal?.addEventListener('abort', cancelCache, { once: true });
        try {
            const stored = (await cacheDeadline.run(Promise.race([Promise.resolve(storage?.get(SNOTEL_CATALOG_KEY)), cacheCancelled])))?.[SNOTEL_CATALOG_KEY];
            if (signal?.aborted) throw aborted();
            if (stored?.version === 1 && Number.isFinite(stored.fetchedAt) && stored.fetchedAt <= now()
                && stored.fetchedAt + CATALOG_TTL > now()) {
                catalog = { stations: validateSnotelStations(stored.stations), expires: stored.fetchedAt + CATALOG_TTL };
                return catalog.stations;
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
    const stations = async ({ signal } = {}) => {
        if (signal?.aborted) throw aborted();
        if (catalog && catalog.expires > now()) return catalog.stations;
        let flight = catalogFlight;
        if (!flight || flight.controller.signal.aborted) {
            flight = { controller: new AbortController(), readers: 0, settled: false, promise: null };
            catalogFlight = flight;
            flight.promise = Promise.resolve().then(() => loadStations({ signal: flight.controller.signal })).finally(() => {
                flight.settled = true;
                if (catalogFlight === flight) catalogFlight = null;
            });
        }
        // Card and map own independent subscriptions. Only the last departure
        // cancels the shared disk/network flight, and abandoned flights can
        // never detach a newer one or populate its cache after cancellation.
        return new Promise((resolve, reject) => {
            let active = true;
            const finish = (settle, value) => {
                if (!active) return;
                active = false;
                signal?.removeEventListener('abort', cancel);
                if (--flight.readers === 0 && !flight.settled) {
                    if (catalogFlight === flight) catalogFlight = null;
                    flight.controller.abort();
                }
                settle(value);
            };
            const cancel = () => finish(reject, aborted());
            flight.readers++;
            signal?.addEventListener('abort', cancel, { once: true });
            flight.promise.then(value => finish(resolve, value), error => finish(reject, error));
            if (signal?.aborted) cancel();
        });
    };
    const observations = async (station, { signal, refresh = false } = {}) => {
        if (signal?.aborted) throw aborted();
        const saved = cache.get(station.id);
        if (!refresh && saved?.expires > now()) return saved.result;
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
        const result = { hourly, daily, loadedAt: now() };
        cache.delete(station.id); cache.set(station.id, { result, expires: now() + DATA_TTL });
        while (cache.size > 3) cache.delete(cache.keys().next().value);
        return result;
    };
    return { stations, observations, clear: () => {
        const flight = catalogFlight; catalogFlight = null;
        flight?.controller.abort();
        catalog = null; cache.clear();
    } };
}
