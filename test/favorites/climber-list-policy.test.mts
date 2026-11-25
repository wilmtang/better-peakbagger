// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFavoritesStore, type FavoritesMutationResult } from '../../src/background/favorites-store.ts';
import { createIgnoredStore, type IgnoredMutateResult } from '../../src/background/ignored-store.ts';
import { favoriteClimbers as F } from '../../src/favorites/favorite-climbers.ts';
import * as I from '../../src/favorites/ignored-climbers.ts';
import { harness as syncHarness, entry } from '../helpers/ignored-sync-harness.mts';
import { fieldsOf, type Fields } from '../helpers/result-fields.mts';

type Values = Record<string, unknown>;
type List = 'favorites' | 'ignored';
// Either store's mutate, as these cases drive both lists alike.
type Mutate = (mutation: Values) => Promise<Fields<FavoritesMutationResult> | Fields<IgnoredMutateResult>>;
const favorite = (cid: number) => ({ ...entry(cid), source: 'manual' });
const harness = (initial?: Values) => {
    const values: Values = structuredClone(initial || {});
    const storage = { get: async () => structuredClone(values),
        set: async (patch: Values) => { await Promise.resolve(); Object.assign(values, structuredClone(patch)); } };
    const favorites = createFavoritesStore({ storage }), ignored = createIgnoredStore({ storage });
    const lists: Record<List, { mutate: Mutate }> = {
        favorites: { mutate: mutation => favorites.mutate(mutation).then(fieldsOf) },
        ignored: { mutate: mutation => ignored.mutate(mutation).then(fieldsOf) },
    };
    return { values, storage, favorites, ignored, lists };
};
// A stored list's entries, read as the identifiers these cases count.
const storedEntries = (value: unknown) => (value as { entries?: { cid: number }[] } | undefined)?.entries;

test('individual additions and entry undo cannot contradict the opposite list', async () => {
    for (const first of ['favorites', 'ignored'] as const) {
        const h = harness();
        assert.equal((await h.lists[first].mutate({ kind: 'add', entry: favorite(2) })).ok, true);
        const other = first === 'favorites' ? 'ignored' : 'favorites';
        const blocked = await h.lists[other].mutate({ kind: 'add', entry: favorite(2), expectedEntry: 'absent' });
        assert.equal(blocked.error?.code, 'list-conflict');
        assert.match(blocked.error?.message ?? '', first === 'ignored' ? /Unignore/ : /Remove from favorites/);
        assert.equal(h.values[other === 'ignored' ? I.IGNORED_KEY : F.FAVORITES_KEY], undefined);
        await h.lists[first].mutate({ kind: 'remove', cid: 2 });
        assert.equal((await h.lists[other].mutate({ kind: 'add', entry: favorite(2) })).ok, true);
    }
});

test('simultaneous ignore and favorite additions share one lane and only one can win', async () => {
    for (const order of [['favorites', 'ignored'], ['ignored', 'favorites']] as List[][]) {
        const h = harness();
        const results = await Promise.all(order.map(list => h.lists[list].mutate({ kind: 'add', entry: favorite(2) })));
        assert.equal(results.filter(result => result.ok).length, 1);
        assert.equal(results[1]?.error?.code, 'list-conflict');
        assert.equal([h.values[F.FAVORITES_KEY], h.values[I.IGNORED_KEY]]
            .filter(list => storedEntries(list)?.some(value => value.cid === 2)).length, 1);
    }
});

test('buddy imports and reviewed favorite replacements cannot add ignored IDs', async () => {
    const h = harness({ [I.IGNORED_KEY]: { schemaVersion: 1, revision: 1, entries: [entry(2)] } });
    const before = JSON.stringify(h.values);
    for (const mutation of [{ kind: 'merge-buddies', entries: [entry(2), entry(3)] },
        { kind: 'replace', favorites: { schemaVersion: 1, entries: [favorite(2)] },
            expectedSignature: F.backupSignature(null) }]) {
        const result = fieldsOf(await h.favorites.mutate(mutation));
        assert.equal(result.error?.code, 'list-conflict');
        assert.equal(JSON.stringify(h.values), before, 'a blocked import must not partially change the list');
    }
});

test('saved buddies and custom favorites protect ignored additions and replacements in either source mode', async () => {
    const h = harness({ [F.FAVORITES_KEY]: { schemaVersion: 1, entries: [favorite(2)] },
        [F.BUDDY_CACHE_KEY]: { ownerCid: 10, entries: [entry(3)], fetchedAt: Date.now() } });
    for (const cid of [2, 3]) {
        assert.equal(fieldsOf(await h.ignored.mutate({ kind: 'add', entry: entry(cid) })).error?.code, 'list-conflict');
        assert.equal(fieldsOf(await h.ignored.mutate({ kind: 'replace', entries: [entry(cid)],
            expectedRevision: 0, expectedSignature: I.signature([]) })).error?.code, 'list-conflict');
    }
});

test('legacy overlaps can be removed but corrupted opposite-list storage never permits additions', async () => {
    const h = harness({ [F.FAVORITES_KEY]: { schemaVersion: 1, entries: [favorite(2)] },
        [I.IGNORED_KEY]: { schemaVersion: 1, revision: 1, entries: [entry(2)] } });
    assert.equal((await h.favorites.mutate({ kind: 'remove', cid: 2 })).ok, true);
    assert.equal((await h.ignored.mutate({ kind: 'remove', cid: 2 })).ok, true);
    h.values[I.IGNORED_KEY] = { schemaVersion: 2 };
    assert.equal(fieldsOf(await h.favorites.mutate({ kind: 'add', entry: favorite(3) })).error?.code, 'storage');
    h.values[I.IGNORED_KEY] = I.emptyList(); h.values[F.FAVORITES_KEY] = { schemaVersion: 2 };
    assert.equal(fieldsOf(await h.ignored.mutate({ kind: 'add', entry: entry(3) })).error?.code, 'storage');
});

test('ignored GitHub restores and merges stop before changing either list when a candidate is favorite', async () => {
    for (const action of ['restore', 'setup']) {
        const h = syncHarness({ local: [], remote: [entry(2)] });
        h.values[F.FAVORITES_KEY] = { schemaVersion: 1, entries: [favorite(2)] };
        const review = fieldsOf(await h.engine.action({ action }));
        assert.ok(review.preview);
        const result = fieldsOf(await h.confirm(review.preview, 'github'));
        assert.equal(result.error?.code, 'list-conflict');
        assert.equal(h.writes, 0);
        assert.deepEqual((await h.store.read()).entries, []);
    }
});

test('an upload reserves future ignored IDs so a concurrent favorite cannot invalidate reconciliation', async () => {
    const h = syncHarness({ local: [], remote: [entry(2)] });
    const favorites = createFavoritesStore({ storage: h.storage });
    let release: (() => void) | undefined;
    h.commitHook = () => new Promise<void>(resolve => { release = resolve; });
    const review = fieldsOf(await h.engine.action({ action: 'setup' }));
    assert.ok(review.preview);
    const upload = h.confirm(review.preview, 'github');
    const deadline = Date.now() + 5000;
    while (!release && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release, 'the sync must reach the reserved upload before testing the concurrent add');
    try {
        const blocked = fieldsOf(await favorites.mutate({ kind: 'add', entry: favorite(2) }));
        assert.equal(blocked.error?.code, 'list-conflict');
        assert.match(blocked.error?.message ?? '', /pending ignored-climber sync/);
    } finally { release?.(); }
    assert.equal((await upload).ok, true);
    assert.deepEqual((await h.store.read()).entries.map(value => value.cid), [2]);
});
