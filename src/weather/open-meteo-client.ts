// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requestDeadline } from '../net/request-deadline.ts';
import { readBoundedResponseText } from '../net/bounded-text.ts';
import { WEATHER_MODELS } from './weather-models.ts';
import { PEAK_WEATHER_MODELS, type PeakWeatherModel } from './peak-weather-models.ts';
import { rateLimitError, cancelResponseBody, type RateLimitError } from '../net/rate-limit.ts';
import type { WeatherSample } from './weather-hourly-table.ts';

export type ArchiveWeatherModel = (typeof WEATHER_MODELS)[number];

export interface WeatherLocation {
    latitude: number;
    longitude: number;
    elevation?: number | null;
}

export interface WeatherDateWindow {
    startDate: string;
    endDate: string;
    partial?: boolean;
}

export interface WeatherGrid {
    latitude: number;
    longitude: number;
    elevation: number;
}

export interface WeatherResponse {
    gustTiming: 'preceding-hour' | 'instant';
    grid: WeatherGrid;
    samples: WeatherSample[];
}

export interface PeakWeatherResponse {
    sharedGrid: boolean;
    models: Record<string, WeatherResponse>;
}

export interface WeatherClientOptions {
    fetchFn?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
}

export interface WeatherClient<M, R> {
    request(summit: WeatherLocation, window: WeatherDateWindow, model: M, options?: { signal?: AbortSignal }): Promise<R>;
    clear(): void;
}

export type WeatherErrorCode = 'invalid' | 'unavailable' | 'invalid-response' | 'service' | 'timeout' | 'network';

export interface WeatherClientError extends Error {
    code: WeatherErrorCode;
}

interface FieldDefinition {
    name: string;
    unit: string;
    min: number;
    max: number;
    integer?: boolean;
    optional?: boolean;
}

interface RequestUrlModel {
    endpoint: string;
    id?: string | null;
    since?: string | null;
    until?: string | null;
    fields: readonly string[];
}

type ValidationModel = Pick<PeakWeatherModel, 'fields'> & { gustTiming?: string };

const fail = (code: WeatherErrorCode, message: string): WeatherClientError =>
    Object.assign(new Error(message), { code });
const fields: Record<string, FieldDefinition> = {
    temperature_2m: { name: 'temperature', unit: '°C', min: -120, max: 70 },
    precipitation: { name: 'precipitation', unit: 'mm', min: 0, max: 2000 },
    wind_speed_10m: { name: 'wind', unit: 'km/h', min: 0, max: 600 },
    wind_gusts_10m: { name: 'gust', unit: 'km/h', min: 0, max: 600 },
    weather_code: { name: 'code', unit: 'wmo code', min: 0, max: 100 },
};
const peakFields: Record<string, FieldDefinition> = {
    ...fields,
    apparent_temperature: { name: 'apparent', unit: '°C', min: -150, max: 100 },
    wind_direction_10m: { name: 'direction', unit: '°', min: 0, max: 360 },
    is_day: { name: 'isDay', unit: '', min: 0, max: 1, integer: true },
    cloud_cover: { name: 'cloud', unit: '%', min: 0, max: 100, optional: true },
    freezing_level_height: { name: 'freezing', unit: 'm', min: -1000, max: 20000, optional: true },
};
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export function weatherRequestUrl(summit: WeatherLocation, window: WeatherDateWindow, model: ArchiveWeatherModel): string {
    if (!WEATHER_MODELS.includes(model)) throw fail('invalid', 'Invalid weather model.');
    return requestUrl(summit, window, model, 2);
}

// Sixteen past and sixteen forecast civil days, plus UTC padding. The forecast
// window caps padding at the API horizon; do not widen historical ascent bounds.
const PEAK_MAX_UTC_DATES = 33;
const peakModels = (models: readonly PeakWeatherModel[]): readonly PeakWeatherModel[] => {
    if (!Array.isArray(models) || models.length < 1 || models.length > 2
        || new Set(models).size !== models.length || models.some(model => !PEAK_WEATHER_MODELS.includes(model))) throw fail('invalid', 'Invalid weather model selection.');
    return models;
};
export function peakWeatherRequestUrl(summit: WeatherLocation, window: WeatherDateWindow, models: readonly PeakWeatherModel[]): string {
    peakModels(models);
    if (models.some(model => !model.domain(summit))) throw fail('invalid', 'Invalid weather model coverage.');
    return requestUrl(summit, window, { endpoint: 'https://api.open-meteo.com/v1/forecast',
        id: models.map(model => model.id).join(','),
        since: models.map(model => model.since).filter((since): since is string => Boolean(since)).sort()[0],
        fields: [...new Set(models.flatMap(model => model.fields))] }, PEAK_MAX_UTC_DATES - 1);
}

function requestUrl(summit: WeatherLocation, window: WeatherDateWindow, model: RequestUrlModel, maxDays: number): string {
    if (!Number.isFinite(summit.latitude) || Math.abs(summit.latitude) > 90
        || !Number.isFinite(summit.longitude) || Math.abs(summit.longitude) > 180) throw fail('invalid', 'Invalid weather subject.');
    const start = Date.parse(`${window.startDate}T00:00:00Z`), end = Date.parse(`${window.endDate}T00:00:00Z`);
    if (![start, end].every(Number.isFinite) || iso(start) !== window.startDate || iso(end) !== window.endDate
        || end < start || end - start > maxDays * 86400_000) throw fail('invalid', 'Invalid weather date window.');
    // Adjacent UTC days may cross the archive's first/last day. Fetch the
    // covered portion and let the civil-day summary label missing hours.
    const startDate = model.since && window.startDate < model.since ? model.since : window.startDate;
    const endDate = model.until && window.endDate > model.until ? model.until : window.endDate;
    if (startDate > endDate) throw fail('unavailable', 'This model has no data for the ascent’s date or location.');
    const url = new URL(model.endpoint);
    const params: Record<string, string | number> = { latitude: summit.latitude, longitude: summit.longitude,
        start_date: startDate, end_date: endDate,
        hourly: model.fields.join(','), timezone: 'GMT', timeformat: 'unixtime',
        temperature_unit: 'celsius', precipitation_unit: 'mm', wind_speed_unit: 'kmh' };
    if (model.id) params.models = model.id;
    if (summit.elevation !== null && summit.elevation !== undefined) {
        if (!Number.isFinite(summit.elevation) || summit.elevation < -500 || summit.elevation > 9000) throw fail('invalid', 'Invalid summit elevation.');
        params.elevation = summit.elevation;
    }
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url.href;
}

export function validateWeatherResponse(
    body: unknown,
    summit: WeatherLocation,
    window: WeatherDateWindow,
    model: ArchiveWeatherModel,
): WeatherResponse {
    return validateResponse(body, summit, window, model, 72);
}
export function validatePeakWeatherResponse(
    body: unknown,
    summit: WeatherLocation,
    window: WeatherDateWindow,
    models: readonly PeakWeatherModel[],
): PeakWeatherResponse {
    peakModels(models);
    const multiple = models.length > 1;
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const bodyHourly = record?.hourly && typeof record.hourly === 'object' && !Array.isArray(record.hourly)
        ? record.hourly as Record<string, unknown> : null;
    const bodyUnits = record?.hourly_units && typeof record.hourly_units === 'object' && !Array.isArray(record.hourly_units)
        ? record.hourly_units as Record<string, unknown> : null;
    return { sharedGrid: multiple, models: Object.fromEntries(models.map(model => {
        const hourly: Record<string, unknown> = { time: bodyHourly?.time };
        const hourly_units: Record<string, unknown> = { time: bodyUnits?.time };
        for (const field of model.fields) {
            const key = multiple ? `${field}_${model.id}` : field;
            hourly[field] = bodyHourly?.[key]; hourly_units[field] = bodyUnits?.[key];
        }
        return [model.id, validateResponse({ ...record, hourly, hourly_units }, summit, window, model, PEAK_MAX_UTC_DATES * 24, peakFields)];
    })) };
}

function validateResponse(
    body: unknown,
    summit: WeatherLocation,
    window: WeatherDateWindow,
    model: ValidationModel,
    maxRows: number,
    definitions: Record<string, FieldDefinition> = fields,
): WeatherResponse {
    function invalid(): never { throw fail('invalid-response', 'The weather service returned an invalid response.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;
    const latitude = record.latitude, longitude = record.longitude, elevation = record.elevation;
    if (record.utc_offset_seconds !== 0
        || typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
        || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
        || typeof elevation !== 'number' || !Number.isFinite(elevation) || elevation < -500 || elevation > 9000) invalid();
    const validLat = latitude as number, validLon = longitude as number, validElev = elevation as number;
    // Validate grid displacement, accounting for the date line. Coarse global
    // grids can be tens of kilometres away; a different continent cannot pass.
    const lonDelta = Math.min(Math.abs(validLon - summit.longitude), 360 - Math.abs(validLon - summit.longitude));
    const distance = Math.hypot((validLat - summit.latitude) * 111,
        lonDelta * 111 * Math.cos(summit.latitude * Math.PI / 180));
    if (distance > 200 || (typeof summit.elevation === 'number' && Number.isFinite(summit.elevation) && Math.abs(validElev - summit.elevation) > 1)) invalid();
    const hourly = record.hourly && typeof record.hourly === 'object' && !Array.isArray(record.hourly)
        ? record.hourly as Record<string, unknown> : invalid();
    const unitsRecord = record.hourly_units && typeof record.hourly_units === 'object' && !Array.isArray(record.hourly_units)
        ? record.hourly_units as Record<string, unknown> : null;
    const rawTimes = hourly.time;
    if (!Array.isArray(rawTimes) || rawTimes.length < 1 || rawTimes.length > maxRows || unitsRecord?.time !== 'unixtime') invalid();
    const start = Date.parse(`${window.startDate}T00:00:00Z`), end = Date.parse(`${window.endDate}T00:00:00Z`) + 86400_000;
    const times: number[] = [];
    (rawTimes as unknown[]).forEach((time, index) => {
        if (typeof time !== 'number' || !Number.isInteger(time) || time % 3600 !== 0 || time * 1000 < start || time * 1000 >= end
            || (index && time <= times[index - 1])) invalid();
        times.push(time as number);
    });
    const columns: Record<string, (number | null)[]> = {};
    for (const [key, definition] of Object.entries(definitions)) {
        if (!model.fields.includes(key)) { columns[definition.name] = times.map(() => null); continue; }
        const rawValues = hourly[key];
        if (!Array.isArray(rawValues) || rawValues.length !== times.length || unitsRecord?.[key] !== definition.unit) {
            // An unavailable supplementary field must not discard usable core
            // weather. Never interpret a missing column or wrong unit as zero.
            if (!definition.optional) invalid();
            columns[definition.name] = times.map(() => null); continue;
        }
        // Model processing can return negative precipitation (seen in ARPEGE).
        // Floor finite amounts at zero; keep genuinely missing values and
        // malformed data subject to the normal validation below.
        let values: unknown[] = rawValues;
        if (key === 'precipitation') values = values.map(value => typeof value === 'number' && Number.isFinite(value) && value < 0 ? 0 : value);
        const validValue = (value: unknown): value is number | null => value === null
            || (typeof value === 'number' && Number.isFinite(value) && value >= definition.min && value <= definition.max
            && (!definition.integer || Number.isInteger(value)));
        if (definition.optional) {
            columns[definition.name] = values.map(value => validValue(value) ? value : null);
        } else {
            const checked: (number | null)[] = [];
            for (const value of values) {
                if (!validValue(value)) invalid();
                checked.push(value);
            }
            columns[definition.name] = checked;
        }
    }
    return {
        gustTiming: model.gustTiming === 'instant' ? 'instant' : 'preceding-hour',
        grid: { latitude: validLat, longitude: validLon, elevation: validElev },
        samples: times.map((time, index) => ({
            time: time * 1000,
            ...Object.fromEntries(Object.entries(columns).map(([key, values]) => [key, values[index]])),
        })) as WeatherSample[],
    };
}

// One client per page: bounded memory only, no persistent ascent history. A
// single page owner owns cancellation; a cancelled flight is never reused.
export function createWeatherClient(options: WeatherClientOptions = {}): WeatherClient<ArchiveWeatherModel, WeatherResponse> {
    return createClient(options, weatherRequestUrl, validateWeatherResponse);
}
export function createPeakWeatherClient(options: WeatherClientOptions = {}): WeatherClient<readonly PeakWeatherModel[], PeakWeatherResponse> {
    return createClient(options, peakWeatherRequestUrl, validatePeakWeatherResponse);
}
function createClient<M, R>(
    { fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000 }: WeatherClientOptions,
    buildUrl: (summit: WeatherLocation, window: WeatherDateWindow, model: M) => string,
    validate: (body: unknown, summit: WeatherLocation, window: WeatherDateWindow, model: M) => R,
): WeatherClient<M, R> {
    const cache = new Map<string, { data: R; expires: number }>();
    const flights = new Map<string, { signal: AbortSignal | undefined; promise: Promise<R> }>();
    let limited: RateLimitError | null = null;
    const request = (summit: WeatherLocation, window: WeatherDateWindow, model: M, { signal }: { signal?: AbortSignal } = {}) => {
        const url = buildUrl(summit, window, model);
        const key = `weather-v1:${url}`;
        if (signal?.aborted) return Promise.reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
        const cached = cache.get(key);
        if (cached && cached.expires > now()) return Promise.resolve(cached.data);
        if (limited?.retryAt && limited.retryAt > now()) return Promise.reject(limited);
        const existing = flights.get(key);
        if (existing && !existing.signal?.aborted) return existing.promise;
        const deadline = requestDeadline.createRequestDeadline(timeoutMs);
        let rejectCancel!: (reason?: unknown) => void;
        const cancellation = new Promise<never>((_, reject) => { rejectCancel = reject; });
        cancellation.catch(() => {});
        const cancel = () => { deadline.abort(); rejectCancel(Object.assign(new Error('Cancelled.'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', cancel, { once: true });
        const run = <T>(promise: Promise<T>): Promise<T> => deadline.run(Promise.race([promise, cancellation]));
        const flight: { signal: AbortSignal | undefined; promise: Promise<R> } = { signal, promise: null as unknown as Promise<R> };
        flight.promise = (async () => {
            let response: Response | undefined;
            try {
                response = await run(fetchFn(url, { credentials: 'omit', referrerPolicy: 'no-referrer',
                    redirect: 'error', cache: 'no-store', signal: deadline.signal }));
                if (response.status === 429) {
                    const next = rateLimitError('Open-Meteo', response, now());
                    next.retryAt ??= now() + 300000;
                    limited = (limited?.retryAt ?? 0) > next.retryAt ? limited : next;
                    throw limited;
                }
                if ([400, 404].includes(response.status)) throw fail('unavailable', Array.isArray(model)
                    ? 'This weather model selection is unavailable for this summit. Choose another model.' : 'This model has no data for the ascent’s date or location.');
                if (!response.ok) throw fail('service', 'The weather service is unavailable. Try again later.');
                if (!/application\/json/i.test(response.headers?.get('content-type') || '')) throw fail('invalid-response', 'The weather service returned an invalid response.');
                const text = await run(readBoundedResponseText(response, { maxBytes: 128 * 1024, signal: deadline.signal, label: 'Weather response' }));
                let body: unknown;
                try { body = JSON.parse(text); } catch { throw fail('invalid-response', 'The weather service returned an invalid response.'); }
                const data = validate(body, summit, window, model);
                if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
                cache.delete(key);
                cache.set(key, { data, expires: now() + (window.partial ? 5 * 60_000 : 6 * 3600_000) });
                while (cache.size > 8) {
                    const oldest = cache.keys().next().value;
                    if (oldest !== undefined) cache.delete(oldest);
                }
                return data;
            } catch (error: unknown) {
                const failure = error as { name?: unknown; code?: unknown } | null | undefined;
                if (failure?.name === 'AbortError' || failure?.code) throw error;
                if (requestDeadline.isTimeout(error)) throw fail('timeout', 'Weather took too long to load. Try again.');
                throw fail('network', 'Weather could not be loaded. Check your connection and try again.');
            } finally {
                cancelResponseBody(response);
                deadline.clear(); signal?.removeEventListener('abort', cancel);
                if (flights.get(key) === flight) flights.delete(key);
            }
        })();
        flights.set(key, flight);
        return flight.promise;
    };
    return { request, clear: () => cache.clear() };
}
