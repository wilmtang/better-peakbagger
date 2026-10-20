// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnotelStations, nearbySnotelStations, validateSnotelData, snotelTimestamp, latestSnotelReading, snotelReportUrl } from '../../src/snow/snotel-data.js';
import { createSnotelClient, SNOTEL_CATALOG_KEY } from '../../src/snow/snotel-client.js';
import { snotelStations, snotelFixture } from '../helpers/snotel-fixture.mjs';

const NOW = Date.parse('2026-10-17T20:00:00Z');
const station = validateSnotelStations(snotelStations())[0];
const response = body => new Response(JSON.stringify(body));
const fetchFixture = async url => new URL(url).pathname.endsWith('/stations') ? response(snotelStations())
    : response(snotelFixture(new URL(url).searchParams.get('stationTriplets'), new URL(url).searchParams.get('duration'), NOW));

test('catalog validates identity, coordinates, elevation and fixed timezone without coercion', () => {
    assert.ok(Math.abs(station.elevation - 1569.72) < .01);
    assert.equal(station.offset, -8);
    for (const patch of [{ name: '' }, { latitude: '46' }, { longitude: 181 }, { dataTimeZone: null }, { stationTriplet: '679:WA:SCAN' }]) {
        assert.throws(() => validateSnotelStations([{ ...snotelStations()[0], ...patch }]), /invalid/);
    }
    assert.throws(() => validateSnotelStations([snotelStations()[0], snotelStations()[0]]), /invalid/);
    assert.throws(() => validateSnotelStations(Array(3001).fill(snotelStations()[0])), /invalid/);
    assert.throws(() => validateSnotelStations([]), /invalid/, 'an empty global network cannot prove local coverage');
});

test('local proximity is bounded, crosses state/date-line boundaries and caps three candidates', () => {
    const near = nearbySnotelStations(validateSnotelStations(snotelStations()), { latitude: 46.85, longitude: -121.76 });
    assert.equal(near[0].id, station.id); assert.ok(near[0].distance < 8000);
    assert.equal(nearbySnotelStations([station], { latitude: 40, longitude: -100 }).length, 0);
    const alaska = { ...station, latitude: 55, longitude: -179.9 };
    assert.equal(nearbySnotelStations([alaska], { latitude: 55, longitude: 179.9 }).length, 1);
    assert.equal(nearbySnotelStations(Array.from({ length: 5 }, (_, i) => ({ ...station, id: `${i}:WA:SNTL` })), station).length, 3);
    assert.throws(() => nearbySnotelStations([station], { latitude: NaN, longitude: 0 }), /Invalid/);
});

test('timestamps use station offsets and reject rollover dates and missing timezone data', () => {
    assert.equal(snotelTimestamp('2026-07-01 12:00', -8), Date.parse('2026-07-01T20:00:00Z'));
    assert.equal(snotelTimestamp('2026-07-01 12:00', -9), Date.parse('2026-07-01T21:00:00Z'));
    for (const date of ['2026-02-30 12:00', '2026-01-01 24:00', '2026-01-01T12:00Z']) assert.throws(() => snotelTimestamp(date, -8), /invalid/);
});

test('measurements preserve gaps, zero, units, per-sensor timestamps and provider flags', () => {
    const body = snotelFixture(station.id, 'HOURLY', NOW);
    body[0].data[0].values.at(-2).value = 0;
    const data = validateSnotelData(body, station, 'HOURLY', NOW);
    assert.equal(data.SNWD.at(-1).value, null);
    assert.equal(latestSnotelReading(data.SNWD).value, 0);
    assert.equal(latestSnotelReading(data.WTEQ).time, NOW - 2 * 3600_000);
    assert.equal(latestSnotelReading(data.SNWD).time, NOW - 3600_000);
    assert.equal(data.WTEQ[0].value, 12 * 25.4); assert.equal(data.SNWD[0].qa, 'P');
    assert.equal(latestSnotelReading([]), null);
    const missing = snotelFixture(station.id, 'DAILY', NOW); missing[0].data[0].error = 'Not supported';
    assert.equal(validateSnotelData(missing, station, 'DAILY', NOW).SNWD.length, 0);
});

test('foreign stations, wrong units, negative/coerced values and unordered/outside-window data fail closed', () => {
    const changes = [body => { body[0].stationTriplet = '375:WA:SNTL'; },
        body => { body[0].data[0].stationElement.storedUnitCode = 'cm'; },
        body => { body[0].data[0].values[0].value = -1; }, body => { body[0].data[0].values[0].value = '32'; },
        body => { body[0].data[0].values.reverse(); }, body => { body[0].data[0].values[0].date = '2020-01-01 00:00'; },
        body => { body[0].data[0].values.push(body[0].data[0].values.at(-1)); }];
    for (const change of changes) {
        const body = snotelFixture(station.id, 'HOURLY', NOW); change(body);
        assert.throws(() => validateSnotelData(body, station, 'HOURLY', NOW), /invalid/);
    }
    assert.match(snotelReportUrl(station), /679%3AWA%3ASNTL/);
    assert.throws(() => snotelReportUrl({ id: 'https://example.com' }), /Invalid/);
});

test('public catalog alone persists; measurement requests omit coordinates, credentials and referrer', async () => {
    const requests = [], stored = {};
    const client = createSnotelClient({ now: () => NOW, fetchFn: async (url, init) => { requests.push({ url, init }); return fetchFixture(url); },
        storage: { get: async () => stored, set: async values => Object.assign(stored, values) } });
    const stations = await client.stations(); await client.stations();
    const result = await client.observations(stations[0]); await client.observations(stations[0]);
    assert.equal(requests.length, 3); assert.equal(result.daily.SNWD.length, 8);
    assert.deepEqual(Object.keys(stored), [SNOTEL_CATALOG_KEY]); assert.deepEqual(stored[SNOTEL_CATALOG_KEY].stations, snotelStations());
    for (const { url, init } of requests) {
        assert.equal(new URL(url).origin, 'https://wcc.sc.egov.usda.gov');
        assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
        assert.doesNotMatch(url, /latitude|longitude|peak|climber|gpx|aid=|cid=/i);
    }
    await client.observations(stations[0], { refresh: true }); assert.equal(requests.length, 5);
    const cachedClient = createSnotelClient({ now: () => NOW, storage: { get: async () => stored }, fetchFn: () => { throw new Error('Unexpected network'); } });
    assert.deepEqual(await cachedClient.stations(), stations);
});

test('concurrent catalog readers share one validated cache/network flight', async () => {
    let reads = 0, requests = 0;
    const client = createSnotelClient({ now: () => NOW,
        storage: { get: async () => { reads++; return {}; } },
        fetchFn: url => { requests++; return fetchFixture(url); } });
    const [card, map] = await Promise.all([client.stations(), client.stations()]);
    assert.deepEqual(card, map);
    assert.equal(reads, 1, 'the public disk catalog is read once');
    assert.equal(requests, 1, 'the full network catalog is fetched once');
});

test('one catalog consumer can cancel without aborting the remaining reader', async () => {
    let release, transportSignal, started;
    const pending = new Promise(resolve => { started = resolve; });
    const client = createSnotelClient({ now: () => NOW, fetchFn: (_url, init) => {
        transportSignal = init.signal; started(); return new Promise(resolve => { release = resolve; });
    } });
    const first = new AbortController(), second = new AbortController();
    const card = client.stations({ signal: first.signal }), map = client.stations({ signal: second.signal });
    await pending;
    const cancelled = assert.rejects(card, { name: 'AbortError' }); first.abort(); await cancelled;
    assert.equal(transportSignal.aborted, false, 'a remaining consumer still owns the transport');
    release(response(snotelStations()));
    assert.equal((await map).length, 2);
});

test('the final cancelled catalog reader aborts the transport and a later reader starts fresh', { timeout: 5000 }, async () => {
    const held = [], writes = [];
    let started, restarted;
    const pending = new Promise(resolve => { started = resolve; });
    const next = new Promise(resolve => { restarted = resolve; });
    const client = createSnotelClient({ now: () => NOW, storage: { set: async value => writes.push(value) },
        fetchFn: (_url, init) => new Promise(resolve => {
            held.push({ init, resolve }); started(); if (held.length === 2) restarted();
        }) });
    const first = new AbortController(), second = new AbortController();
    const card = client.stations({ signal: first.signal }), map = client.stations({ signal: second.signal });
    await pending;
    const cancellations = Promise.all([assert.rejects(card, { name: 'AbortError' }), assert.rejects(map, { name: 'AbortError' })]);
    first.abort(); assert.equal(held[0].init.signal.aborted, false);
    second.abort(); assert.equal(held[0].init.signal.aborted, true, 'the last cancellation releases the source immediately');
    await cancellations;
    const replacement = client.stations();
    // The first flight may finish after the new one. It cannot clear or fill
    // the newer flight/cache, even when fetch ignores its aborted signal.
    held[0].resolve(response(snotelStations().map(value => ({ ...value, name: 'Stale' }))));
    await next;
    held[1].resolve(response(snotelStations()));
    assert.equal((await replacement)[0].name, station.name);
    assert.equal((await client.stations())[0].name, station.name);
    assert.equal(held.length, 2); assert.equal(writes.length, 1);
});

test('clearing a catalog abandons its flight and rejected flights can be retried', async () => {
    let release, started, calls = 0;
    const pending = new Promise(resolve => { started = resolve; });
    const client = createSnotelClient({ now: () => NOW, fetchFn: url => {
        if (++calls > 1) return fetchFixture(url);
        started(); return new Promise(resolve => { release = resolve; });
    } });
    const reading = client.stations(); await pending;
    const cancelled = assert.rejects(reading, { name: 'AbortError' }); client.clear(); await cancelled;
    const fresh = await client.stations();
    release(response(snotelStations().map(value => ({ ...value, name: 'Stale' }))));
    assert.deepEqual(await client.stations(), fresh); assert.equal(calls, 2);
    let fail = true;
    const retry = createSnotelClient({ now: () => NOW, fetchFn: url => fail ? new Response('', { status: 503 }) : fetchFixture(url) });
    await Promise.all([assert.rejects(retry.stations(), /unavailable/), assert.rejects(retry.stations(), /unavailable/)]);
    fail = false;
    assert.equal((await retry.stations()).length, 2);
});

test('expired, future or malformed catalog cache is replaced, and data cache expires', async () => {
    let clock = NOW, calls = 0;
    const client = createSnotelClient({ now: () => clock, fetchFn: url => { calls++; return fetchFixture(url); } });
    await client.observations(station); assert.equal(calls, 2);
    clock += 31 * 60_000; await client.observations(station); assert.equal(calls, 4);
    for (const saved of [{ version: 1, fetchedAt: NOW + 1, stations: snotelStations() },
        { version: 1, fetchedAt: NOW - 8 * 86400_000, stations: snotelStations() }, { version: 1, fetchedAt: NOW, stations: [{}] }]) {
        let fetched = false;
        const other = createSnotelClient({ now: () => NOW, storage: { get: async () => ({ [SNOTEL_CATALOG_KEY]: saved }) },
            fetchFn: url => { fetched = true; return fetchFixture(url); } });
        await other.stations(); assert.equal(fetched, true);
    }
});

test('rate limits stop subsequent calls, including missing or unexposed Retry-After', async () => {
    for (const headers of [{ 'retry-after': '120' }, {}]) {
        let calls = 0;
        const client = createSnotelClient({ now: () => NOW, fetchFn: async () => { calls++; return new Response('', { status: 429, headers }); } });
        await assert.rejects(client.observations(station), error => error.code === 'rate-limit' && error.retryAt > NOW);
        await assert.rejects(client.observations(station), /NRCS request limit/); assert.equal(calls, 1);
    }
});

test('cancellation and deadlines settle non-cooperative transports without caching late responses', async () => {
    let resolve, calls = 0;
    const client = createSnotelClient({ now: () => NOW, fetchFn: async () => { calls++; return new Promise(done => { resolve = done; }); } });
    const controller = new AbortController(), pending = client.observations(station, { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    resolve(response(snotelFixture(station.id, 'HOURLY', NOW)));
    const timed = createSnotelClient({ timeoutMs: 10, fetchFn: () => new Promise(() => {}) });
    await assert.rejects(timed.stations(), { name: 'TimeoutError' }); assert.equal(calls, 1);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(client.stations({ signal: cancelled.signal }), { name: 'AbortError' });
    const stuckStorage = createSnotelClient({ now: () => NOW, timeoutMs: 10,
        storage: { get: () => new Promise(() => {}) }, fetchFn: fetchFixture });
    assert.equal((await stuckStorage.stations()).length, 2, 'a stalled optional cache cannot block the API');
    const controller2 = new AbortController();
    const readingCache = stuckStorage.stations({ signal: controller2.signal });
    controller2.abort();
    // A memory-cache hit is already complete; a cold read must still cancel.
    await readingCache;
    stuckStorage.clear();
    const controller3 = new AbortController(), cold = stuckStorage.stations({ signal: controller3.signal });
    controller3.abort(); await assert.rejects(cold, { name: 'AbortError' });
});

test('oversized and failed responses cannot become an empty snow report or a partial cached result', async () => {
    const huge = createSnotelClient({ fetchFn: async () => new Response(' '.repeat(2_000_001)) });
    await assert.rejects(huge.stations(), { code: 'response-too-large' });
    let calls = 0;
    const failed = createSnotelClient({ now: () => NOW, fetchFn: async url => { calls++; return calls % 2 === 0 ? new Response('', { status: 503 }) : fetchFixture(url); } });
    await assert.rejects(failed.observations(station), /unavailable/);
    await assert.rejects(failed.observations(station), /unavailable/); assert.equal(calls, 4);
});

for (const stage of ['hourly headers', 'daily headers', 'daily body']) {
    test(`${stage} deadline aborts transport, reports timeout and allows immediate retry`, async () => {
        let stall = true, transportSignal, cancelledBody = false, calls = 0;
        const client = createSnotelClient({ now: () => NOW, timeoutMs: 20, fetchFn: (url, init) => {
            calls++;
            const target = new URL(url).searchParams.get('duration') === (stage.startsWith('daily') ? 'DAILY' : 'HOURLY');
            if (!stall || !target) return fetchFixture(url);
            transportSignal = init.signal;
            if (stage.endsWith('body')) return new Response(new ReadableStream({ cancel: () => { cancelledBody = true; } }));
            return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('Transport aborted'), { name: 'AbortError' }));
            }, { once: true }));
        } });
        await assert.rejects(client.observations(station), { name: 'TimeoutError' });
        assert.equal(transportSignal.aborted, true);
        if (stage.endsWith('body')) assert.equal(cancelledBody, true);
        const before = calls; stall = false;
        const result = await client.observations(station);
        assert.equal(result.daily.SNWD.length, 8);
        assert.equal(calls, before + 2, 'a partial timed-out observation was not cached');
        await client.observations(station); assert.equal(calls, before + 2);
    });
}
