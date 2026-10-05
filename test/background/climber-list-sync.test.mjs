// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../src/favorites/ignored-climbers.js';
import { harness, entry } from '../helpers/ignored-sync-harness.mjs';

test('fresh connected sync defaults on and initializes by preserving both lists', async () => {
    for (const remote of [null, [], [entry(2)]]) {
        const h = harness({ remote, syncEnabled: null });
        assert.equal((await h.engine.status()).state.enabled, true);
        const result = await h.engine.start();
        assert.equal(result.ok, true);
        assert.equal(result.state.phase, 'synced');
        assert.deepEqual(new Set(result.list.entries.map(e => e.cid)), new Set([1, ...(remote || []).map(e => e.cid)]));
        assert.deepEqual(I.parseBackup(h.remote), result.list.entries);
    }
});
test('fresh sync requires a connected repository and preserves explicit opt-outs across connection changes', async () => {
    const { createClimberListSync } = await import('../../src/background/climber-list-sync.js');
    const fresh = harness({ syncEnabled: null });
    const offline = createClimberListSync({ ...fresh.engineOptions, getAccess: async () => ({ error: { code: 'not-connected' } }) });
    assert.equal((await offline.start()).skipped, true);
    assert.equal(fresh.reads, 0); assert.equal(fresh.writes, 0);
    const disabled = harness();
    await disabled.engine.connectionChanged();
    assert.equal((await disabled.engine.status()).state.enabled, false);
    assert.equal(disabled.reads, 0); assert.equal(disabled.writes, 0);
});
test('fresh metadata conflicts keep sync enabled and pause without writing or replacing either list', async () => {
    const h = harness({ remote: [entry(1, 'Other name')], syncEnabled: null });
    const result = await h.engine.start();
    assert.equal(result.preview.conflicts.length, 1);
    assert.equal((await h.engine.status()).state.enabled, true);
    assert.equal(h.writes, 0);
    assert.deepEqual((await h.store.read()).entries, [entry(1)]);
    await h.engine.action({ action: 'check' });
    assert.equal(h.reads, 1, 'a pending review must not repeat the setup');
});
test('turning sync on persists immediately and new connections retain the preference', async () => {
    const h = harness({ remote: [entry(2)] });
    const result = await h.engine.action({ action: 'enable' });
    assert.equal(result.state.enabled, true);
    assert.equal(h.reads, 0); assert.equal(h.writes, 0);
    await h.engine.connectionChanged();
    assert.equal((await h.engine.status()).state.enabled, true);
    assert.deepEqual(new Set((await h.store.read()).entries.map(e => e.cid)), new Set([1,2]));
    await h.engine.action({ action: 'disable' });
    await h.engine.connectionChanged();
    assert.equal((await h.engine.status()).state.enabled, false);
});
test('disabling during first automatic setup prevents an upload and retains the opt-out', async () => {
    const h = harness({ syncEnabled: null });
    h.readHook = () => h.engine.action({ action: 'disable' });
    assert.equal((await h.engine.start()).ok, false);
    assert.equal(h.writes, 0);
    assert.equal((await h.engine.status()).state.enabled, false);
});
test('disabling between automatic setup and confirmation cannot re-enable sync', async () => {
    const h = harness({ syncEnabled: null });
    const save = h.storage.set;
    let disabled;
    h.storage.set = async patch => {
        await save(patch);
        if (patch[I.SYNC_KEY]?.review?.kind === 'setup' && !disabled) disabled = h.engine.action({ action: 'disable' });
    };
    assert.equal((await h.engine.start()).ok, false);
    await disabled;
    assert.equal(h.writes, 0);
    assert.equal((await h.engine.status()).state.enabled, false);
});

test('new-file backup is explicit and allowlisted; existing remote needs a reviewed replacement', async () => {
    const h = harness(); assert.equal((await h.engine.action({ action: 'backup' })).ok, true);
    assert.deepEqual(I.parseBackup(h.remote), [entry(1)]);
    assert.equal(h.values[I.SYNC_KEY].enabled, false);
    h.remote = I.serializeBackup([entry(2)]);
    const response = await h.engine.action({ action: 'backup' });
    assert.equal(response.needsReview, true); assert.equal(h.writes, 1);
    assert.deepEqual(response.preview.impacts.device.remote, { added: 1, removed: 1 });
    assert.equal((await h.confirm(response.preview, 'device')).ok, true);
});
test('missing and malformed backup are never empty restores, but an explicit empty file can clear with guarded Undo', async () => {
    const h = harness(); assert.equal((await h.engine.action({ action: 'restore' })).error.code, 'missing');
    h.remote = '{"entries":[]}'; assert.equal((await h.engine.action({ action: 'restore' })).error.code, 'invalid');
    h.remote = I.serializeBackup([]);
    const preview = (await h.engine.action({ action: 'restore' })).preview;
    const restored = await h.confirm(preview, 'github'); assert.deepEqual(restored.list.entries, []);
    await h.store.mutate({ kind: 'add', entry: entry(3) });
    const undo = await h.store.mutate({ kind: 'replace', ...restored.undo });
    assert.equal(undo.error.code, 'stale'); assert.deepEqual((await h.store.read()).entries, [entry(3)]);
});
test('storage failure cannot create an empty upload', async () => {
    const h = harness(); h.failGet = true;
    assert.equal((await h.engine.action({ action: 'backup' })).ok, false);
    assert.equal(h.writes, 0); assert.equal(h.reads, 0);
});
test('a changed local revision or remote snapshot invalidates review', async () => {
    for (const side of ['local', 'remote']) {
        const h = harness({ remote: [entry(2)] });
        const preview = (await h.engine.action({ action: 'backup' })).preview;
        if (side === 'local') await h.store.mutate({ kind: 'add', entry: entry(3) }); else h.remote = I.serializeBackup([entry(4)]);
        const response = await h.confirm(preview, 'device'); assert.equal(response.error.code, 'stale'); assert.equal(h.writes, 0);
    }
});
test('the file is reread on a ref retry and cannot overwrite new remote membership', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = (await h.engine.action({ action: 'backup' })).preview;
    h.retryHook = () => { h.remote = I.serializeBackup([entry(4)]); };
    assert.equal((await h.confirm(preview, 'device')).error.code, 'stale'); assert.equal(h.writes, 0);
    assert.deepEqual(I.parseBackup(h.remote), [entry(4)]);
});
test('an auth epoch change cancels a reviewed write', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = (await h.engine.action({ action: 'backup' })).preview;
    h.epoch++; assert.equal((await h.confirm(preview, 'device')).error.code, 'superseded'); assert.equal(h.writes, 0);
});
test('changes made during upload survive reconciliation and a failed reconciliation retains its journal', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = (await h.engine.action({ action: 'backup' })).preview;
    h.commitHook = async () => { await h.store.mutate({ kind: 'remove', cid: 1 }); await h.store.mutate({ kind: 'add', entry: entry(3) }); };
    const response = await h.confirm(preview, 'merge'); assert.equal(response.ok, true);
    assert.deepEqual(new Set(response.list.entries.map(e => e.cid)), new Set([2,3]));
    assert.deepEqual(new Set(I.parseBackup(h.remote).map(e => e.cid)), new Set([1,2]));
    const broken = harness(); broken.failReconcile = true;
    assert.equal((await broken.engine.action({ action: 'backup' })).ok, false);
    assert.ok(broken.values[I.SYNC_KEY].pending); assert.deepEqual(I.parseBackup(broken.remote), [entry(1)]);
});

const setup = async h => {
    const response = await h.engine.action({ action: 'setup' });
    assert.equal(response.ok, true);
    const confirmed = await h.confirm(response.preview); assert.equal(confirmed.ok, true); return confirmed;
};
test('sync setup is device-local, reviewed, and preserves both lists by default', async () => {
    const h = harness({ remote: [entry(2)] });
    assert.equal((await h.engine.start()).skipped, true); assert.equal(h.reads, 0);
    const response = await h.engine.action({ action: 'setup' });
    assert.deepEqual((await h.store.read()).entries, [entry(1)]); assert.equal(h.values[I.SYNC_KEY].enabled, false);
    const confirmed = await h.confirm(response.preview);
    assert.equal(confirmed.state.enabled, true); assert.equal(confirmed.state.phase, 'synced');
    assert.deepEqual(new Set(confirmed.list.entries.map(e => e.cid)), new Set([1,2]));
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
    assert.deepEqual(new Set(I.parseBackup(remote).map(e => e.cid)), new Set([3,4]));
});
test('delete versus metadata change pauses before writes; scoped choices propagate the chosen removal', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'remove', cid: 1 }); h.remote = I.serializeBackup([entry(1, 'Changed on GitHub')]);
    const writes = h.writes, response = await h.engine.action({ action: 'sync' });
    assert.equal(response.ok, false); assert.equal(response.preview.kind, 'conflict'); assert.equal(h.writes, writes);
    assert.deepEqual((await h.store.read()).entries, []);
    assert.equal(response.preview.conflicts[0].device, null);
    const confirmed = await h.confirm(response.preview, 'merge', { 1: 'device' });
    assert.equal(confirmed.ok, true); assert.deepEqual(I.parseBackup(h.remote), []);
});
test('sync ref retries rerun the merge with fresh remote and local snapshots', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'add', entry: entry(2) });
    h.retryHook = async () => { h.remote = I.serializeBackup([entry(1),entry(3)]); await h.store.mutate({ kind: 'add', entry: entry(4) }); };
    const response = await h.engine.action({ action: 'sync' }); assert.equal(response.ok, true);
    assert.deepEqual(new Set(I.parseBackup(h.remote).map(e => e.cid)), new Set([1,2,3,4]));
});
test('local edits after commit stay pending, and edits before ref advancement abort the stale proposal', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    h.remote = I.serializeBackup([entry(1),entry(2)]);
    h.commitHook = async () => { await h.store.mutate({ kind: 'add', entry: entry(3) }); };
    const response = await h.engine.action({ action: 'sync' });
    assert.equal(response.state.phase, 'pending'); assert.deepEqual(new Set(response.list.entries.map(e => e.cid)), new Set([1,2,3]));
    assert.deepEqual(I.parseBackup(h.remote), [entry(1),entry(2)]);
    h.commitHook = null; h.beforeRefHook = async () => { await h.store.mutate({ kind: 'remove', cid: 1 }); };
    const aborted = await h.engine.action({ action: 'sync' }); assert.equal(aborted.error.code, 'stale');
    assert.deepEqual(I.parseBackup(h.remote), [entry(1),entry(2)]); assert.ok(h.values[I.SYNC_KEY].pending);
});
test('worker restart confirms an accepted setup and rebases later local edits', async () => {
    const h = harness({ remote: [entry(2)] }); const preview = (await h.engine.action({ action: 'setup' })).preview;
    h.commitHook = async () => { await h.store.mutate({ kind: 'add', entry: entry(3) }); h.failReconcile = true; };
    assert.equal((await h.confirm(preview)).ok, false); assert.ok(h.values[I.SYNC_KEY].pending);
    h.failReconcile = false; h.commitHook = null;
    const { createClimberListSync } = await import('../../src/background/climber-list-sync.js');
    const resumed = createClimberListSync(h.engineOptions);
    const recovered = await resumed.start(); assert.equal(recovered.ok, true); assert.equal(recovered.result.recovered, true);
    assert.deepEqual(new Set(recovered.list.entries.map(e => e.cid)), new Set([1,2,3]));
    assert.equal(recovered.state.enabled, true); assert.equal(recovered.state.phase, 'pending'); assert.equal(recovered.state.pending, null);
});
test('uncertain recovery and a missing confirmed file require review without recreating or replacing local data', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'add', entry: entry(3) }); h.failReconcile = true;
    assert.equal((await h.engine.action({ action: 'sync' })).ok, false); h.failReconcile = false;
    h.remote = I.serializeBackup([entry(1),entry(3),entry(4)]);
    const writes = h.writes; const response = await h.engine.action({ action: 'sync' });
    assert.equal(response.preview.kind, 'recovery'); assert.equal(h.writes, writes); assert.deepEqual((await h.store.read()).entries, [entry(3),entry(1)]);
    assert.equal((await h.confirm(response.preview)).ok, true);
    h.remote = null;
    const missing = await h.engine.action({ action: 'sync' }); assert.equal(missing.preview.remote, null); assert.equal(h.remote, null);
});
test('disabling during an accepted upload leaves local edits and the uncertainty journal, with no startup network', async () => {
    const h = harness({ remote: [entry(1)] }); await setup(h);
    await h.store.mutate({ kind: 'add', entry: entry(3) });
    h.commitHook = () => h.engine.action({ action: 'disable' });
    const response = await h.engine.action({ action: 'sync' }); assert.equal(response.ok, false);
    assert.equal(h.values[I.SYNC_KEY].enabled, false); assert.ok(h.values[I.SYNC_KEY].pending);
    assert.deepEqual((await h.store.read()).entries, [entry(3),entry(1)]);
    const reads = h.reads; assert.equal((await h.engine.start()).skipped, true); assert.equal(h.reads, reads);
});
test('alarms trail local edits, check on startup and manager opening, and duplicate sync triggers coalesce', async () => {
    const h = harness({ remote: [entry(1)] }); let time = 1000000;
    const scheduled = new Map();
    const { createClimberListSync, IGNORED_SYNC_ALARM, IGNORED_CHANGE_ALARM } = await import('../../src/background/climber-list-sync.js');
    h.engine = createClimberListSync({ ...h.engineOptions, now: () => time,
        alarms: { create: (name, options) => scheduled.set(name, options), clear: name => scheduled.delete(name) } });
    await setup(h); assert.equal(scheduled.get(IGNORED_SYNC_ALARM).periodInMinutes, 15);
    await h.store.mutate({ kind: 'add', entry: entry(2) }); await h.engine.localChanged(); await h.engine.localChanged();
    assert.equal(scheduled.get(IGNORED_CHANGE_ALARM).delayInMinutes, 0.5);
    assert.equal(h.values[I.SYNC_KEY].phase, 'pending');
    const checked = await h.engine.action({ action: 'check' }); assert.equal(checked.skipped, true);
    time += 61000;
    let release; const gate = new Promise(resolve => { release = resolve; }); h.commitHook = () => gate;
    const one = h.engine.action({ action: 'sync' }), two = h.engine.action({ action: 'sync' }); assert.equal(one, two);
    release(); await one; h.commitHook = null;
    assert.equal((await h.engine.start()).ok, true);
    await h.engine.action({ action: 'disable' }); assert.equal(scheduled.size, 0);
});
test('sync refuses a union over capacity and preserves baseline after storage and network failures', async () => {
    const local = Array.from({ length: I.LIMIT }, (_,i) => entry(i+1));
    const h = harness({ local, remote: local }); await setup(h);
    h.remote = I.serializeBackup([...local, entry(1501)].slice(1));
    await h.store.mutate({ kind: 'remove', cid: 2 }); await h.store.mutate({ kind: 'add', entry: entry(1502) });
    const response = await h.engine.action({ action: 'sync' });
    // Both sides removed a different old ID: independent removals also converge.
    assert.equal(response.ok, true);
    assert.equal(response.list.entries.length, I.LIMIT);
    h.remote = I.serializeBackup([...response.list.entries.filter(e => e.cid !== 3), entry(1503)]);
    await h.store.mutate({ kind: 'remove', cid: 3 }); await h.store.mutate({ kind: 'add', entry: entry(1504) });
    const blocked = await h.engine.action({ action: 'sync' }); assert.equal(blocked.ok, false); assert.match(blocked.error.message, /1,500/);
    const base = h.values[I.SYNC_KEY].base; h.failGet = true;
    assert.equal((await h.engine.action({ action: 'sync' })).ok, false); assert.deepEqual(h.values[I.SYNC_KEY].base, base);
});
