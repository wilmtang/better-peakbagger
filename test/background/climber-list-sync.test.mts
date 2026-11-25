// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../src/favorites/ignored-climbers.ts';
import { harness, entry } from '../helpers/ignored-sync-harness.mts';
import type { IgnoredSyncAlarms, IgnoredSyncState } from '../../src/background/climber-list-sync.ts';
import { deferred } from '../helpers/deferred.mts';
import { fieldsOf } from '../helpers/result-fields.mts';
import { required } from '../helpers/required.mts';

const storedState = (h: ReturnType<typeof harness>) => h.values[I.SYNC_KEY] as IgnoredSyncState;

test('explicitly enabled connected sync initializes by preserving both lists', async () => {
    for (const remote of [null, [], [entry(2)]]) {
        const h = harness({ remote, syncEnabled: true });
        assert.equal(fieldsOf(await h.engine.status()).state?.enabled, true);
        const result = fieldsOf(await h.engine.start());
        assert.equal(result.ok, true);
        assert.equal(required(result.state).phase, 'synced');
        assert.deepEqual(new Set(required(result.list).entries.map(e => e.cid)), new Set([1, ...(remote || []).map(e => e.cid)]));
        assert.deepEqual(I.parseBackup(h.remote), required(result.list).entries);
    }
});
test('fresh sync requires a connected repository and preserves explicit opt-outs across connection changes', async () => {
    const { createClimberListSync } = await import('../../src/background/climber-list-sync.ts');
    const fresh = harness({ syncEnabled: true });
    const offline = createClimberListSync({ ...fresh.engineOptions, getAccess: async () => ({ error: { code: 'not-connected' } }) });
    assert.equal(fieldsOf(await offline.start()).skipped, true);
    assert.equal(fresh.reads, 0); assert.equal(fresh.writes, 0);
    const disabled = harness();
    await disabled.engine.connectionChanged();
    assert.equal(fieldsOf(await disabled.engine.status()).state?.enabled, false);
    assert.equal(disabled.reads, 0); assert.equal(disabled.writes, 0);
});
test('fresh metadata conflicts keep sync enabled and pause without writing or replacing either list', async () => {
    const h = harness({ remote: [entry(1, 'Other name')], syncEnabled: true });
    const result = fieldsOf(await h.engine.start());
    assert.equal(required(result.preview).conflicts.length, 1);
    assert.equal(fieldsOf(await h.engine.status()).state?.enabled, true);
    assert.equal(h.writes, 0);
    assert.deepEqual((await h.store.read()).entries, [entry(1)]);
    await h.engine.action({ action: 'check' });
    assert.equal(h.reads, 1, 'a pending review must not repeat the setup');
});
test('an automatic check delayed behind manual review preserves the reviewed preview', async () => {
    const { createClimberListSync } = await import('../../src/background/climber-list-sync.ts');
    const h = harness({ remote: [entry(2)], syncEnabled: true });
    const heldCheck = deferred<void>(), reachedAccess = deferred<void>();
    let accessCalls = 0;
    const engine = createClimberListSync({ ...h.engineOptions, getAccess: async () => {
        if (++accessCalls === 1) { reachedAccess.resolve(); await heldCheck.promise; }
        return h.engineOptions.getAccess();
    } });
    const automatic = engine.action({ action: 'check' });
    await reachedAccess.promise;
    const prepared = fieldsOf(await engine.action({ action: 'setup' }));
    assert.equal(prepared.ok, true);
    heldCheck.resolve();
    const checked = fieldsOf(await automatic);
    assert.equal(h.writes, 0, 'automatic work must not upload before manual confirmation');
    assert.equal(checked.skipped, true, 'queued automatic work must yield to the new manual review');
    assert.equal(required(fieldsOf(await engine.status()).preview).id, required(prepared.preview).id);
    const confirmed = fieldsOf(await engine.action({ action: 'confirm', reviewId: required(prepared.preview).id, mode: 'merge' }));
    assert.equal(confirmed.ok, true);
    assert.deepEqual(new Set(required(confirmed.list).entries.map(item => item.cid)), new Set([1,2]));
});
test('an automatic check delayed behind disabling sync retains the opt-out', async () => {
    const { createClimberListSync } = await import('../../src/background/climber-list-sync.ts');
    const h = harness({ remote: [entry(2)], syncEnabled: true });
    const heldCheck = deferred<void>(), reachedAccess = deferred<void>();
    let accessCalls = 0;
    const engine = createClimberListSync({ ...h.engineOptions, getAccess: async () => {
        if (++accessCalls === 1) { reachedAccess.resolve(); await heldCheck.promise; }
        return h.engineOptions.getAccess();
    } });
    const automatic = engine.action({ action: 'check' });
    await reachedAccess.promise;
    await engine.action({ action: 'disable' });
    heldCheck.resolve();
    assert.equal(fieldsOf(await automatic).skipped, true);
    const status = fieldsOf(await engine.status());
    assert.equal(required(status.state).enabled, false);
    assert.equal(status.preview, null);
    assert.equal(h.reads, 0);
    assert.equal(h.writes, 0);
});
test('turning sync on persists immediately and new connections retain the preference', async () => {
    const h = harness({ remote: [entry(2)] });
    const result = fieldsOf(await h.engine.action({ action: 'enable' }));
    assert.equal(required(result.state).enabled, true);
    assert.equal(h.reads, 0); assert.equal(h.writes, 0);
    await h.engine.connectionChanged();
    assert.equal(fieldsOf(await h.engine.status()).state?.enabled, true);
    assert.deepEqual(new Set((await h.store.read()).entries.map(e => e.cid)), new Set([1,2]));
    await h.engine.action({ action: 'disable' });
    await h.engine.connectionChanged();
    assert.equal(fieldsOf(await h.engine.status()).state?.enabled, false);
});
test('disabling during first automatic setup prevents an upload and retains the opt-out', async () => {
    const h = harness({ syncEnabled: true });
    h.readHook = () => h.engine.action({ action: 'disable' });
    assert.equal((await h.engine.start()).ok, false);
    assert.equal(h.writes, 0);
    assert.equal(fieldsOf(await h.engine.status()).state?.enabled, false);
});
test('disabling between automatic setup and confirmation cannot re-enable sync', async () => {
    const h = harness({ syncEnabled: true });
    const save = h.storage.set;
    let disabled: ReturnType<typeof h.engine.action> | undefined;
    h.storage.set = async patch => {
        await save(patch);
        if ((patch[I.SYNC_KEY] as IgnoredSyncState | undefined)?.review?.kind === 'setup' && !disabled) disabled = h.engine.action({ action: 'disable' });
    };
    assert.equal((await h.engine.start()).ok, false);
    await required(disabled);
    assert.equal(h.writes, 0);
    assert.equal(fieldsOf(await h.engine.status()).state?.enabled, false);
});

test('new-file backup is explicit and allowlisted; existing remote needs a reviewed replacement', async () => {
    const h = harness(); assert.equal((await h.engine.action({ action: 'backup' })).ok, true);
    assert.deepEqual(I.parseBackup(h.remote), [entry(1)]);
    assert.equal(storedState(h).enabled, false);
    h.remote = I.serializeBackup([entry(2)]);
    const response = fieldsOf(await h.engine.action({ action: 'backup' }));
    assert.equal(response.needsReview, true); assert.equal(h.writes, 1);
    assert.deepEqual(required(response.preview).impacts.device.remote, { added: 1, removed: 1 });
    assert.equal(fieldsOf(await h.confirm(required(response.preview), 'device')).ok, true);
});
test('missing and malformed backup are never empty restores, but an explicit empty file can clear with guarded Undo', async () => {
    const h = harness(); assert.equal(fieldsOf(await h.engine.action({ action: 'restore' })).error?.code, 'missing');
    h.remote = '{"entries":[]}'; assert.equal(fieldsOf(await h.engine.action({ action: 'restore' })).error?.code, 'invalid');
    h.remote = I.serializeBackup([]);
    const preview = fieldsOf(await h.engine.action({ action: 'restore' })).preview;
    const restored = fieldsOf(await h.confirm(required(preview), 'github')); assert.deepEqual(required(restored.list).entries, []);
    await h.store.mutate({ kind: 'add', entry: entry(3) });
    const undo = await h.store.mutate({ kind: 'replace', ...required(restored.undo) });
    assert.equal(fieldsOf(undo).error?.code, 'stale'); assert.deepEqual((await h.store.read()).entries, [entry(3)]);
});
test('storage failure cannot create an empty upload', async () => {
    const h = harness(); h.failGet = true;
    assert.equal((await h.engine.action({ action: 'backup' })).ok, false);
    assert.equal(h.writes, 0); assert.equal(h.reads, 0);
});
test('a changed local revision or remote snapshot invalidates review', async () => {
    for (const side of ['local', 'remote']) {
        const h = harness({ remote: [entry(2)] });
        const preview = fieldsOf(await h.engine.action({ action: 'backup' })).preview;
        if (side === 'local') await h.store.mutate({ kind: 'add', entry: entry(3) }); else h.remote = I.serializeBackup([entry(4)]);
        const response = fieldsOf(await h.confirm(required(preview), 'device')); assert.equal(response.error?.code, 'stale'); assert.equal(h.writes, 0);
    }
});
test('the file is reread on a ref retry and cannot overwrite new remote membership', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = fieldsOf(await h.engine.action({ action: 'backup' })).preview;
    h.retryHook = () => { h.remote = I.serializeBackup([entry(4)]); };
    assert.equal(fieldsOf(await h.confirm(required(preview), 'device')).error?.code, 'stale'); assert.equal(h.writes, 0);
    assert.deepEqual(I.parseBackup(h.remote), [entry(4)]);
});
test('an auth epoch change cancels a reviewed write', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = fieldsOf(await h.engine.action({ action: 'backup' })).preview;
    h.epoch++; assert.equal(fieldsOf(await h.confirm(required(preview), 'device')).error?.code, 'superseded'); assert.equal(h.writes, 0);
});
test('changes made during upload survive reconciliation and a failed reconciliation retains its journal', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = fieldsOf(await h.engine.action({ action: 'backup' })).preview;
    h.commitHook = async () => { await h.store.mutate({ kind: 'remove', cid: 1 }); await h.store.mutate({ kind: 'add', entry: entry(3) }); };
    const response = fieldsOf(await h.confirm(required(preview), 'merge')); assert.equal(response.ok, true);
    assert.deepEqual(new Set(required(response.list).entries.map(e => e.cid)), new Set([2,3]));
    assert.deepEqual(new Set(required(I.parseBackup(h.remote)).map(e => e.cid)), new Set([1,2]));
    const broken = harness(); broken.failReconcile = true;
    assert.equal((await broken.engine.action({ action: 'backup' })).ok, false);
    assert.ok(storedState(broken).pending); assert.deepEqual(I.parseBackup(broken.remote), [entry(1)]);
});

const setup = async (h: ReturnType<typeof harness>) => {
    const response = fieldsOf(await h.engine.action({ action: 'setup' }));
    assert.equal(response.ok, true);
    const confirmed = fieldsOf(await h.confirm(required(response.preview))); assert.equal(confirmed.ok, true); return confirmed;
};
test('sync setup is device-local, reviewed, and preserves both lists by default', async () => {
    const h = harness({ remote: [entry(2)] });
    assert.equal(fieldsOf(await h.engine.start()).skipped, true); assert.equal(h.reads, 0);
    const response = fieldsOf(await h.engine.action({ action: 'setup' }));
    assert.deepEqual((await h.store.read()).entries, [entry(1)]); assert.equal(storedState(h).enabled, false);
    const confirmed = fieldsOf(await h.confirm(required(response.preview)));
    assert.equal(required(confirmed.state).enabled, true); assert.equal(required(confirmed.state).phase, 'synced');
    assert.deepEqual(new Set(required(confirmed.list).entries.map(e => e.cid)), new Set([1,2]));
});
test('two devices converge independent additions and deletions against their own common baseline', async () => {
    const a = harness({ local: [entry(1),entry(2)], remote: [entry(1),entry(2)] });
    const b = harness({ local: [entry(1),entry(2)], remote: [entry(1),entry(2)] });
    let remote = a.remote;
    for (const h of [a,b]) Object.defineProperty(h, 'remote', { get: () => remote, set: value => { remote = value; } });
    await setup(a); await setup(b);
    await a.store.mutate({ kind: 'remove', cid: 1 }); await a.store.mutate({ kind: 'add', entry: entry(3) });
    assert.equal((await a.engine.action({ action: 'sync' })).ok, true);
    await b.store.mutate({ kind: 'remove', cid: 2 }); await b.store.mutate({ kind: 'add', entry: entry(4) });
    assert.equal((await b.engine.action({ action: 'sync' })).ok, true);
    assert.equal((await a.engine.action({ action: 'sync' })).ok, true);
    for (const h of [a,b]) assert.deepEqual(new Set((await h.store.read()).entries.map(e => e.cid)), new Set([3,4]));
    assert.deepEqual(new Set(required(I.parseBackup(remote)).map(e => e.cid)), new Set([3,4]));
});
test('delete versus metadata change pauses before writes; scoped choices propagate the chosen removal', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'remove', cid: 1 }); h.remote = I.serializeBackup([entry(1, 'Changed on GitHub')]);
    const writes = h.writes, response = fieldsOf(await h.engine.action({ action: 'sync' }));
    assert.equal(response.ok, false); assert.equal(required(response.preview).kind, 'conflict'); assert.equal(h.writes, writes);
    assert.deepEqual((await h.store.read()).entries, []);
    assert.equal(required(response.preview).conflicts[0].device, null);
    const confirmed = fieldsOf(await h.confirm(required(response.preview), 'merge', { 1: 'device' }));
    assert.equal(confirmed.ok, true); assert.deepEqual(I.parseBackup(h.remote), []);
});
test('sync ref retries rerun the merge with fresh remote and local snapshots', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'add', entry: entry(2) });
    h.retryHook = async () => { h.remote = I.serializeBackup([entry(1),entry(3)]); await h.store.mutate({ kind: 'add', entry: entry(4) }); };
    const response = fieldsOf(await h.engine.action({ action: 'sync' })); assert.equal(response.ok, true);
    assert.deepEqual(new Set(required(I.parseBackup(h.remote)).map(e => e.cid)), new Set([1,2,3,4]));
});
test('local edits after commit stay pending, and edits before ref advancement abort the stale proposal', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    h.remote = I.serializeBackup([entry(1),entry(2)]);
    h.commitHook = async () => { await h.store.mutate({ kind: 'add', entry: entry(3) }); };
    const response = fieldsOf(await h.engine.action({ action: 'sync' }));
    assert.equal(required(response.state).phase, 'pending'); assert.deepEqual(new Set(required(response.list).entries.map(e => e.cid)), new Set([1,2,3]));
    assert.deepEqual(I.parseBackup(h.remote), [entry(1),entry(2)]);
    h.commitHook = null; h.beforeRefHook = async () => { await h.store.mutate({ kind: 'remove', cid: 1 }); };
    const aborted = fieldsOf(await h.engine.action({ action: 'sync' })); assert.equal(aborted.error?.code, 'stale');
    assert.deepEqual(I.parseBackup(h.remote), [entry(1),entry(2)]); assert.ok(storedState(h).pending);
});
test('worker restart confirms an accepted setup and rebases later local edits', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = fieldsOf(await h.engine.action({ action: 'setup' })).preview;
    h.commitHook = async () => { await h.store.mutate({ kind: 'add', entry: entry(3) }); h.failReconcile = true; };
    assert.equal(fieldsOf(await h.confirm(required(preview))).ok, false); assert.ok(storedState(h).pending);
    h.failReconcile = false; h.commitHook = null;
    const { createClimberListSync } = await import('../../src/background/climber-list-sync.ts');
    const resumed = createClimberListSync(h.engineOptions);
    const recovered = fieldsOf(await resumed.start()); assert.equal(recovered.ok, true); assert.equal(required(recovered.result).recovered, true);
    assert.deepEqual(new Set(required(recovered.list).entries.map(e => e.cid)), new Set([1,2,3]));
    assert.equal(required(recovered.state).enabled, true); assert.equal(required(recovered.state).phase, 'pending'); assert.equal(required(recovered.state).pending, null);
});
test('uncertain recovery and a missing confirmed file require review without recreating or replacing local data', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'add', entry: entry(3) }); h.failReconcile = true;
    assert.equal((await h.engine.action({ action: 'sync' })).ok, false); h.failReconcile = false;
    h.remote = I.serializeBackup([entry(1),entry(3),entry(4)]);
    const writes = h.writes; const response = fieldsOf(await h.engine.action({ action: 'sync' }));
    assert.equal(required(response.preview).kind, 'recovery'); assert.equal(h.writes, writes); assert.deepEqual((await h.store.read()).entries, [entry(3),entry(1)]);
    assert.equal(fieldsOf(await h.confirm(required(response.preview))).ok, true);
    h.remote = null;
    const missing = fieldsOf(await h.engine.action({ action: 'sync' })); assert.equal(required(missing.preview).remote, null); assert.equal(h.remote, null);
});
test('disabling during an accepted upload leaves local edits and the uncertainty journal, with no startup network', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'add', entry: entry(3) });
    h.commitHook = () => h.engine.action({ action: 'disable' });
    const response = fieldsOf(await h.engine.action({ action: 'sync' })); assert.equal(response.ok, false);
    assert.equal(storedState(h).enabled, false); assert.ok(storedState(h).pending);
    assert.deepEqual((await h.store.read()).entries, [entry(3),entry(1)]);
    const reads = h.reads; assert.equal(fieldsOf(await h.engine.start()).skipped, true); assert.equal(h.reads, reads);
});
test('alarms trail local edits, check on startup and manager opening, and duplicate sync triggers coalesce', async () => {
    const h = harness({ remote: [entry(1)] }); let time = 1000000;
    const scheduled = new Map<string, Parameters<IgnoredSyncAlarms['create']>[1]>();
    const { createClimberListSync, IGNORED_SYNC_ALARM, IGNORED_CHANGE_ALARM } = await import('../../src/background/climber-list-sync.ts');
    h.engine = createClimberListSync({ ...h.engineOptions, now: () => time,
        alarms: { create: (name, options) => scheduled.set(name, options), clear: name => scheduled.delete(name) } });
    await setup(h); assert.equal(scheduled.get(IGNORED_SYNC_ALARM)?.periodInMinutes, 15);
    await h.store.mutate({ kind: 'add', entry: entry(2) }); await h.engine.localChanged(); await h.engine.localChanged();
    assert.equal(scheduled.get(IGNORED_CHANGE_ALARM)?.delayInMinutes, 0.5);
    assert.equal(storedState(h).phase, 'pending');
    const checked = fieldsOf(await h.engine.action({ action: 'check' })); assert.equal(checked.skipped, true);
    time += 61000;
    const gate = deferred<void>(); h.commitHook = () => gate.promise;
    const one = h.engine.action({ action: 'sync' }), two = h.engine.action({ action: 'sync' }); assert.equal(one, two);
    gate.resolve(); await one; h.commitHook = null;
    assert.equal((await h.engine.start()).ok, true);
    await h.engine.action({ action: 'disable' }); assert.equal(scheduled.size, 0);
});
test('sync refuses a union over capacity and preserves baseline after storage and network failures', async () => {
    const local = Array.from({ length: I.LIMIT }, (_,i) => entry(i+1));
    const h = harness({ local, remote: local }); await setup(h);
    h.remote = I.serializeBackup([...local, entry(1501)].slice(1));
    await h.store.mutate({ kind: 'remove', cid: 2 }); await h.store.mutate({ kind: 'add', entry: entry(1502) });
    const response = fieldsOf(await h.engine.action({ action: 'sync' }));
    // Both sides removed a different old ID: independent removals also converge.
    assert.equal(response.ok, true);
    assert.equal(required(response.list).entries.length, I.LIMIT);
    h.remote = I.serializeBackup([...required(response.list).entries.filter(e => e.cid !== 3), entry(1503)]);
    await h.store.mutate({ kind: 'remove', cid: 3 }); await h.store.mutate({ kind: 'add', entry: entry(1504) });
    const blocked = fieldsOf(await h.engine.action({ action: 'sync' })); assert.equal(blocked.ok, false); assert.match(required(blocked.error?.message), /1,500/);
    const base = storedState(h).base; h.failGet = true;
    assert.equal((await h.engine.action({ action: 'sync' })).ok, false); assert.deepEqual(storedState(h).base, base);
});

test('a fresh device does not transfer ignored climbers until explicitly enabled', async () => {
    const h = harness({ syncEnabled: null, remote: [entry(2)] });
    assert.equal(fieldsOf(await h.engine.status()).state?.enabled, false);
    await h.engine.start(); await h.engine.connectionChanged();
    assert.equal(h.reads, 0); assert.equal(h.writes, 0);
    await h.engine.action({ action: 'enable' });
    assert.equal(fieldsOf(await h.engine.status()).state?.enabled, true);
});
