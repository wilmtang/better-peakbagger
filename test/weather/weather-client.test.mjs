import test from 'node:test';
import assert from 'node:assert/strict';
import { WEATHER_MODELS, eligibleWeatherModels, recommendedWeatherModels } from '../../src/weather/weather-models.js';
import { createWeatherClient, weatherRequestUrl, validateWeatherResponse } from '../../src/weather/open-meteo-client.js';

const summit = { latitude: 46.851731, longitude: -121.760395, elevation: 4391, nation: 'united states' };
const window = { startDate: '2024-07-11', endDate: '2024-07-13', partial: false };
const model = WEATHER_MODELS[0];
export function weatherResponse({ startDate = window.startDate, model: selected = model } = {}) {
    const units = { time: 'unixtime', temperature_2m: '°C', precipitation: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', weather_code: 'wmo code' };
    const hourly = { time: Array.from({ length: 72 }, (_, i) => Date.parse(`${startDate}T00:00:00Z`) / 1000 + i * 3600) };
    for (const field of selected.fields) hourly[field] = hourly.time.map(() => field === 'weather_code' ? 3 : field === 'precipitation' ? 0.1 : 10);
    return { ...summit, utc_offset_seconds: 0, hourly_units: units, hourly };
}
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('model recommendations respect date, nation and projected regional grids', () => {
    const now = Date.parse('2026-10-10');
    assert.equal(recommendedWeatherModels(summit, '2024-07-12', now)[0].id, 'gfs_hrrr');
    assert.equal(recommendedWeatherModels({ ...summit, latitude: 21.3, longitude: -157.8 }, '2024-07-12', now)[0].id, 'ecmwf_ifs');
    assert.equal(recommendedWeatherModels({ ...summit, latitude: 64, longitude: -150 }, '2024-07-12', now)[0].id, 'ecmwf_ifs');
    assert.equal(recommendedWeatherModels({ ...summit, latitude: 49.85, longitude: -123, nation: 'canada' }, '2024-07-12', now)[0].id, 'gem_hrdps_continental');
    assert.equal(recommendedWeatherModels(summit, '2000-01-01', now)[0].id, 'era5_seamless');
    assert.equal(recommendedWeatherModels(summit, '1940-01-01', now)[0].id, 'era5');
    assert.equal(recommendedWeatherModels(summit, '1930-01-01', now).length, 0);
    assert.equal(eligibleWeatherModels(summit, '2024-07-12', now).some(item => item.id === 'ncep_nbm_conus'), false);
    assert.equal(eligibleWeatherModels(summit, '2026-10-10', now).some(item => item.id === 'era5'), false);
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

test('deadlines and caller cancellation settle a transport that ignores AbortSignal', async () => {
    const client = createWeatherClient({ fetchFn: () => new Promise(() => {}), timeoutMs: 15 });
    await assert.rejects(client.request(summit, window, model), { code: 'timeout' });
    const controller = new AbortController();
    const pending = client.request(summit, window, model, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});
