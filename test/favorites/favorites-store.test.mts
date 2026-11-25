// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFavoritesStore } from '../../src/background/favorites-store.ts';
import { favoriteClimbers as F } from '../../src/favorites/favorite-climbers.ts';
import { fieldsOf } from '../helpers/result-fields.mts';

interface Entry { cid: number; name: string; addedAt: number; source: string }
interface Envelope { schemaVersion: number; entries: Entry[] }

const entry = (cid: number, name = `Climber ${cid}`, addedAt = cid, source = 'manual'): Entry => ({
    cid, name, addedAt, source,
});
const envelope = (entries: unknown[]) => ({ schemaVersion: F.SCHEMA_VERSION, entries });

// Tests seed unreadable values too; what they read back is the worker's list.
const createStorage = (initial: unknown = envelope([])) => {
    let value = structuredClone(initial);
    let failNextSet = false;
    return {
        async get() {
            await Promise.resolve();
            return { [F.FAVORITES_KEY]: structuredClone(value) };
        },
        async set(patch: Record<string, unknown>) {
            await Promise.resolve();
            if (failNextSet) {
                failNextSet = false;
                throw new Error('storage unavailable');
            }
            value = structuredClone(patch[F.FAVORITES_KEY]);
        },
        read: () => structuredClone(value) as Envelope,
        failOnce: () => { failNextSet = true; },
    };
};

test('the worker queue composes simultaneous intent-based additions', async () => {
    const storage = createStorage(envelope([entry(1)]));
    const store = createFavoritesStore({ storage, now: () => 50 });

    const [first, second] = await Promise.all([
        store.mutate({ kind: 'add', entry: entry(2) }),
        store.mutate({ kind: 'add', entry: entry(3) }),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(storage.read().entries.map(value => value.cid), [3, 2, 1]);
});

test('an additive Buddy merge and a removal both apply to the latest list', async () => {
    const storage = createStorage(envelope([entry(1), entry(2)]));
    const store = createFavoritesStore({ storage, now: () => 75 });

    await Promise.all([
        store.mutate({ kind: 'merge-buddies', entries: [{ cid: 3, name: 'Buddy Three' }] }),
        store.mutate({ kind: 'remove', cid: 1 }),
    ]);

    assert.deepEqual(storage.read().entries, [
        entry(2),
        { cid: 3, name: 'Buddy Three', addedAt: 75, source: 'buddy' },
    ]);
});

test('a destructive replacement rejects a stale reviewed signature', async () => {
    const original = envelope([entry(1)]);
    const storage = createStorage(original);
    const store = createFavoritesStore({ storage });
    const reviewedSignature = F.backupSignature(original);

    await store.mutate({ kind: 'add', entry: entry(2) });
    const result = await store.mutate({
        kind: 'replace',
        favorites: envelope([entry(3)]),
        expectedSignature: reviewedSignature,
    });

    assert.equal(result.ok, false);
    assert.equal(fieldsOf(result).error?.code, 'stale');
    assert.match(fieldsOf(result).error?.message ?? '', /changed in another tab/i);
    assert.deepEqual(storage.read().entries.map(value => value.cid), [2, 1]);
    assert.deepEqual(result.favorites?.entries.map(value => value.cid), [2, 1]);
});

test('a failed storage write does not poison the next queued mutation', async () => {
    const storage = createStorage(envelope([entry(1)]));
    const store = createFavoritesStore({ storage });
    storage.failOnce();

    const failed = await store.mutate({ kind: 'add', entry: entry(2) });
    const recovered = await store.mutate({ kind: 'add', entry: entry(3) });

    assert.equal(failed.ok, false);
    assert.equal(fieldsOf(failed).error?.code, 'storage');
    assert.equal(recovered.ok, true);
    assert.deepEqual(storage.read().entries.map(value => value.cid), [3, 1]);
});

test('invalid or over-capacity mutations fail without truncating stored favorites', async () => {
    const full = envelope(Array.from({ length: F.LIMIT }, (_, index) => entry(index + 1)));
    const storage = createStorage(full);
    const store = createFavoritesStore({ storage });

    const overLimit = await store.mutate({ kind: 'add', entry: entry(F.LIMIT + 1) });
    const duplicateReplacement = await store.mutate({
        kind: 'replace',
        favorites: envelope([entry(1), entry(1)]),
        expectedSignature: F.backupSignature(full),
    });

    assert.equal(fieldsOf(overLimit).error?.code, 'limit');
    assert.equal(fieldsOf(duplicateReplacement).error?.code, 'invalid');
    assert.equal(storage.read().entries.length, F.LIMIT);
    assert.equal(storage.read().entries.at(-1)?.cid, F.LIMIT);
});

test('ordinary edits and replacements preserve unreadable saved favorites exactly', async () => {
    const unreadable = [
        null, [], { schemaVersion: 2, entries: [entry(1)] },
        { schemaVersion: 1 }, envelope([entry(1), { cid: 2, name: 'Incomplete' }]),
        envelope([entry(1), entry(1)]),
        envelope(Array.from({ length: F.LIMIT + 1 }, (_, index) => entry(index + 1))),
    ];
    const mutations = [
        { kind: 'add', entry: entry(3) },
        { kind: 'remove', cid: 1 },
        { kind: 'merge-buddies', entries: [{ cid: 3, name: 'Buddy Three' }] },
        { kind: 'replace', favorites: envelope([entry(3)]), expectedSignature: F.backupSignature(envelope([])) },
    ];
    for (const original of unreadable) {
        for (const mutation of mutations) {
            const storage = createStorage(original);
            const result = await createFavoritesStore({ storage }).mutate(mutation);
            assert.equal(result.ok, false);
            assert.equal(fieldsOf(result).error?.code, 'storage');
            assert.deepEqual(storage.read(), original);
        }
    }
});
