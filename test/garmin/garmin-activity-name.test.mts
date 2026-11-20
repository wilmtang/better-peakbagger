// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminImports } from '../../src/garmin/garmin-imports.ts';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';
import { waitingItem, type GarminTestStore } from '../helpers/garmin-imports-harness.mts';

type ImportOptions = Parameters<typeof createGarminImports>[0];
type Row = { id: string; owner: string; name: string; date: string; localStart: string; utcStart: string; type: string };
type Snapshot = { items: { id: string; summary: { type: string; date: string; name: string; localStart: string } }[] };

async function harness(rows: Row[]) {
    const store = createGarminStore(new IDBFactory()) as unknown as GarminTestStore;
    const prefs = { ...Schema.DEFAULTS, enableGarminInbox: true, garminHistoryStart: '2026-01-01' };
    const imports = createGarminImports({
        ext: { runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}` },
            permissions: { contains: async () => true, remove: async () => true },
            alarms: { clear: async () => true, create: async () => {} } } as unknown as ImportOptions['ext'],
        store: store as unknown as ImportOptions['store'], settings: { requireCurrent: async () => prefs },
        clientFactory: () => ({ owner: async () => '123', list: async () => rows.map(row => ({ ...row })), recording: async () => new ArrayBuffer(0) }),
        clock: () => Date.UTC(2026, 10, 11, 12), date: () => '2026-11-11',
        // Peak checks wait for Peakbagger, so items stay as listed.
        binding: async () => { throw new Error('Peakbagger is not open in this test.'); },
        decode: async () => ({ segments: [] }), prepare: async () => ({ analysis: { matches: [] } }), openDrafts: () => null,
    });
    await imports.connect('fictional-personal-key');
    return { imports, store };
}
type StoredItem = { phase: string; summary: { name?: string; type: string } };
const stored = async (store: GarminTestStore) => (await store.read()).items as unknown as Record<string, StoredItem>;
const row = (id: string, name: string, localStart: string): Row =>
    ({ id, owner: '123', name, date: localStart.slice(0, 10), localStart, utcStart: '', type: 'hiking' });

test('the inbox snapshot carries each activity title and local start time', async () => {
    const h = await harness([row('21', 'Snohomish County Hiking', '2026-11-03 14:10:00'), row('20', '', '2026-11-02 07:45:00')]);
    try {
        await h.imports.check();
        const snapshot = await h.imports.snapshot() as unknown as Snapshot;
        assert.deepEqual(snapshot.items.map(item => item.summary).sort((a, b) => a.localStart.localeCompare(b.localStart)), [
            { type: 'hiking', date: '2026-11-02', name: '', localStart: '2026-11-02 07:45:00' },
            { type: 'hiking', date: '2026-11-03', name: 'Snohomish County Hiking', localStart: '2026-11-03 14:10:00' },
        ]);
    } finally { await h.store.close(); }
});

test('a listed activity takes Garmin’s current title, including one imported before titles were kept', async () => {
    const rows = [row('12', 'Morning on the ridge', '2026-11-02 08:00:00')];
    const h = await harness(rows);
    try {
        await h.store.mutate(state => { state.items['12'] = waitingItem('12', { summary: { date: '2026-11-02', type: 'hiking', localStart: '2026-11-02 08:00:00' } }); });
        await h.imports.check();
        assert.equal((await stored(h.store))['12'].summary.name, 'Morning on the ridge');
        rows[0].name = 'Ridge traverse';
        await h.imports.check(true);
        const items = await stored(h.store);
        assert.equal(items['12'].summary.name, 'Ridge traverse', 'a renamed activity follows Garmin');
        assert.equal(items['12'].summary.type, 'hiking', 'the rest of the summary is unchanged');
        assert.equal(items['12'].phase, 'waiting', 'renaming never re-queues or replaces the item');
        rows[0].name = '';
        await h.imports.check(true);
        assert.equal((await stored(h.store))['12'].summary.name, 'Ridge traverse', 'a listing without a title keeps the last one');
    } finally { await h.store.close(); }
});
