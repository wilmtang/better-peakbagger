// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime } from '../time/mountain-time.ts';
import type { MountainZone } from '../time/mountain-time.ts';
import { weatherDayWindow, summarizeWeatherDay } from './weather-day.ts';
import type { WeatherDaySummary, WeatherDayWindow, WeatherSample, WeatherSeries } from './weather-day.ts';

export interface WeatherWindowSpan {
    zone: MountainZone;
    days: WeatherDayWindow[];
    startDate: string;
    endDate: string;
    partial: boolean;
}

export interface WeatherPeakWindow {
    zone: MountainZone;
    today: string;
    past: WeatherWindowSpan;
    forecast: WeatherWindowSpan;
    startDate: string;
    endDate: string;
    partial: true;
}

export interface WeatherWeekWindow {
    days: readonly WeatherDayWindow[];
}

export interface WeatherWeekDaySummary<TSample extends WeatherSample = WeatherSample> extends WeatherDaySummary<TSample> {
    window: WeatherDayWindow;
}

const DAY = 86400_000, HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const PEAK_FORECAST_DAYS = 16;

// Request GMT/Unix timestamps and group locally: the API's fixed UTC offset
// ignores DST transitions. Include the final precipitation interval endpoint.
function completedWeatherWindow(zone: MountainZone, now: number, dayCount: number): WeatherWindowSpan {
    const today = mountainTime.localDate(zone, now);
    if (!today) throw new RangeError('Invalid time value');
    const midnight = Date.parse(`${today}T00:00:00Z`);
    const days: WeatherDayWindow[] = [];
    for (let offset = dayCount; offset >= 1; offset--) days.push(weatherDayWindow(iso(midnight - offset * DAY), zone, now));
    if (days.some(day => day.partial)) throw new Error('The summit’s completed weather days could not be resolved.');
    return { zone, days, startDate: iso(days[0]!.start), endDate: iso(Math.ceil(days.at(-1)!.end / HOUR) * HOUR), partial: false };
}

export const summarizeWeatherWeek = <TSample extends WeatherSample = WeatherSample>(
    data: WeatherSeries<TSample>,
    window: WeatherWeekWindow,
): WeatherWeekDaySummary<TSample>[] => {
    return window.days.map(day => {
        const summary = summarizeWeatherDay(data, day);
        return { window: day, ...summary,
            useful: summary.useful || Number.isFinite(summary.precipitation.total) || Number.isFinite(summary.gust.high) };
    });
};

// One padded UTC request covers both views. Forecast summaries use complete
// local days, including all of today; historical ascent dates still reject
// future days and cut off unfinished hours by default.
export function weatherPeakWindow(zone: MountainZone, now = Date.now()): WeatherPeakWindow {
    const today = mountainTime.localDate(zone, now);
    if (!zone || !today) throw new RangeError('Invalid time value');
    const midnight = Date.parse(`${today}T00:00:00Z`);
    const past = completedWeatherWindow(zone, now, PEAK_FORECAST_DAYS);
    const days = Array.from({ length: PEAK_FORECAST_DAYS }, (_, offset) =>
        weatherDayWindow(iso(midnight + offset * DAY), zone, now, { forecast: true }));
    // The GMT request cannot exceed the API's sixteen UTC dates from today.
    // Keep full civil-day expectations so truncated final hours stay partial.
    const lastApiDate = Date.parse(`${iso(now)}T00:00:00Z`) + (PEAK_FORECAST_DAYS - 1) * DAY;
    const forecast: WeatherWindowSpan = { zone, days, startDate: iso(days[0]!.start),
        endDate: iso(Math.min(Math.ceil(days.at(-1)!.end / HOUR) * HOUR, lastApiDate)), partial: true };
    return { zone, today, past, forecast, startDate: past.startDate, endDate: forecast.endDate, partial: true };
}
