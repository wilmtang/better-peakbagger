import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_BEST_MATCH, WEATHER_MODELS, eligibleWeatherModels } from '../../src/weather/weather-models.js';
import { createWeatherClient, weatherRequestUrl, validateWeatherResponse } from '../../src/weather/open-meteo-client.js';

const summit = { latitude: 46.851731, longitude: -121.760395, elevation: 4391 };
const window = { startDate: '2024-07-11', endDate: '2024-07-13', partial: false };
const model = WEATHER_MODELS[0];
export function weatherResponse({ startDate = window.startDate, model: selected = model } = {}) {
    const units = { time: 'unixtime', temperature_2m: '°C', precipitation: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', weather_code: 'wmo code' };
    const hourly = { time: Array.from({ length: 72 }, (_, i) => Date.parse(`${startDate}T00:00:00Z`) / 1000 + i * 3600) };
    for (const field of selected.fields) hourly[field] = hourly.time.map(() => field === 'weather_code' ? 3 : field === 'precipitation' ? 0.1 : 10);
    return { ...summit, utc_offset_seconds: 0, hourly_units: units, hourly };
}
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('validated data carries packaged model gust timing, with CERRA and forecasts retaining interval maxima', () => {
    for (const selected of WEATHER_MODELS.filter(item => item.fields.includes('wind_gusts_10m'))) {
        const expected = ['best_match', 'ecmwf_ifs', 'era5_seamless', 'era5'].includes(selected.id) ? 'instant' : 'preceding-hour';
        assert.equal(validateWeatherResponse(weatherResponse({ model: selected }), summit, window, selected).gustTiming, expected);
    }
});

test('archive Best Match uses the packaged archive endpoint across its date coverage', () => {
    const url = new URL(weatherRequestUrl(summit, window, ARCHIVE_BEST_MATCH));
    assert.equal(url.origin + url.pathname, 'https://archive-api.open-meteo.com/v1/archive');
    assert.equal(url.searchParams.get('models'), 'best_match');
    assert.equal(url.searchParams.get('hourly'), ARCHIVE_BEST_MATCH.fields.join(','));
    for (const date of ['1940-01-01', '2000-01-01', '2024-07-12']) {
        assert.ok(eligibleWeatherModels(summit, date, Date.parse('2026-10-11')).includes(ARCHIVE_BEST_MATCH));
    }
    const first = new URL(weatherRequestUrl(summit, { startDate: '1939-12-31', endDate: '1940-01-02' }, ARCHIVE_BEST_MATCH));
    assert.equal(first.searchParams.get('start_date'), '1940-01-01');
});

test('model eligibility respects archive dates and projected regional grids', () => {
    const now = Date.parse('2026-10-10');
    assert.ok(eligibleWeatherModels(summit, '2024-07-12', now).some(item => item.id === 'gfs_hrrr'));
    assert.equal(eligibleWeatherModels({ ...summit, latitude: 21.3, longitude: -157.8 }, '2024-07-12', now).some(item => item.id === 'gfs_hrrr'), false);
    assert.equal(eligibleWeatherModels({ ...summit, latitude: 64, longitude: -150 }, '2024-07-12', now).some(item => item.id === 'gfs_hrrr'), false);
    assert.ok(eligibleWeatherModels({ ...summit, latitude: 49.85, longitude: -123 }, '2024-07-12', now).some(item => item.id === 'gem_hrdps_continental'));
    assert.ok(eligibleWeatherModels(summit, '2000-01-01', now).some(item => item.id === 'era5_seamless'));
    assert.ok(eligibleWeatherModels(summit, '1940-01-01', now).some(item => item.id === 'era5'));
    assert.equal(eligibleWeatherModels(summit, '1930-01-01', now).length, 0);
    assert.equal(eligibleWeatherModels(summit, '2024-07-12', now).some(item => item.id === 'ncep_nbm_conus'), false);
    assert.equal(eligibleWeatherModels(summit, '2026-10-10', now).some(item => item.id === 'era5'), false);
    const newZealand = { latitude: -43.6, longitude: 170.14 };
    const nzNow = Date.parse('2026-10-10T12:00:00Z'); // October 11 at the summit
    assert.ok(eligibleWeatherModels(newZealand, '2026-10-11', nzNow).some(item => item.id === 'ecmwf_ifs'));
    assert.equal(eligibleWeatherModels(newZealand, '2026-10-12', nzNow).length, 0);
    const alps = { latitude: 46, longitude: 7 };
    assert.ok(eligibleWeatherModels(alps, '2020-01-01', now).some(item => item.id === 'cerra'));
    assert.equal(eligibleWeatherModels(alps, '2022-01-01', now).some(item => item.id === 'cerra'), false);
});

test('fixed-host request never accepts caller model, URL or overlong dates', () => {
    const url = new URL(weatherRequestUrl(summit, window, model));
    assert.equal(url.host, 'historical-forecast-api.open-meteo.com');
    assert.equal(url.searchParams.get('timezone'), 'GMT');
    assert.equal(url.searchParams.get('elevation'), '4391');
    assert.throws(() => weatherRequestUrl(summit, window, { ...model, endpoint: 'https://evil.test' }));
    assert.throws(() => weatherRequestUrl(summit, { ...window, endDate: '2025-07-13' }, model));
});

test('UTC padding is clipped at an archive boundary without substituting the ascent date', () => {
    const era5 = WEATHER_MODELS.find(item => item.id === 'era5');
    const first = new URL(weatherRequestUrl(summit, { startDate: '1939-12-31', endDate: '1940-01-02' }, era5));
    assert.equal(first.searchParams.get('start_date'), '1940-01-01');
    assert.equal(first.searchParams.get('end_date'), '1940-01-02');
    const cerra = WEATHER_MODELS.find(item => item.id === 'cerra');
    const last = new URL(weatherRequestUrl(summit, { startDate: '2021-06-29', endDate: '2021-07-01' }, cerra));
    assert.equal(last.searchParams.get('end_date'), '2021-06-30');
    assert.throws(() => weatherRequestUrl(summit, { startDate: '1939-01-01', endDate: '1939-01-03' }, era5), { code: 'unavailable' });
});

test('response contract validates units, aligned arrays, coordinate/elevation and timestamps', () => {
    assert.equal(validateWeatherResponse(weatherResponse(), summit, window, model).samples.length, 72);
    for (const corrupt of [
        body => { body.hourly.temperature_2m[0] = '3'; },
        body => { body.hourly.precipitation.pop(); },
        body => { body.hourly_units.temperature_2m = '°F'; },
        body => { body.hourly.time[1] = body.hourly.time[0]; },
        body => { body.latitude = 0; },
        body => { body.elevation = null; },
        body => { body.utc_offset_seconds = -3600; },
    ]) {
        const body = weatherResponse(); corrupt(body);
        assert.throws(() => validateWeatherResponse(body, summit, window, model), { code: 'invalid-response' });
    }
    const body = weatherResponse(); body.hourly.temperature_2m[0] = null;
    assert.equal(validateWeatherResponse(body, summit, window, model).samples[0].temperature, null);
});

test('negative precipitation becomes unavailable without weakening other value checks', () => {
    const body = weatherResponse();
    body.hourly.precipitation.splice(0, 4, -0.1, -100, 0, null);
    Object.freeze(body.hourly.precipitation);
    const data = validateWeatherResponse(body, summit, window, model);
    assert.deepEqual(data.samples.slice(0, 4).map(row => row.precipitation), [null, null, 0, null]);
    assert.equal(data.samples[4].precipitation, 0.1);
    assert.equal(data.samples[0].temperature, 10);
    assert.equal(body.hourly.precipitation[0], -0.1, 'the provider response must remain unchanged');
    for (const value of ['-0.1', NaN, -Infinity, Infinity, 2001]) {
        const invalid = weatherResponse(); invalid.hourly.precipitation[0] = value;
        assert.throws(() => validateWeatherResponse(invalid, summit, window, model), { code: 'invalid-response' });
    }
    const invalid = weatherResponse(); invalid.hourly.wind_speed_10m[0] = -1;
    assert.throws(() => validateWeatherResponse(invalid, summit, window, model), { code: 'invalid-response' });
});

test('per-page client deduplicates and caches valid results with no credentials or referrer', async () => {
    let calls = 0;
    const client = createWeatherClient({ fetchFn: async (url, init) => {
        calls++; assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
        assert.equal(new URL(url).searchParams.has('aid'), false); return response(weatherResponse());
    } });
    const [a, b] = await Promise.all([client.request(summit, window, model), client.request(summit, window, model)]);
    assert.equal(a, b); assert.equal(calls, 1);
    await client.request(summit, window, model); assert.equal(calls, 1);
    client.clear(); await client.request(summit, window, model); assert.equal(calls, 2);
});

test('429, missing archive and oversized responses are classified without retry', async () => {
    for (const [fetchFn, code] of [
        [async () => new Response('', { status: 429 }), 'rate-limit'],
        [async () => new Response('', { status: 400 }), 'unavailable'],
        [async () => new Response('', { status: 503 }), 'service'],
        [async () => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': String(129 * 1024) } }), 'response-too-large'],
    ]) await assert.rejects(createWeatherClient({ fetchFn }).request(summit, window, model), { code });
});

test('a confirmed limit survives unreadable bodies and gates new requests while cached results stay usable', async () => {
    let now = 1700000000000, calls = 0, cancelled = false;
    const client = createWeatherClient({ now: () => now, fetchFn: async () => {
        calls++;
        if (calls !== 2) return response(weatherResponse());
        return { status: 429, headers: new Headers({ 'retry-after': '120' }),
            body: { cancel() { cancelled = true; } }, text() { throw new Error('must not read'); } };
    } });
    const cached = await client.request(summit, window, model);
    const other = WEATHER_MODELS.find(item => item !== model);
    await assert.rejects(client.request(summit, window, other), { code: 'rate-limit', retryAt: now + 120000 });
    assert.equal(cancelled, true);
    assert.equal(await client.request(summit, window, model), cached);
    client.clear();
    await assert.rejects(client.request(summit, window, model), { code: 'rate-limit' });
    assert.equal(calls, 2);
    now += 120001;
    await client.request(summit, window, model); assert.equal(calls, 3);
});

test('deadlines and caller cancellation settle a transport that ignores AbortSignal', async () => {
    const client = createWeatherClient({ fetchFn: () => new Promise(() => {}), timeoutMs: 15 });
    await assert.rejects(client.request(summit, window, model), { code: 'timeout' });
    const controller = new AbortController();
    const pending = client.request(summit, window, model, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});
