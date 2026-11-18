// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { garminImportsHarness, readyItem, waitingItem } from '../helpers/garmin-imports-harness.mts';

test('a full inbox stops preparing the same activity until an item is removed', async () => {
    const h = await garminImportsHarness();
    try {
        // One stored item large enough that adding any prepared route crosses the
        // 20 MiB inbox limit, and one activity waiting for preparation.
        await h.store.mutate(state => {
            state.items['900'] = readyItem('900', { padding: 'x'.repeat(20 * 1024 * 1024) });
            state.items['12'] = waitingItem('12');
            state.preparePending = true;
            state.lastCheck = h.now();
        });
        await h.imports.check(false, true);
        assert.equal(h.counts.downloads, 1, 'the first pass tries the waiting activity once');
        const full = await h.store.read();
        assert.equal(full.error?.code, 'capacity');
        assert.equal(full.items['12'].phase, 'waiting');
        assert.equal(full.preparePending, false, 'a full inbox must not leave preparation pending');
        for (let period = 0; period < 4; period++) {
            h.advance(60_000);
            await h.imports.check(false, true);
        }
        assert.equal(h.counts.downloads, 1, 'later alarm periods must not re-download the same activity');
        assert.equal(h.counts.preparations, 1, 'later alarm periods must not repeat Peakbagger lookups');
        assert.equal(h.alarms.size, 0, 'no continuation alarm while the inbox is full');
        await h.imports.check();
        assert.equal(h.counts.downloads, 1, 'a manual check lists Garmin but does not retry while storage is full');
        assert.equal((await h.store.read()).error?.storage, true);

        assert.equal((await h.send('GARMIN_DONE', '900')).ok, true);
        const relieved = await h.store.read();
        assert.equal(relieved.error, null);
        assert.equal(relieved.preparePending, true, 'removing an item resumes the waiting activity');
        assert.equal(h.alarms.size, 1, 'resumption is scheduled, not left for the next periodic check');
        await h.imports.check(false, true);
        assert.equal(h.counts.downloads, 2);
        assert.equal((await h.store.read()).items['12'].phase, 'ready');
    } finally { await h.store.close(); }
});
