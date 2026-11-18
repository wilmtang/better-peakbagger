// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { garminImportsHarness, readyItem, waitingItem } from '../helpers/garmin-imports-harness.mts';

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

test('an item stranded by a repeated Dismiss and Undo is restored to the inbox', async () => {
    const h = await garminImportsHarness();
    try {
        // The old Undo deleted the receipt and left the item dismissed with no deadline.
        await h.store.mutate(state => {
            state.items['12'] = readyItem('12', { phase: 'dismissed', previousPhase: 'dismissed' });
            state.items['13'] = waitingItem('13', { phase: 'dismissed', undoUntil: Number.NaN });
        });
        const snapshot = await h.imports.snapshot() as unknown as Snapshot;
        assert.deepEqual(snapshot.items.map(item => item.id).sort(), ['12', '13']);
        const state = await h.store.read();
        assert.equal(state.items['12'].phase, 'ready', 'an analyzed item keeps its analysis');
        assert.equal(state.items['13'].phase, 'waiting');
        assert.equal(state.preparePending, true, 'a restored waiting item is prepared again');
    } finally { await h.store.close(); }
});

test('a dismissed item without a deadline but with its dismissal receipt is collected', async () => {
    const h = await garminImportsHarness();
    try {
        await h.store.mutate(state => {
            state.items['12'] = readyItem('12', { phase: 'dismissed' });
            state.receipts['12'] = { dismissed: true };
        });
        const snapshot = await h.imports.snapshot() as unknown as Snapshot;
        assert.equal(snapshot.pending, 0);
        assert.equal((await h.store.read()).items['12'], undefined);
        assert.equal((await h.store.read()).receipts['12']?.dismissed, true, 'its dismissal still blocks re-import');
    } finally { await h.store.close(); }
});

test('a check restores a stranded dismissed item', async () => {
    const h = await garminImportsHarness();
    try {
        await h.store.mutate(state => { state.items['12'] = readyItem('12', { phase: 'dismissed', undoUntil: Number.NaN }); });
        await h.imports.check(false, true);
        assert.equal((await h.store.read()).items['12'].phase, 'ready');
    } finally { await h.store.close(); }
});

type History = { history: { id: string; dismissed: boolean; undoAvailable: boolean }[] };

test('inbox history keeps the newest receipts whatever the Garmin ID magnitude', async () => {
    const h = await garminImportsHarness();
    try {
        await h.store.mutate(state => {
            // Older large-ID receipts, then a newer small-ID activity in the inbox.
            for (let i = 0; i < 205; i++) state.receipts[String(21_000_000_000 + i)] = { complete: true, at: h.now() - 1_000_000 + i };
            state.items['3900000000'] = readyItem('3900000000');
        });
        assert.equal((await h.send('GARMIN_DISMISS', '3900000000')).ok, true);
        const { history } = await h.imports.snapshot() as unknown as History;
        assert.equal(history.length, 200);
        const dismissed = history.find(receipt => receipt.id === '3900000000');
        assert.ok(dismissed, 'the newest dismissal is published even though its ID sorts first');
        assert.equal(dismissed.undoAvailable, true);
        assert.equal(history.some(receipt => receipt.id === '21000000000'), false, 'the oldest receipts are the ones left out');
    } finally { await h.store.close(); }
});

test('an undoable dismissal stays in history even when 200 newer receipts exist', async () => {
    const h = await garminImportsHarness();
    try {
        await h.store.mutate(state => { state.items['12'] = readyItem('12'); });
        assert.equal((await h.send('GARMIN_DISMISS', '12')).ok, true);
        await h.store.mutate(state => {
            for (let i = 0; i < 200; i++) state.receipts[String(21_000_000_000 + i)] = { complete: true, at: h.now() + 1 + i };
        });
        const { history } = await h.imports.snapshot() as unknown as History;
        assert.equal(history.find(receipt => receipt.id === '12')?.undoAvailable, true);
    } finally { await h.store.close(); }
});
