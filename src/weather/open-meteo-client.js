// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { WEATHER_MODELS } from './weather-models.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = {
    temperature_2m: { name: 'temperature', unit: '°C', min: -120, max: 70 },
    precipitation: { name: 'precipitation', unit: 'mm', min: 0, max: 2000 },
    wind_speed_10m: { name: 'wind', unit: 'km/h', min: 0, max: 600 },
    wind_gusts_10m: { name: 'gust', unit: 'km/h', min: 0, max: 600 },
    weather_code: { name: 'code', unit: 'wmo code', min: 0, max: 100 },
};
const iso = ms => new Date(ms).toISOString().slice(0, 10);
export function weatherRequestUrl(summit, window, model) {
    if (!WEATHER_MODELS.includes(model) || !Number.isFinite(summit.latitude) || Math.abs(summit.latitude) > 90
        || !Number.isFinite(summit.longitude) || Math.abs(summit.longitude) > 180) throw fail('invalid', 'Invalid weather subject.');
    const start = Date.parse(`${window.startDate}T00:00:00Z`), end = Date.parse(`${window.endDate}T00:00:00Z`);
    if (![start, end].every(Number.isFinite) || iso(start) !== window.startDate || iso(end) !== window.endDate
        || end < start || end - start > 2 * 86400_000) throw fail('invalid', 'Invalid weather date window.');
    const url = new URL(model.endpoint);
    const params = { latitude: summit.latitude, longitude: summit.longitude,
        start_date: window.startDate, end_date: window.endDate, models: model.id,
        hourly: model.fields.join(','), timezone: 'GMT', timeformat: 'unixtime',
        temperature_unit: 'celsius', precipitation_unit: 'mm', wind_speed_unit: 'kmh' };
    if (summit.elevation !== null && summit.elevation !== undefined) {
        if (!Number.isFinite(summit.elevation) || summit.elevation < -500 || summit.elevation > 9000) throw fail('invalid', 'Invalid summit elevation.');
        params.elevation = summit.elevation;
    }
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url.href;
}

export function validateWeatherResponse(body, summit, window, model) {
    const invalid = () => { throw fail('invalid-response', 'The weather service returned an invalid response.'); };
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.utc_offset_seconds !== 0
        || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90
        || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180
        || !Number.isFinite(body.elevation) || body.elevation < -500 || body.elevation > 9000) invalid();
    // Validate grid displacement, accounting for the date line. Coarse global
    // grids can be tens of kilometres away; a different continent cannot pass.
    const lonDelta = Math.min(Math.abs(body.longitude - summit.longitude), 360 - Math.abs(body.longitude - summit.longitude));
    const distance = Math.hypot((body.latitude - summit.latitude) * 111,
        lonDelta * 111 * Math.cos(summit.latitude * Math.PI / 180));
    if (distance > 200 || (Number.isFinite(summit.elevation) && Math.abs(body.elevation - summit.elevation) > 1)) invalid();
    const hourly = body.hourly, times = hourly?.time;
    if (!Array.isArray(times) || times.length < 1 || times.length > 72 || body.hourly_units?.time !== 'unixtime') invalid();
    const start = Date.parse(`${window.startDate}T00:00:00Z`), end = Date.parse(`${window.endDate}T00:00:00Z`) + 86400_000;
    times.forEach((time, index) => {
        if (!Number.isInteger(time) || time % 3600 !== 0 || time * 1000 < start || time * 1000 >= end
            || (index && time <= times[index - 1])) invalid();
    });
    const columns = {};
    for (const [key, definition] of Object.entries(fields)) {
        if (!model.fields.includes(key)) { columns[definition.name] = times.map(() => null); continue; }
        const values = hourly[key];
        if (!Array.isArray(values) || values.length !== times.length || body.hourly_units?.[key] !== definition.unit) invalid();
        if (values.some(value => value !== null && (!Number.isFinite(value) || value < definition.min || value > definition.max))) invalid();
        columns[definition.name] = values;
    }
    return {
        grid: { latitude: body.latitude, longitude: body.longitude, elevation: body.elevation },
        samples: times.map((time, index) => ({ time: time * 1000, ...Object.fromEntries(Object.entries(columns).map(([key, values]) => [key, values[index]])) })),
    };
}

// One client per page: bounded memory only, no persistent ascent history. A
// single page owner owns cancellation; a cancelled flight is never reused.
export function createWeatherClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
    const cache = new Map(), flights = new Map();
    const request = (summit, window, model, { signal } = {}) => {
        const url = weatherRequestUrl(summit, window, model);
        const key = `weather-v1:${url}`;
        if (signal?.aborted) return Promise.reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
        const cached = cache.get(key);
        if (cached && cached.expires > now()) return Promise.resolve(cached.data);
        if (flights.has(key) && !flights.get(key).signal?.aborted) return flights.get(key).promise;
        const deadline = requestDeadline.createRequestDeadline(timeoutMs);
        let rejectCancel;
        const cancellation = new Promise((_, reject) => { rejectCancel = reject; });
        cancellation.catch(() => {});
        const cancel = () => { deadline.abort(); rejectCancel(Object.assign(new Error('Cancelled.'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', cancel, { once: true });
        const run = promise => deadline.run(Promise.race([promise, cancellation]));
        const flight = { signal, promise: null };
        flight.promise = (async () => {
            try {
                const response = await run(fetchFn(url, { credentials: 'omit', referrerPolicy: 'no-referrer',
                    redirect: 'error', cache: 'no-store', signal: deadline.signal }));
                if (response.status === 429) throw fail('rate-limit', 'Weather requests are temporarily limited. Wait before trying again.');
                if ([400, 404].includes(response.status)) throw fail('unavailable', 'This model has no data for the ascent’s date or location.');
                if (!response.ok) throw fail('service', 'The weather service is unavailable. Try again later.');
                if (!/application\/json/i.test(response.headers?.get('content-type') || '')) throw fail('invalid-response', 'The weather service returned an invalid response.');
                const text = await run(readBoundedResponseText(response, { maxBytes: 128 * 1024, signal: deadline.signal, label: 'Weather response' }));
                let body;
                try { body = JSON.parse(text); } catch { throw fail('invalid-response', 'The weather service returned an invalid response.'); }
                const data = validateWeatherResponse(body, summit, window, model);
                if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
                cache.delete(key);
                cache.set(key, { data, expires: now() + (window.partial ? 5 * 60_000 : 6 * 3600_000) });
                while (cache.size > 8) cache.delete(cache.keys().next().value);
                return data;
            } catch (error) {
                if (error.name === 'AbortError' || error.code) throw error;
                if (requestDeadline.isTimeout(error)) throw fail('timeout', 'Weather took too long to load. Try again.');
                throw fail('network', 'Weather could not be loaded. Check your connection and try again.');
            } finally {
                deadline.clear(); signal?.removeEventListener('abort', cancel);
                if (flights.get(key) === flight) flights.delete(key);
            }
        })();
        flights.set(key, flight);
        return flight.promise;
    };
    return { request, clear: () => cache.clear() };
}
