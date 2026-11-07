// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createGarminBadge, waitingCountLabel } from '../../src/garmin/garmin-badge.ts';
import { createGarminImports } from '../../src/garmin/garmin-imports.ts';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';

type ImportOptions = Parameters<typeof createGarminImports>[0];

const fakeAction = () => {
    const texts: string[] = [], titles: string[] = [], colors: string[] = [];
    return { texts, titles, colors, action: {
        setBadgeBackgroundColor: async ({ color }: { color: string }) => { colors.push(color); },
        setBadgeText: async ({ text }: { text: string }) => { texts.push(text); },
        setTitle: async ({ title }: { title: string }) => { titles.push(title); },
    } };
};
const badgeExt = (action: ReturnType<typeof fakeAction>['action']) =>
    ({ action }) as unknown as Parameters<typeof createGarminBadge>[0]['ext'];

test('the count label stays short enough for the toolbar badge', () => {
    assert.deepEqual([0, 1, 99, 100].map(waitingCountLabel), ['', '1', '99', '99+']);
});

test('the badge shows the queue, and clears when the preference or the inbox is off', async () => {
    const fake = fakeAction();
    const prefs = { enableGarminInbox: true, showInboxToolbarCount: true };
    const badge = createGarminBadge({ ext: badgeExt(fake.action), settings: { requireCurrent: async () => prefs }, summary: async () => ({ queued: 3 }) });
    await badge.sync();
    assert.equal(fake.texts.at(-1), '3');
    assert.match(fake.titles.at(-1)!, /3 waiting for peak checks/);
    prefs.showInboxToolbarCount = false;
    await badge.sync();
    assert.equal(fake.texts.at(-1), '');
    assert.doesNotMatch(fake.titles.at(-1)!, /waiting/);
    prefs.showInboxToolbarCount = true; prefs.enableGarminInbox = false;
    await badge.sync();
    assert.equal(fake.texts.at(-1), '');
});

test('an unreadable preference keeps the last accurate badge', async () => {
    const fake = fakeAction();
    let readable = true;
    const badge = createGarminBadge({ ext: badgeExt(fake.action), summary: async () => ({ queued: 2 }), settings: { requireCurrent: async () => {
        if (!readable) throw new Error('storage unavailable');
        return { enableGarminInbox: true, showInboxToolbarCount: true };
    } } });
    await badge.sync();
    readable = false;
    await badge.sync();
    assert.deepEqual(fake.texts, ['2']);
});

test('a write during a pass still settles on the newest queue', async () => {
    const fake = fakeAction();
    let queued = 1, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const badge = createGarminBadge({ ext: badgeExt(fake.action), settings: { requireCurrent: async () => ({ enableGarminInbox: true, showInboxToolbarCount: true }) }, summary: async () => {
        const value = queued;
        if (first) { first = false; await gate; }
        return { queued: value };
    } });
    const running = badge.sync();
    await new Promise(resolve => setTimeout(resolve, 0));
    queued = 4;
    void badge.sync();
    release();
    await running;
    assert.equal(fake.texts.at(-1), '4');
});

test('inbox writes move the badge, and reviewed outcomes do not count', async () => {
    const fake = fakeAction();
    const store = createGarminStore();
    const prefs = { ...Schema.DEFAULTS };
    const imports = createGarminImports({
        ext: { action: fake.action, alarms: { clear: async () => true, create: async () => {} }, permissions: { contains: async () => false },
            runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
        settings: { requireCurrent: async () => prefs }, store,
    } as unknown as ImportOptions);
    const settled = async (text: string) => {
        for (let attempt = 0; attempt < 100 && fake.texts.at(-1) !== text; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(fake.texts.at(-1), text);
    };
    const item = (id: string, phase: string) => ({ id, phase, saved: [], summary: { date: '2026-10-30', type: 'mountaineering' } });
    await imports.store.mutate(state => { state.items = { 1: item('1', 'no-matches'), 2: item('2', 'no-gps'), 3: item('3', 'waiting') }; });
    await settled('1');
    assert.equal((await imports.snapshot(false)).pending, 3, 'the inbox still lists its reviewed activities');
    await imports.store.mutate(state => { state.items['3'].phase = 'no-matches'; });
    await settled('');
    await store.close();
});
