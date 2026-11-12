// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminImports } from '../../src/garmin/garmin-imports.ts';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';

type ImportOptions = Parameters<typeof createGarminImports>[0];

const inboxSender = { id: 'test', url: 'chrome-extension://test/options/inbox.html', tab: { id: 1 }, frameId: 0 } as chrome.runtime.MessageSender;

async function setup() {
    const store = createGarminStore(new IDBFactory());
    const alarms = new Map<string, unknown>();
    const counts = { downloads: 0, preparations: 0 };
    let now = Date.UTC(2026, 10, 11, 12);
    const prefs = { ...Schema.DEFAULTS, enableGarminInbox: true, garminHistoryStart: '2026-01-01' };
    const ext = {
        runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}` },
        permissions: { contains: async () => true, remove: async () => true },
        alarms: { clear: async (key: string) => alarms.delete(key), create: async (key: string, value: unknown) => { alarms.set(key, value); } },
    } as unknown as ImportOptions['ext'];
    const imports = createGarminImports({
        ext, store: store as unknown as ImportOptions['store'], settings: { requireCurrent: async () => prefs },
        clientFactory: () => ({ owner: async () => '123', list: async () => [],
            recording: async () => { counts.downloads++; return new ArrayBuffer(0); } }),
        clock: () => now, date: () => '2026-11-11',
        binding: async () => ({ cid: '456' }), decode: async () => ({ segments: [] }),
        prepare: async () => { counts.preparations++; return { analysis: { matches: [{ id: 987, name: 'Peak', classification: 'strong' }] } }; },
        openDrafts: () => null,
    });
    await imports.connect('fictional-personal-key');
    // One stored item large enough that adding any prepared route crosses the
    // 20 MiB inbox limit, and one activity waiting for preparation.
    await store.mutate((state: { items: Record<string, unknown>; preparePending?: boolean; lastCheck: number }) => {
        state.items['900'] = { id: '900', owner: '123', cid: '456', phase: 'ready', saved: [], summary: { date: '2026-10-01', type: 'hiking' },
            analysis: { matches: [{ id: 1, name: 'Big', classification: 'strong' }], route: [], waypoints: [], padding: 'x'.repeat(20 * 1024 * 1024) } };
        state.items['12'] = { id: '12', owner: '123', cid: '456', phase: 'waiting', saved: [], summary: { date: '2026-10-23', type: 'hiking' } };
        state.preparePending = true;
        state.lastCheck = now;
    });
    return { imports, store, alarms, counts, advance: (ms: number) => { now += ms; } };
}

test('a full inbox stops preparing the same activity until an item is removed', async () => {
    const h = await setup();
    try {
        await h.imports.check(false, true);
        assert.equal(h.counts.downloads, 1, 'the first pass tries the waiting activity once');
        const full = await h.store.read();
        assert.equal(full.error?.code, 'capacity');
        assert.equal(full.items['12'].phase, 'waiting');
        assert.equal(full.preparePending, false, 'a full inbox must not leave preparation pending');
        for (let period = 0; period < 4; period++) {
            h.advance(60_000);
            await h.imports.check(false, true);
        }
        assert.equal(h.counts.downloads, 1, 'later alarm periods must not re-download the same activity');
        assert.equal(h.counts.preparations, 1, 'later alarm periods must not repeat Peakbagger lookups');
        assert.equal(h.alarms.size, 0, 'no continuation alarm while the inbox is full');

        assert.equal((await h.imports.handle({ type: 'GARMIN_DONE', id: '900', key: '' }, inboxSender) as { ok: boolean }).ok, true);
        const relieved = await h.store.read();
        assert.equal(relieved.error, null);
        assert.equal(relieved.preparePending, true, 'removing an item resumes the waiting activity');
        assert.equal(h.alarms.size, 1, 'resumption is scheduled, not left for the next periodic check');
        await h.imports.check(false, true);
        assert.equal(h.counts.downloads, 2);
        assert.equal((await h.store.read()).items['12'].phase, 'ready');
    } finally { await h.store.close(); }
});
