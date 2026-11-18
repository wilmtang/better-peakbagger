// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { requestDeadline } from '../net/request-deadline.ts';
import { readBoundedResponseText } from '../net/bounded-text.ts';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.ts';

export interface AirQualityPoint {
    latitude: number;
    longitude: number;
}

export interface AirQualitySample {
    time: number;
    aqi: number | null;
    pm: number | null;
}

export interface AirQualityData {
    samples: AirQualitySample[];
    loadedAt: number;
    grid: AirQualityPoint;
}

export interface AirQualityRequestOptions {
    signal?: AbortSignal;
    refresh?: boolean;
}

export interface AirQualityClientOptions {
    fetchFn?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
}

export interface AirQualityClient {
    clear(): void;
    request(point: AirQualityPoint, options?: AirQualityRequestOptions): Promise<AirQualityData>;
}

const fail = (message: string): Error => new Error(message);
export function airQualityUrl(point: AirQualityPoint): string {
    if (!Number.isFinite(point?.latitude) || Math.abs(point.latitude) > 90
        || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) throw fail('Invalid air-quality location.');
    const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
    Object.entries({ latitude: point.latitude, longitude: point.longitude, hourly: 'us_aqi,pm2_5',
        forecast_days: 5, timezone: 'GMT', timeformat: 'unixtime' }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url.href;
}
export const airQualityCategory = (value: number | null): string => value === null ? 'Unavailable' : value <= 50 ? 'Good' : value <= 100 ? 'Moderate'
    : value <= 150 ? 'Unhealthy for sensitive groups' : value <= 200 ? 'Unhealthy' : value <= 300 ? 'Very unhealthy' : 'Hazardous';
export function readAirQuality(body: unknown, point: AirQualityPoint, now = Date.now()): AirQualityData {
    function invalid(): never { throw fail('The air-quality service returned invalid data.'); }
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : invalid();
    const hourly = record.hourly && typeof record.hourly === 'object' && !Array.isArray(record.hourly)
        ? record.hourly as Record<string, unknown> : null;
    const unitsRecord = record.hourly_units && typeof record.hourly_units === 'object' && !Array.isArray(record.hourly_units)
        ? record.hourly_units as Record<string, unknown> : null;
    const times = hourly?.time, aqi = hourly?.us_aqi, pm = hourly?.pm2_5;
    const latitude = record.latitude, longitude = record.longitude;
    if (record.error || record.utc_offset_seconds !== 0
        || typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
        || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
        || unitsRecord?.time !== 'unixtime' || unitsRecord.us_aqi !== 'USAQI' || unitsRecord.pm2_5 !== 'μg/m³'
        || !Array.isArray(times) || times.length < 1 || times.length > 120 || !Array.isArray(aqi) || !Array.isArray(pm)
        || aqi.length !== times.length || pm.length !== times.length) invalid();
    const rawTimes = times as unknown[];
    const rawAqi = aqi as unknown[];
    const rawPm = pm as unknown[];
    const gridLongitude = Math.abs(longitude - point.longitude);
    if (Math.hypot((latitude - point.latitude) * 111, Math.min(gridLongitude, 360 - gridLongitude) * 111 * Math.cos(point.latitude * Math.PI / 180)) > 200) invalid();
    const start = Math.floor(now / 86400000) * 86400000;
    const validMetric = (value: unknown): value is number | null =>
        value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000);
    const samples: AirQualitySample[] = rawTimes.map((time, index) => {
        const aqiValue = rawAqi[index], pmValue = rawPm[index];
        if (typeof time !== 'number' || !Number.isSafeInteger(time) || time % 3600 || time * 1000 < start || time * 1000 >= start + 5 * 86400000
            || (index && time !== (rawTimes[index - 1] as number) + 3600)
            || !validMetric(aqiValue) || !validMetric(pmValue)) invalid();
        return { time: time * 1000, aqi: aqiValue, pm: pmValue };
    });
    if (!samples.some(sample => sample.time + 3600000 > now && sample.aqi !== null)) throw fail('Air-quality forecasts are unavailable for this location.');
    return { samples, loadedAt: now, grid: { latitude, longitude } };
}
// One owner, memory only. Caller cancellation races nonconforming transports too.
export function createAirQualityClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000 }: AirQualityClientOptions = {}): AirQualityClient {
    const cache = new Map<string, AirQualityData>(); let retryAt = 0;
    return {
        clear: () => cache.clear(),
        async request(point: AirQualityPoint, { signal, refresh = false }: AirQualityRequestOptions = {}) {
            const url = airQualityUrl(point), cached = cache.get(url);
            if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
            if (!refresh && cached && now() - cached.loadedAt < 300000) return cached;
            if (retryAt > now()) throw Object.assign(fail('Air-quality requests are temporarily limited. Try again later.'), { retryAt });
            const deadline = requestDeadline.createRequestDeadline(timeoutMs);
            let rejectCancel!: (reason?: unknown) => void;
            let response: Response | undefined;
            const cancellation = new Promise<never>((_, reject) => { rejectCancel = reject; });
            cancellation.catch(() => {});
            const cancel = () => { deadline.abort(); rejectCancel(new DOMException('Cancelled.', 'AbortError')); };
            signal?.addEventListener('abort', cancel, { once: true });
            const run = <T>(promise: Promise<T>): Promise<T> => deadline.run(Promise.race([promise, cancellation]));
            try {
                response = await run(fetchFn(url, { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }));
                if (response.status === 429) {
                    const error = rateLimitError('Open-Meteo air quality', response, now());
                    retryAt = error.retryAt || now() + 300000; throw Object.assign(error, { retryAt });
                }
                if (!response.ok) throw fail('Air quality could not be loaded. Try again.');
                if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw fail('The air-quality service returned invalid data.');
                const body: unknown = JSON.parse(await run(readBoundedResponseText(response, { maxBytes: 65536, signal: deadline.signal, label: 'Air quality' })));
                const data = readAirQuality(body, point, now());
                if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
                cache.delete(url); cache.set(url, data);
                while (cache.size > 4) {
                    const oldest = cache.keys().next().value;
                    if (oldest !== undefined) cache.delete(oldest);
                }
                return data;
            } finally {
                cancelResponseBody(response); deadline.clear(); signal?.removeEventListener('abort', cancel);
            }
        },
    };
}
