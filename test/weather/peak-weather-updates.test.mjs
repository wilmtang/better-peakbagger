import test from 'node:test';
import assert from 'node:assert/strict';
import { PEAK_WEATHER_MODELS } from '../../src/weather/peak-weather-models.js';
import { peakModelUpdateDomains, validatePeakModelUpdate, createPeakModelUpdateClient } from '../../src/weather/peak-weather-updates.js';

const now = Date.parse('2026-10-11T12:00:00Z');
const body = { last_run_initialisation_time: now / 1000 - 7200, last_run_availability_time: now / 1000 - 1800, update_interval_seconds: 21600 };
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('model metadata maps known selection IDs and exposes both GFS products', () => {
    assert.deepEqual(peakModelUpdateDomains(PEAK_WEATHER_MODELS.find(model => model.id === 'gfs_global')), ['ncep_gfs013', 'ncep_gfs025']);
    assert.deepEqual(peakModelUpdateDomains(PEAK_WEATHER_MODELS.find(model => model.id === 'gfs_hrrr')), ['ncep_hrrr_conus']);
    assert.deepEqual(peakModelUpdateDomains(PEAK_WEATHER_MODELS.find(model => model.id === 'bom_access_global')), []);
    assert.throws(() => peakModelUpdateDomains({ id: 'gfs_global' }), /Invalid/);
});

test('update metadata separates availability from initialization and labels next time as a cadence estimate', () => {
    const result = validatePeakModelUpdate(body, now);
    assert.equal(result.run, now - 7200_000); assert.equal(result.lastUpdate, now - 1800_000);
    assert.equal(result.nextExpected, now + 19800_000);
    for (const patch of [{ last_run_availability_time: 0 }, { last_run_availability_time: now / 1000 + 3600 },
        { last_run_initialisation_time: now / 1000 }, { update_interval_seconds: 0 },
        { update_interval_seconds: 900.5 }, { update_interval_seconds: 1e10 }]) {
        assert.throws(() => validatePeakModelUpdate({ ...body, ...patch }, now), /Invalid/);
    }
    assert.ok(validatePeakModelUpdate({ ...body, last_run_availability_time: now / 1000 - 2 * 86400, last_run_initialisation_time: now / 1000 - 3 * 86400 }, now + 3 * 86400_000).nextExpected < now,
        'a delayed update must not be rolled forward into an invented future time');
});

test('optional metadata stays private, caches only in memory and obeys a shared cooldown', async () => {
    let calls = 0, clock = now, limited = false;
    const client = createPeakModelUpdateClient({ now: () => clock, fetchFn: async (url, init) => {
        calls++; assert.equal(url, 'https://api.open-meteo.com/data/ncep_gfs013/static/meta.json');
        assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
        return limited ? new Response('', { status: 429, headers: { 'retry-after': '1200' } }) : reply(body);
    } });
    const first = await client.request('ncep_gfs013'); assert.ok(first.data);
    assert.equal(await client.request('ncep_gfs013'), first); assert.equal(calls, 1);
    clock += 300_000; await client.request('ncep_gfs013'); assert.equal(calls, 2);
    limited = true; client.clear(); assert.equal((await client.request('ncep_gfs013')).data, null);
    client.clear(); assert.equal((await client.request('dwd_icon')).data, null); assert.equal(calls, 3);
    clock += 300_000; client.clear(); assert.equal((await client.request('dwd_icon')).data, null); assert.equal(calls, 3, 'clearing the cache cannot bypass Retry-After');
    await assert.rejects(client.request('../anything'), /Invalid/);
});

test('metadata failures and oversized or hung bodies cannot break or indefinitely stall weather', async () => {
    for (const fetchFn of [async () => new Response('', { status: 503 }), async () => reply({}),
        async () => new Response('x'.repeat(16385), { headers: { 'content-type': 'application/json' } }),
        () => new Promise(() => {}), async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise(() => {}) })]) {
        let calls = 0;
        const client = createPeakModelUpdateClient({ now: () => now, timeoutMs: 10, fetchFn: (...args) => { calls++; return fetchFn(...args); } });
        assert.equal((await client.request('ncep_gfs013')).data, null);
        assert.equal((await client.request('ncep_gfs013')).data, null); assert.equal(calls, 1);
    }
});

test('cancellation rejects a signal-ignoring fetch and does not poison the next request', async () => {
    let calls = 0;
    const client = createPeakModelUpdateClient({ now: () => now, fetchFn: () => ++calls === 1 ? new Promise(() => {}) : reply(body) });
    const controller = new AbortController(), pending = client.request('ncep_gfs013', { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    assert.ok((await client.request('ncep_gfs013')).data); assert.equal(calls, 2);
});
