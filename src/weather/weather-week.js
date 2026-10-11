// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime } from '../time/mountain-time.js';
import { weatherDayWindow, summarizeWeatherDay } from './weather-day.js';

const DAY = 86400_000, HOUR = 3600_000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

// Seven completed civil days at the summit, not seven UTC dates or 168 hours.
// Request GMT/Unix timestamps and group locally: the API's fixed UTC offset
// ignores DST transitions. Include the final precipitation interval endpoint.
export function weatherWeekWindow(zone, now = Date.now()) {
    const today = mountainTime.localDate(zone, now);
    const midnight = Date.parse(`${today}T00:00:00Z`);
    const days = [];
    for (let offset = 7; offset >= 1; offset--) days.push(weatherDayWindow(iso(midnight - offset * DAY), zone, now));
    if (days.some(day => day.partial)) throw new Error('The summit’s completed weather days could not be resolved.');
    return { zone, days, startDate: iso(days[0].start), endDate: iso(Math.ceil(days.at(-1).end / HOUR) * HOUR), partial: false };
}

export const summarizeWeatherWeek = (data, window) => window.days.map(day => ({ window: day, ...summarizeWeatherDay(data, day) }));
