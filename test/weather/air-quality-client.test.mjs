import test from 'node:test';
import assert from 'node:assert/strict';
import { airQualityUrl, readAirQuality, airQualityCategory, createAirQualityClient } from '../../src/weather/air-quality-client.js';
import { airQualityFixture } from '../helpers/air-quality-fixture.mjs';
const now = Date.parse('2026-10-24T12:00:00Z'), point = { latitude: 46.85, longitude: -121.76 };
const fixture = () => airQualityFixture({ now });
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
test('AQI query sends only coordinates and bounded UTC forecast fields', () => {
    const url = new URL(airQualityUrl({ ...point, elevation: 4392, account: 'private' }));
    assert.equal(url.hostname, 'air-quality-api.open-meteo.com');
    assert.deepEqual([...url.searchParams.keys()], ['latitude', 'longitude', 'hourly', 'forecast_days', 'timezone', 'timeformat']);
    assert.throws(() => airQualityUrl({ latitude: NaN, longitude: 0 }));
    assert.equal(readAirQuality(fixture(), point, now).samples.length, 120);
    assert.deepEqual([0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301, null].map(airQualityCategory),
        ['Good', 'Good', 'Moderate', 'Moderate', 'Unhealthy for sensitive groups', 'Unhealthy for sensitive groups', 'Unhealthy', 'Unhealthy', 'Very unhealthy', 'Very unhealthy', 'Hazardous', 'Unavailable']);
});
test('AQI rejects wrong units, invalid geometry, times and values; missing is never zero', () => {
    for (const mutate of [d => d.hourly_units.us_aqi = 'EU', d => d.latitude = 0, d => d.hourly.time[1]++,
        d => d.hourly.us_aqi[0] = -1, d => d.hourly.pm2_5.pop(), d => d.hourly.time.push(now / 1000), d => d.error = true]) {
        const d = fixture(); mutate(d);
        assert.throws(() => readAirQuality(d, point, now));
    }
    const d = fixture(); d.hourly.pm2_5[0] = null;
    assert.equal(readAirQuality(d, point, now).samples[0].pm, null);
    d.hourly.us_aqi.fill(null); assert.throws(() => readAirQuality(d, point, now), /unavailable/);
});
test('client caches in memory, refreshes explicitly, bounds bodies and preserves rate limits', async () => {
    let calls = 0, options, mode = 'ok';
    const client = createAirQualityClient({ now: () => now, fetchFn: async (_, init) => {
        calls++; options = init;
        return mode === 'limited' ? new Response('', { status: 429 }) : mode === 'large' ? response('x'.repeat(70000)) : response(fixture());
    } });
    await client.request(point); await client.request(point); assert.equal(calls, 1);
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
    await client.request(point, { refresh: true }); assert.equal(calls, 2);
    mode = 'large'; await assert.rejects(client.request(point, { refresh: true }), /limit/);
    mode = 'limited'; await assert.rejects(client.request(point, { refresh: true }), /limit/);
    await assert.rejects(client.request(point, { refresh: true }), /limited/); assert.equal(calls, 4);
});
test('client cancellation and deadline bound even a transport that ignores abort', async () => {
    const client = createAirQualityClient({ now: () => now, timeoutMs: 10, fetchFn: () => new Promise(() => {}) });
    await assert.rejects(client.request(point), { name: 'TimeoutError' });
    const controller = new AbortController(); const flight = client.request(point, { signal: controller.signal }); controller.abort();
    await assert.rejects(flight, { name: 'AbortError' });
});
