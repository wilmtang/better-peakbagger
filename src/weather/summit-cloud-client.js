// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SUMMIT_CLOUD_MODELS } from './summit-cloud-models.js';
import { cloudSamplePoints, cloudDistanceKm } from './summit-cloud-core.js';
import { createPeakModelUpdateClient } from './peak-weather-updates.js';
import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.js';

const HOUR = 3600_000;
const fields = {
    temperature: ['temperature', '°C', -120, 70], relative_humidity: ['humidity', '%', 0, 100],
    geopotential_height: ['height', 'm', -1000, 20000], cloud_cover: ['cloud', '%', 0, 100],
    wind_speed: ['wind', 'm/s', 0, 200], wind_direction: ['direction', '°', 0, 360],
};
const fail = (message, code = 'unavailable') => Object.assign(new Error(message), { code });
const cancelled = () => new DOMException('Cancelled.', 'AbortError');
const isoHour = time => new Date(time).toISOString().slice(0, 16);

export function summitCloudRequest(subject, day, model) {
    if (!subject || !SUMMIT_CLOUD_MODELS.includes(model) || !model.domain(subject)
        || !Number.isFinite(subject.latitude) || Math.abs(subject.latitude) > 90
        || !Number.isFinite(subject.longitude) || Math.abs(subject.longitude) > 180
        || !Number.isFinite(subject.elevation) || subject.elevation < -500 || subject.elevation > 9000
        || !Number.isSafeInteger(day?.start) || !Number.isSafeInteger(day.end) || day.end <= day.start || day.end - day.start > 26 * HOUR) throw fail('Invalid summit cloud request.', 'invalid');
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

export function readSummitCloudResponse(body, request) {
    const invalid = () => { throw fail('The cloud service returned invalid data.', 'invalid-response'); };
    if (!Array.isArray(body) || body.length !== request.points.length) invalid();
    const points = body.map((data, index) => {
        const grid = { latitude: data?.latitude, longitude: data?.longitude, elevation: data?.elevation };
        if (data?.utc_offset_seconds !== 0 || !Object.values(grid).every(Number.isFinite)
            || Math.abs(grid.latitude) > 90 || Math.abs(grid.longitude) > 180 || grid.elevation < -500 || grid.elevation > 9000
            || cloudDistanceKm(grid, request.points[index]) > Math.max(20, request.model.gridKm * 2)) invalid();
        const times = data.hourly?.time;
        if (data.hourly_units?.time !== 'unixtime' || !Array.isArray(times) || !times.length || times.length > 26) invalid();
        const columns = new Map();
        for (const pressure of request.model.levels) for (const [variable, [name, unit, low, high]] of Object.entries(fields)) {
            const key = `${variable}_${pressure}hPa`, column = data.hourly?.[key];
            // A missing native level or unsupported field remains a gap. It
            // must not turn an otherwise valid profile into zero cloud.
            columns.set(`${pressure}/${name}`, data.hourly_units?.[key] === unit && Array.isArray(column) && column.length === times.length
                ? column.map(value => Number.isFinite(value) && value >= low && value <= high ? value : null) : times.map(() => null));
        }
        const samples = times.map((seconds, i) => {
            const time = seconds * 1000;
            if (!Number.isSafeInteger(seconds) || seconds % 3600 || time < request.start || time >= request.end || i && seconds !== times[i - 1] + 3600) invalid();
            return { time, levels: request.model.levels.map(pressure => ({ pressure,
                ...Object.fromEntries(Object.values(fields).map(([name]) => [name, columns.get(`${pressure}/${name}`)[i]])) })) };
        });
        return { ...request.points[index], grid, samples };
    });
    return { model: request.model, points };
}

export function createSummitCloudClient({ fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 15000,
    updateClient = createPeakModelUpdateClient({ fetchFn, now }) } = {}) {
    const cache = new Map(); let retryAt = 0;
    return {
        clear() { cache.clear(); updateClient.clear(); },
        async request(subject, day, model, { signal, refresh = false } = {}) {
            if (signal?.aborted) throw cancelled();
            const request = summitCloudRequest(subject, day, model), cached = cache.get(request.url);
            if (!refresh && cached && now() - cached.loadedAt < 300000) return cached;
            if (retryAt > now()) throw Object.assign(fail('Cloud forecast requests are temporarily limited. Try again later.', 'rate-limit'), { retryAt });
            const deadline = requestDeadline.createRequestDeadline(timeoutMs);
            let rejectCancel, response;
            const cancellation = new Promise((_, reject) => { rejectCancel = reject; }); cancellation.catch(() => {});
            const cancel = () => { deadline.abort(); rejectCancel(cancelled()); };
            signal?.addEventListener('abort', cancel, { once: true });
            const run = promise => deadline.run(Promise.race([promise, cancellation]));
            try {
                response = await run(fetchFn(request.url, { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }));
                if (response.status === 429) {
                    const error = rateLimitError('Open-Meteo', response, now()); retryAt = error.retryAt || now() + 300000;
                    throw Object.assign(error, { retryAt });
                }
                if (!response.ok) throw fail('Cloud forecasts could not be loaded. Try Refresh.');
                if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw fail('The cloud service returned invalid data.', 'invalid-response');
                const text = await run(readBoundedResponseText(response, { maxBytes: 1024 * 1024, signal: deadline.signal, label: 'Cloud profiles' }));
                const result = readSummitCloudResponse(JSON.parse(text), request);
                // Optional freshness must not discard an otherwise usable profile.
                // The predictor explicitly downgrades an unverified update.
                let metadata = { data: null };
                try { metadata = await run(updateClient.request(model.metadata, { signal: deadline.signal })); }
                catch { if (signal?.aborted) throw cancelled(); }
                if (signal?.aborted) throw cancelled();
                const value = { ...result, metadata: metadata.data, loadedAt: now() };
                cache.delete(request.url); cache.set(request.url, value);
                while (cache.size > 6) cache.delete(cache.keys().next().value);
                return value;
            } finally {
                cancelResponseBody(response); deadline.clear(); signal?.removeEventListener('abort', cancel);
            }
        },
    };
}
