// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../src/favorites/ignored-climbers.js';
import { harness, entry } from '../helpers/ignored-sync-harness.mjs';
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
