// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeClimberMembership } from '../../src/favorites/climber-membership.js';

const fixture = () => {
    const reads = [], listeners = new Set(), states = [];
    const api = { storage: { local: { get: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
    const observer = observeClimberMembership(api, state => states.push(state));
    return { reads, states, observer, listeners,
        change: () => listeners.forEach(fn => fn({ bpbIgnoredClimbers: {} }, 'local')) };
};
const ignored = cid => ({ bpbIgnoredClimbers: { schemaVersion: 1, revision: cid,
    entries: [{ cid, name: `Climber ${cid}`, addedAt: 1 }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('membership observer subscribes before reading and rejects superseded snapshots', async () => {
    const { reads, states, observer, change, listeners } = fixture();
    assert.equal(listeners.size, 1);
    change();
    reads[1].resolve(ignored(2)); await tick();
    reads[0].resolve(ignored(1)); await tick();
    assert.equal(states.length, 1);
    assert.deepEqual([...states[0].blockedIds], [2]);
    const refreshing = observer.refresh();
    observer.stop(); reads[2].resolve(ignored(3)); await refreshing;
    assert.equal(states.length, 1);
    assert.equal(listeners.size, 0);
});

test('membership failures preserve the last valid snapshot and recover coherently', async () => {
    const { reads, states, observer } = fixture();
    reads[0].resolve(ignored(1)); await tick();
    const failed = observer.refresh(); reads[1].reject(new Error('offline')); await failed;
    assert.match(states[1].error, /Couldn't load/);
    assert.deepEqual([...states[1].blockedIds], [1]);
    const malformed = observer.refresh();
    reads[2].resolve({ ...ignored(2), bpbFavoriteClimbers: { schemaVersion: 1, entries: [{ cid: 'invalid' }] } });
    await malformed;
    assert.match(states[2].error, /Couldn't load/);
    const recovered = observer.refresh();
    reads[3].resolve({ ...ignored(2), bpbIgnoredSyncState: { pending: {
        result: [{ cid: 3, name: 'Pending climber', addedAt: 1 }] } } });
    await recovered;
    assert.equal(states[3].error, '');
    assert.deepEqual([...states[3].blockedIds], [2, 3]);
    assert.deepEqual([...states[3].pendingIds], [3]);
    observer.stop();
});
