// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuddyCacheStore } from '../../src/background/buddy-cache-store.js';
import { createBuddyStore } from '../../src/background/buddy-store.js';
import { createIgnoredStore } from '../../src/background/ignored-store.js';
import { BUDDY_CACHE_EPOCH_KEY } from '../../src/favorites/buddy-cache.js';

const target = { cid: 3, name: 'New Buddy' };
const cache = (entries, fetchedAt = 1) => ({ ownerCid: 1, entries, fetchedAt });
const harness = initial => {
    const values = { bpbBuddyCache: structuredClone(initial) };
    const storage = { get: async () => structuredClone(values),
        set: async patch => Object.assign(values, structuredClone(patch)) };
    let clock = 100;
    const create = () => createBuddyCacheStore({ storage, now: () => clock });
    const buddy = createBuddyStore({ storage, settings: async () => ({ favoritesSource: 'buddies' }), now: () => clock });
    const change = async action => {
        const sender = { tab: { id: 1 } };
        const lease = await buddy.action({ phase: 'begin', ownerCid: 1, ...target, action }, sender);
        assert.equal(lease.ok, true);
        assert.equal((await buddy.action({ phase: 'dispatch', token: lease.token }, sender)).ok, true);
        assert.equal((await buddy.action({ phase: 'complete', token: lease.token, buddy: action === 'add' }, sender)).ok, true);
    };
    return { values, create, store: create(), change, ignored: createIgnoredStore({ storage }), advance: () => { clock++; } };
};
const begin = (store, observedAt = null) => store.action({ phase: 'begin', observedAt }).then(result => {
    assert.equal(result.ok, true); return result.snapshot;
});
const publish = (store, snapshot, value) => store.action({ phase: 'publish', snapshot, cache: value });

test('late refreshes cannot undo confirmed Buddy additions or removals, including after worker restart', async () => {
    for (const action of ['add', 'remove']) {
        const original = cache(action === 'add' ? [] : [target]);
        const h = harness(original), snapshot = await begin(h.store);
        await h.change(action);
        const confirmed = structuredClone(h.values);
        const result = await publish(h.create(), snapshot, { ...original, fetchedAt: 100 });
        assert.deepEqual(result, { ok: true, written: false });
        assert.deepEqual(h.values, confirmed);
        const ignore = await h.ignored.mutate({ kind: 'add', entry: { ...target, addedAt: 100 } });
        assert.equal(ignore.ok, action === 'remove');
    }
});

test('refresh publication and Buddy confirmation share one lane in either order', async () => {
    const h = harness(cache([])), snapshot = await begin(h.store);
    assert.equal((await publish(h.store, snapshot, cache([], 100))).written, true);
    await h.change('add');
    assert.deepEqual(h.values.bpbBuddyCache.entries, [target]);
    assert.equal(h.values.bpbBuddyCache.fetchedAt, 100, 'target confirmation preserves report age');
});

test('concurrent refreshes preserve the first accepted result instead of letting an older response win', async () => {
    const h = harness(cache([]));
    const [first, second] = await Promise.all([begin(h.store), begin(h.store)]);
    const current = cache([target], 100);
    assert.equal((await publish(h.store, second, current)).written, true);
    assert.equal((await publish(h.store, first, cache([], 100))).written, false);
    assert.deepEqual(h.values.bpbBuddyCache, current);
    const epoch = structuredClone(h.values[BUDDY_CACHE_EPOCH_KEY]);
    assert.equal((await publish(h.store, first, current)).written, true, 'Options can acknowledge its own helper result');
    assert.deepEqual(h.values[BUDDY_CACHE_EPOCH_KEY], epoch, 'an acknowledgement performs no second write');
});

test('an older rendered report cannot overwrite a change completed before its content script started', async () => {
    const h = harness(cache([]));
    await h.change('add'); h.advance();
    const snapshot = await begin(h.store, 99);
    assert.equal((await publish(h.store, snapshot, cache([], 101))).written, false);
    assert.deepEqual(h.values.bpbBuddyCache.entries, [target]);
    const fresh = await begin(h.store, 101);
    assert.equal((await publish(h.store, fresh, cache([target], 101))).written, true);
});

test('invalid refresh data preserves the last cache and an absent cache can become a valid empty list', async () => {
    const h = harness(undefined), snapshot = await begin(h.store);
    assert.equal((await publish(h.store, snapshot, cache([]))).written, true);
    const saved = structuredClone(h.values);
    for (const value of [null, cache([{ cid: 0, name: 'Invalid' }]), cache([target, target])]) {
        assert.equal((await publish(h.store, await begin(h.store), value)).ok, false);
        assert.deepEqual(h.values, saved);
    }
});
