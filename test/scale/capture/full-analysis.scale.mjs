// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production-scale CPU coverage stays outside npm test. This exercises the
// accepted 20,000-point route and 5,000-peak response together, including the
// exact synchronous/cooperative equivalence and the event-loop yield contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { captureCore as Core } from '../../../src/capture/capture-core.js';
import { captureResourceLimits as Limits } from '../../../src/capture/capture-resource-limits.js';

const START_TIME = Date.UTC(2026, 6, 1, 14);
const route = Array.from({ length: Limits.MAX_GPX_TRACK_POINTS }, (_, index) => ({
    lat: 40 + Math.sin(index / 7) * 0.0001,
    lon: -105.3 + index * 0.6 / (Limits.MAX_GPX_TRACK_POINTS - 1),
    ele: 2_000 + Math.sin(index / 13) * 80,
    time: START_TIME + index * 1_000,
}));
const peaks = Array.from({ length: Limits.MAX_PEAKBAGGER_PEAKS }, (_, index) => ({
    id: index + 1,
    name: `Scale Peak ${index + 1}`,
    location: 'Scale Range',
    lat: index < 64 ? 40 : 40.01,
    lon: -105.3 + index * 0.6 / (Limits.MAX_PEAKBAGGER_PEAKS - 1),
    elevationM: 2_000,
    prominenceFt: 100,
}));

const cooperativeScheduler = () => {
    let sliceStartedAt = performance.now();
    let yields = 0;
    const checkpoint = async () => {
        const current = performance.now();
        if (current - sliceStartedAt < 8) return;
        await new Promise(resolve => setTimeout(resolve, 0));
        sliceStartedAt = performance.now();
        yields++;
    };
    return { checkpoint, result: () => ({ yields }) };
};

test('production-scale full analysis remains exact, bounded, and cooperative', async () => {
    // Reference work is deliberately outside the scheduling measurement: the
    // shipped worker uses only the cooperative path.
    const referenceMatches = Core.detectPeaks([route], peaks, 0.95);
    const referenceReduced = Core.reduceTrack([route], referenceMatches, Core.MAX_UPLOAD_POINTS);
    const scheduler = cooperativeScheduler();
    const startedAt = performance.now();
    const cooperativeMatches = await Core.detectPeaksAsync([route], peaks, 0.95, {
        checkpoint: scheduler.checkpoint,
    });
    assert.deepEqual(cooperativeMatches, referenceMatches);
    assert.equal(cooperativeMatches.length, 64);

    const cooperativeReduced = await Core.reduceTrackAsync(
        [route],
        cooperativeMatches,
        Core.MAX_UPLOAD_POINTS,
        { checkpoint: scheduler.checkpoint },
    );
    assert.deepEqual(cooperativeReduced, referenceReduced);
    assert.equal(cooperativeReduced.retainedPointCount, Core.MAX_UPLOAD_POINTS);

    const draftFields = [];
    for (const match of cooperativeMatches.slice(0, 8)) {
        draftFields.push(Core.calculateDraftFields([route], match, { utcOffsetMinutes: -420 }));
        await scheduler.checkpoint();
    }
    assert.equal(draftFields.length, 8);
    assert.ok(draftFields.every(fields => Number.isFinite(fields.upDistanceM)));

    const elapsedMs = performance.now() - startedAt;
    const scheduling = scheduler.result();
    assert.ok(elapsedMs < 15_000, `full analysis took ${elapsedMs.toFixed(1)} ms`);
    assert.ok(scheduling.yields > 10, 'production analysis must yield repeatedly');
});

test('cooperative detection and reduction propagate cancellation at internal checkpoints', async t => {
    for (const stopAt of [1, 50, 500]) {
        await t.test(`detection checkpoint ${stopAt}`, async () => {
            let checkpoints = 0;
            await assert.rejects(
                Core.detectPeaksAsync([route], peaks, 0.95, {
                    checkpoint: async () => {
                        if (++checkpoints === stopAt) throw new Error('scale cancellation');
                    },
                }),
                /scale cancellation/,
            );
        });
    }

    const matches = Core.detectPeaks([route], peaks, 0.95);
    for (const stopAt of [1, 50, 500]) {
        await t.test(`reduction checkpoint ${stopAt}`, async () => {
            let checkpoints = 0;
            await assert.rejects(
                Core.reduceTrackAsync([route], matches, Core.MAX_UPLOAD_POINTS, {
                    checkpoint: async () => {
                        if (++checkpoints === stopAt) throw new Error('scale cancellation');
                    },
                }),
                /scale cancellation/,
            );
        });
    }
});
