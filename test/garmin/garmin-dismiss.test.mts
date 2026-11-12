// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { garminImportsHarness, readyItem } from '../helpers/garmin-imports-harness.mts';

type Snapshot = { items: { id: string }[]; pending: number };

test('a second Dismiss leaves Undo able to restore the activity', async () => {
    const h = await garminImportsHarness();
    try {
        await h.store.mutate(state => { state.items['12'] = readyItem('12'); });
        assert.equal((await h.send('GARMIN_DISMISS', '12')).ok, true);
        assert.equal((await h.send('GARMIN_DISMISS', '12')).ok, true, 'a repeated Dismiss from another tab is harmless');
        assert.equal((await h.send('GARMIN_UNDO', '12')).ok, true);
        const state = await h.store.read();
        assert.equal(state.items['12'].phase, 'ready', 'Undo restores the phase from before the first Dismiss');
        assert.equal(state.receipts['12'], undefined);
        const snapshot = await h.imports.snapshot() as unknown as Snapshot;
        assert.deepEqual(snapshot.items.map(item => item.id), ['12']);
    } finally { await h.store.close(); }
});

test('an item stranded as dismissed without an Undo deadline is collected', async () => {
    const h = await garminImportsHarness();
    try {
        await h.store.mutate(state => {
            state.items['12'] = readyItem('12', { phase: 'dismissed' });
            state.receipts['12'] = { dismissed: true };
        });
        const snapshot = await h.imports.snapshot() as unknown as Snapshot;
        assert.equal(snapshot.pending, 0);
        assert.equal((await h.store.read()).items['12'], undefined, 'the stranded item no longer occupies the inbox');
        assert.equal((await h.store.read()).receipts['12']?.dismissed, true, 'its dismissal still blocks re-import');
    } finally { await h.store.close(); }
});

test('a check collects a stranded dismissed item', async () => {
    const h = await garminImportsHarness();
    try {
        await h.store.mutate(state => { state.items['12'] = readyItem('12', { phase: 'dismissed', undoUntil: Number.NaN }); });
        await h.imports.check(false, true);
        assert.equal((await h.store.read()).items['12'], undefined);
    } finally { await h.store.close(); }
});
