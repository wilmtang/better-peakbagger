// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { IDBFactory } from 'fake-indexeddb';
import { createGarminImports } from '../../src/garmin/garmin-imports.ts';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';

type ImportOptions = Parameters<typeof createGarminImports>[0];
export type GarminTestState = {
    items: Record<string, Record<string, unknown>>; receipts: Record<string, Record<string, unknown>>;
    error: { code: string; message?: string; storage?: boolean } | null; preparePending?: boolean; lastCheck: number;
};
export type GarminTestStore = {
    read(): Promise<GarminTestState>; mutate<Result>(mutate: (state: GarminTestState) => Result): Promise<Result>; close(): Promise<void>;
};

export const inboxSender = { id: 'test', url: 'chrome-extension://test/options/inbox.html', tab: { id: 1 }, frameId: 0 } as chrome.runtime.MessageSender;

export async function garminImportsHarness() {
    const store = createGarminStore(new IDBFactory()) as unknown as GarminTestStore;
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
    const send = async (type: string, id: string) =>
        await imports.handle({ type, id, key: '' }, inboxSender) as { ok: boolean; error?: { code?: string } };
    return { imports, store, alarms, counts, prefs, send, now: () => now, advance: (ms: number) => { now += ms; } };
}

export const waitingItem = (id: string, extra: Record<string, unknown> = {}) => ({
    id, owner: '123', cid: '456', phase: 'waiting', saved: [], summary: { date: '2026-10-23', type: 'hiking' }, ...extra,
});
export const readyItem = (id: string, extra: Record<string, unknown> = {}) => waitingItem(id, {
    phase: 'ready', analysis: { matches: [{ id: 1, name: 'Summit', classification: 'strong' }], route: [], waypoints: [] }, ...extra,
});
