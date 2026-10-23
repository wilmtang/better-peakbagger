import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { createGarminClient } from '../../src/garmin/garmin-api.js';
const key = 'fictional-personal-key-for-tests';
const jwt = () => `a.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 3600 }))}.b`;
test('API uses isolated transport, bounded token renewal and generic rejection', async () => {
    const calls = []; let exchange = 0;
    const client = createGarminClient({ key, fetcher: async (url, options) => {
        calls.push([url, options]);
        if (url.endsWith('/token')) return new Response(++exchange === 1 ? jwt() : '', { status: exchange === 1 ? 200 : 401 });
        return new Response('', { status: 401 });
    } });
    await assert.rejects(client.owner(), error => error.code === 'key-rejected' && !/expired/.test(error.message));
    assert.equal(calls.length, 3);
    for (const [url, options] of calls) { assert(url.startsWith('https://personal.connectapi.garmin.com/')); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); }
});
test('owner verified through authenticated API; list drops names and coordinates', async () => {
    let tokens = 0;
    const client = createGarminClient({ key, fetcher: async url => {
        if (url.endsWith('/token')) { tokens++; return new Response(jwt()); }
        return Response.json(url.includes('userprofile') ? { userData: { userProfilePk: 123 } }
            : [{ activityId: 45, ownerId: 123, startTimeLocal: '2026-10-23 08:00:00', activityName: 'private name', startLatitude: 48, averageHR: 120, activityType: { typeKey: 'hiking' } }]);
    } });
    assert.equal(await client.owner(), '123');
    const list = await client.list({ from: '2026-10-01', to: '2026-10-23' });
    assert.deepEqual(Object.keys(list[0]), ['id', 'owner', 'date', 'localStart', 'utcStart', 'type']); assert.equal(tokens, 1);
});
test('network errors, limits and successful renewal do not claim rejected key', async () => {
    await assert.rejects(createGarminClient({ key, fetcher: async () => { throw new Error(key); } }).owner(), e => e.code === 'offline' && !e.message.includes(key));
    await assert.rejects(createGarminClient({ key, fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) }).owner(), e => e.code === 'rate' && e.retryAt > Date.now());
});
test('IndexedDB mutations serialize and survive a new store instance', async () => {
    const factory = new IDBFactory(); const a = createGarminStore(factory), b = createGarminStore(factory);
    await Promise.all(Array.from({ length: 10 }, () => a.mutate(s => { s.epoch++; })));
    assert.equal((await b.read()).epoch, 10); await a.close(); await b.close();
});
