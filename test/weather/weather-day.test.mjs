import test from 'node:test';
import assert from 'node:assert/strict';
import { mountainTime } from '../../src/time/mountain-time.js';
import { weatherDayWindow, summarizeWeatherDay } from '../../src/weather/weather-day.js';

const now = Date.parse('2026-10-10T12:00:00Z');
const zone = mountainTime.resolve(46.85, -121.76);
const samplesFor = window => {
    const samples = [];
    for (let time = Date.parse(`${window.startDate}T00:00:00Z`); time < Date.parse(`${window.endDate}T00:00:00Z`) + 86400_000; time += 3600_000) {
        samples.push({ time, temperature: 3, wind: 10, gust: 20, precipitation: 1, code: 0 });
    }
    return { samples };
};

test('historical winter offset and 23/25-hour days use the summit civil day', () => {
    for (const [date, start, hours] of [
        ['2024-01-15', '2024-01-15T08:00:00Z', 24],
        ['2024-03-10', '2024-03-10T08:00:00Z', 23],
        ['2024-11-03', '2024-11-03T07:00:00Z', 25],
    ]) {
        const window = weatherDayWindow(date, zone, now);
        assert.equal(window.start, Date.parse(start));
        assert.equal(window.end - window.start, hours * 3600_000);
        const day = summarizeWeatherDay(samplesFor(window), window);
        assert.equal(day.hourly.length, hours);
        assert.equal(day.precipitation.total, hours);
        assert.equal(day.coreComplete, true);
    }
});

test('precipitation excludes starting midnight and includes next midnight', () => {
    const window = weatherDayWindow('2024-07-12', zone, now);
    const data = samplesFor(window);
    data.samples.find(row => row.time === window.start).precipitation = 900;
    data.samples.find(row => row.time === window.end).precipitation = 5;
    assert.equal(summarizeWeatherDay(data, window).precipitation.total, 28);
});

test('fractional zones proportionally allocate both boundary accumulations', () => {
    for (const [lat, lon] of [[27.7, 85.3], [28.6, 77.2]]) {
        const window = weatherDayWindow('2024-07-12', mountainTime.resolve(lat, lon), now);
        const result = summarizeWeatherDay(samplesFor(window), window);
        assert.equal(result.precipitation.total, 24);
        assert.equal(result.precipitation.complete, true);
        assert.equal(result.precipitation.allocationEstimated, true);
    }
});

test('missing samples and unknown codes remain partial and never become zero', () => {
    const window = weatherDayWindow('2024-07-12', zone, now);
    const data = samplesFor(window);
    data.samples.forEach(row => { row.precipitation = null; row.gust = null; row.code = 100; });
    data.samples.find(row => row.time === window.start + 3600_000).code = 61;
    const result = summarizeWeatherDay(data, window);
    assert.equal(result.precipitation.total, null);
    assert.equal(result.gust.high, null);
    assert.equal(result.condition.label, 'Rain occurred');
    assert.equal(result.partial, true);
    assert.equal(result.condition.complete, false);
});

test('current day excludes future samples and unfinished precipitation intervals', () => {
    const window = weatherDayWindow('2024-07-12', zone, Date.parse('2024-07-12T12:30:00Z'));
    const result = summarizeWeatherDay(samplesFor(window), window);
    assert.equal(result.partial, true);
    assert.equal(result.hourly.length, 6);
    assert.equal(result.precipitation.total, 5);
    assert.equal(result.precipitation.complete, false);
});

test('date-line days, skipped dates, future dates and estimated timezones', () => {
    const apia = mountainTime.resolve(-13.83, -171.76);
    assert.throws(() => weatherDayWindow('2011-12-30', apia, now), /does not exist/);
    const beforeSkip = weatherDayWindow('2011-12-29', apia, now);
    assert.equal(beforeSkip.end - beforeSkip.start, 86400_000);
    assert.throws(() => weatherDayWindow('2027-01-01', zone, now), /future/);
    const estimated = mountainTime.resolve(0, 170, { lookup: () => { throw new Error(); } });
    assert.equal(estimated.estimated, true);
    assert.equal(weatherDayWindow('2024-07-12', estimated, now).start, Date.parse('2024-07-11T13:00:00Z'));
});
