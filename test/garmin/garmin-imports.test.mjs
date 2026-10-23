import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { createGarminImports, importRange } from '../../src/garmin/garmin-imports.js';
import { GarminError } from '../../src/garmin/garmin-api.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
const sender = { id: 'test', url: 'chrome-extension://test/options/inbox.html', tab: { id: 1 }, frameId: 0 };
async function setup(overrides = {}) {
    const store = createGarminStore(new IDBFactory()); const alarms = new Map();
    const prefs = { ...Schema.DEFAULTS, garminHistoryStart: '2026-01-01', ...overrides.prefs };
    const row = { id: '12', owner: '123', date: '2026-10-23', localStart: '2026-10-23 08:00:00', type: 'hiking' };
    const counts = { lists: 0, downloads: 0, preparations: 0 };
    const imports = createGarminImports({ ext: { runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}` },
        permissions: { contains: async () => overrides.permission ? overrides.permission() : true, remove: async () => true }, alarms: { clear: async key => alarms.delete(key), create: async (key, value) => alarms.set(key, value) } },
    store, settings: { requireCurrent: async () => prefs },
    clientFactory: options => { overrides.onClient?.(options); return { owner: async () => '123', list: async () => { counts.lists++; return [row]; }, recording: async () => { counts.downloads++; return new Uint8Array(); }, ...overrides.api }; },
    clock: overrides.clock || Date.now, date: overrides.date,
    binding: overrides.binding || (async () => ({ cid: '456' })), decode: async () => ({ segments: [] }),
    prepare: overrides.prepare || (async () => { counts.preparations++; return { analysis: { matches: [{ id: 987 }] } }; }),
    });
    await imports.connect('fictional-personal-key');
    await imports.handle({ type: 'GARMIN_ENABLE' }, sender);
    return { imports, store, prefs, counts, alarms, row };
}
test('date scopes clip recent checks and widen for catch-up', () => {
    assert.deepEqual(importRange({ garminRecentDays: 30, garminHistoryStart: '2026-10-20' }, '', 0, false, '2026-10-23'), { from: '2026-10-20', to: '2026-10-23' });
    assert.equal(importRange({ garminRecentDays: 7, garminHistoryStart: 'all' }, '', Date.parse('2026-09-01'), false, '2026-10-23').from, '2026-08-31');
});
test('default mountain group imports climbing and backcountry skiing without admitting unrelated sports', async () => {
    const included = ['hiking', 'walking', 'trail_running', 'mountaineering', 'rock_climbing', 'backcountry_skiing_snowboarding'];
    const excluded = ['resort_skiing_snowboarding', 'cross_country_skiing', 'indoor_climbing', 'cycling', 'other'];
    const rows = [...included, ...excluded].map((type, i) => ({ id: String(i + 1), owner: '123', date: '2026-10-23', type }));
    const { imports, store, prefs, counts } = await setup({ date: () => '2026-10-23', api: { list: async () => rows } });
    try {
        await imports.check();
        assert.deepEqual(Object.values((await store.read()).items).map(item => item.summary.type), included);
        await imports.check(); await imports.check();
        assert.equal(counts.downloads, included.length, 'overlapping checks do not redownload the expanded group');
        prefs.garminActivityTypes = 'all'; await imports.settingsChanged(); await imports.check();
        assert.deepEqual(Object.values((await store.read()).items).map(item => item.summary.type), [...included, ...excluded]);
    } finally { await store.close(); }
});
test('durable activity IDs avoid duplicate downloads and survive disconnect', async () => {
    const { imports, counts, store } = await setup();
    await imports.check(); await imports.check();
    assert.equal(counts.downloads, 1); assert.equal(counts.preparations, 1);
    await imports.disconnect();
    assert.equal(Object.keys((await store.read()).items).length, 1); assert.equal((await store.read()).connection.key, null);
    await store.close();
});
test('dismissal tombstone prevents recreation; verified save removes completed snapshot', async () => {
    const { imports, store, counts } = await setup(); await imports.check();
    await imports.saved('12', '987', '789');
    assert.equal(Object.keys((await store.read()).items).length, 0);
    await imports.check(); assert.equal(counts.downloads, 1); assert.equal((await store.read()).receipts['12'].peaks['987'], '789'); await store.close();
});
test('manual mode never schedules discovery; concurrent checks coalesce', async () => {
    const { imports, alarms, counts, store } = await setup({ prefs: { garminCheckHours: 0 } });
    assert.equal(alarms.size, 0);
    await Promise.all([imports.check(), imports.check(), imports.check()]); assert.equal(counts.downloads, 1); assert.equal(alarms.size, 0); await store.close();
});
test('incomplete pagination retains a cursor and no successful checkpoint', async () => {
    const { imports, store } = await setup({ api: { list: async () => Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), date: '2026-10-23', owner: '123', type: 'hiking' })) } });
    await imports.check(); const state = await store.read();
    assert.equal(state.lastCheck, 0); assert.equal(state.scan.offset, 135); await store.close();
});
test('rejected key pauses alarms and retains drafts', async () => {
    const { imports, store, alarms } = await setup({ api: { list: async () => { throw new GarminError('key-rejected'); } } });
    await store.mutate(s => { s.items['1'] = { id: '1' }; }); await imports.check();
    assert.equal((await store.read()).error.code, 'key-rejected'); assert.equal(alarms.size, 0);
    assert.equal(Object.keys((await store.read()).items).length, 1); await store.close();
});
test('untrusted messages cannot read retained routes or credentials', async () => {
    const { imports, store } = await setup();
    assert.equal((await imports.handle({ type: 'GARMIN_STATUS' }, { ...sender, url: 'https://www.peakbagger.com/' })).ok, false);
    const summary = await imports.handle({ type: 'GARMIN_SUMMARY' }, { ...sender, url: 'chrome-extension://test/popup/popup.html' });
    assert.equal(summary.items, undefined); assert.equal(JSON.stringify(summary).includes('fictional-personal-key'), false); await store.close();
});

test('credential imports preserve consent and ignore independent scope epochs', async () => {
    const { imports, prefs, store } = await setup();
    const snapshot = await imports.readSnapshot();
    const next = await imports.verifyImportedKey('replacement-fictional-key', snapshot);
    prefs.garminRecentDays = 14; await imports.settingsChanged();
    assert.equal((await imports.replaceIfSnapshot(snapshot, next)).replaced, true);
    assert.equal((await store.read()).connection.enabled, true);
    const onNewDevice = await imports.verifyImportedKey('replacement-fictional-key', { epoch: 0, connection: null });
    assert.equal(onNewDevice.enabled, false);
    const before = await imports.readSnapshot();
    await imports.connect('newer-fictional-key');
    assert.equal((await imports.replaceIfSnapshot(before, next)).replaced, false);
    assert.equal((await store.read()).connection.key, 'newer-fictional-key'); await store.close();
});

test('dismissal offers durable Undo, then frees the snapshot while retaining its tombstone', async () => {
    let now = Date.now(); const { imports, store } = await setup({ clock: () => now }); await imports.check();
    await imports.handle({ type: 'GARMIN_DISMISS', id: '12' }, sender);
    assert.equal((await imports.snapshot()).pending, 0); assert.equal((await imports.snapshot()).history[0].undoAvailable, true);
    await imports.handle({ type: 'GARMIN_UNDO', id: '12' }, sender);
    assert.equal((await imports.snapshot()).pending, 1);
    await imports.handle({ type: 'GARMIN_DISMISS', id: '12' }, sender); now += 60001;
    assert.equal((await imports.snapshot()).history[0].undoAvailable, false);
    assert.equal((await store.read()).items['12'], undefined);
    await imports.check(); assert.equal((await imports.snapshot()).pending, 0); await store.close();
});
test('public list and summary never serialize retained routes, draft fields or credentials', async () => {
    const { imports, store } = await setup(); await imports.check();
    await store.mutate(s => { s.items['12'].analysis = { matches: [{ id: 1, name: 'Peak', draftFields: { private: 'derived-fields' } }], route: [[{ lat: 12.3456789, lon: -12, time: 123 }]], waypoints: [] }; });
    const serialized = JSON.stringify(await imports.snapshot());
    assert(!serialized.includes('12.3456789')); assert(!serialized.includes('derived-fields')); assert(!serialized.includes('fictional-personal-key'));
    const summary = await store.summary(); assert.equal(summary.pending, 1); assert.equal(summary.items, undefined); await store.close();
});
test('bounded continuation drains queued preparation without rescanning completed metadata', async () => {
    const { imports, store, counts } = await setup(); await imports.check(); const lists = counts.lists;
    await store.mutate(s => { for (let i = 20; i < 25; i++) s.items[i] = { ...s.items['12'], id: String(i), phase: 'waiting', analysis: null }; s.preparePending = true; });
    await imports.check(false, true);
    assert.equal(counts.lists, lists); assert.equal(counts.preparations, 4); assert.equal((await store.read()).preparePending, true);
    await imports.check(false, true); assert.equal((await store.read()).preparePending, false); await store.close();
});
test('capacity pauses intake without starving already queued preparation', async () => {
    const { imports, store, counts, row } = await setup();
    await store.mutate(s => { for (let i = 1000; i < 1200; i++) s.items[i] = { id: String(i), owner: '123', cid: '456', summary: row, phase: 'waiting', saved: [] }; });
    await imports.check(); assert.equal(counts.preparations, 3); assert.equal((await store.read()).error.code, 'capacity');
    const lists = counts.lists; await imports.check(false, true); assert.equal(counts.preparations, 6); assert.equal(counts.lists, lists); await store.close();
});
test('permission removal cancels an active read and preserves pending drafts', async () => {
    let granted = true, signal, started;
    const ready = new Promise(resolve => { started = resolve; });
    const { imports, store, alarms } = await setup({ permission: () => granted, onClient: options => { signal = options.signal; },
        api: { recording: async () => { started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } } });
    const active = imports.check(); await ready; granted = false; await imports.accessChanged(); await active;
    assert.equal(signal.aborted, true); assert.equal((await store.read()).error.code, 'permission'); assert.equal(alarms.size, 0);
    assert.equal((await imports.snapshot()).pending, 1); await store.close();
});
test('resumable coverage keeps its declared end date across midnight', async () => {
    let date = '2026-10-23'; const queries = [];
    const { imports, store } = await setup({ date: () => date, api: { list: async query => { queries.push(query); return Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), owner: '123', date: '2026-10-23', type: 'hiking' })); } } });
    await imports.check(); date = '2026-10-24'; await imports.check(false, true);
    assert.equal(queries.at(-1).to, '2026-10-23'); assert.equal((await store.read()).scan.offset, 270); await store.close();
});

test('a dismissed activity stays dismissed when an in-flight recording finishes', async () => {
    let finish, started; const ready = new Promise(resolve => { started = resolve; });
    const { imports, store } = await setup({ api: { recording: async () => { started(); return new Promise(resolve => { finish = resolve; }); } } });
    const checking = imports.check(); await ready;
    await imports.handle({ type: 'GARMIN_DISMISS', id: '12' }, sender);
    finish(new Uint8Array()); await checking;
    assert.equal((await imports.snapshot()).pending, 0);
    assert.equal((await store.read()).items['12'].phase, 'dismissed');
    await store.close();
});
test('full-history intent survives a concurrent recent scan and restarts at the history boundary', async () => {
    let finish, started; const ready = new Promise(resolve => { started = resolve; }); let held = true; const queries = [];
    const { imports, store } = await setup({ api: { list: async query => {
        queries.push(query);
        if (held) { held = false; started(); await new Promise(resolve => { finish = resolve; }); }
        return [];
    } } });
    await store.mutate(s => { s.lastFull = Date.now(); });
    const active = imports.check(); await ready; const full = imports.check(true);
    finish(); await Promise.all([active, full]);
    assert(queries.some(query => query.from === '2026-01-01'), 'Explicit full-history request must not disappear behind a recent check');
    await store.close();
});


test('blocked peak lookups survive checks and resume the queued activity on a Peakbagger visit', async () => {
    let blocked = true, preparations = 0;
    const { imports, store, counts } = await setup({ prepare: async () => {
        preparations++;
        if (blocked) throw Object.assign(new Error('challenge'), { code: 'cloudflare' });
        return { analysis: { matches: [{ id: 987 }] } };
    } });
    try {
        await imports.check();
        assert.equal((await imports.snapshot()).queued, 1);
        assert.equal((await store.read()).peakbaggerBlocked.code, 'cloudflare');
        await imports.check();
        assert.equal(preparations, 1, 'scheduled checks must not retry blocked Peakbagger requests');
        assert.equal(counts.downloads, 1);
        const lists = counts.lists;
        blocked = false;
        await Promise.all([imports.peakbaggerVisited(42), imports.peakbaggerVisited(42)]);
        assert.equal(counts.lists, lists, 'a visit resumes preparation without rescanning Garmin history');
        assert.equal(preparations, 2);
        assert.equal((await imports.snapshot()).queued, 0);
        assert.equal((await store.read()).items['12'].phase, 'ready');
        assert.equal((await store.read()).peakbaggerBlocked, null);
    } finally { await store.close(); }
});
test('a missing Peakbagger page queues metadata without downloading and rate limits survive visits', async () => {
    let available = true, probes = 0, now = Date.now();
    const { imports, store, counts } = await setup({ clock: () => now, binding: async () => {
        probes++;
        if (!available) throw Object.assign(new Error('limited'), { code: 'rate-limit', retryAt: now + 60000 });
        return { cid: '456' };
    } });
    try {
        available = false; await imports.check();
        assert.equal((await imports.snapshot()).queued, 1);
        assert.equal(counts.downloads, 0);
        const before = probes; available = true;
        await imports.peakbaggerVisited(42); assert.equal(probes, before);
        now += 60001; await imports.peakbaggerVisited(42);
        assert.equal((await imports.snapshot()).queued, 0);
    } finally { await store.close(); }
});

test('one Peakbagger visit drains several preparation batches even in Manual only mode', async () => {
    const { imports, store, counts, alarms } = await setup({ prefs: { garminCheckHours: 0 } });
    try {
        await store.mutate(state => {
            state.peakbaggerBlocked = { code: 'peakbagger' };
            for (let i = 1; i <= 7; i++) state.items[i] = { id: String(i), phase: 'waiting', owner: '123', cid: '456', summary: { type: 'hiking' } };
        });
        await imports.peakbaggerVisited(42);
        assert.equal(counts.preparations, 7);
        assert.equal(counts.lists, 0);
        assert.equal(alarms.size, 0);
        assert.equal((await imports.snapshot()).queued, 0);
    } finally { await store.close(); }
});
