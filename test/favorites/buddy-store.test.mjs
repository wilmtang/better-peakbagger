// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuddyStore } from '../../src/background/buddy-store.js';
import { createIgnoredStore } from '../../src/background/ignored-store.js';
import { BUDDY_INTENTS_KEY } from '../../src/favorites/buddy-state.js';
import * as I from '../../src/favorites/ignored-climbers.js';

const entry = { cid: 900002, name: 'Casey Alpine', addedAt: 1 };
const begin = { phase: 'begin', ownerCid: 900001, cid: entry.cid, name: entry.name, action: 'add' };
const harness = initial => {
    const values = structuredClone(initial || {});
    const storage = { get: async () => structuredClone(values), set: async patch => { Object.assign(values, structuredClone(patch)); } };
    let clock = 1000, sequence = 0;
    const create = () => createBuddyStore({ storage, settings: async () => ({ favoritesSource: 'buddies' }),
        now: () => clock, token: () => `token-${++sequence}` });
    return { values, storage, create, store: create(), ignored: createIgnoredStore({ storage }), advance: () => { clock += 60001; } };
};
const sender = id => ({ tab: { id } });

test('Buddy and Ignore additions serialize so only one can win, including sync reservations', async () => {
    for (const buddyFirst of [true, false]) {
        const h = harness();
        const buddy = () => h.store.action(begin, sender(1)), ignore = () => h.ignored.mutate({ kind: 'add', entry });
        const results = await Promise.all(buddyFirst ? [buddy(), ignore()] : [ignore(), buddy()]);
        assert.equal(results.filter(result => result.ok).length, 1);
    }
    const h = harness({ [I.SYNC_KEY]: { pending: { result: [entry] } } });
    assert.equal((await h.store.action(begin, sender(1))).ok, false);
});

test('two tabs cannot dispatch the same intent; unknown state survives worker restart and lease expiry', async () => {
    const h = harness(), first = await h.store.action(begin, sender(1));
    assert.equal((await h.store.action(begin, sender(2))).ok, false);
    assert.equal((await h.store.action({ phase: 'dispatch', token: first.token }, sender(2))).ok, false);
    await h.store.action({ phase: 'dispatch', token: first.token }, sender(1));
    h.advance();
    assert.equal((await h.ignored.mutate({ kind: 'add', entry })).ok, false, 'expiry never authorizes Ignore');
    const restarted = h.create(), recovered = await restarted.action(begin, sender(2));
    assert.equal(recovered.checkOnly, true);
    assert.equal((await restarted.action({ phase: 'dispatch', token: recovered.token }, sender(2))).ok, false);
    assert.equal((await restarted.action({ phase: 'complete', token: first.token, buddy: false }, sender(1))).ok, false);
    assert.equal((await restarted.action({ phase: 'complete', token: recovered.token, buddy: false }, sender(2))).ok, true);
    assert.deepEqual(h.values[BUDDY_INTENTS_KEY], []);
    assert.equal((await h.ignored.mutate({ kind: 'add', entry })).ok, true);
});

test('pre-dispatch failures release reservations; dispatched failures retain them and wrong owners cannot recover', async () => {
    const h = harness();
    let result = await h.store.action(begin, sender(1));
    await h.store.action({ phase: 'failed', token: result.token }, sender(1));
    assert.deepEqual(h.values[BUDDY_INTENTS_KEY], []);
    result = await h.store.action(begin, sender(1));
    await h.store.action({ phase: 'dispatch', token: result.token }, sender(1));
    await h.store.action({ phase: 'failed', token: result.token, dispatched: true }, sender(1));
    assert.equal(h.values[BUDDY_INTENTS_KEY][0].leaseUntil, 0);
    assert.equal((await h.store.action({ ...begin, ownerCid: 900009 }, sender(1))).ok, false);
});

test('status-only reservations cannot dispatch, including recovery of an abandoned preparation', async () => {
    const h = harness();
    let result = await h.store.action({ ...begin, checkOnly: true }, sender(1));
    assert.equal((await h.store.action({ phase: 'dispatch', token: result.token }, sender(1))).ok, false);
    await h.store.action({ phase: 'failed', token: result.token }, sender(1));
    await h.store.action(begin, sender(1)); h.advance();
    result = await h.store.action(begin, sender(2));
    assert.equal(result.checkOnly, true);
    assert.equal((await h.store.action({ phase: 'dispatch', token: result.token }, sender(2))).ok, false);
});

test('unreadable favorite settings cannot hide a confirmed Buddy result or mutate favorites using defaults', async () => {
    const h = harness(), store = createBuddyStore({ storage: h.storage,
        settings: async () => { throw new Error('storage unavailable'); } });
    const lease = await store.action(begin, sender(1));
    await store.action({ phase: 'dispatch', token: lease.token }, sender(1));
    const result = await store.action({ phase: 'complete', token: lease.token, buddy: true }, sender(1));
    assert.equal(result.ok, true); assert.match(result.warning, /Buddy change saved/);
    assert.equal(h.values.bpbBuddyCache.entries[0].cid, entry.cid);
    assert.equal(h.values.bpbFavoriteClimbers, undefined);
    assert.equal(h.values[BUDDY_INTENTS_KEY][0].status, 'confirmed');
});

test('reconciliation preserves malformed Buddy cache data instead of replacing it with a partial list', async () => {
    const cache = { ownerCid: 900001, entries: [{ cid: 0, name: 'Invalid' }], fetchedAt: 1000 };
    const h = harness({ bpbBuddyCache: cache }), lease = await h.store.action(begin, sender(1));
    await h.store.action({ phase: 'dispatch', token: lease.token }, sender(1));
    assert.equal((await h.store.action({ phase: 'complete', token: lease.token, buddy: true }, sender(1))).ok, false);
    assert.deepEqual(h.values.bpbBuddyCache, cache);
    assert.equal(h.values[BUDDY_INTENTS_KEY].length, 1);
});
