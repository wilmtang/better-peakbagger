// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoRoutes } from '../../src/background/photo-routes.ts';

const PAGE = 'chrome-extension://test-extension/photos/photos.html';
const popupSender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup/popup.html' };

interface FakeTab { id: number; windowId?: number; url?: string }

const harness = (tabs: FakeTab[], overrides: { query?: () => Promise<FakeTab[]> } = {}) => {
    const calls = { created: [] as unknown[], updated: [] as unknown[], focused: [] as unknown[], queries: 0 };
    const ext = {
        runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}` },
        permissions: { contains: async () => false },
        tabs: {
            query: overrides.query || (async () => { calls.queries++; return tabs; }),
            create: async (options: unknown) => { calls.created.push(options); return { id: 77 }; },
            update: async (id: number, options: unknown) => { calls.updated.push([id, options]); return { id }; },
        },
        windows: { update: async (id: number, options: unknown) => { calls.focused.push([id, options]); } },
    };
    const routes = createPhotoRoutes({
        ext, storage: () => ({}), now: () => 0, isPeakbaggerSender: () => false,
        mutateMap: async () => null, readMap: async () => ({}), randomToken: () => 'token',
        keyStore: {}, trustedActions: {}, buildOpenResponse: () => ({}), logCleanupFailure() {},
    } as never);
    const open = routes.handlers.PHOTO_STANDALONE_OPEN as (message: object, sender: object) => unknown;
    return { calls, open: (sender: object = popupSender) => open({ type: 'PHOTO_STANDALONE_OPEN' }, sender) };
};

test('the popup opens a fresh standalone editor when no photo tab exists', async () => {
    const { calls, open } = harness([{ id: 1, windowId: 1, url: 'https://www.peakbagger.com/' }, { id: 2, windowId: 1 }]);
    assert.deepEqual(await open(), { ok: true, tabId: 77 });
    assert.deepEqual(calls.created, [{ url: PAGE, active: true }]);
    assert.deepEqual(calls.updated, []);
});

test('the popup focuses an existing standalone editor instead of duplicating it', async () => {
    const { calls, open } = harness([
        { id: 3, windowId: 8, url: `${PAGE}?mode=library` },
        { id: 4, windowId: 9, url: PAGE },
    ]);
    assert.deepEqual(await open(), { ok: true, tabId: 4 });
    assert.deepEqual(calls.updated, [[4, { active: true }]]);
    assert.deepEqual(calls.focused, [[9, { focused: true }]]);
    assert.deepEqual(calls.created, []);
});

test('the popup falls back to an open library tab, which shares the same page', async () => {
    const { calls, open } = harness([{ id: 3, windowId: 8, url: `${PAGE}?mode=library` }]);
    assert.deepEqual(await open(), { ok: true, tabId: 3 });
    assert.deepEqual(calls.created, []);
});

test('the popup never takes over a photo tab bound to a report', async () => {
    const { calls, open } = harness([
        { id: 5, windowId: 1, url: `${PAGE}?mode=edit&returnToken=abc` },
        { id: 6, windowId: 1, url: `${PAGE}?localPhotoId=def` },
        { id: 7, windowId: 1, url: `${PAGE}?imageUrl=https%3A%2F%2Fexample.com%2Fa.jpg` },
        { id: 8, windowId: 1, url: 'chrome-extension://test-extension/photos/guide.html' },
        { id: 9, windowId: 1, url: 'chrome-extension://another-extension/photos/photos.html' },
    ]);
    assert.deepEqual(await open(), { ok: true, tabId: 77 });
    assert.deepEqual(calls.updated, []);
    assert.equal(calls.created.length, 1);
});

test('only the packaged popup may use this route', async () => {
    const { calls, open } = harness([]);
    for (const sender of [
        { id: 'test-extension', url: 'https://www.peakbagger.com/popup/popup.html' },
        { id: 'another-extension', url: popupSender.url },
        { id: 'test-extension', url: 'chrome-extension://test-extension/reports/instagram.html' },
        { id: 'test-extension', url: popupSender.url, tab: { id: 4 }, frameId: 2 },
    ]) assert.deepEqual(await open(sender), { ok: false, error: { code: 'forbidden' } });
    assert.equal(calls.queries, 0);
    assert.deepEqual(calls.created, []);
});

test('repeated activation shares one open, and a browser failure reports rather than throws', async () => {
    const first = harness([]);
    await Promise.all([first.open(), first.open()]);
    assert.equal(first.calls.created.length, 1);
    const failing = harness([], { query: async () => { throw new Error('browser unavailable'); } });
    assert.deepEqual(await failing.open(), { ok: false });
});
