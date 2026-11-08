import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error jsdom ships no declarations.
import { JSDOM } from 'jsdom';
import { compactWeatherHours, createWeatherHourlyTable, weatherWindColor } from '../../src/weather/weather-hourly-table.ts';
import type { WeatherMetric, WeatherSample, WeatherWindow } from '../../src/weather/weather-hourly-table.ts';
import { weatherDayWindow } from '../../src/weather/weather-day.js';
import { mountainTime } from '../../src/time/mountain-time.js';
import { units } from '../../src/ui/units.js';

const HOUR = 3600000;
function fixture(latitude = 46.85, longitude = -121.75, date = '2024-11-04') {
    const zone = mountainTime.resolve(latitude, longitude)!;
    const window: WeatherWindow = weatherDayWindow(date, zone, Date.parse('2025-01-01'));
    const samples: WeatherSample[] = Array.from({ length: 28 }, (_, index) => ({
        time: Math.floor(window.start / HOUR) * HOUR + index * HOUR, temperature: index - 8,
        apparent: index - 12, code: 3, cloud: 50, wind: 35, gust: index + 40, direction: 225,
        freezing: 3000, precipitation: 1, isDay: 1,
    }));
    return { zone, window, samples };
}
const format = (value: number | null | undefined, key: WeatherMetric) => units.formatWeather(value, key, key === 'temperature' || key === 'freezing' ? 'metric' : 'imperial') as string;
function withDocument(run: () => void) {
    const dom = new JSDOM('');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    try { run(); } finally {
        if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
        dom.window.close();
    }
}

test('compact Conditions keeps nine readings, caller units and the existing archive renderer', () => withDocument(() => {
    const input = fixture(), compact = createWeatherHourlyTable({ ...input, format, compact: true }).table;
    assert.deepEqual([...compact.tBodies[0].rows].map(row => row.dataset.weatherRow), ['code', 'temperature', 'wind', 'gust', 'direction', 'precipitation', 'cloud', 'apparent', 'freezing']);
    assert.equal(compact.querySelector('[data-weather-row="temperature"] th')!.textContent, 'Temperature°C');
    assert.equal(compact.querySelector('[data-weather-row="wind"] th')!.textContent, 'Windmph');
    assert.equal(compact.querySelector('[data-weather-row="freezing"] th')!.textContent, 'Freezing levelm');
    assert.equal(compact.querySelector('[data-weather-row="temperature"] td')!.textContent, '−8');
    assert.match(compact.querySelector('[data-weather-row="gust"] td')!.getAttribute('title')!, /12:00 AM PST.*01:00 AM PST/);
    assert.match(compact.querySelector('[data-weather-row="direction"] td')!.getAttribute('aria-label')!, /SW \(225°\)/);
    const archive = createWeatherHourlyTable({ ...input, format }).table;
    assert.equal(archive.classList.contains('bpb-weather-strip'), false);
    assert.equal(archive.tBodies[0].rows[0].textContent!.startsWith('Conditions'), true);
    assert.match(archive.querySelector('[data-weather-row="temperature"] td')!.textContent!, /°C/);
}));

test('missing values have no contour or band, zero remains zero and positive traces remain visible', () => withDocument(() => {
    const input = fixture(); input.samples[0].temperature = null; input.samples[1].wind = null;
    input.samples[1].precipitation = null; input.samples[2].precipitation = 0; input.samples[3].precipitation = .001;
    const table = createWeatherHourlyTable({ ...input, format, compact: true }).table;
    const missing = table.querySelector<HTMLTableCellElement>('[data-weather-row="temperature"] td')!;
    assert.equal(missing.textContent, '—'); assert.equal(missing.hasAttribute('data-temperature-tone'), false);
    assert.equal(table.querySelectorAll('[data-weather-row="wind"] td')[1].hasAttribute('data-wind-color'), false);
    const rain = table.querySelectorAll('[data-weather-row="precipitation"] td');
    assert.equal(rain[0].textContent, '—'); assert.equal(rain[1].textContent, '0.00'); assert.equal(rain[1].hasAttribute('data-rain'), false);
    assert.equal(rain[2].textContent, '<0.01');
}));

test('compact clocks retain fractional minutes, local dates and the two different DST hours', () => {
    const fold = fixture(46.85, -121.75, '2024-11-03');
    const rows = compactWeatherHours(fold.zone, Array.from({ length: 25 }, (_, i) => fold.window.start + i * HOUR));
    const repeated = rows.filter(row => row.clock === '01');
    assert.equal(repeated.length, 2); assert.deepEqual(repeated.map(row => row.zone), ['PDT', 'PST']);
    assert.ok(repeated.every(row => row.showZone)); assert.notEqual(repeated[0].title, repeated[1].title);
    const fractional = fixture(27.7, 85.3);
    const firstUtcHour = Math.ceil(fractional.window.start / HOUR) * HOUR;
    assert.equal(compactWeatherHours(fractional.zone, [firstUtcHour])[0].clock, '00:45');
});

test('longitude-estimate fallback keeps the pinned label short and labels exact times as estimated', () => withDocument(() => {
    const input = fixture();
    const zone = mountainTime.resolve(46.85, -121.75, { lookup: () => { throw new Error('No timezone'); } })!;
    const table = createWeatherHourlyTable({ ...input, zone, format, compact: true }).table;
    assert.equal(table.tHead!.rows[0].cells[0].textContent, 'Local time');
    assert.match(table.querySelector('time')!.title, /estimated from longitude/);
}));

test('fractional DST zone offsets fit compact headers without losing their full exact-time labels', () => {
    for (const [latitude, longitude, timeZone] of [[-31.55, 159.08, 'Australia/Lord_Howe'], [-43.95, -176.55, 'Pacific/Chatham']] as const) {
        const zone = mountainTime.resolve(latitude, longitude, { lookup: () => timeZone })!;
        const window = weatherDayWindow('2024-04-07', zone, Date.parse('2025-01-01'));
        const first = Math.ceil(window.start / HOUR) * HOUR;
        const times = Array.from({ length: 25 }, (_, index) => first + index * HOUR).filter(time => time < window.end);
        const hours = compactWeatherHours(zone, times);
        assert.equal(new Set(hours.map(row => row.zone)).size, 2);
        assert.ok(hours.every(row => row.displayZone.length <= 6));
        assert.ok(hours.some(row => row.displayZone.includes(':')));
        assert.ok(hours.every(row => row.title.includes(row.zone)));
    }
});

test('compact bands retain raw physical speed and interval gusts at fractional boundaries', () => withDocument(() => {
    const input = fixture(27.7, 85.3);
    const metric = createWeatherHourlyTable({ ...input, format: (value, key) => units.formatWeather(value, key, 'metric'), compact: true }).table;
    const imperial = createWeatherHourlyTable({ ...input, format: (value, key) => units.formatWeather(value, key, 'imperial'), compact: true }).table;
    const selector = '[data-weather-row="gust"] td';
    assert.equal((metric.querySelector(selector) as HTMLElement).style.getPropertyValue('--weather-strip-wind'), (imperial.querySelector(selector) as HTMLElement).style.getPropertyValue('--weather-strip-wind'));
    assert.match(metric.querySelector(selector)!.getAttribute('title')!, /Estimated|overlapping hour/);
    assert.equal(metric.querySelector('[data-weather-row="temperature"] td')!.textContent, '—');
    assert.notEqual(weatherWindColor(13), weatherWindColor(45));
}));
