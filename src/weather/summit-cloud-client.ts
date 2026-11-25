// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SUMMIT_CLOUD_MODELS } from './summit-cloud-models.ts';
import type { SummitCloudModel, SummitCloudSubject } from './summit-cloud-models.ts';
import { cloudSamplePoints, cloudDistanceKm } from './summit-cloud-core.ts';
import type { CloudLevelInput } from './summit-cloud-core.ts';
import { createPeakModelUpdateClient } from './peak-weather-updates.ts';
import { requestDeadline } from '../net/request-deadline.ts';
import { readBoundedResponseText } from '../net/bounded-text.ts';
import type { BoundedReadableStream, BoundedResponseLike } from '../net/bounded-text.ts';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.ts';

const HOUR = 3600_000;
const fields = {
    temperature: ['temperature', '°C', -120, 70], relative_humidity: ['humidity', '%', 0, 100],
    geopotential_height: ['height', 'm', -1000, 20000], cloud_cover: ['cloud', '%', 0, 100],
    wind_speed: ['wind', 'm/s', 0, 200], wind_direction: ['direction', '°', 0, 360],
} as const;

type CloudFieldName = typeof fields[keyof typeof fields][0];

export interface SummitCloudError extends Error {
    code: string;
    retryAt?: number;
}

export interface SummitCloudDayWindow {
    start: number;
    end: number;
}

export interface SummitCloudSamplePoint {
    latitude: number;
    longitude: number;
    bearing: number | null;
}

export interface SummitCloudRequest {
    url: string;
    points: SummitCloudSamplePoint[];
    start: number;
    end: number;
    model: SummitCloudModel;
}

export interface SummitCloudLevel extends CloudLevelInput {
    pressure: number;
    temperature: number | null;
    humidity: number | null;
    height: number | null;
    cloud: number | null;
    wind: number | null;
    direction: number | null;
}

export interface SummitCloudSample {
    time: number;
    levels: SummitCloudLevel[];
}

export interface SummitCloudPoint {
    latitude: number;
    longitude: number;
    bearing: number | null;
    grid: { latitude: number; longitude: number; elevation: number };
    samples: SummitCloudSample[];
}

export interface SummitCloudProfile {
    model: SummitCloudModel;
    points: SummitCloudPoint[];
}

export interface SummitCloudMetadata {
    lastUpdate: number;
    updateIntervalSeconds: number;
}

export interface SummitCloudResult extends SummitCloudProfile {
    metadata: SummitCloudMetadata | null;
    loadedAt: number;
}

export interface SummitCloudResponseLike extends BoundedResponseLike {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    body?: BoundedReadableStream | null;
}

export type SummitCloudFetch = (url: string, init?: RequestInit) => Promise<SummitCloudResponseLike>;

export interface SummitCloudUpdateClient {
    clear(): void;
    request(model: string, options?: { signal?: AbortSignal }): Promise<{ data: SummitCloudMetadata | null }>;
}

export interface SummitCloudClientOptions {
    fetchFn?: SummitCloudFetch;
    now?: () => number;
    timeoutMs?: number;
    updateClient?: SummitCloudUpdateClient;
}

export interface SummitCloudRequestOptions {
    signal?: AbortSignal;
    refresh?: boolean;
}

export interface SummitCloudClient {
    clear(): void;
    request(
        subject: SummitCloudSubject | null | undefined,
        day: SummitCloudDayWindow | null | undefined,
        model: SummitCloudModel | null | undefined,
        options?: SummitCloudRequestOptions,
    ): Promise<SummitCloudResult>;
}

const fail = (message: string, code = 'unavailable'): SummitCloudError => Object.assign(new Error(message), { code });
const cancelled = () => new DOMException('Cancelled.', 'AbortError');
const isoHour = (time: number) => new Date(time).toISOString().slice(0, 16);

export function summitCloudRequest(
    subject: SummitCloudSubject | null | undefined,
    day: SummitCloudDayWindow | null | undefined,
    model: SummitCloudModel | null | undefined,
): SummitCloudRequest {
    if (!subject || !model || !SUMMIT_CLOUD_MODELS.includes(model) || !model.domain(subject)
        || !Number.isFinite(subject.latitude) || Math.abs(subject.latitude) > 90
        || !Number.isFinite(subject.longitude) || Math.abs(subject.longitude) > 180
        || typeof subject.elevation !== 'number' || !Number.isFinite(subject.elevation) || subject.elevation < -500 || subject.elevation > 9000
        || !day || !Number.isSafeInteger(day.start) || !Number.isSafeInteger(day.end) || day.end <= day.start || day.end - day.start > 26 * HOUR) throw fail('Invalid summit cloud request.', 'invalid');
    const points = cloudSamplePoints(subject, model.gridKm);
    const start = Math.ceil(day.start / HOUR) * HOUR, end = Math.ceil(day.end / HOUR) * HOUR;
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    const parameters = { latitude: points.map(point => point.latitude.toFixed(5)).join(','), longitude: points.map(point => point.longitude.toFixed(5)).join(','),
        elevation: points.map(() => 'nan').join(','), cell_selection: 'nearest', models: model.id,
        hourly: model.levels.flatMap(level => Object.keys(fields).map(field => `${field}_${level}hPa`)).join(','),
        start_hour: isoHour(start), end_hour: isoHour(end - HOUR), timezone: 'GMT', timeformat: 'unixtime', temperature_unit: 'celsius', wind_speed_unit: 'ms' };
    Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return { url: url.href, points, start, end, model };
}

export function readSummitCloudResponse(body: unknown, request: SummitCloudRequest): SummitCloudProfile {
    const invalid: () => never = () => { throw fail('The cloud service returned invalid data.', 'invalid-response'); };
    if (!Array.isArray(body) || body.length !== request.points.length) invalid();
    const points: SummitCloudPoint[] = body.map((raw: unknown, index) => {
        const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
        const gridRaw = { latitude: data?.latitude, longitude: data?.longitude, elevation: data?.elevation };
        if (!data || data.utc_offset_seconds !== 0
            || typeof gridRaw.latitude !== 'number' || !Number.isFinite(gridRaw.latitude)
            || typeof gridRaw.longitude !== 'number' || !Number.isFinite(gridRaw.longitude)
            || typeof gridRaw.elevation !== 'number' || !Number.isFinite(gridRaw.elevation)) invalid();
        const grid = { latitude: gridRaw.latitude, longitude: gridRaw.longitude, elevation: gridRaw.elevation };
        if (Math.abs(grid.latitude) > 90 || Math.abs(grid.longitude) > 180 || grid.elevation < -500 || grid.elevation > 9000
            || cloudDistanceKm(grid, request.points[index]!) > Math.max(20, request.model.gridKm * 2)) invalid();
        const hourly = data.hourly && typeof data.hourly === 'object' ? data.hourly as Record<string, unknown> : null;
        const hourlyUnits = data.hourly_units && typeof data.hourly_units === 'object' ? data.hourly_units as Record<string, unknown> : null;
        const times = hourly?.time;
        if (hourlyUnits?.time !== 'unixtime' || !Array.isArray(times) || !times.length || times.length > 26) invalid();
        const columns = new Map<string, (number | null)[]>();
        for (const pressure of request.model.levels) for (const [variable, [name, unit, low, high]] of Object.entries(fields)) {
            const key = `${variable}_${pressure}hPa`, column = hourly?.[key];
            // A missing native level or unsupported field remains a gap. It
            // must not turn an otherwise valid profile into zero cloud.
            columns.set(`${pressure}/${name}`, hourlyUnits?.[key] === unit && Array.isArray(column) && column.length === times.length
                ? column.map((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : null) : times.map(() => null));
        }
        const samples: SummitCloudSample[] = times.map((seconds: unknown, i) => {
            if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds)) invalid();
            const time = seconds * 1000;
            const prev = i ? times[i - 1] : undefined;
            if (seconds % 3600 || time < request.start || time >= request.end || (i && (typeof prev !== 'number' || seconds !== prev + 3600))) invalid();
            return { time, levels: request.model.levels.map(pressure => ({ pressure,
                ...Object.fromEntries(Object.values(fields).map(([name]) => [name, columns.get(`${pressure}/${name}`)?.[i] ?? null])) as Record<CloudFieldName, number | null> })) };
        });
        return { ...request.points[index]!, grid, samples };
    });
    return { model: request.model, points };
}

export function createSummitCloudClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000,
    updateClient = createPeakModelUpdateClient({ fetchFn: fetchFn as typeof globalThis.fetch, now }) }: SummitCloudClientOptions = {}): SummitCloudClient {
    const cache = new Map<string, SummitCloudResult>(); let retryAt = 0;
    return {
        clear() { cache.clear(); updateClient.clear(); },
        async request(subject, day, model, { signal, refresh = false } = {}) {
            if (signal?.aborted) throw cancelled();
            const request = summitCloudRequest(subject, day, model), cached = cache.get(request.url);
            if (!refresh && cached && now() - cached.loadedAt < 300000) return cached;
            if (retryAt > now()) throw Object.assign(fail('Cloud forecast requests are temporarily limited. Try again later.', 'rate-limit'), { retryAt });
            const deadline = requestDeadline.createRequestDeadline(timeoutMs);
            let rejectCancel: ((reason?: unknown) => void) | undefined;
            let response: SummitCloudResponseLike | undefined;
            const cancellation = new Promise<never>((_, reject) => { rejectCancel = reject; }); cancellation.catch(() => {});
            const cancel = () => { deadline.abort(); rejectCancel?.(cancelled()); };
            signal?.addEventListener('abort', cancel, { once: true });
            const run = <T>(promise: Promise<T>): Promise<T> => deadline.run(Promise.race([promise, cancellation]));
            try {
                response = await run(fetchFn(request.url, { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }));
                if (response.status === 429) {
                    const error = rateLimitError('Open-Meteo', response, now()); retryAt = error.retryAt || now() + 300000;
                    throw Object.assign(error, { retryAt });
                }
                if (!response.ok) throw fail('Cloud forecasts could not be loaded. Try Refresh.');
                if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw fail('The cloud service returned invalid data.', 'invalid-response');
                const text = await run(readBoundedResponseText(response, { maxBytes: 1024 * 1024, signal: deadline.signal, label: 'Cloud profiles' }));
                const result = readSummitCloudResponse(JSON.parse(text) as unknown, request);
                // Optional freshness must not discard an otherwise usable profile.
                // The predictor explicitly downgrades an unverified update.
                let metadata: { data: SummitCloudMetadata | null } = { data: null };
                try { metadata = await run(updateClient.request(model!.metadata, { signal: deadline.signal })); }
                catch { if (signal?.aborted) throw cancelled(); }
                if (signal?.aborted) throw cancelled();
                const value: SummitCloudResult = { ...result, metadata: metadata.data, loadedAt: now() };
                cache.delete(request.url); cache.set(request.url, value);
                while (cache.size > 6) {
                    const oldestKey = cache.keys().next().value;
                    if (oldestKey === undefined) break;
                    cache.delete(oldestKey);
                }
                return value;
            } finally {
                cancelResponseBody(response); deadline.clear(); signal?.removeEventListener('abort', cancel);
            }
        },
    };
}
