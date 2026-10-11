import test from 'node:test';
import assert from 'node:assert/strict';
import { mountainTime } from '../../src/time/mountain-time.js';
import { weatherDayWindow, summarizeWeatherDay, hourlyWeatherCondition, knownWeatherCode } from '../../src/weather/weather-day.js';

const now = Date.parse('2026-10-10T12:00:00Z');
const zone = mountainTime.resolve(46.85, -121.76);
const samplesFor = window => {
    const samples = [];
    for (let time = Date.parse(`${window.startDate}T00:00:00Z`); time < Date.parse(`${window.endDate}T00:00:00Z`) + 86400_000; time += 3600_000) {
        samples.push({ time, temperature: 3, wind: 10, gust: 20, precipitation: 1, code: 0 });
    }
    return { samples };
};

test('hourly conditions retain code intensity and missing values never become clear skies', () => {
    for (const [code, label, icon] of [[0, 'Clear', 'sun'], [3, 'Overcast', 'cloud'], [48, 'Rime fog', 'fog'],
        [61, 'Light rain', 'rain'], [65, 'Heavy rain', 'rain'], [67, 'Heavy freezing rain', 'rain'],
        [71, 'Light snow', 'snow'], [86, 'Heavy snow showers', 'snow'], [97, 'Heavy thunderstorm', 'storm'], [99, 'Thunderstorm with heavy hail', 'storm']]) {
        assert.deepEqual(hourlyWeatherCondition(code), { label, icon });
        assert.equal(knownWeatherCode(code), true);
    }
    for (const code of [null, undefined, NaN, '0', -1, 4, 100, 61.5]) {
        assert.deepEqual(hourlyWeatherCondition(code), { label: 'Unavailable', icon: 'unknown' });
    }
    const window = weatherDayWindow('2024-07-12', zone, now), data = samplesFor(window);
    data.samples.find(row => row.time === window.start).code = 97;
    assert.equal(summarizeWeatherDay(data, window).condition.label, 'Thunderstorms');
});

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

test('gust timing follows the model contract across midnight, DST and fractional zones', () => {
    for (const [localZone, date] of [[zone, '2024-07-12'], [zone, '2024-03-10'], [zone, '2024-11-03'],
        [mountainTime.resolve(27.7, 85.3), '2024-07-12']]) {
        const window = weatherDayWindow(date, localZone, now), data = samplesFor(window);
        const first = Math.ceil(window.start / 3600_000) * 3600_000;
        const last = Math.ceil(window.end / 3600_000) * 3600_000;
        data.samples.find(row => row.time === first).gust = 100;
        data.samples.find(row => row.time === last).gust = 200;
        const instant = summarizeWeatherDay({ ...data, gustTiming: 'instant' }, window).gust;
        const interval = summarizeWeatherDay({ ...data, gustTiming: 'preceding-hour' }, window).gust;
        assert.equal(instant.high, 100); assert.equal(instant.complete, true);
        assert.equal(interval.high, 200); assert.equal(interval.complete, true);
        data.samples.find(row => row.time === first).gust = null;
        assert.equal(summarizeWeatherDay({ ...data, gustTiming: 'instant' }, window).gust.complete, false);
    }
});

test('current instantaneous gusts include returned samples but exclude the future', () => {
    const window = weatherDayWindow('2024-07-12', zone, Date.parse('2024-07-12T12:30:00Z'));
    const data = samplesFor(window);
    data.samples.find(row => row.time === window.start).gust = 100;
    data.samples.find(row => row.time === Date.parse('2024-07-12T13:00:00Z')).gust = 200;
    assert.equal(summarizeWeatherDay({ ...data, gustTiming: 'instant' }, window).gust.high, 100);
    assert.equal(summarizeWeatherDay({ ...data, gustTiming: 'preceding-hour' }, window).gust.high, 20);
});

test('fractional zones proportionally allocate both boundary accumulations', () => {
    for (const [lat, lon] of [[27.7, 85.3], [28.6, 77.2]]) {
        const window = weatherDayWindow('2024-07-12', mountainTime.resolve(lat, lon), now);
        const result = summarizeWeatherDay(samplesFor(window), window);
        assert.equal(result.precipitation.total, 24);
        assert.equal(result.precipitation.complete, true);
        assert.equal(result.precipitation.allocationEstimated, true);
        assert.equal(result.precipitationHours.reduce((sum, row) => sum + row.value, 0), result.precipitation.total);
        assert.equal(result.precipitationHours[0].start, window.start);
        assert.equal(result.precipitationHours.at(-1).time, window.end);
        assert.equal(result.precipitationHours.length, 25);
        assert.equal(result.precipitationHours[0].partialInterval, true);
        assert.equal(result.precipitationHours.at(-1).partialInterval, true);
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
    assert.ok(result.precipitationHours.every(row => row.sourceTime <= window.cutoff));
    assert.equal(result.precipitationHours.reduce((sum, row) => sum + row.value, 0), 5);
});

test('precipitation intervals retain unavailable slots instead of bridging missing timestamps', () => {
    const window = weatherDayWindow('2024-07-12', zone, now), data = samplesFor(window);
    data.samples = data.samples.filter(row => row.time !== window.start + 3600_000);
    const result = summarizeWeatherDay(data, window);
    assert.equal(result.precipitationHours.length, 24);
    assert.equal(result.precipitationHours[0].value, null);
    assert.equal(result.precipitationHours.filter(row => row.value !== null).reduce((sum, row) => sum + row.value, 0), result.precipitation.total);
});

test('sparse native series never pretend to cover the missing hourly intervals', () => {
    const window = weatherDayWindow('2024-07-12', zone, now);
    for (const interval of [3, 6]) {
        const data = samplesFor(window);
        data.samples = data.samples.filter((_, index) => index % interval === 0);
        data.samples.forEach(row => { row.code = null; });
        const result = summarizeWeatherDay(data, window);
        assert.equal(result.partial, true);
        assert.equal(result.temperature.complete, false);
        assert.equal(result.precipitation.complete, false);
        assert.ok(result.precipitation.total < 24);
        assert.equal(result.condition.label, 'Conditions unavailable');
        assert.equal(result.condition.icon, 'unknown');
    }
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
