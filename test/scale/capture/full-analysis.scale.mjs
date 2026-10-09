// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production-scale CPU coverage stays outside npm test. This exercises the
// accepted 100,000-point route and 5,000-peak response together, including the
// summit identities, protected anchors, point budgets, and event-loop yielding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { captureCore as Core } from '../../../src/capture/capture-core.js';
import { captureResourceLimits as Limits } from '../../../src/capture/capture-resource-limits.js';
import { CAPTURE_CPU_SAMPLE_COUNT, evaluateCaptureCpuSamples } from '../../helpers/capture-scale-policy.mjs';

const START_TIME = Date.UTC(2026, 6, 1, 14);
const route = Array.from({ length: Limits.MAX_GPX_TRACK_POINTS }, (_, index) => {
    const fraction = index / (Limits.MAX_GPX_TRACK_POINTS - 1);
    // Increase recording density without changing the original route's
    // geometry or elevation oscillations and its reduction-error expectation.
    const originalIndex = fraction * 19_999;
    return {
        lat: 40 + Math.sin(originalIndex / 7) * 0.0001,
        lon: -105.3 + fraction * 0.6,
        ele: 2_000 + Math.sin(originalIndex / 13) * 80,
        time: START_TIME + index * 1_000,
    };
});
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

test('production-scale full analysis remains exact, bounded, and cooperative', { timeout: 120_000 }, async t => {
    const samples = [];
    for (let sample = 1; sample <= CAPTURE_CPU_SAMPLE_COUNT; sample++) {
        const scheduler = cooperativeScheduler();
        const startedAt = performance.now();
        const phaseCpu = [];
        const measure = async operation => {
            const startedCpu = process.cpuUsage();
            const result = await operation();
            const cpu = process.cpuUsage(startedCpu);
            phaseCpu.push((cpu.user + cpu.system) / 1_000);
            return result;
        };
        const cooperativeMatches = await measure(() => Core.detectPeaksAsync([route], peaks, 0.95, {
            checkpoint: scheduler.checkpoint,
        }));
        assert.deepEqual(cooperativeMatches.map(match => match.id).sort((a, b) => a - b),
            Array.from({ length: 64 }, (_, index) => index + 1));
        assert.equal(cooperativeMatches.length, 64);

        const cooperativeReduced = await measure(() => Core.reduceTrackAsync(
            [route],
            cooperativeMatches,
            Core.MAX_UPLOAD_POINTS,
            { checkpoint: scheduler.checkpoint },
        ));
        const retained = new Set(cooperativeReduced.segments[0]);
        assert.ok([...retained].every(point => route.includes(point)));
        assert.ok(retained.has(route[0]) && retained.has(route.at(-1)));
        for (const { encounter } of cooperativeMatches) {
            assert.ok(retained.has(route[encounter.edgeIndex]) && retained.has(route[encounter.edgeIndex + 1]));
        }
        assert.ok(Number.isFinite(cooperativeReduced.maxDeviationM) && cooperativeReduced.maxDeviationM < 2);
        assert.equal(cooperativeReduced.retainedPointCount, Core.MAX_UPLOAD_POINTS);

        const draftFields = [];
        await measure(async () => {
            for (const match of cooperativeMatches.slice(0, 8)) {
                draftFields.push(Core.calculateDraftFields([route], match, { utcOffsetMinutes: -420 }));
                await scheduler.checkpoint();
            }
        });
        assert.equal(draftFields.length, 8);
        assert.ok(draftFields.every(fields => Number.isFinite(fields.upDistanceM)));

        const elapsedMs = performance.now() - startedAt;
        const cpuMs = phaseCpu.reduce((sum, value) => sum + value, 0);
        samples.push(cpuMs);
        const scheduling = scheduler.result();
        t.diagnostic(`full analysis sample ${sample}: ${cpuMs.toFixed(1)} ms CPU, ${elapsedMs.toFixed(1)} ms wall, ${scheduling.yields} yields; phase CPU ${phaseCpu.map(value => value.toFixed(1)).join('/')}`);
        assert.ok(scheduling.yields > 10, 'production analysis must yield repeatedly');
    }
    const summary = evaluateCaptureCpuSamples(samples);
    t.diagnostic(`full analysis CPU median ${summary.median.toFixed(1)} ms, range ${summary.minimum.toFixed(1)}–${summary.maximum.toFixed(1)} ms; all ${samples.length} samples retained`);
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

    const matches = await Core.detectPeaksAsync([route], peaks, 0.95);
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
