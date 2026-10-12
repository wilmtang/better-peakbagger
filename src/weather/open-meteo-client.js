// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { WEATHER_MODELS } from './weather-models.js';
import { PEAK_WEATHER_MODELS } from './peak-weather-models.js';
import { rateLimitError } from '../net/rate-limit.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = {
    temperature_2m: { name: 'temperature', unit: '°C', min: -120, max: 70 },
    precipitation: { name: 'precipitation', unit: 'mm', min: 0, max: 2000 },
    wind_speed_10m: { name: 'wind', unit: 'km/h', min: 0, max: 600 },
    wind_gusts_10m: { name: 'gust', unit: 'km/h', min: 0, max: 600 },
    weather_code: { name: 'code', unit: 'wmo code', min: 0, max: 100 },
};
const peakFields = {
    ...fields,
    apparent_temperature: { name: 'apparent', unit: '°C', min: -150, max: 100 },
    wind_direction_10m: { name: 'direction', unit: '°', min: 0, max: 360 },
    is_day: { name: 'isDay', unit: '', min: 0, max: 1, integer: true },
};
const iso = ms => new Date(ms).toISOString().slice(0, 10);
export function weatherRequestUrl(summit, window, model) {
    if (!WEATHER_MODELS.includes(model)) throw fail('invalid', 'Invalid weather model.');
    return requestUrl(summit, window, model, 2);
}

// Sixteen past and sixteen forecast civil days, plus UTC padding. The forecast
// window caps padding at the API horizon; do not widen historical ascent bounds.
const PEAK_MAX_UTC_DATES = 33;
const peakModels = models => {
    if (!Array.isArray(models) || models.length < 1 || models.length > 2
        || new Set(models).size !== models.length || models.some(model => !PEAK_WEATHER_MODELS.includes(model))) throw fail('invalid', 'Invalid weather model selection.');
    return models;
};
export function peakWeatherRequestUrl(summit, window, models) {
    peakModels(models);
    if (models.some(model => !model.domain(summit))) throw fail('invalid', 'Invalid weather model coverage.');
    return requestUrl(summit, window, { endpoint: 'https://api.open-meteo.com/v1/forecast',
        id: models.map(model => model.id).join(','), since: models.map(model => model.since).sort()[0],
        fields: [...new Set(models.flatMap(model => model.fields))] }, PEAK_MAX_UTC_DATES - 1);
}

function requestUrl(summit, window, model, maxDays) {
    if (!Number.isFinite(summit.latitude) || Math.abs(summit.latitude) > 90
        || !Number.isFinite(summit.longitude) || Math.abs(summit.longitude) > 180) throw fail('invalid', 'Invalid weather subject.');
    const start = Date.parse(`${window.startDate}T00:00:00Z`), end = Date.parse(`${window.endDate}T00:00:00Z`);
    if (![start, end].every(Number.isFinite) || iso(start) !== window.startDate || iso(end) !== window.endDate
        || end < start || end - start > maxDays * 86400_000) throw fail('invalid', 'Invalid weather date window.');
    // Adjacent UTC days may cross the archive's first/last day. Fetch the
    // covered portion and let the civil-day summary label missing hours.
    const startDate = window.startDate < model.since ? model.since : window.startDate;
    const endDate = model.until && window.endDate > model.until ? model.until : window.endDate;
    if (startDate > endDate) throw fail('unavailable', 'This model has no data for the ascent’s date or location.');
    const url = new URL(model.endpoint);
    const params = { latitude: summit.latitude, longitude: summit.longitude,
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

export function validateWeatherResponse(body, summit, window, model) {
    return validateResponse(body, summit, window, model, 72);
}
export function validatePeakWeatherResponse(body, summit, window, models) {
    peakModels(models);
    const multiple = models.length > 1;
    return { sharedGrid: multiple, models: Object.fromEntries(models.map(model => {
        const hourly = { time: body?.hourly?.time }, hourly_units = { time: body?.hourly_units?.time };
        for (const field of model.fields) {
            const key = multiple ? `${field}_${model.id}` : field;
            hourly[field] = body?.hourly?.[key]; hourly_units[field] = body?.hourly_units?.[key];
        }
        return [model.id, validateResponse({ ...body, hourly, hourly_units }, summit, window, model, PEAK_MAX_UTC_DATES * 24, peakFields)];
    })) };
}

function validateResponse(body, summit, window, model, maxRows, definitions = fields) {
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
    if (!Array.isArray(times) || times.length < 1 || times.length > maxRows || body.hourly_units?.time !== 'unixtime') invalid();
    const start = Date.parse(`${window.startDate}T00:00:00Z`), end = Date.parse(`${window.endDate}T00:00:00Z`) + 86400_000;
    times.forEach((time, index) => {
        if (!Number.isInteger(time) || time % 3600 !== 0 || time * 1000 < start || time * 1000 >= end
            || (index && time <= times[index - 1])) invalid();
    });
    const columns = {};
    for (const [key, definition] of Object.entries(definitions)) {
        if (!model.fields.includes(key)) { columns[definition.name] = times.map(() => null); continue; }
        let values = hourly[key];
        if (!Array.isArray(values) || values.length !== times.length || body.hourly_units?.[key] !== definition.unit) invalid();
        // Model processing can return negative precipitation (seen in ARPEGE).
        // Floor finite amounts at zero; keep genuinely missing values and
        // malformed data subject to the normal validation below.
        if (key === 'precipitation') values = values.map(value => Number.isFinite(value) && value < 0 ? 0 : value);
        if (values.some(value => value !== null && (!Number.isFinite(value) || value < definition.min || value > definition.max
            || (definition.integer && !Number.isInteger(value))))) invalid();
        columns[definition.name] = values;
    }
    return {
        gustTiming: model.gustTiming || 'preceding-hour',
        grid: { latitude: body.latitude, longitude: body.longitude, elevation: body.elevation },
        samples: times.map((time, index) => ({ time: time * 1000, ...Object.fromEntries(Object.entries(columns).map(([key, values]) => [key, values[index]])) })),
    };
}

// One client per page: bounded memory only, no persistent ascent history. A
// single page owner owns cancellation; a cancelled flight is never reused.
export function createWeatherClient(options = {}) {
    return createClient(options, weatherRequestUrl, validateWeatherResponse);
}
export function createPeakWeatherClient(options = {}) {
    return createClient(options, peakWeatherRequestUrl, validatePeakWeatherResponse);
}
function createClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000 }, buildUrl, validate) {
    const cache = new Map(), flights = new Map();
    let limited = null;
    const request = (summit, window, model, { signal } = {}) => {
        const url = buildUrl(summit, window, model);
        const key = `weather-v1:${url}`;
        if (signal?.aborted) return Promise.reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
        const cached = cache.get(key);
        if (cached && cached.expires > now()) return Promise.resolve(cached.data);
        if (limited?.retryAt > now()) return Promise.reject(limited);
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
                if (response.status === 429) { limited = rateLimitError('Open-Meteo', response, now()); throw limited; }
                if ([400, 404].includes(response.status)) throw fail('unavailable', Array.isArray(model)
                    ? 'This weather model selection is unavailable for this summit. Choose another model.' : 'This model has no data for the ascent’s date or location.');
                if (!response.ok) throw fail('service', 'The weather service is unavailable. Try again later.');
                if (!/application\/json/i.test(response.headers?.get('content-type') || '')) throw fail('invalid-response', 'The weather service returned an invalid response.');
                const text = await run(readBoundedResponseText(response, { maxBytes: 128 * 1024, signal: deadline.signal, label: 'Weather response' }));
                let body;
                try { body = JSON.parse(text); } catch { throw fail('invalid-response', 'The weather service returned an invalid response.'); }
                const data = validate(body, summit, window, model);
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
