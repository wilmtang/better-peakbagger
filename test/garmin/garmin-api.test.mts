// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminStore, GARMIN_DB, type GarminConnection } from '../../src/garmin/garmin-store.ts';
import { createGarminClient, garminActivityLabel, GarminError } from '../../src/garmin/garmin-api.ts';

type Fetcher = NonNullable<Parameters<typeof createGarminClient>[0]>['fetcher'];
const failure = (code: string) => (error: unknown) => error instanceof GarminError && error.code === code;
const key = 'fictional-personal-key-for-tests';
const jwt = () => `a.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 3600, garmin_guid: 'test-owner-guid' }))}.b`;
test('mountain activity inbox labels distinguish climbing and backcountry sports', () => {
    assert.equal(garminActivityLabel('mountaineering'), 'Mountaineering');
    assert.equal(garminActivityLabel('rock_climbing'), 'Rock climb');
    assert.equal(garminActivityLabel('backcountry_skiing_snowboarding'), 'Backcountry ski / snowboard');
});
test('API uses isolated transport, bounded token renewal and generic rejection', async () => {
    const calls: [string, RequestInit][] = []; let exchange = 0;
    const client = createGarminClient({ key, fetcher: (async (url: string, options: RequestInit) => {
        calls.push([url, options]);
        if (url.endsWith('/token')) return new Response(++exchange === 1 ? jwt() : '', { status: exchange === 1 ? 200 : 401 });
        return new Response('', { status: 401 });
    }) as Fetcher });
    await assert.rejects(client.owner(), error => failure('key-rejected')(error) && !/expired/.test((error as Error).message));
    assert.equal(calls.length, 3);
    for (const [url, options] of calls) { assert(url.startsWith('https://personal.connectapi.garmin.com/')); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); }
});
test('owner verified through authenticated API; list keeps the activity title and drops coordinates', async () => {
    let tokens = 0;
    const client = createGarminClient({ key, fetcher: (async (url: string) => {
        if (url.endsWith('/token')) { tokens++; return new Response(jwt()); }
        return Response.json(url.includes('userprofile') ? { displayName: 'not-used-as-identity' }
            : url.includes('/activity-service/') ? { activityId: 45, userProfileId: 123 }
                : [{ activityId: 45, ownerId: 123, startTimeLocal: '2026-10-23 08:00:00', activityName: ' Snohomish\u0000 County\n\u202eHiking ', startLatitude: 48, averageHR: 120, activityType: { typeKey: 'hiking' } }]);
    }) as Fetcher });
    assert.deepEqual(await client.owner(), { subject: 'test-owner-guid', owner: '123' });
    const list = await client.list({ from: '2026-10-01', to: '2026-10-23' });
    assert.deepEqual(Object.keys(list[0]), ['id', 'owner', 'name', 'date', 'localStart', 'utcStart', 'type']); assert.equal(tokens, 1);
    assert.equal(list[0].name, 'Snohomish County Hiking', 'control and format characters collapse to single spaces');
});
test('list bounds a long title and leaves a missing one empty', async () => {
    const rows = [{ activityId: 45, ownerId: 123, startTimeLocal: '2026-10-23 08:00:00', activityName: 'x'.repeat(500), activityType: { typeKey: 'hiking' } },
        { activityId: 46, ownerId: 123, startTimeLocal: '2026-10-23 09:00:00', activityName: 7, activityType: { typeKey: 'hiking' } }];
    const client = createGarminClient({ key, fetcher: (async (url: string) => url.endsWith('/token') ? new Response(jwt()) : Response.json(rows)) as Fetcher });
    const list = await client.list({ from: '2026-10-01', to: '2026-10-23' });
    assert.deepEqual(list.map(row => row.name.length), [120, 0]);
});
test('list keeps emoji sequences whole and never splits a surrogate pair', async () => {
    const climber = '\u{1F9D7}\u200D\u2640\uFE0F';
    const rows = [{ activityId: 45, ownerId: 123, startTimeLocal: '2026-10-23 08:00:00', activityName: `${climber} Ridge`, activityType: { typeKey: 'hiking' } },
        { activityId: 46, ownerId: 123, startTimeLocal: '2026-10-23 09:00:00', activityName: `${'x'.repeat(119)}\u{1F3D4}\uFE0F tail`, activityType: { typeKey: 'hiking' } }];
    const client = createGarminClient({ key, fetcher: (async (url: string) => url.endsWith('/token') ? new Response(jwt()) : Response.json(rows)) as Fetcher });
    const [joined, bounded] = await client.list({ from: '2026-10-01', to: '2026-10-23' });
    assert.equal(joined.name, `${climber} Ridge`);
    assert.equal(bounded.name, `${'x'.repeat(119)}\u{1F3D4}`, 'the bound counts code points');
});
test('network errors, limits and successful renewal do not claim rejected key', async () => {
    await assert.rejects(createGarminClient({ key, fetcher: (async () => { throw new Error(key); }) as Fetcher }).owner(),
        e => failure('offline')(e) && !(e as Error).message.includes(key));
    await assert.rejects(createGarminClient({ key, fetcher: (async () => new Response('', { status: 429, headers: { 'retry-after': '120' } })) as Fetcher }).owner(),
        e => failure('rate')(e) && (e as GarminError).retryAt > Date.now());
});
test('IndexedDB mutations serialize and survive a new store instance', async () => {
    const factory = new IDBFactory(); const a = createGarminStore(factory), b = createGarminStore(factory);
    await Promise.all(Array.from({ length: 10 }, () => a.mutate(s => { s.epoch++; })));
    assert.equal((await b.read()).epoch, 10); await a.close(); await b.close();
});
test('legacy cached summaries treat a saved key as enabled without rewriting credentials', async () => {
    const factory = new IDBFactory(), store = createGarminStore(factory);
    let database: IDBDatabase | undefined;
    try {
        // A legacy connection that still carries its former enabled flag.
        await store.mutate(state => { state.connection = { key, enabled: false } as GarminConnection; });
        database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(GARMIN_DB, 1);
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
            const tx = database!.transaction('state', 'readwrite');
            tx.objectStore('state').put({ configured: true, enabled: false, queued: 0 }, 'summary');
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        assert.equal((await store.summary()).enabled, true);
        assert.equal(((await store.read()).connection as { enabled?: boolean } | null)?.enabled, false);
    } finally { database?.close(); await store.close(); }
});
