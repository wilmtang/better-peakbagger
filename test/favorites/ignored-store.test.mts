// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../src/favorites/ignored-climbers.ts';
import { createIgnoredStore } from '../../src/background/ignored-store.ts';
import { observeIgnored, type IgnoredStorageApi, type ObservedIgnoredState } from '../../src/favorites/ignored-client.ts';
import { fieldsOf } from '../helpers/result-fields.mts';
const entry = (cid: number) => ({ cid, name: `Climber ${cid}`, addedAt: cid });
const harness = () => {
    const values: Record<string, unknown> = {};
    const storage = { get: async () => structuredClone(values),
        set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); } };
    return { values, storage, store: createIgnoredStore({ storage }) };
};
test('parallel operations compose and duplicate adds do not advance revision', async () => {
    const { store } = harness();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate({ kind: 'add', entry: entry(i + 1) })));
    assert.equal((await store.read()).entries.length, 20);
    assert.equal((await store.read()).revision, 20);
    assert.equal(fieldsOf(await store.mutate({ kind: 'add', entry: entry(1) })).alreadyPresent, true);
    assert.equal((await store.read()).revision, 20);
});
test('reviewed replacements and whole-list undo reject intervening writes', async () => {
    const { store } = harness();
    const reviewed = await store.read();
    await store.mutate({ kind: 'add', entry: entry(1) });
    const result = await store.mutate({ kind: 'replace', entries: [], expectedRevision: reviewed.revision,
        expectedSignature: I.signature(reviewed.entries) });
    assert.equal(fieldsOf(result).error?.code, 'stale');
    assert.equal((await store.read()).entries.length, 1);
});
test('entry-level undo preserves unrelated additions and rejects a changed entry', async () => {
    const { store } = harness();
    await store.mutate({ kind: 'add', entry: entry(1) });
    await store.mutate({ kind: 'remove', cid: 1, expectedEntry: I.entrySignature(entry(1)) });
    await store.mutate({ kind: 'add', entry: entry(2) });
    assert.equal((await store.mutate({ kind: 'add', entry: entry(1), expectedEntry: 'absent' })).ok, true);
    assert.deepEqual((await store.read()).entries.map(e => e.cid), [1,2]);
    assert.equal(fieldsOf(await store.mutate({ kind: 'add', entry: entry(1), expectedEntry: 'absent' })).error?.code, 'stale');
});
test('malformed storage and failed reads or writes never confirm an empty list', async () => {
    const { store, values, storage } = harness();
    values[I.IGNORED_KEY] = { schemaVersion: 2 };
    assert.equal((await store.mutate({ kind: 'add', entry: entry(1) })).ok, false);
    delete values[I.IGNORED_KEY];
    storage.set = async () => { throw new Error('write failed'); };
    assert.equal((await store.mutate({ kind: 'add', entry: entry(1) })).ok, false);
    assert.equal(values[I.IGNORED_KEY], undefined);
    assert.equal(fieldsOf(await store.preference('true')).error?.code, 'invalid');
});
test('storage notification wins over a stale initial async read', async () => {
    let resolveRead!: (values: Record<string, unknown>) => void;
    let listener!: Parameters<IgnoredStorageApi['storage']['onChanged']['addListener']>[0];
    const states: ObservedIgnoredState[] = [];
    const api: IgnoredStorageApi = { storage: { local: { get: () => new Promise(resolve => { resolveRead = resolve; }) },
        onChanged: { addListener: fn => { listener = fn; }, removeListener: () => {} } } };
    const observer = observeIgnored(api, state => { states.push(state); });
    listener({ [I.IGNORED_KEY]: { newValue: { schemaVersion: 1, revision: 1, entries: [entry(1)] } } }, 'local');
    resolveRead({ [I.IGNORED_KEY]: I.emptyList() });
    await Promise.resolve();
    assert.equal(states.length, 1);
    assert.equal(fieldsOf(states[0]!).list?.revision, 1);
    observer.stop();
});
