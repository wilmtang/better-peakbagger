// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { mountainTime } from '../time/mountain-time.js';
import { hourlyWeatherCondition } from './weather-day.js';

const HOUR = 3600_000, element = dom.element;
const icons = { sun: '☀', cloud: '☁', partly: '⛅', rain: '☂', snow: '❄', fog: '≋', storm: 'ϟ', unknown: '—' };
const measurements = [['code', 'Conditions'], ['temperature', 'Temperature'], ['apparent', 'Feels like'], ['precipitation', 'Rain/snow'], ['wind', 'Wind'], ['gust', 'Gusts'], ['direction', 'Wind from']];

// Instantaneous fields exclude ending midnight; accumulations include it and
// exclude starting midnight. Missing timestamps remain explicit empty slots.
export function hourlyWeatherSeries(window, samples, metric, gustTiming = 'preceding-hour') {
    const byTime = new Map(samples.map(sample => [sample.time, sample]));
    const interval = metric === 'precipitation' || (metric === 'gust' && gustTiming === 'preceding-hour');
    const rows = [];
    const first = interval ? Math.floor(window.start / HOUR) * HOUR + HOUR : Math.ceil(window.start / HOUR) * HOUR;
    const limit = interval ? Math.ceil(window.cutoff / HOUR) * HOUR : window.cutoff - 1;
    for (let time = first; time <= limit; time += HOUR) {
        if (interval && window.partial && time > window.cutoff) continue;
        const start = interval ? Math.max(time - HOUR, window.start) : time;
        const end = interval ? Math.min(time, window.cutoff) : time;
        const partialInterval = interval && end - start !== HOUR;
        let value = byTime.get(time)?.[metric] ?? null;
        if (metric === 'precipitation' && Number.isFinite(value)) value *= (end - start) / HOUR;
        rows.push({ time: end, sourceTime: time, start, value, partialInterval });
    }
    return rows;
}

// Put accumulations under the start of their actual interval, alongside the
// readings at that instant. Fractional-hour boundaries never borrow a reading.
export function hourlyWeatherColumns(window, samples, gustTiming = 'preceding-hour') {
    const instant = hourlyWeatherSeries(window, samples, 'code');
    const rain = hourlyWeatherSeries(window, samples, 'precipitation');
    const gust = hourlyWeatherSeries(window, samples, 'gust', gustTiming);
    const byTime = new Map(samples.map(sample => [sample.time, sample]));
    const rainByStart = new Map(rain.map(row => [row.start, row]));
    const gustByStart = new Map(gust.map(row => [row.start, row]));
    return [...new Set([...instant.map(row => row.time), ...rain.map(row => row.start)])].sort((a, b) => a - b).map(time => ({
        time, sample: byTime.get(time), rain: rainByStart.get(time), gust: gustByStart.get(time),
    }));
}

export function createWeatherHourlyTable({ window, samples, zone, format, gustTiming = 'preceding-hour', keys = measurements.map(([key]) => key) }) {
    const hours = hourlyWeatherColumns(window, samples, gustTiming), columns = new Map();
    const localTime = time => `${mountainTime.formatClock(zone, time)} ${mountainTime.zoneLabel(zone, time)}`;
    const table = element('table', { class: 'bpb-weather-hourly-table', 'aria-label': 'Hourly weather' });
    const head = element('tr', {}, [element('th', { scope: 'col', text: 'Hours' })]);
    for (const row of hours) {
        const cell = element('th', { scope: 'col', class: 'bpb-weather-conditions-hour', 'data-weather-time': row.time }, [
            element('time', { datetime: new Date(row.time).toISOString(), title: localTime(row.time), text: mountainTime.formatClock(zone, row.time).replace(/^0/, '').replace(':00', '') }),
            element('span', { class: 'bpb-weather-hour-zone', text: mountainTime.zoneLabel(zone, row.time) }),
        ]);
        head.append(cell); columns.set(row.time, [cell]);
    }
    table.append(element('thead', {}, [head]));
    const body = element('tbody');
    for (const [key, label] of measurements.filter(([fieldKey]) => keys.includes(fieldKey))) {
        const line = element('tr', { 'data-weather-row': key }, [element('th', { scope: 'row', text: label })]);
        for (const row of hours) {
            const interval = key === 'precipitation' ? row.rain : key === 'gust' ? row.gust : null;
            const value = interval ? interval.value : key === 'precipitation' || key === 'gust' ? null : row.sample?.[key];
            const cell = element('td', { 'data-weather-time': row.time });
            if (key === 'code') {
                const condition = hourlyWeatherCondition(value);
                const icon = row.sample?.isDay === 0 && ['sun', 'partly'].includes(condition.icon) ? condition.icon === 'partly' ? '☁☾' : '☾' : icons[condition.icon];
                cell.append(element('span', { class: `bpb-weather-hour-icon bpb-weather-hour-icon-${condition.icon}`, role: 'img', 'aria-label': condition.label, title: `${localTime(row.time)} · ${condition.label}`, text: icon }));
            } else if (key === 'direction' && Number.isFinite(value)) {
                const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(value / 45) % 8];
                cell.title = `Wind from ${compass} (${Math.round(value)}°)`;
                cell.append(element('span', { class: 'bpb-weather-wind-arrow', 'aria-hidden': 'true', style: `transform: rotate(${value}deg)`, text: '↓' }), element('span', { text: compass }));
            } else {
                cell.textContent = format(value, key === 'apparent' ? 'temperature' : key === 'gust' ? 'wind' : key);
                if (interval) cell.title = key === 'gust' && gustTiming === 'instant' ? `${localTime(row.time)} · Instantaneous gust estimate`
                    : `${localTime(interval.start)} – ${localTime(interval.time)}${interval.partialInterval ? key === 'precipitation' ? ' · Estimated boundary interval' : ' · Gust for the overlapping hour' : ''}`;
                if ((key === 'wind' || key === 'gust') && Number.isFinite(value)) cell.dataset.strength = value < 20 ? 'calm' : value < 40 ? 'breezy' : value < 60 ? 'strong' : 'high';
            }
            line.append(cell); columns.get(row.time).push(cell);
        }
        body.append(line);
    }
    table.append(body);
    return { table, columns };
}
