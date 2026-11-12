// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Toolbar Garmin captures write an import-history receipt so the inbox never
// re-imports an activity already saved. An unsaved capture must not lock the
// activity out of being captured again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { garminImportsHarness } from '../helpers/garmin-imports-harness.mts';

type Imports = Awaited<ReturnType<typeof garminImportsHarness>>['imports'] & {
    captureBlocked(activityId: string, currentJobId?: string): Promise<boolean>;
};
const job = (id: string, extra: Record<string, unknown> = {}) => ({ id, activityId: '777', cid: '456', selectedIds: [7, 8], ...extra });

for (const inbox of [true, false]) {
    test(`an unsaved toolbar capture can be captured again (inbox ${inbox ? 'on' : 'off'})`, async () => {
        const h = await garminImportsHarness();
        h.prefs.enableGarminInbox = inbox;
        const imports = h.imports as Imports;
        try {
            await imports.reserveCapture(job('first-job'));
            // The first job was cleared, expired or rolled back: no current job remains.
            assert.equal(await imports.captureBlocked('777'), false, 'a receipt with no saved peak does not block');
            await imports.reserveCapture(job('second-job'));
            assert.equal((await h.store.read()).receipts['777'].jobId, 'second-job', 'the new capture takes over the receipt');
            await imports.captureSaved(job('second-job'), '7', '9001');
            assert.deepEqual((await h.store.read()).receipts['777'].peaks, { 7: '9001' });
        } finally { await h.store.close(); }
    });
}

test('a save from a surviving draft of the earlier capture is still recorded', async () => {
    const h = await garminImportsHarness();
    const imports = h.imports as Imports;
    try {
        await imports.reserveCapture(job('first-job'));
        await imports.reserveCapture(job('second-job'));
        await imports.captureSaved(job('first-job'), '8', '9002');
        const receipt = (await h.store.read()).receipts['777'];
        assert.deepEqual(receipt.peaks, { 8: '9002' }, 'the inbox must not later import an activity that was saved');
        assert.equal(await imports.captureBlocked('777'), true, 'a saved peak keeps the duplicate protection while the inbox is on');
    } finally { await h.store.close(); }
});

test('the inbox keeps refusing a saved or inbox-owned activity, but not while it is off', async () => {
    const h = await garminImportsHarness();
    const imports = h.imports as Imports;
    try {
        await imports.reserveCapture(job('first-job'));
        await imports.captureSaved(job('first-job'), '7', '9001');
        assert.equal(await imports.captureBlocked('777'), true);
        assert.equal(await imports.captureBlocked('777', 'first-job'), false, 'the receipt\'s own job may continue');
        await assert.rejects(imports.reserveCapture(job('second-job')), (error: { code?: string }) => error.code === 'duplicate');
        await h.store.mutate(state => { state.items['888'] = { id: '888', phase: 'ready', saved: [], summary: {} }; });
        assert.equal(await imports.captureBlocked('888'), true, 'an activity waiting in the inbox is reviewed there');
        h.prefs.enableGarminInbox = false;
        assert.equal(await imports.captureBlocked('777'), false, 'with the inbox off, import history is not consulted');
        assert.equal(await imports.captureBlocked('888'), false);
        await imports.reserveCapture(job('second-job'));
        await imports.captureSaved(job('second-job'), '8', '9002');
        assert.deepEqual((await h.store.read()).receipts['777'].peaks, { 7: '9001', 8: '9002' }, 'saves from both captures are kept');
    } finally { await h.store.close(); }
});
