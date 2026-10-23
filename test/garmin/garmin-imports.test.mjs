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
        permissions: { contains: async () => true, remove: async () => true }, alarms: { clear: async key => alarms.delete(key), create: async (key, value) => alarms.set(key, value) } },
    store, settings: { requireCurrent: async () => prefs },
    clientFactory: () => ({ owner: async () => '123', list: async () => { counts.lists++; return [row]; }, recording: async () => { counts.downloads++; return new Uint8Array(); }, ...overrides.api }),
    binding: async () => ({ cid: '456' }), decode: async () => ({ segments: [] }),
    prepare: async () => { counts.preparations++; return { analysis: { matches: [{ id: 987 }] } }; },
    });
    await imports.connect('fictional-personal-key');
    await imports.handle({ type: 'GARMIN_ENABLE' }, sender);
    return { imports, store, prefs, counts, alarms, row };
}
test('date scopes clip recent checks and widen for catch-up', () => {
    assert.deepEqual(importRange({ garminRecentDays: 30, garminHistoryStart: '2026-10-20' }, '', 0, false, '2026-10-23'), { from: '2026-10-20', to: '2026-10-23' });
    assert.equal(importRange({ garminRecentDays: 7, garminHistoryStart: 'all' }, '', Date.parse('2026-09-01'), false, '2026-10-23').from, '2026-08-31');
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
