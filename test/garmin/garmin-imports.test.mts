import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminStore } from '../../src/garmin/garmin-store.ts';
import { createGarminImports, importRange } from '../../src/garmin/garmin-imports.ts';
import { GarminError } from '../../src/garmin/garmin-api.ts';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';
import { deferred } from '../helpers/deferred.mts';
import { inboxSender as sender } from '../helpers/garmin-imports-harness.mts';
import { required } from '../helpers/required.mts';

type Imports = ReturnType<typeof createGarminImports>;
type Dependencies = Parameters<typeof createGarminImports>[0];
type Service = ReturnType<NonNullable<Dependencies['clientFactory']>>;
type ClientOptions = Parameters<NonNullable<Dependencies['clientFactory']>>[0];
type ListQuery = Parameters<Service['list']>[0];
type Message = NonNullable<Parameters<Imports['handle']>[0]>;
type InboxItem = Parameters<Dependencies['prepare']>[0];
interface Overrides extends Partial<Pick<Dependencies, 'binding' | 'clock' | 'date' | 'prepare'>> {
    prefs?: Partial<typeof Schema.DEFAULTS>;
    permission?: () => boolean | Promise<boolean>;
    removePermission?: () => Promise<boolean>;
    settingsError?: () => boolean;
    onClient?: (options: ClientOptions) => void;
    api?: Partial<Service>;
}

// Test the same sparse messages that arrive from the extension's UI.
async function send(imports: Imports, message: Partial<Message> & Pick<Message, 'type'>,
    from: chrome.runtime.MessageSender) {
    const reply = await imports.handle(message as Message, from);
    assert.ok(reply && typeof reply === 'object' && 'ok' in reply);
    return reply as {
        ok: boolean; configured?: boolean; accessRemoved?: boolean; items?: unknown;
        error?: { code?: string } | null;
    };
}

const match = { id: 987, name: 'Summit', classification: 'strong' };

async function setup(overrides: Overrides = {}) {
    const store = createGarminStore(new IDBFactory()) as unknown as Imports['store'];
    const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();
    const prefs = { ...Schema.DEFAULTS, garminHistoryStart: '2026-01-01', ...overrides.prefs };
    const row = { id: '12', owner: '123', date: '2026-10-23', localStart: '2026-10-23 08:00:00', type: 'hiking' };
    const counts = { lists: 0, downloads: 0, preparations: 0 };
    const ext = {
        runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}` },
        permissions: {
            contains: async () => overrides.permission ? overrides.permission() : true,
            remove: overrides.removePermission || (async () => true),
        },
        alarms: {
            clear: async (key: string) => alarms.delete(key),
            create: async (key: string, value: chrome.alarms.AlarmCreateInfo) => { alarms.set(key, value); },
        },
    } as unknown as Dependencies['ext'];
    const imports = createGarminImports({
        ext,
        store,
        settings: { requireCurrent: async () => {
            if (overrides.settingsError?.()) throw new Error('storage unavailable');
            return prefs;
        } },
        clientFactory: options => {
            overrides.onClient?.(options);
            return {
                owner: async () => '123',
                list: async () => { counts.lists++; return [row]; },
                recording: async () => { counts.downloads++; return new ArrayBuffer(0); },
                ...overrides.api,
            };
        },
        clock: overrides.clock || Date.now,
        date: overrides.date,
        binding: overrides.binding || (async () => ({ cid: '456' })),
        decode: async () => ({ segments: [] }),
        prepare: overrides.prepare || (async () => {
            counts.preparations++;
            return { analysis: { matches: [match] } };
        }),
        openDrafts: () => assert.fail('this harness does not open draft tabs'),
    });
    await imports.connect('fictional-personal-key');
    return { imports, store, prefs, counts, alarms, row };
}
test('connecting a Garmin key enables imports without a separate activation or Peakbagger session', async () => {
    let bindings = 0;
    const h = await setup({ binding: async () => { bindings++; throw new GarminError('peakbagger'); } });
    try {
        assert.equal((await h.imports.snapshot()).enabled, true);
        assert.equal(h.alarms.size, 1, 'Connecting schedules the first check');
        assert.equal(bindings, 0, 'Connecting does not depend on Peakbagger being open');
        await h.imports.check();
        const state = await h.store.read();
        assert.equal(h.counts.lists, 2);
        assert.equal(h.counts.downloads, 0, 'Recordings wait for a verified Peakbagger account');
        assert.equal(state.items['12'].phase, 'waiting');
        assert.equal(state.peakbaggerBlocked?.code, 'peakbagger');
    } finally { await h.store.close(); }
});
test('disconnect wins over a connection still waiting for host permission', async () => {
    let hold = false;
    const waiting = deferred<void>();
    const gate = deferred<void>();
    const h = await setup({ permission: async () => { if (hold) { waiting.resolve(); await gate.promise; } return true; } });
    try {
        hold = true;
        const connecting = h.imports.connect('fictional-replacement-key');
        const rejected = assert.rejects(connecting, error => error instanceof GarminError && error.code === 'cancelled');
        await waiting.promise;
        await h.imports.disconnect();
        gate.resolve(); await rejected;
        assert.equal((await h.store.read()).connection?.key, null);
        assert.equal(h.alarms.size, 0);
    } finally { gate.resolve(); await h.store.close(); }
});
test('saved Garmin credentials can be inspected and disconnected while imports are off', async () => {
    const h = await setup();
    try {
        await h.imports.check();
        const before = await h.store.read();
        h.prefs.enableGarminInbox = false;
        const status = await send(h.imports, { type: 'GARMIN_CONNECTION_STATUS' }, sender);
        assert.deepEqual(status, { ok: true, configured: true });
        const forbidden = await send(h.imports, { type: 'GARMIN_CONNECTION_STATUS' }, { url: 'https://www.peakbagger.com/' });
        assert.equal(forbidden.ok, false);
        const result = await send(h.imports, { type: 'GARMIN_DISCONNECT' }, sender);
        assert.equal(result.ok, true);
        const after = await h.store.read();
        assert.equal(after.connection?.key, null);
        assert.deepEqual(after.items, before.items);
        assert.deepEqual(after.receipts, before.receipts);
        assert.equal(h.alarms.size, 0);
        assert.ok(before.items['12']);
        const disabled = await send(h.imports, { type: 'GARMIN_STATUS' }, sender);
        assert.equal(disabled.configured, false);
        assert.deepEqual(disabled.items, [], 'The disabled inbox still redacts retained activity data');
    } finally { await h.store.close(); }
});
test('disconnect aborts key verification and remains available when settings cannot be read', async () => {
    let hold = false, broken = false;
    let signal: AbortSignal | undefined;
    const waiting = deferred<void>();
    const gate = deferred<void>();
    const h = await setup({ settingsError: () => broken,
        onClient: options => { signal = options.signal; },
        api: { owner: async () => { if (hold) { waiting.resolve(); await gate.promise; } return '123'; } },
        removePermission: async () => { throw new Error('permission removal failed'); },
    });
    try {
        hold = true;
        const connecting = send(h.imports, { type: 'GARMIN_CONNECT', key: 'fictional-replacement' }, sender);
        await waiting.promise; broken = true;
        assert.equal((await send(h.imports, { type: 'GARMIN_CONNECTION_STATUS' }, sender)).configured, true);
        const removed = await send(h.imports, { type: 'GARMIN_DISCONNECT' }, sender);
        assert.equal(removed.ok, true);
        assert.equal(removed.accessRemoved, false);
        assert.equal(required(signal).aborted, true);
        gate.resolve();
        assert.equal((await connecting).error?.code, 'cancelled');
        assert.equal((await h.store.read()).connection?.key, null);
    } finally { gate.resolve(); await h.store.close(); }
});
test('an already saved Garmin key imports without the former enable flag', async () => {
    const h = await setup();
    try {
        await h.store.mutate(state => { required(state.connection).enabled = false; });
        await h.imports.reconcile();
        assert.equal((await h.imports.snapshot()).enabled, true);
        assert.equal(h.alarms.size, 1);
        await h.imports.check();
        assert.equal(h.counts.preparations, 1);
    } finally { await h.store.close(); }
});
test('the first preparation binds every queued activity and later checks retain that account', async () => {
    let available = false, cid = '456'; const expected: Parameters<Dependencies['binding']>[0][] = [];
    const rows = [12, 13, 14, 15].map(id => ({ id: String(id), owner: '123', date: '2026-10-23', type: 'hiking' }));
    const h = await setup({ api: { list: async () => rows }, binding: async expectedCid => {
        expected.push(expectedCid);
        if (!available || expectedCid && expectedCid !== cid) throw new GarminError('peakbagger');
        return { cid };
    }, prepare: async (item, _route, context) => {
        assert.equal(item.cid, context.cid);
        return { analysis: { matches: [match] } };
    } });
    try {
        await h.imports.check(); assert.equal(h.counts.downloads, 0);
        available = true; await h.imports.check(false, false, { resume: true });
        const state = await h.store.read();
        assert.equal(state.connection?.cid, '456');
        assert(Object.values(state.items).every(item => item.cid === '456'));
        assert.deepEqual(expected, [undefined, undefined, '456', '456']);
        cid = '789'; await h.imports.check();
        assert.equal(expected.at(-1), '456');
        assert.equal(h.counts.downloads, 3, 'Changing the signed-in climber cannot download the remaining route');
        assert.equal((await h.store.read()).items['15'].phase, 'waiting');
    } finally { await h.store.close(); }
});
test('disconnect during the first Peakbagger account check cannot bind or download a route', async () => {
    const started = deferred<void>();
    const hold = deferred<void>();
    const h = await setup({ binding: async () => { started.resolve(); await hold.promise; return { cid: '456' }; } });
    try {
        const checking = h.imports.check(); await started.promise;
        await h.imports.disconnect(); hold.resolve(); await checking;
        const state = await h.store.read();
        assert.equal(state.connection?.key, null);
        assert.equal(state.connection?.cid, undefined);
        assert.equal(h.counts.downloads, 0);
    } finally { hold.resolve(); await h.store.close(); }
});
test('restoring Garmin access needs permission but no second account activation', async () => {
    let allowed = true, bindings = 0;
    const h = await setup({ permission: () => allowed, binding: async () => { bindings++; return { cid: '456' }; } });
    try {
        allowed = false; await h.imports.accessChanged();
        assert.equal((await send(h.imports, { type: 'GARMIN_ACCESS' }, sender)).error?.code, 'permission');
        assert.equal(h.alarms.size, 0);
        allowed = true;
        const restored = await send(h.imports, { type: 'GARMIN_ACCESS' }, sender);
        assert.equal(restored.ok, true); assert.equal(restored.error, null);
        assert.equal(h.alarms.size, 1); assert.equal(bindings, 0);
        await h.store.mutate(state => { state.error = { code: 'key-rejected' }; });
        assert.equal((await send(h.imports, { type: 'GARMIN_ACCESS' }, sender)).error?.code, 'key-rejected');
        assert.equal(h.alarms.size, 0, 'Restoring host access must not resume a rejected key');
    } finally { await h.store.close(); }
});
test('date scopes clip recent checks and widen for catch-up', () => {
    assert.deepEqual(importRange({ ...Schema.DEFAULTS, garminRecentDays: 30, garminHistoryStart: '2026-10-20' }, '', 0, false, '2026-10-23'), { from: '2026-10-20', to: '2026-10-23' });
    assert.equal(importRange({ ...Schema.DEFAULTS, garminRecentDays: 7, garminHistoryStart: 'all' }, '', Date.parse('2026-09-01'), false, '2026-10-23').from, '2026-08-31');
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
    assert.equal(Object.keys((await store.read()).items).length, 1); assert.equal((await store.read()).connection?.key, null);
    await store.close();
});
test('dismissal tombstone prevents recreation; verified save removes completed snapshot', async () => {
    const { imports, store, counts } = await setup(); await imports.check();
    await imports.saved('12', '987', '789');
    assert.equal(Object.keys((await store.read()).items).length, 0);
    await imports.check(); assert.equal(counts.downloads, 1); assert.equal((await store.read()).receipts['12'].peaks?.['987'], '789'); await store.close();
});
test('manual mode never schedules discovery; concurrent checks coalesce', async () => {
    const { imports, alarms, counts, store } = await setup({ prefs: { garminCheckHours: 0 } });
    assert.equal(alarms.size, 0);
    await Promise.all([imports.check(), imports.check(), imports.check()]); assert.equal(counts.downloads, 1); assert.equal(alarms.size, 0); await store.close();
});
test('incomplete pagination retains a cursor and no successful checkpoint', async () => {
    const { imports, store } = await setup({ api: { list: async () => Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), date: '2026-10-23', owner: '123', type: 'hiking' })) } });
    await imports.check(); const state = await store.read();
    assert.equal(state.lastCheck, 0); assert.equal(state.scan?.offset, 135); await store.close();
});
test('rejected key pauses alarms and retains drafts', async () => {
    const { imports, store, alarms } = await setup({ api: { list: async () => { throw new GarminError('key-rejected'); } } });
    // This intentionally sparse saved item pre-dates the current inbox shape.
    await store.mutate(s => { s.items['1'] = { id: '1' } as InboxItem; }); await imports.check();
    assert.equal((await store.read()).error?.code, 'key-rejected'); assert.equal(alarms.size, 0);
    assert.equal(Object.keys((await store.read()).items).length, 1); await store.close();
});
test('untrusted messages cannot read retained routes or credentials', async () => {
    const { imports, store } = await setup();
    assert.equal((await send(imports, { type: 'GARMIN_STATUS' }, { ...sender, url: 'https://www.peakbagger.com/' })).ok, false);
    const summary = await send(imports, { type: 'GARMIN_SUMMARY' }, { ...sender, url: 'chrome-extension://test/popup/popup.html' });
    assert.equal(summary.ok, true);
    assert.equal('items' in summary, false);
    assert.equal(JSON.stringify(summary).includes('fictional-personal-key'), false); await store.close();
});

test('credential imports enable drafts and ignore independent scope epochs', async () => {
    const { imports, prefs, store } = await setup();
    const snapshot = await imports.readSnapshot();
    const next = await imports.verifyImportedKey('replacement-fictional-key', snapshot);
    prefs.garminRecentDays = 14; await imports.settingsChanged();
    assert.equal((await imports.replaceIfSnapshot(snapshot, next)).replaced, true);
    assert.equal((await store.read()).connection?.enabled, true);
    const newDevice = { epoch: 0, connection: null };
    const onNewDevice = await imports.verifyImportedKey('replacement-fictional-key', newDevice);
    assert.equal(onNewDevice?.enabled, true);
    const before = await imports.readSnapshot();
    await imports.connect('newer-fictional-key');
    assert.equal((await imports.replaceIfSnapshot(before, next)).replaced, false);
    assert.equal((await store.read()).connection?.key, 'newer-fictional-key'); await store.close();
});

test('dismissal offers durable Undo, then frees the snapshot while retaining its tombstone', async () => {
    let now = Date.now(); const { imports, store } = await setup({ clock: () => now }); await imports.check();
    await send(imports, { type: 'GARMIN_DISMISS', id: '12' }, sender);
    assert.equal((await imports.snapshot()).pending, 0); assert.equal((await imports.snapshot()).history?.[0]?.undoAvailable, true);
    await send(imports, { type: 'GARMIN_UNDO', id: '12' }, sender);
    assert.equal((await imports.snapshot()).pending, 1);
    await send(imports, { type: 'GARMIN_DISMISS', id: '12' }, sender); now += 60001;
    assert.equal((await imports.snapshot()).history?.[0]?.undoAvailable, false);
    assert.equal((await store.read()).items['12'], undefined);
    await imports.check(); assert.equal((await imports.snapshot()).pending, 0); await store.close();
});
test('public list and summary never serialize retained routes, draft fields or credentials', async () => {
    const { imports, store } = await setup(); await imports.check();
    const privateMatch = { id: 1, name: 'Peak', classification: 'strong', draftFields: { private: 'derived-fields' } };
    await store.mutate(s => { s.items['12'].analysis = { matches: [privateMatch], route: [[{ lat: 12.3456789, lon: -12, time: 123 }]], waypoints: [] }; });
    const snapshot = await imports.snapshot();
    assert.partialDeepStrictEqual(snapshot.items, [{ id: '12', analysis: { matches: [{ name: 'Peak' }] } }]);
    const serialized = JSON.stringify(snapshot);
    assert(!serialized.includes('12.3456789')); assert(!serialized.includes('derived-fields')); assert(!serialized.includes('fictional-personal-key'));
    const summary = await store.summary(); assert.equal(summary.pending, 1); assert.equal('items' in summary, false); await store.close();
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
    await imports.check(); assert.equal(counts.preparations, 3); assert.equal((await store.read()).error?.code, 'capacity');
    const lists = counts.lists; await imports.check(false, true); assert.equal(counts.preparations, 6); assert.equal(counts.lists, lists); await store.close();
});
test('permission removal cancels an active read and preserves pending drafts', async () => {
    let granted = true;
    let signal: AbortSignal | undefined;
    const ready = deferred<void>();
    const { imports, store, alarms } = await setup({ permission: () => granted, onClient: options => { signal = options.signal; },
        api: { recording: async () => { ready.resolve(); return new Promise((_resolve, reject) => required(signal).addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } } });
    const active = imports.check(); await ready.promise; granted = false; await imports.accessChanged(); await active;
    assert.equal(required(signal).aborted, true); assert.equal((await store.read()).error?.code, 'permission'); assert.equal(alarms.size, 0);
    assert.equal((await imports.snapshot()).pending, 1); await store.close();
});
test('resumable coverage keeps its declared end date across midnight', async () => {
    let date = '2026-10-23'; const queries: ListQuery[] = [];
    const { imports, store } = await setup({ date: () => date, api: { list: async query => { queries.push(query); return Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), owner: '123', date: '2026-10-23', type: 'hiking' })); } } });
    await imports.check(); date = '2026-10-24'; await imports.check(false, true);
    assert.equal(queries.at(-1)?.to, '2026-10-23'); assert.equal((await store.read()).scan?.offset, 270); await store.close();
});

test('a dismissed activity stays dismissed when an in-flight recording finishes', async () => {
    const ready = deferred<void>();
    const recording = deferred<ArrayBuffer>();
    const { imports, store } = await setup({ api: { recording: async () => { ready.resolve(); return recording.promise; } } });
    const checking = imports.check(); await ready.promise;
    await send(imports, { type: 'GARMIN_DISMISS', id: '12' }, sender);
    recording.resolve(new ArrayBuffer(0)); await checking;
    assert.equal((await imports.snapshot()).pending, 0);
    assert.equal((await store.read()).items['12'].phase, 'dismissed');
    await store.close();
});
test('full-history intent survives a concurrent recent scan and restarts at the history boundary', async () => {
    const ready = deferred<void>();
    const finish = deferred<void>();
    let held = true; const queries: ListQuery[] = [];
    const { imports, store } = await setup({ api: { list: async query => {
        queries.push(query);
        if (held) { held = false; ready.resolve(); await finish.promise; }
        return [];
    } } });
    await store.mutate(s => { s.lastFull = Date.now(); });
    const active = imports.check(); await ready.promise; const full = imports.check(true);
    finish.resolve(); await Promise.all([active, full]);
    assert(queries.some(query => query.from === '2026-01-01'), 'Explicit full-history request must not disappear behind a recent check');
    await store.close();
});


test('blocked peak lookups survive checks and resume the queued activity on a Peakbagger visit', async () => {
    let blocked = true, preparations = 0;
    const { imports, store, counts } = await setup({ prepare: async () => {
        preparations++;
        if (blocked) throw Object.assign(new Error('challenge'), { code: 'cloudflare' });
        return { analysis: { matches: [match] } };
    } });
    try {
        await imports.check();
        assert.equal((await imports.snapshot()).queued, 1);
        assert.equal((await store.read()).peakbaggerBlocked?.code, 'cloudflare');
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
            state.peakbaggerBlocked = { code: 'peakbagger' } as typeof state.peakbaggerBlocked;
            for (let i = 1; i <= 7; i++) {
                // A queued item can predate the saved-peaks field.
                state.items[i] = { id: String(i), phase: 'waiting', owner: '123', cid: '456', summary: { type: 'hiking' } } as InboxItem;
            }
        });
        await imports.peakbaggerVisited(42);
        assert.equal(counts.preparations, 7);
        assert.equal(counts.lists, 0);
        assert.equal(alarms.size, 0);
        assert.equal((await imports.snapshot()).queued, 0);
    } finally { await store.close(); }
});

test('the master switch stops alarms and visit/manual work without deleting the queue or key', async () => {
    const { imports, prefs, store, counts, alarms } = await setup();
    try {
        await imports.check();
        await store.mutate(state => { state.items['12'].phase = 'waiting'; });
        const key = required((await store.read()).connection?.key);
        const before = { ...counts };
        prefs.enableGarminInbox = false; await imports.settingsChanged();
        assert.equal(alarms.size, 0);
        await imports.check(); await imports.peakbaggerVisited(42);
        assert.deepEqual(counts, before);
        assert.equal((await store.read()).connection?.key, key);
        assert.equal((await store.read()).items['12'].phase, 'waiting');
        assert.equal((await send(imports, { type: 'GARMIN_INBOX_OPEN' }, sender)).error?.code, 'disabled');
        prefs.enableGarminInbox = true; await imports.settingsChanged();
        assert.equal(alarms.size, 1);
        await imports.peakbaggerVisited(42);
        assert.equal((await store.read()).items['12'].phase, 'ready');
    } finally { await store.close(); }
});

test('turning the inbox off cancels in-flight preparation and preserves the queued item', async () => {
    let signal: AbortSignal | undefined;
    const ready = deferred<void>();
    const { imports, prefs, store } = await setup({ onClient: options => { signal = options.signal; },
        api: { recording: async () => { ready.resolve(); return new Promise((_resolve, reject) => required(signal).addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } } });
    try {
        const checking = imports.check(); await ready.promise;
        prefs.enableGarminInbox = false; await imports.settingsChanged(); await checking;
        assert.equal(required(signal).aborted, true);
        assert.equal((await store.read()).items['12'].phase, 'waiting');
        assert.equal((await imports.snapshot()).featureEnabled, false);
    } finally { await store.close(); }
});

test('manual checks finish their bounded preparation without starting a new discovery cycle', async () => {
    let lists = 0;
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), owner: '123', date: '2026-10-23', type: 'hiking' }));
    const h = await setup({ prefs: { garminCheckHours: 0 }, api: { list: async () => { lists++; return rows; } } });
    try {
        await h.imports.check();
        assert.equal((await h.store.read()).preparePending, true);
        assert.equal(h.alarms.size, 1, 'An explicit manual check must finish its queued work');
        const before = lists;
        await h.imports.check(false, true);
        assert.equal(lists, before, 'Preparation continuation must not rediscover activities');
        assert.equal(h.counts.preparations, 4); assert.equal(h.alarms.size, 0);
    } finally { await h.store.close(); }
});
test('Undo requeues waiting work with a new revision in manual mode', async () => {
    const h = await setup({ prefs: { garminCheckHours: 0 } });
    try {
        await h.imports.check();
        await h.store.mutate(state => { state.items['12'].phase = 'waiting'; state.items['12'].analysis = null; state.preparePending = false; });
        await send(h.imports, { type: 'GARMIN_DISMISS', id: '12' }, sender);
        const revision = required((await h.store.read()).items['12'].revision);
        await send(h.imports, { type: 'GARMIN_UNDO', id: '12' }, sender);
        const state = await h.store.read();
        assert.equal(state.items['12'].revision, revision + 1);
        assert.equal(state.preparePending, true); assert.equal(h.alarms.size, 1);
    } finally { await h.store.close(); }
});
test('background discovery prunes expired dismissed snapshots before checking capacity', async () => {
    const h = await setup();
    try {
        await h.store.mutate(state => {
            for (let i = 1000; i < 1200; i++) {
                state.items[i] = { id: String(i), phase: 'dismissed', undoUntil: 0 } as InboxItem;
                state.receipts[i] = { dismissed: true };
            }
        });
        await h.imports.check(); const state = await h.store.read();
        assert.equal(state.error, null); assert.equal(Object.keys(state.items).length, 1);
        assert.equal(Object.keys(state.receipts).length, 200, 'Pruning must retain import tombstones');
        assert.equal(h.counts.preparations, 1);
    } finally { await h.store.close(); }
});
test('an explicit resume arriving during a check runs after the blocked pass', async () => {
    let calls = 0, bindings = 0;
    const started = deferred<void>();
    const hold = deferred<void>();
    const h = await setup({ api: { list: async () => {
        if (++calls === 1) { started.resolve(); await hold.promise; }
        return [{ id: '12', owner: '123', date: '2026-10-23', type: 'hiking' }];
    } }, binding: async (_cid, options) => {
        if (++bindings === 1) throw new GarminError('cloudflare');
        assert.equal(options.tabId, 42); return { cid: '456' };
    } });
    try {
        const first = h.imports.check(); await started.promise;
        const resumed = h.imports.check(false, false, { resume: true, tabId: 42 });
        hold.resolve(); await Promise.all([first, resumed]);
        assert.equal((await h.store.read()).items['12'].phase, 'ready');
        assert.equal(bindings, 2);
    } finally { hold.resolve(); await h.store.close(); }
});

test('manual full-history checks continue pagination and stop once queued tracks are prepared', async () => {
    const rows = Array.from({ length: 151 }, (_, i) => ({ id: String(i + 1), owner: '123', date: '2026-10-23', type: 'hiking' }));
    const h = await setup({ prefs: { garminCheckHours: 0 }, api: { list: async ({ start }) => rows.slice(start, start + 50) } });
    try {
        await h.imports.check(true); assert.equal((await h.store.read()).scan?.offset, 135);
        assert.equal(h.alarms.size, 1);
        // Each pass remains bounded while completing this explicit request.
        for (let pass = 0; pass < 60 && h.alarms.size; pass++) await h.imports.check(false, true);
        const state = await h.store.read();
        assert.equal(state.scan, null); assert.equal(state.preparePending, false);
        assert.equal(h.counts.preparations, 151); assert.equal(h.alarms.size, 0);
    } finally { await h.store.close(); }
});

test('matching Garmin subjects preserve known ownership on empty accounts and reject conflicting owners', async () => {
    let account: { subject: string; owner: string | null } = { subject: 'stable-subject', owner: '123' };
    const h = await setup({ api: { owner: async () => account } });
    try {
        account = { subject: 'stable-subject', owner: null };
        await h.imports.connect('replacement-key');
        assert.equal((await h.store.read()).connection?.owner, '123');
        const previous = await h.imports.readSnapshot();
        assert.equal((await h.imports.verifyImportedKey('imported-key', previous))?.owner, '123');
        await h.imports.check(); assert.equal((await h.store.read()).error, null);
        account = { subject: 'stable-subject', owner: '999' };
        await assert.rejects(h.imports.connect('wrong-owner-key'), error => error instanceof GarminError && error.code === 'identity');
        await assert.rejects(h.imports.verifyImportedKey('wrong-owner-key', previous), error => error instanceof GarminError && error.code === 'identity');
        assert.equal((await h.store.read()).connection?.key, 'replacement-key');
    } finally { await h.store.close(); }
});
