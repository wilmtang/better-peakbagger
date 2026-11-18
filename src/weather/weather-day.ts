// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime } from '../time/mountain-time.ts';
import type { MountainZone } from '../time/mountain-time.ts';

export type WeatherIconKind = 'sun' | 'partly' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm' | 'unknown';

export interface WeatherDayWindowOptions {
    forecast?: boolean;
}

export interface WeatherDayWindow {
    date: string;
    zone: MountainZone;
    start: number;
    end: number;
    cutoff: number;
    partial: boolean;
    startDate: string;
    endDate: string;
}

export interface WeatherConditionSummary {
    label: string;
    icon: WeatherIconKind;
}

export interface WeatherRangeMetric {
    low: number | null;
    high: number | null;
    complete: boolean;
}

export interface WeatherConditionResult extends WeatherConditionSummary {
    codes?: readonly number[];
    complete: boolean;
}

export interface WeatherPrecipitationHour {
    start: number;
    time: number;
    sourceTime: number;
    value: number | null;
    partialInterval: boolean;
}

export interface WeatherPrecipitationSummary {
    total: number | null;
    complete: boolean;
    allocationEstimated: boolean;
}

export interface WeatherSample {
    time: number;
    temperature?: number | null;
    wind?: number | null;
    gust?: number | null;
    precipitation?: number | null;
    code?: number | null;
}

export interface WeatherSeries<TSample extends WeatherSample = WeatherSample> {
    samples: readonly TSample[];
    gustTiming?: string | null;
}

export interface WeatherDaySummary<TSample extends WeatherSample = WeatherSample> {
    temperature: WeatherRangeMetric;
    wind: WeatherRangeMetric;
    gust: WeatherRangeMetric;
    condition: WeatherConditionResult;
    precipitation: WeatherPrecipitationSummary;
    hourly: (TSample & { precipitation: null })[];
    precipitationHours: WeatherPrecipitationHour[];
    partial: boolean;
    coreComplete: boolean;
    useful: boolean;
}

interface WeatherConditionEntry {
    readonly codes: readonly number[];
    readonly label: string;
    readonly icon: WeatherIconKind;
}

const HOUR = 3600_000, DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function weatherDayWindow(
    date: string,
    zone: MountainZone | null | undefined,
    now = Date.now(),
    { forecast = false }: WeatherDayWindowOptions = {},
): WeatherDayWindow {
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(midnight) || iso(midnight) !== date) throw new Error('Invalid ascent date.');
    const start = mountainTime.civilToInstant(zone, date, 0);
    const next = mountainTime.civilToInstant(zone, iso(midnight + DAY), 0);
    if (!zone || !start || start.date !== date || !next || next.ms <= start.ms) throw new Error('This date does not exist in the summit’s timezone.');
    if (!forecast && start.ms > now) throw new Error('Weather is unavailable for a future ascent date.');
    return {
        date, zone, start: start.ms, end: next.ms, cutoff: forecast ? next.ms : Math.min(now, next.ms),
        partial: !forecast && now < next.ms,
        startDate: iso(midnight - DAY), endDate: iso(midnight + DAY),
    };
}

const CONDITIONS: readonly WeatherConditionEntry[] = [
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
export const knownWeatherCode = (code: unknown): code is number =>
    typeof code === 'number' && Number.isInteger(code) && CONDITIONS.some(item => item.codes.includes(code));
// Hourly descriptions identify the returned sample, rather than the day's
// priority headline (for example, "Rain occurred"). WMO codes from Open-Meteo:
// https://open-meteo.com/en/docs/historical-weather-api
const HOURLY_LABELS: Record<number, string> = {
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
export const hourlyWeatherCondition = (code: unknown): WeatherConditionSummary => {
    const condition = typeof code === 'number' && Number.isInteger(code) ? CONDITIONS.find(item => item.codes.includes(code)) : undefined;
    return condition && typeof code === 'number' ? { label: HOURLY_LABELS[code] || condition.label, icon: condition.icon }
        : { label: 'Unavailable', icon: 'unknown' };
};
const range = (values: number[]): { low: number | null; high: number | null } =>
    values.length ? { low: Math.min(...values), high: Math.max(...values) } : { low: null, high: null };

// The API exposes hourly interpolations even for coarser native models. Only
// claim coverage of the returned hourly series, never independent observations.
export function summarizeWeatherDay<TSample extends WeatherSample>(
    data: WeatherSeries<TSample>,
    window: Pick<WeatherDayWindow, 'start' | 'end' | 'cutoff' | 'partial'>,
): WeatherDaySummary<TSample> {
    const rows = data.samples;
    const instants = rows.filter(row => row.time >= window.start && row.time < window.cutoff);
    const expected: number[] = [];
    for (let time = Math.ceil(window.start / HOUR) * HOUR; time < window.cutoff; time += HOUR) expected.push(time);
    const byTime = new Map(rows.map(row => [row.time, row]));
    const field = (name: 'temperature' | 'wind' | 'gust'): WeatherRangeMetric => {
        const values = instants.map(row => row[name]).filter(isFiniteNumber);
        return { ...range(values), complete: expected.length > 0 && expected.every(time => isFiniteNumber(byTime.get(time)?.[name])) };
    };
    const temperature = field('temperature'), wind = field('wind');
    let total = 0, covered = 0, gustCovered = 0, allocationEstimated = false;
    const gustValues: number[] = [];
    const precipitationHours: WeatherPrecipitationHour[] = [];
    const hourly = instants.map(row => ({ ...row, precipitation: null }));
    for (let end = Math.floor(window.start / HOUR) * HOUR + HOUR; end <= Math.ceil(window.cutoff / HOUR) * HOUR; end += HOUR) {
        const overlap = Math.max(0, Math.min(end, window.cutoff) - Math.max(end - HOUR, window.start));
        if (!overlap || (window.partial && end > window.cutoff)) continue; // never use the future/current unfinished hour
        // Only interval gusts share precipitation's preceding-hour boundary.
        const gustValue = byTime.get(end)?.gust;
        if (isFiniteNumber(gustValue)) { gustValues.push(gustValue); gustCovered += overlap; }
        const value = byTime.get(end)?.precipitation;
        precipitationHours.push({ start: Math.max(end - HOUR, window.start), time: Math.min(end, window.cutoff),
            sourceTime: end, value: isFiniteNumber(value) ? value * overlap / HOUR : null, partialInterval: overlap !== HOUR });
        if (!isFiniteNumber(value)) continue;
        total += value * overlap / HOUR;
        covered += overlap;
        if (overlap !== HOUR) allocationEstimated = true;
    }
    const precipitationComplete = covered === window.end - window.start && !window.partial;
    const gust = data.gustTiming === 'instant' ? field('gust')
        : { ...range(gustValues), complete: gustCovered === window.end - window.start && !window.partial };
    const codes = instants.map(row => row.code).filter(knownWeatherCode);
    const conditionComplete = expected.length > 0 && expected.every(time => knownWeatherCode(byTime.get(time)?.code));
    const condition: WeatherConditionSummary & { codes?: readonly number[] } =
        CONDITIONS.find(item => codes.some(code => item.codes.includes(code))) || { label: 'Conditions unavailable', icon: 'unknown' };
    const coreComplete = temperature.complete && wind.complete && conditionComplete && precipitationComplete;
    return {
        temperature, wind, gust, condition: { ...condition, complete: conditionComplete },
        precipitation: { total: covered > 0 ? total : null, complete: precipitationComplete, allocationEstimated },
        hourly, precipitationHours, partial: window.partial || !coreComplete, coreComplete,
        useful: instants.some(row => isFiniteNumber(row.temperature) || isFiniteNumber(row.wind) || knownWeatherCode(row.code)),
    };
}
