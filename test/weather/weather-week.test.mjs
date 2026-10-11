import test from 'node:test';
import assert from 'node:assert/strict';
import { mountainTime } from '../../src/time/mountain-time.js';
import { weatherWeekWindow, weatherPeakWindow, summarizeWeatherWeek } from '../../src/weather/weather-week.js';
import { weatherDayWindow } from '../../src/weather/weather-day.js';
import { createRecentWeatherClient, createPeakWeatherClient, recentWeatherRequestUrl, peakWeatherRequestUrl,
    validateRecentWeatherResponse, validatePeakWeatherResponse, weatherRequestUrl, validateWeatherResponse } from '../../src/weather/open-meteo-client.js';
import { PEAK_WEATHER_MODELS } from '../../src/weather/peak-weather-models.js';
import { WEATHER_MODELS } from '../../src/weather/weather-models.js';

const models = [PEAK_WEATHER_MODELS.find(model => model.id === 'gfs_global')];
const summit = { latitude: 46.851731, longitude: -121.760395, elevation: 4391 };
const zone = mountainTime.resolve(summit.latitude, summit.longitude);
const window = weatherWeekWindow(zone, Date.parse('2024-03-12T12:00:00Z'));
function responseBody(window) {
    const start = Date.parse(window.startDate), end = Date.parse(window.endDate) + 86400_000;
    const time = Array.from({ length: (end - start) / 3600_000 }, (_, i) => (start + i * 3600_000) / 1000);
    return { ...summit, utc_offset_seconds: 0,
        hourly_units: { time: 'unixtime', temperature_2m: '°C', precipitation: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', weather_code: 'wmo code', apparent_temperature: '°C', wind_direction_10m: '°', is_day: '' },
        hourly: { time, apparent_temperature: time.map(() => -2), wind_direction_10m: time.map(() => 225), is_day: time.map(() => 1), temperature_2m: time.map(() => 3), precipitation: time.map(() => 1), wind_speed_10m: time.map(() => 10), wind_gusts_10m: time.map(() => 20), weather_code: time.map(() => 0) } };
}

test('week is seven completed summit civil days across DST and the date line', () => {
    for (const [lat, lon, now, first, last, hours] of [
        [46.85, -121.76, '2024-03-12T12:00:00Z', '2024-03-05', '2024-03-11', 167],
        [46.85, -121.76, '2024-11-05T12:00:00Z', '2024-10-29', '2024-11-04', 169],
        [-43.6, 170.14, '2024-07-12T12:30:00Z', '2024-07-06', '2024-07-12', 168],
        [27.7, 85.3, '2024-07-12T12:30:00Z', '2024-07-05', '2024-07-11', 168],
    ]) {
        const nowMs = Date.parse(now), week = weatherWeekWindow(mountainTime.resolve(lat, lon), nowMs);
        assert.equal(week.days.length, 7);
        assert.equal(week.days[0].date, first); assert.equal(week.days.at(-1).date, last);
        assert.equal((week.days.at(-1).end - week.days[0].start) / 3600_000, hours);
        assert.ok(week.days.every(day => day.end <= nowMs && !day.partial));
        assert.ok(Date.parse(week.endDate) + 86400_000 > week.days.at(-1).end);
    }
});

test('weekly summaries include midnight accumulation and exclude yesterday’s gust from today', () => {
    const body = responseBody(window), day = window.days.at(-1);
    body.hourly.wind_gusts_10m[body.hourly.time.indexOf(day.start / 1000)] = 500;
    body.hourly.wind_gusts_10m[body.hourly.time.indexOf(day.end / 1000)] = 100;
    body.hourly.precipitation[body.hourly.time.indexOf(day.end / 1000)] = 5;
    const days = summarizeWeatherWeek(validateRecentWeatherResponse(body, summit, window), window);
    assert.equal(days.at(-1).gust.high, 100);
    assert.equal(days.at(-1).precipitation.total, 28);
    assert.equal(days.find(day => day.window.date === '2024-03-10').hourly.length, 23);
    assert.ok(days.every(day => day.coreComplete));
    body.hourly.precipitation.fill(null);
    const missing = summarizeWeatherWeek(validateRecentWeatherResponse(body, summit, window), window);
    assert.ok(missing.every(day => day.partial && day.precipitation.total === null));
});

test('recent requests use fixed automatic forecast endpoint and preserve strict ascent bounds', () => {
    const url = new URL(recentWeatherRequestUrl(summit, window));
    assert.equal(url.origin, 'https://api.open-meteo.com');
    assert.equal(url.pathname, '/v1/forecast');
    assert.equal(url.searchParams.has('models'), false);
    assert.equal(url.searchParams.get('timeformat'), 'unixtime');
    assert.equal(url.searchParams.get('timezone'), 'GMT');
    assert.equal(url.searchParams.get('elevation'), '4391');
    assert.throws(() => recentWeatherRequestUrl(summit, { ...window, endDate: '2024-04-12' }));
    assert.throws(() => recentWeatherRequestUrl(summit, { ...window, startDate: '2024-02-30' }));
    assert.throws(() => weatherRequestUrl(summit, window, WEATHER_MODELS[0]));
    assert.throws(() => validateWeatherResponse(responseBody(window), summit, window, WEATHER_MODELS[0]));
});

test('precipitation-only days retain useful partial totals instead of disappearing', () => {
    const body = responseBody(window);
    for (const field of ['temperature_2m', 'wind_speed_10m', 'wind_gusts_10m', 'weather_code']) body.hourly[field].fill(null);
    const days = summarizeWeatherWeek(validateRecentWeatherResponse(body, summit, window), window);
    assert.ok(days.every(day => day.useful && day.partial && day.precipitation.complete));
    assert.ok(days.every(day => day.condition.label === 'Conditions unavailable' && day.temperature.high === null));
    assert.equal(days.at(-1).precipitation.total, 24);
});

test('weekly response stays bounded and validates all fields, grid, timestamps and missing values', () => {
    const body = responseBody(window);
    assert.equal(validateRecentWeatherResponse(body, summit, window).samples.length, 192);
    for (const corrupt of [
        body => body.hourly.time.push(body.hourly.time.at(-1) + 3600),
        body => { body.hourly.temperature_2m[0] = '2'; },
        body => { body.hourly_units.precipitation = 'inch'; },
        body => { body.hourly.wind_gusts_10m.pop(); },
        body => { body.longitude = 0; },
        body => { body.elevation = 0; },
        body => { body.hourly.time[1] = body.hourly.time[0]; },
        body => { body.hourly.time[0] -= 3600; },
    ]) {
        const changed = responseBody(window); corrupt(changed);
        assert.throws(() => validateRecentWeatherResponse(changed, summit, window), { code: 'invalid-response' });
    }
    const large = responseBody({ startDate: '2024-03-01', endDate: '2024-03-10' });
    assert.throws(() => validateRecentWeatherResponse(large, summit, { startDate: '2024-03-01', endDate: '2024-03-10' }), { code: 'invalid-response' });
    body.hourly.temperature_2m.fill(null);
    assert.equal(validateRecentWeatherResponse(body, summit, window).samples[0].temperature, null);
});

test('weekly transport has bounded caching, private requests, errors and cancellation', async () => {
    let calls = 0;
    const client = createRecentWeatherClient({ fetchFn: async (url, init) => {
        calls++; assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
        assert.equal(init.redirect, 'error'); assert.ok(!/[?&](?:pid|cid|name|gpx)=/.test(url));
        return new Response(JSON.stringify(responseBody(window)), { headers: { 'content-type': 'application/json' } });
    } });
    const [a, b] = await Promise.all([client.request(summit, window), client.request(summit, window)]);
    assert.equal(a, b); assert.equal(calls, 1);
    await client.request(summit, window); assert.equal(calls, 1);
    client.clear(); await client.request(summit, window); assert.equal(calls, 2);
    const hanging = createRecentWeatherClient({ fetchFn: () => new Promise(() => {}), timeoutMs: 15 });
    await assert.rejects(hanging.request(summit, window), { code: 'timeout' });
    const controller = new AbortController(), pending = hanging.request(summit, window, { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(createRecentWeatherClient({ fetchFn: async () => new Response('', { status: 400 }) }).request(summit, window), /Recent weather is unavailable/);
});

test('peak window covers sixteen completed and sixteen forecast days without exceeding the UTC API horizon', () => {
    for (const [lat, lon, clock, first, last, hours, pastFirst, pastHours] of [
        [46.85, -121.76, '2024-03-09T12:00:00Z', '2024-03-09', '2024-03-24', 383, '2024-02-22', 384],
        [46.85, -121.76, '2024-11-02T12:00:00Z', '2024-11-02', '2024-11-17', 385, '2024-10-17', 384],
        [46.85, -121.76, '2024-03-12T12:00:00Z', '2024-03-12', '2024-03-27', 384, '2024-02-25', 383],
        [46.85, -121.76, '2024-11-05T12:00:00Z', '2024-11-05', '2024-11-20', 384, '2024-10-20', 385],
        [-43.6, 170.14, '2024-07-12T12:30:00Z', '2024-07-13', '2024-07-28', 384, '2024-06-27', 384],
        [27.7, 85.3, '2024-07-12T12:30:00Z', '2024-07-12', '2024-07-27', 384, '2024-06-26', 384],
        [46.85, -121.76, '2024-07-12T01:30:00Z', '2024-07-11', '2024-07-26', 384, '2024-06-25', 384],
        [1.87, -157.43, '2024-07-12T12:30:00Z', '2024-07-13', '2024-07-28', 384, '2024-06-27', 384],
        [46.85, -121.76, '2025-01-05T12:00:00Z', '2025-01-05', '2025-01-20', 384, '2024-12-20', 384],
    ]) {
        const now = Date.parse(clock), zone = mountainTime.resolve(lat, lon), peak = weatherPeakWindow(zone, now);
        assert.equal(peak.forecast.days.length, 16); assert.equal(peak.past.days.length, 16);
        assert.equal(peak.past.days[0].date, pastFirst);
        assert.equal((peak.past.days.at(-1).end - peak.past.days[0].start) / 3600_000, pastHours);
        assert.equal(peak.today, first); assert.equal(peak.forecast.days.at(-1).date, last);
        assert.equal(peak.past.days.at(-1).end, peak.forecast.days[0].start);
        assert.equal((peak.forecast.days.at(-1).end - peak.forecast.days[0].start) / 3600_000, hours);
        assert.ok(peak.forecast.days.every(day => day.cutoff === day.end && !day.partial));
        assert.ok(peak.past.days.every(day => day.end <= now && !day.partial));
        assert.ok(Date.parse(peak.startDate) <= peak.past.days[0].start);
        const apiLastDate = Date.parse(`${clock.slice(0, 10)}T00:00:00Z`) + 15 * 86400_000;
        assert.equal(Date.parse(peak.endDate), apiLastDate);
        assert.ok((apiLastDate - Date.parse(peak.startDate)) / 86400_000 <= 32);
        assert.doesNotThrow(() => peakWeatherRequestUrl(summit, peak, models));
        const data = validatePeakWeatherResponse(responseBody(peak), summit, peak, models).models.gfs_global;
        assert.ok(summarizeWeatherWeek(data, peak.past).every(day => day.coreComplete && !day.partial));
        const summaries = summarizeWeatherWeek(data, peak.forecast);
        assert.ok(summaries.slice(0, -1).every(day => day.coreComplete));
        assert.equal(summaries.at(-1).partial, peak.forecast.days.at(-1).end >= apiLastDate + 86400_000);
        assert.equal(peak.partial, true);
        assert.throws(() => weatherDayWindow(peak.forecast.days[1].date, zone, now), /future ascent/);
    }
});

test('combined request validates padded future data without widening ascent or past-only bounds', () => {
    const peak = weatherPeakWindow(zone, Date.parse('2024-11-05T12:00:00Z'));
    const url = new URL(peakWeatherRequestUrl(summit, peak, models));
    assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
    assert.equal(url.searchParams.get('models'), 'gfs_global');
    assert.equal(url.searchParams.get('start_date'), peak.startDate);
    assert.equal(url.searchParams.get('end_date'), peak.endDate);
    assert.equal(url.searchParams.get('elevation'), '4391');
    const body = responseBody(peak), data = validatePeakWeatherResponse(body, summit, peak, models).models.gfs_global;
    const forecast = summarizeWeatherWeek(data, peak.forecast);
    assert.ok(forecast.slice(0, -1).every(day => day.coreComplete && day.precipitation.total === 24 && day.hourly.length === 24));
    assert.equal(forecast.at(-1).hourly.length, 16);
    assert.equal(forecast.at(-1).precipitation.total, 15);
    assert.equal(forecast.at(-1).partial, true);
    assert.ok(forecast[0].hourly.some(row => row.time > Date.parse('2024-11-05T12:00:00Z')));
    assert.throws(() => weatherRequestUrl(summit, peak, WEATHER_MODELS[0]));
    assert.throws(() => recentWeatherRequestUrl(summit, peak));
    assert.throws(() => validateRecentWeatherResponse(body, summit, peak), { code: 'invalid-response' });
    assert.throws(() => peakWeatherRequestUrl(summit, { ...peak, endDate: '2024-12-01' }, models));
    const maximum = { startDate: '2024-11-01', endDate: '2024-12-03' };
    assert.equal(validatePeakWeatherResponse(responseBody(maximum), summit, maximum, models).models.gfs_global.samples.length, 792);
    assert.doesNotThrow(() => peakWeatherRequestUrl(summit, maximum, models));
    const oversizedWindow = { ...maximum, endDate: '2024-12-04' }, oversized = responseBody(oversizedWindow);
    assert.throws(() => peakWeatherRequestUrl(summit, oversizedWindow, models));
    assert.throws(() => validatePeakWeatherResponse(oversized, summit, oversizedWindow, models), { code: 'invalid-response' });
});

test('past and forecast share one private request with a five-minute cache and known limit cooldown', async () => {
    const peak = weatherPeakWindow(zone, Date.parse('2024-11-05T12:00:00Z'));
    let calls = 0, now = Date.parse('2024-11-05T12:00:00Z'), limited = false;
    const client = createPeakWeatherClient({ now: () => now, fetchFn: async (_, init) => {
        calls++; assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
        assert.equal(init.redirect, 'error');
        return limited ? new Response('', { status: 429, headers: { 'retry-after': '120' } })
            : new Response(JSON.stringify(responseBody(peak)), { headers: { 'content-type': 'application/json' } });
    } });
    const [past, forecast] = await Promise.all([client.request(summit, peak, models), client.request(summit, peak, models)]);
    assert.equal(past, forecast); assert.equal(calls, 1);
    assert.equal(summarizeWeatherWeek(past.models.gfs_global, peak.past).length, 16);
    assert.equal(summarizeWeatherWeek(forecast.models.gfs_global, peak.forecast).length, 16);
    now += 299_999; await client.request(summit, peak, models); assert.equal(calls, 1);
    now += 1; await client.request(summit, peak, models); assert.equal(calls, 2);
    limited = true; client.clear(); await assert.rejects(client.request(summit, peak, models), { code: 'rate-limit' });
    client.clear(); await assert.rejects(client.request(summit, peak, models), { code: 'rate-limit' }); assert.equal(calls, 3);
});
