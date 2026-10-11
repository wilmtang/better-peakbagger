// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime } from '../time/mountain-time.js';

const HOUR = 3600_000, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
export function weatherDayWindow(date, zone, now = Date.now(), { forecast = false } = {}) {
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(midnight) || iso(midnight) !== date) throw new Error('Invalid ascent date.');
    const start = mountainTime.civilToInstant(zone, date, 0);
    const next = mountainTime.civilToInstant(zone, iso(midnight + DAY), 0);
    if (!start || start.date !== date || !next || next.ms <= start.ms) throw new Error('This date does not exist in the summit’s timezone.');
    if (!forecast && start.ms > now) throw new Error('Weather is unavailable for a future ascent date.');
    return {
        date, zone, start: start.ms, end: next.ms, cutoff: forecast ? next.ms : Math.min(now, next.ms),
        partial: !forecast && now < next.ms,
        startDate: iso(midnight - DAY), endDate: iso(midnight + DAY),
    };
}

const CONDITIONS = [
    { codes: [95, 96, 97, 99], label: 'Thunderstorms', icon: 'storm' },
    { codes: [56, 57, 66, 67], label: 'Freezing rain or drizzle', icon: 'rain' },
    { codes: [71, 73, 75, 77, 85, 86], label: 'Snow occurred', icon: 'snow' },
    { codes: [51, 53, 55, 61, 63, 65, 80, 81, 82], label: 'Rain occurred', icon: 'rain' },
    { codes: [45, 48], label: 'Fog', icon: 'fog' },
    { codes: [3], label: 'Overcast', icon: 'cloud' },
    { codes: [2], label: 'Partly cloudy', icon: 'partly' },
    { codes: [1], label: 'Mainly clear', icon: 'sun' },
    { codes: [0], label: 'Clear', icon: 'sun' },
];
export const knownWeatherCode = code => Number.isInteger(code) && CONDITIONS.some(item => item.codes.includes(code));
// Hourly descriptions identify the returned sample, rather than the day's
// priority headline (for example, "Rain occurred"). WMO codes from Open-Meteo:
// https://open-meteo.com/en/docs/historical-weather-api
const HOURLY_LABELS = {
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
    61: 'Light rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Light snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light rain showers', 81: 'Moderate rain showers', 82: 'Heavy rain showers',
    85: 'Light snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with light hail', 97: 'Heavy thunderstorm', 99: 'Thunderstorm with heavy hail',
    48: 'Rime fog',
};
export const hourlyWeatherCondition = code => {
    const condition = Number.isInteger(code) && CONDITIONS.find(item => item.codes.includes(code));
    return condition ? { label: HOURLY_LABELS[code] || condition.label, icon: condition.icon }
        : { label: 'Unavailable', icon: 'unknown' };
};
const range = values => values.length ? { low: Math.min(...values), high: Math.max(...values) } : { low: null, high: null };

// The API exposes hourly interpolations even for coarser native models. Only
// claim coverage of the returned hourly series, never independent observations.
export function summarizeWeatherDay(data, window) {
    const rows = data.samples;
    const instants = rows.filter(row => row.time >= window.start && row.time < window.cutoff);
    const expected = [];
    for (let time = Math.ceil(window.start / HOUR) * HOUR; time < window.cutoff; time += HOUR) expected.push(time);
    const byTime = new Map(rows.map(row => [row.time, row]));
    const field = name => {
        const values = instants.map(row => row[name]).filter(Number.isFinite);
        return { ...range(values), complete: expected.length > 0 && expected.every(time => Number.isFinite(byTime.get(time)?.[name])) };
    };
    const temperature = field('temperature'), wind = field('wind');
    let total = 0, covered = 0, gustCovered = 0, allocationEstimated = false;
    const gustValues = [];
    const precipitationHours = [];
    const hourly = instants.map(row => ({ ...row, precipitation: null }));
    for (let end = Math.floor(window.start / HOUR) * HOUR + HOUR; end <= Math.ceil(window.cutoff / HOUR) * HOUR; end += HOUR) {
        const overlap = Math.max(0, Math.min(end, window.cutoff) - Math.max(end - HOUR, window.start));
        if (!overlap || (window.partial && end > window.cutoff)) continue; // never use the future/current unfinished hour
        // Only interval gusts share precipitation's preceding-hour boundary.
        const gustValue = byTime.get(end)?.gust;
        if (Number.isFinite(gustValue)) { gustValues.push(gustValue); gustCovered += overlap; }
        const value = byTime.get(end)?.precipitation;
        precipitationHours.push({ start: Math.max(end - HOUR, window.start), time: Math.min(end, window.cutoff),
            sourceTime: end, value: Number.isFinite(value) ? value * overlap / HOUR : null, partialInterval: overlap !== HOUR });
        if (!Number.isFinite(value)) continue;
        total += value * overlap / HOUR;
        covered += overlap;
        if (overlap !== HOUR) allocationEstimated = true;
    }
    const precipitationComplete = covered === window.end - window.start && !window.partial;
    const gust = data.gustTiming === 'instant' ? field('gust')
        : { ...range(gustValues), complete: gustCovered === window.end - window.start && !window.partial };
    const codes = instants.map(row => row.code).filter(knownWeatherCode);
    const conditionComplete = expected.length > 0 && expected.every(time => knownWeatherCode(byTime.get(time)?.code));
    const condition = CONDITIONS.find(item => codes.some(code => item.codes.includes(code))) || { label: 'Conditions unavailable', icon: 'unknown' };
    const coreComplete = temperature.complete && wind.complete && conditionComplete && precipitationComplete;
    return {
        temperature, wind, gust, condition: { ...condition, complete: conditionComplete },
        precipitation: { total: covered > 0 ? total : null, complete: precipitationComplete, allocationEstimated },
        hourly, precipitationHours, partial: window.partial || !coreComplete, coreComplete,
        useful: instants.some(row => Number.isFinite(row.temperature) || Number.isFinite(row.wind) || knownWeatherCode(row.code)),
    };
}
