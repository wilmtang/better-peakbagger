import test from 'node:test';
import assert from 'node:assert/strict';
import { mountainTime } from '../../src/time/mountain-time.js';
import { weatherWeekWindow, summarizeWeatherWeek } from '../../src/weather/weather-week.js';
import { createRecentWeatherClient, recentWeatherRequestUrl, validateRecentWeatherResponse, weatherRequestUrl, validateWeatherResponse } from '../../src/weather/open-meteo-client.js';
import { WEATHER_MODELS } from '../../src/weather/weather-models.js';

const summit = { latitude: 46.851731, longitude: -121.760395, elevation: 4391 };
const zone = mountainTime.resolve(summit.latitude, summit.longitude);
const window = weatherWeekWindow(zone, Date.parse('2024-03-12T12:00:00Z'));
function responseBody(window) {
    const start = Date.parse(window.startDate), end = Date.parse(window.endDate) + 86400_000;
    const time = Array.from({ length: (end - start) / 3600_000 }, (_, i) => (start + i * 3600_000) / 1000);
    return { ...summit, utc_offset_seconds: 0,
        hourly_units: { time: 'unixtime', temperature_2m: '°C', precipitation: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', weather_code: 'wmo code' },
        hourly: { time, temperature_2m: time.map(() => 3), precipitation: time.map(() => 1), wind_speed_10m: time.map(() => 10), wind_gusts_10m: time.map(() => 20), weather_code: time.map(() => 0) } };
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
