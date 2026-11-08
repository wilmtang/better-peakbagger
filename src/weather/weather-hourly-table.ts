// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { mountainTime } from '../time/mountain-time.js';
import { hourlyWeatherCondition } from './weather-day.js';
import { createWeatherIcon } from './weather-icon.js';
import { units } from '../ui/units.js';

export type WeatherMetric = 'code' | 'cloud' | 'temperature' | 'apparent' | 'precipitation' | 'freezing' | 'wind' | 'gust' | 'direction';
export type WeatherZone = NonNullable<ReturnType<typeof mountainTime.resolve>>;
export interface WeatherWindow { date: string; start: number; end: number; cutoff: number; partial: boolean }
export interface WeatherSample extends Partial<Record<WeatherMetric, number | null>> { time: number; isDay?: number | null }
export interface HourlyWeatherReading { time: number; sourceTime: number; start: number; value: number | null; partialInterval: boolean }
export type WeatherFormat = (value: number | null | undefined, key: WeatherMetric) => string;
type GustTiming = 'preceding-hour' | 'instant';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const weatherIcon = createWeatherIcon as (kind: string, options: { night: boolean; className: string; label: string; title: string }) => HTMLElement;

const HOUR = 3600_000, element = dom.element;
const measurements: [WeatherMetric, string][] = [['code', 'Conditions'], ['cloud', 'Cloud cover'], ['temperature', 'Temperature'], ['apparent', 'Feels like'], ['precipitation', 'Rain/snow'], ['freezing', 'Freezing level'], ['wind', 'Wind'], ['gust', 'Gusts'], ['direction', 'Wind from']];
const compactOrder: WeatherMetric[] = ['code', 'temperature', 'wind', 'gust', 'direction', 'precipitation', 'cloud', 'apparent', 'freezing'];

// Shared by the two hourly strips. Preserve fractional-zone minutes and make
// repeated civil hours distinguishable instead of rounding them into an hour.
export function compactWeatherHours(zone: WeatherZone, times: number[]) {
    const readings = times.map(time => {
        const minutes = mountainTime.localMinute(zone, time)!;
        const clock = `${String(Math.floor(minutes / 60)).padStart(2, '0')}${minutes % 60 ? `:${String(minutes % 60).padStart(2, '0')}` : ''}`;
        const date = mountainTime.localDate(zone, time)!;
        return { time, date, clock, zone: mountainTime.zoneLabel(zone, time)!, title: `${date} ${mountainTime.formatClock(zone, time)} ${mountainTime.zoneLabel(zone, time)}` };
    });
    const keys = new Map<string, number>();
    readings.forEach(row => keys.set(`${row.date}/${row.clock}`, (keys.get(`${row.date}/${row.clock}`) || 0) + 1));
    const changesZone = new Set(readings.map(row => row.zone)).size > 1;
    return readings.map(row => ({ ...row, showZone: changesZone || keys.get(`${row.date}/${row.clock}`)! > 1 }));
}

// Palette thresholds are physical km/h, independent of the displayed units.
export function weatherWindColor(kmh: number) {
    const stops = [[0, 219, 241, 246], [13, 139, 222, 239], [26, 74, 199, 220], [35, 174, 212, 66], [45, 241, 221, 52], [56, 243, 174, 64], [72, 235, 135, 117]];
    const next = stops.findIndex(stop => stop[0] >= kmh);
    if (next <= 0) return next < 0 ? 'rgb(235 135 117)' : 'rgb(219 241 246)';
    const a = stops[next - 1], b = stops[next], fraction = (kmh - a[0]) / (b[0] - a[0]);
    return `rgb(${[1, 2, 3].map(index => Math.round(a[index] + (b[index] - a[index]) * fraction)).join(' ')})`;
}

export function sizeWeatherStrip(table: HTMLTableElement, hours: number) {
    table.style.setProperty('--weather-hour-count', String(hours));
    const group = document.createElement('colgroup');
    for (let index = 0; index <= hours; index++) group.append(document.createElement('col'));
    table.prepend(group);
}

const formatKey = (key: WeatherMetric): WeatherMetric => key === 'apparent' ? 'temperature' : key === 'gust' ? 'wind' : key;
function compactUnit(format: WeatherFormat, key: WeatherMetric) {
    const kind = formatKey(key), example = format(0, kind);
    return [units.symbol(kind, 'metric'), units.symbol(kind, 'imperial')].find(unit => unit && example.endsWith(unit)) || '';
}
function compactValue(formatted: string, unit: string, key: WeatherMetric, value: number | null | undefined) {
    const text = unit && formatted.endsWith(unit) ? formatted.slice(0, -unit.length).trim() : formatted;
    // A positive trace must not become a dry hour when the owning formatter
    // rounds to zero. Keep its existing precision and selected unit.
    if (key === 'precipitation' && finite(value) && value > 0 && Number(text) === 0) {
        const digits = text.split('.')[1]?.length || 0;
        return digits ? `<${(10 ** -digits).toFixed(digits)}` : '<1';
    }
    return text;
}

// Instantaneous fields exclude ending midnight; accumulations include it and
// exclude starting midnight. Missing timestamps remain explicit empty slots.
export function hourlyWeatherSeries(window: WeatherWindow, samples: WeatherSample[], metric: WeatherMetric, gustTiming: GustTiming = 'preceding-hour') {
    const byTime = new Map(samples.map(sample => [sample.time, sample]));
    const accumulation = metric === 'precipitation';
    const interval = accumulation || (metric === 'gust' && gustTiming === 'preceding-hour');
    const rows: HourlyWeatherReading[] = [];
    const first = interval ? Math.floor(window.start / HOUR) * HOUR + HOUR : Math.ceil(window.start / HOUR) * HOUR;
    const limit = interval ? Math.ceil(window.cutoff / HOUR) * HOUR : window.cutoff - 1;
    for (let time = first; time <= limit; time += HOUR) {
        if (interval && window.partial && time > window.cutoff) continue;
        const start = interval ? Math.max(time - HOUR, window.start) : time;
        const end = interval ? Math.min(time, window.cutoff) : time;
        const partialInterval = interval && end - start !== HOUR;
        let value = byTime.get(time)?.[metric] ?? null;
        if (accumulation && finite(value)) value *= (end - start) / HOUR;
        rows.push({ time: end, sourceTime: time, start, value, partialInterval });
    }
    return rows;
}

// Put accumulations under the start of their actual interval, alongside the
// readings at that instant. Fractional-hour boundaries never borrow a reading.
export function hourlyWeatherColumns(window: WeatherWindow, samples: WeatherSample[], gustTiming: GustTiming = 'preceding-hour') {
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

export function createWeatherHourlyTable({ window, samples, zone, format, gustTiming = 'preceding-hour', keys = measurements.map(([key]) => key), compact = false }: {
    window: WeatherWindow; samples: WeatherSample[]; zone: WeatherZone; format: WeatherFormat; gustTiming?: GustTiming; keys?: WeatherMetric[]; compact?: boolean;
}) {
    const hours = hourlyWeatherColumns(window, samples, gustTiming), columns = new Map<number, HTMLTableCellElement[]>();
    const labels = compact ? compactWeatherHours(zone, hours.map(row => row.time)) : [];
    const localTime = (time: number) => `${mountainTime.formatClock(zone, time)} ${mountainTime.zoneLabel(zone, time)}`;
    const table = element('table', { class: `bpb-weather-hourly-table${compact ? ' bpb-weather-strip bpb-weather-strip--conditions' : ''}`, 'aria-label': 'Hourly weather' }) as HTMLTableElement;
    if (compact) sizeWeatherStrip(table, hours.length);
    const head = element('tr', {}, [element('th', { scope: 'col', text: compact ? zone.estimated || labels.some(row => row.showZone) ? 'Local time' : `Time · ${labels[0]?.zone || ''}` : 'Hours' })]);
    for (const [index, row] of hours.entries()) {
        const cell = element('th', { scope: 'col', class: 'bpb-weather-conditions-hour', 'data-weather-time': row.time }, [
            element('time', { datetime: new Date(row.time).toISOString(), title: compact ? labels[index].title : localTime(row.time), text: compact ? labels[index].clock : mountainTime.formatClock(zone, row.time).replace(/^0/, '').replace(':00', '') }),
            ...(!compact || labels[index].showZone ? [element('span', { class: 'bpb-weather-hour-zone', text: mountainTime.zoneLabel(zone, row.time) })] : []),
        ]);
        if (compact && row.sample?.isDay === 0) cell.dataset.night = 'true';
        head.append(cell); columns.set(row.time, [cell]);
    }
    table.append(element('thead', {}, [head]));
    const body = element('tbody');
    const ordered = compact ? compactOrder.map(key => measurements.find(([fieldKey]) => key === fieldKey)!) : measurements;
    const temperatures = hours.map(row => row.sample?.temperature).filter(finite);
    const minimum = Math.min(...temperatures), range = Math.max(1, Math.max(...temperatures) - minimum);
    for (const [key, label] of ordered.filter(([fieldKey]) => keys.includes(fieldKey))) {
        const unit = compact && !['code', 'direction'].includes(key) ? compactUnit(format, key) : '';
        const heading = element('th', { scope: 'row', text: compact && key === 'code' ? 'Weather' : label });
        if (unit) heading.append(element('span', { class: 'bpb-weather-strip-unit', text: unit }));
        if (compact && key === 'freezing') heading.title = 'Freezing level above sea level';
        if (compact && key === 'precipitation') heading.title = 'Rain and snow as liquid water equivalent';
        const line = element('tr', { 'data-weather-row': key }, [heading]);
        for (const [index, row] of hours.entries()) {
            const interval = key === 'precipitation' ? row.rain : key === 'gust' ? row.gust : null;
            const value = interval ? interval.value : ['precipitation', 'gust'].includes(key) ? null : row.sample?.[key];
            const cell = element('td', { 'data-weather-time': row.time }) as HTMLTableCellElement;
            if (key === 'code') {
                const condition = hourlyWeatherCondition(value);
                cell.append(weatherIcon(condition.icon, { night: row.sample?.isDay === 0, className: 'bpb-weather-hour-icon',
                    label: condition.label, title: `${localTime(row.time)} · ${condition.label}` }));
            } else if (key === 'direction' && finite(value)) {
                const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(value / 45) % 8];
                cell.title = `Wind from ${compass} (${Math.round(value)}°)`;
                cell.append(element('span', { class: 'bpb-weather-wind-arrow', 'aria-hidden': 'true', style: `transform: rotate(${value}deg)`, text: '↓' }), element('span', { text: compass }));
                if (compact) { cell.setAttribute('aria-label', cell.title); cell.lastElementChild!.classList.add('bpb-weather-strip-compass'); }
            } else {
                const formatted = format(value, formatKey(key));
                cell.textContent = compact ? compactValue(formatted, unit, key, value) : formatted;
                if (interval) cell.title = key === 'gust' && gustTiming === 'instant' ? `${localTime(row.time)} · Instantaneous gust estimate`
                    : `${localTime(interval.start)} – ${localTime(interval.time)}${interval.partialInterval ? key !== 'gust' ? ' · Estimated boundary interval' : ' · Gust for the overlapping hour' : ''}`;
                if ((key === 'wind' || key === 'gust') && finite(value)) {
                    if (compact) { cell.dataset.windColor = ''; cell.style.setProperty('--weather-strip-wind', weatherWindColor(value)); }
                    else cell.dataset.strength = value < 20 ? 'calm' : value < 40 ? 'breezy' : value < 60 ? 'strong' : 'high';
                }
                if (compact && key === 'temperature' && finite(value)) {
                    const contour = (other: typeof row | undefined) => other && Math.abs(other.time - row.time) <= HOUR && finite(other.sample?.temperature) ? other.sample.temperature : value;
                    const y = (temperature: number) => 75 - (temperature - minimum) / range * 45;
                    cell.dataset.temperatureTone = value < 0 ? 'cold' : 'warm';
                    cell.style.setProperty('--weather-temp-left', `${(y(contour(hours[index - 1])) + y(value)) / 2}%`);
                    cell.style.setProperty('--weather-temp-right', `${(y(value) + y(contour(hours[index + 1]))) / 2}%`);
                    cell.replaceChildren(element('span', { class: 'bpb-weather-strip-temperature', text: cell.textContent }));
                }
                if (compact && key === 'cloud' && finite(value)) cell.style.setProperty('--weather-cloud-fill', `${Math.max(0, Math.min(100, value)) * .36}%`);
                if (compact && key === 'precipitation' && finite(value) && value > 0) { cell.dataset.rain = ''; cell.style.setProperty('--weather-rain-fill', `${Math.min(75, Math.sqrt(value / 5) * 75)}%`); }
            }
            line.append(cell); columns.get(row.time)!.push(cell);
        }
        body.append(line);
    }
    table.append(body);
    return { table, columns };
}
