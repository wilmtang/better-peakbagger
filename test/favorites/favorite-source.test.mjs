// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFavoriteSource } from '../../src/favorites/favorite-source.js';
const harness = (cache, owner = 1) => {
    const dom = new JSDOM(owner ? `<a href="/climber/climber.aspx?cid=${owner}">My Home Page</a>` : '',
        { url: 'https://www.peakbagger.com/peak.aspx?pid=1' });
    const callbacks = new Set(); let config = { favoritesSource: 'buddies' }; const states = [];
    const values = { bpbBuddyCache: cache };
    const api = { storage: { local: { get: async () => values, set: async patch => Object.assign(values, patch) },
        onChanged: { addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn) } } };
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
test('source switch invalidates a late buddy response before it can replace local cache', async () => {
    const h = harness(null); let finish;
    const source = createFavoriteSource({ ...h, fetchDocument: () => new Promise(resolve => { finish = resolve; }) });
    await source.ready; const pending = source.refresh({ active: true });
    h.changeSource('custom');
    finish({ kind: 'ok', document: h.doc }); await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.states.at(-1).mode, 'custom');
    assert.equal((await h.api.storage.local.get()).bpbBuddyCache, null);
    source.stop(); h.close();
});
