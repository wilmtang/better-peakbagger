// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFavoriteSource } from '../../src/favorites/favorite-source.js';
import { makeChromeStub } from '../helpers/load-page.mjs';
import { BUDDY_MESSAGE } from '../../src/favorites/buddy-state.js';
const harness = (cache, owner = 1) => {
    const dom = new JSDOM(owner ? `<a href="/climber/climber.aspx?cid=${owner}">My Home Page</a>` : '',
        { url: 'https://www.peakbagger.com/peak.aspx?pid=1' });
    let config = { favoritesSource: 'buddies' }; const states = [];
    const api = makeChromeStub({}, { bpbBuddyCache: cache });
    let settingListener;
    const settings = { requireCurrent: async () => config, subscribe: fn => {
        settingListener = fn; return () => {};
    } };
    return { api, settings, doc: dom.window.document, onState: state => states.push(state), states,
        close: () => dom.window.close(), changeSource: next => { config = { favoritesSource: next }; settingListener(config); } };
};
test('buddy source rejects wrong-owner and signed-out caches, and valid empty custom is available', async () => {
    for (const owner of [1, null]) {
        const h = harness({ ownerCid: 2, entries: [{ cid: 3, name: 'Other' }], fetchedAt: Date.now() }, owner);
        const source = createFavoriteSource(h); await source.ready;
        assert.equal(h.states.at(-1).available, false);
        assert.equal(h.states.at(-1).ids.size, 0);
        h.changeSource('custom'); await source.ready; await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.states.at(-1).available, true);
        assert.equal(h.states.at(-1).ids.size, 0);
        source.stop(); h.close();
    }
});
test('stale matching cache remains available on refresh error and does not loop requests', async () => {
    const h = harness({ ownerCid: 1, entries: [{ cid: 3, name: 'Buddy' }], fetchedAt: 0 }); let requests = 0;
    const source = createFavoriteSource({ ...h, fetchDocument: async () => { requests++; return { kind: 'error' }; } });
    await source.ready; await source.refresh({ active: true });
    assert.equal(h.states.at(-1).available, true);
    assert.ok(h.states.at(-1).ids.has(3));
    assert.match(h.states.at(-1).error, /saved/);
    await source.refresh({ active: true }); assert.equal(requests, 1);
    source.stop(); h.close();
});
test('an unavailable Buddy worker preserves saved members and gives reload guidance without looping', async () => {
    for (const phase of ['begin', 'publish']) {
        const saved = { ownerCid: 1, entries: [{ cid: 3, name: 'Saved Buddy' }], fetchedAt: 0 };
        const h = harness(saved);
        let requests = 0;
        const send = h.api.runtime.sendMessage.bind(h.api.runtime);
        Object.defineProperty(h.api.runtime, 'sendMessage', { configurable: true, value: message =>
            message?.type === 'BUDDY_CACHE_UPDATE' && message.phase === phase ? Promise.resolve(null) : send(message) });
        const source = createFavoriteSource({ ...h, fetchDocument: async () => {
            requests++; return { kind: 'ok', document: h.doc };
        } });
        try {
            await source.ready; await source.refresh({ active: true });
            assert.equal(h.states.at(-1).available, true);
            assert.deepEqual([...h.states.at(-1).ids], [3]);
            assert.match(h.states.at(-1).error, /Reload the extension, then reload this page/i);
            assert.doesNotMatch(h.states.at(-1).error, /loaded|could not save/i);
            assert.deepEqual(h.api._localStore.bpbBuddyCache, saved);
            await source.refresh({ active: true });
            assert.equal(requests, phase === 'begin' ? 0 : 1);
        } finally { source.stop(); h.close(); }
    }
});
test('source switch invalidates a late buddy response before it can replace local cache', async () => {
    const h = harness(null); let finish, started;
    const fetching = new Promise(resolve => { started = resolve; });
    const source = createFavoriteSource({ ...h, fetchDocument: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
    await source.ready; const pending = source.refresh({ active: true });
    await fetching;
    h.changeSource('custom');
    finish({ kind: 'ok', document: h.doc }); await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.states.at(-1).mode, 'custom');
    assert.equal((await h.api.storage.local.get('bpbBuddyCache')).bpbBuddyCache, null);
    source.stop(); h.close();
});

test('a limited buddy source retains saved members and exposes the service warning without looping', async () => {
    const h = harness({ ownerCid: 1, entries: [{ cid: 3, name: 'Buddy' }], fetchedAt: 0 });
    let requests = 0;
    const source = createFavoriteSource({ ...h, fetchDocument: async () => {
        requests++; return { kind: 'transient', error: { source: 'peakbagger', code: 'rate-limit', retryAt: Date.now() + 60000 } };
    } });
    try {
        await source.ready; await source.refresh({ active: true });
        assert.equal(h.states.at(-1).available, true); assert.ok(h.states.at(-1).ids.has(3));
        assert.match(h.states.at(-1).error, /saved Buddy List.*Peakbagger request limit reached/);
        await source.refresh({ active: true }); assert.equal(requests, 1);
    } finally { source.stop(); h.close(); }
});

test('an ordinary Buddy server failure retains typed recovery without claiming a rate limit', async () => {
    const h = harness(null);
    let requests = 0;
    const source = createFavoriteSource({ ...h, fetchDocument: async () => {
        requests++; return { kind: 'transient', error: { source: 'peakbagger', code: 'server', status: 503 } };
    } });
    try {
        await source.ready; await source.refresh({ active: true });
        assert.equal(h.states.at(-1).available, false);
        assert.match(h.states.at(-1).error, /Peakbagger is temporarily unavailable \(HTTP 503\).*Try again later/);
        assert.doesNotMatch(h.states.at(-1).error, /request limit|rate.limit/i);
        await source.refresh({ active: true }); assert.equal(requests, 1);
    } finally { source.stop(); h.close(); }
});

test('a delayed report response cannot undo a confirmed Buddy change or weaken Ignore protection', async () => {
    const h = harness({ ownerCid: 1, entries: [], fetchedAt: 0 });
    let finish, started;
    const fetching = new Promise(resolve => { started = resolve; });
    const source = createFavoriteSource({ ...h, fetchDocument: () => {
        started(); return new Promise(resolve => { finish = resolve; });
    } });
    try {
        await source.ready;
        const refresh = source.refresh({ active: true }); await fetching;
        const lease = await h.api.runtime.sendMessage({ type: BUDDY_MESSAGE, phase: 'begin',
            cid: 3, ownerCid: 1, name: 'New Buddy', action: 'add' });
        await h.api.runtime.sendMessage({ type: BUDDY_MESSAGE, phase: 'dispatch', token: lease.token });
        await h.api.runtime.sendMessage({ type: BUDDY_MESSAGE, phase: 'complete', token: lease.token, buddy: true });
        finish({ kind: 'ok', document: h.doc }); await refresh;
        assert.deepEqual(h.api._localStore.bpbBuddyCache.entries, [{ cid: 3, name: 'New Buddy' }]);
        assert.equal(h.api._localStore.bpbBuddyCache.fetchedAt, 0);
        assert.ok(h.states.at(-1).ids.has(3)); assert.equal(h.states.at(-1).loading, false);
        assert.match(h.states.at(-1).error, /changed during refresh/);
        const ignore = await h.api.runtime.sendMessage({ type: 'IGNORED_MUTATE',
            mutation: { kind: 'add', entry: { cid: 3, name: 'New Buddy', addedAt: 1 } } });
        assert.equal(ignore.ok, false);
    } finally { source.stop(); h.close(); }
});
