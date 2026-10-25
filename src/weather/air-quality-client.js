// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.js';

const fail = message => new Error(message);
export function airQualityUrl(point) {
    if (!Number.isFinite(point?.latitude) || Math.abs(point.latitude) > 90
        || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) throw fail('Invalid air-quality location.');
    const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
    Object.entries({ latitude: point.latitude, longitude: point.longitude, hourly: 'us_aqi,pm2_5',
        forecast_days: 5, timezone: 'GMT', timeformat: 'unixtime' }).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.href;
}
export const airQualityCategory = value => value === null ? 'Unavailable' : value <= 50 ? 'Good' : value <= 100 ? 'Moderate'
    : value <= 150 ? 'Unhealthy for sensitive groups' : value <= 200 ? 'Unhealthy' : value <= 300 ? 'Very unhealthy' : 'Hazardous';
export function readAirQuality(body, point, now = Date.now()) {
    const invalid = () => { throw fail('The air-quality service returned invalid data.'); };
    const times = body?.hourly?.time, aqi = body?.hourly?.us_aqi, pm = body?.hourly?.pm2_5;
    if (body?.error || body?.utc_offset_seconds !== 0 || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90
        || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180
        || body.hourly_units?.time !== 'unixtime' || body.hourly_units.us_aqi !== 'USAQI' || body.hourly_units.pm2_5 !== 'μg/m³'
        || !Array.isArray(times) || times.length < 1 || times.length > 120 || !Array.isArray(aqi) || !Array.isArray(pm)
        || aqi.length !== times.length || pm.length !== times.length) invalid();
    const longitude = Math.abs(body.longitude - point.longitude);
    if (Math.hypot((body.latitude - point.latitude) * 111, Math.min(longitude, 360 - longitude) * 111 * Math.cos(point.latitude * Math.PI / 180)) > 200) invalid();
    const start = Math.floor(now / 86400000) * 86400000;
    const samples = times.map((time, index) => {
        if (!Number.isSafeInteger(time) || time % 3600 || time * 1000 < start || time * 1000 >= start + 5 * 86400000
            || index && time !== times[index - 1] + 3600
            || [aqi[index], pm[index]].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 10000))) invalid();
        return { time: time * 1000, aqi: aqi[index], pm: pm[index] };
    });
    if (!samples.some(sample => sample.time + 3600000 > now && sample.aqi !== null)) throw fail('Air-quality forecasts are unavailable for this location.');
    return { samples, loadedAt: now, grid: { latitude: body.latitude, longitude: body.longitude } };
}
// One owner, memory only. Caller cancellation races nonconforming transports too.
export function createAirQualityClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
    const cache = new Map(); let retryAt = 0;
    return {
        clear: () => cache.clear(),
        async request(point, { signal, refresh = false } = {}) {
            const url = airQualityUrl(point), cached = cache.get(url);
            if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
            if (!refresh && cached && now() - cached.loadedAt < 300000) return cached;
            if (retryAt > now()) throw Object.assign(fail('Air-quality requests are temporarily limited. Try again later.'), { retryAt });
            const deadline = requestDeadline.createRequestDeadline(timeoutMs);
            let rejectCancel, response;
            const cancellation = new Promise((_, reject) => { rejectCancel = reject; });
            cancellation.catch(() => {});
            const cancel = () => { deadline.abort(); rejectCancel(new DOMException('Cancelled.', 'AbortError')); };
            signal?.addEventListener('abort', cancel, { once: true });
            const run = promise => deadline.run(Promise.race([promise, cancellation]));
            try {
                response = await run(fetchFn(url, { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }));
                if (response.status === 429) {
                    const error = rateLimitError('Open-Meteo air quality', response, now());
                    retryAt = error.retryAt || now() + 300000; throw Object.assign(error, { retryAt });
                }
                if (!response.ok) throw fail('Air quality could not be loaded. Try again.');
                if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw fail('The air-quality service returned invalid data.');
                const body = JSON.parse(await run(readBoundedResponseText(response, { maxBytes: 65536, signal: deadline.signal, label: 'Air quality' })));
                const data = readAirQuality(body, point, now());
                if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
                cache.delete(url); cache.set(url, data);
                while (cache.size > 4) cache.delete(cache.keys().next().value);
                return data;
            } finally {
                cancelResponseBody(response); deadline.clear(); signal?.removeEventListener('abort', cancel);
            }
        },
    };
}
