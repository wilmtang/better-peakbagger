import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlyWeatherSeries as peakHourlySeries, hourlyWeatherColumns as peakHourlyConditions, hourlyWeatherColumns } from '../../src/weather/weather-hourly-table.js';
import { weatherDayWindow } from '../../src/weather/weather-day.js';
import { mountainTime } from '../../src/time/mountain-time.js';

const HOUR = 3600_000;
const series = window => Array.from({ length: 28 }, (_, i) => ({ time: Math.floor(window.start / HOUR) * HOUR + i * HOUR, temperature: i, wind: i, gust: i, precipitation: 1, code: 3 }));
const now = Date.parse('2025-01-01');

test('instantaneous graphs retain 23/25-hour local days and conditions include missing hours', () => {
    const zone = mountainTime.resolve(46.85, -121.75);
    for (const [date, length] of [['2024-03-10', 23], ['2024-11-03', 25]]) {
        const window = weatherDayWindow(date, zone, now), samples = series(window);
        assert.equal(peakHourlySeries(window, samples, 'temperature').length, length);
        const missing = samples.filter(sample => sample.time !== window.start + 3 * HOUR);
        const result = peakHourlySeries(window, missing, 'code');
        assert.equal(result.length, length); assert.equal(result[3].value, null);
        assert.equal(result.at(-1).time, window.end - HOUR);
    }
});

test('rain and gust graphs include the day’s ending midnight and exclude its starting midnight', () => {
    const zone = mountainTime.resolve(46.85, -121.75), window = weatherDayWindow('2024-11-04', zone, now);
    const samples = series(window);
    samples[0].precipitation = 100; samples[0].gust = 999;
    const end = samples.find(sample => sample.time === window.end); end.precipitation = 9; end.gust = 80;
    const rain = peakHourlySeries(window, samples, 'precipitation'), gust = peakHourlySeries(window, samples, 'gust');
    assert.equal(rain.length, 24); assert.equal(rain[0].time, window.start + HOUR);
    assert.equal(rain.at(-1).time, window.end); assert.equal(rain.at(-1).value, 9);
    assert.equal(rain.reduce((sum, row) => sum + row.value, 0), 32);
    assert.equal(Math.max(...gust.map(row => row.value)), 80);
    assert.equal(peakHourlySeries(window, samples, 'wind').at(-1).time, window.end - HOUR);
});

test('fractional-hour boundary rain is allocated consistently with daily totals while gusts remain maxima', () => {
    const zone = mountainTime.resolve(27.7, 85.3), window = weatherDayWindow('2024-11-04', zone, now);
    const samples = series(window), rain = peakHourlySeries(window, samples, 'precipitation'), gust = peakHourlySeries(window, samples, 'gust');
    assert.equal(rain.length, 25);
    assert.equal(rain[0].value, .75); assert.equal(rain.at(-1).value, .25);
    assert.equal(rain.reduce((sum, row) => sum + row.value, 0), 24);
    assert.equal(rain.at(-1).time, window.end); assert.ok(rain.at(-1).sourceTime > window.end);
    assert.equal(rain.at(-1).partialInterval, true);
    assert.equal(gust.at(-1).value, samples.find(sample => sample.time === gust.at(-1).sourceTime).gust);
    assert.equal(gust.at(-1).partialInterval, true);
});

test('missing values stay missing, zero rain stays zero and incomplete intervals never use a future sample', () => {
    const zone = mountainTime.resolve(46.85, -121.75), window = weatherDayWindow('2024-11-04', zone, now);
    const samples = series(window); samples[1].precipitation = null; samples[2].precipitation = 0;
    const rain = peakHourlySeries(window, samples, 'precipitation');
    assert.equal(rain[0].value, null); assert.equal(rain[1].value, 0);
    const partial = { ...window, partial: true, cutoff: window.start + 5.5 * HOUR };
    assert.equal(peakHourlySeries(partial, samples, 'precipitation').length, 5);
    assert.equal(peakHourlySeries(partial, samples, 'temperature').length, 6);
});

test('horizontal conditions align intervals with their start and preserve fractional and DST boundaries', () => {
    for (const [lat, lon, date, length] of [[46.85, -121.75, '2024-11-03', 25], [46.85, -121.75, '2024-03-10', 23], [27.7, 85.3, '2024-11-04', 25]]) {
        const zone = mountainTime.resolve(lat, lon), window = weatherDayWindow(date, zone, now), samples = series(window);
        const endSample = samples.find(sample => sample.time === Math.ceil(window.end / HOUR) * HOUR);
        endSample.precipitation = 8; endSample.gust = 80; endSample.temperature = 999;
        const rows = peakHourlyConditions(window, samples);
        assert.equal(rows.length, length); assert.equal(rows[0].time, window.start);
        assert.ok(rows.every(row => row.time < window.end && row.sample?.temperature !== 999));
        assert.equal(rows.at(-1).gust.value, 80);
        assert.equal(rows.at(-1).rain.value, lon === 85.3 ? 2 : 8);
        assert.equal(rows.reduce((sum, row) => sum + row.rain.value, 0), peakHourlySeries(window, samples, 'precipitation').reduce((sum, row) => sum + row.value, 0));
        if (lon === 85.3) { assert.equal(rows[0].sample, undefined); assert.equal(rows[0].rain.partialInterval, true); }
    }
});

test('shared hourly columns retain instantaneous archive gusts at DST and fractional boundaries', () => {
    for (const [lat, lon, date] of [[46.85, -121.75, '2024-11-03'], [46.85, -121.75, '2024-03-10'], [27.7, 85.3, '2024-11-04']]) {
        const zone = mountainTime.resolve(lat, lon), window = weatherDayWindow(date, zone, now), samples = series(window);
        samples.find(sample => sample.time === Math.ceil(window.end / HOUR) * HOUR).gust = 999;
        const rows = hourlyWeatherColumns(window, samples, 'instant');
        assert.ok(rows.every(row => row.gust?.value !== 999));
        for (const row of rows) {
            assert.equal(row.gust?.value ?? null, row.sample?.gust ?? null);
            if (row.gust) assert.equal(row.gust.start, row.gust.time);
        }
        if (lon === 85.3) { assert.equal(rows[0].gust, undefined); assert.equal(rows[0].rain.value, .75); }
    }
});
