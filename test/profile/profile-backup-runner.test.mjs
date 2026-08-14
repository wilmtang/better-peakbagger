// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { profileBackupCore as Core } from '../../src/profile/profile-backup-core.js';

const editFixture = await readFile(new URL('../fixtures/pages/climber-ascentedit.html', import.meta.url), 'utf8');
const items = [1, 2, 3].map(aid => ({
    aid,
    peakName: `Peak ${aid}`,
    ascentUrl: `https://peakbagger.com/climber/Ascent.aspx?aid=${aid}`,
    editUrl: `https://peakbagger.com/climber/AscentEdit.aspx?aid=${aid}`,
}));
const ok = { kind: 'ok', data: { snapshot: true } };

test('response classifier distinguishes edit data, challenge, transient, and wrong content', () => {
    assert.equal(Core.classifyResponse(200, {}, editFixture), 'ok');
    assert.equal(Core.classifyResponse(200, {}, '<html><form id="login">Sign in</form></html>'), 'wrong-content');
    assert.equal(Core.classifyResponse(403, { 'cf-mitigated': 'challenge' }, '<html/>'), 'challenged');
    assert.equal(Core.classifyResponse(403, {}, '<title>Just a moment...</title>'), 'challenged');
    assert.equal(Core.classifyResponse(500, {}, ''), 'transient');
    assert.equal(Core.classifyResponse(200, {}, '<?xml version="1.0"?><gpx/>', { kind: 'gpx' }), 'ok');
    assert.equal(Core.classifyResponse(200, {}, '<html>not a track</html>', { kind: 'gpx' }), 'wrong-content');
});

test('a challenge stops the queue and resume re-probes the same item before continuing', async () => {
    const calls = [];
    let challenged = false;
    const runner = Core.createRunner({
        ascents: items,
        paceMs: 0,
        sleep: async () => {},
        loadItem: async (item, { probe, probeUrl }) => {
            calls.push({ aid: item.aid, probe, probeUrl });
            if (item.aid === 2 && !challenged) { challenged = true; return { kind: 'challenged', url: item.editUrl }; }
            return ok;
        },
        pushBatch: async () => ({ ok: true }),
    });

    const paused = await runner.run();
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'challenge');
    assert.deepEqual(calls.map(call => call.aid), [1, 2]);
    assert.ok(!calls.some(call => call.aid === 3), 'the queue must stop at the challenged ascent');

    const finished = await runner.resume();
    assert.equal(finished.status, 'complete');
    assert.deepEqual(calls, [
        { aid: 1, probe: false, probeUrl: null },
        { aid: 2, probe: false, probeUrl: null },
        { aid: 2, probe: true, probeUrl: items[1].editUrl },
        { aid: 3, probe: false, probeUrl: null },
    ]);
});

test('transient errors use the injected backoff schedule and fail only after two retries', async () => {
    const delays = [];
    let attempts = 0;
    const runner = Core.createRunner({
        ascents: [items[0]],
        sleep: async ms => delays.push(ms),
        loadItem: async () => { attempts += 1; return { kind: 'transient', reason: 'offline' }; },
        pushBatch: async () => ({ ok: true }),
    });
    const result = await runner.run();
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [4000, 15000]);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.failures.map(failure => [failure.aid, failure.kind]), [[1, 'transient']]);
});

test('pause interrupts a retry backoff and publishes the request before settling', async () => {
    let startedWait;
    const waiting = new Promise(resolve => { startedWait = resolve; });
    let waitAborted = false;
    let attempts = 0;
    const runner = Core.createRunner({
        ascents: [items[0]],
        loadItem: async () => {
            attempts += 1;
            return { kind: 'transient', reason: 'offline' };
        },
        sleep: (_ms, { signal }) => new Promise(resolve => {
            startedWait();
            signal.addEventListener('abort', () => {
                waitAborted = true;
                resolve();
            }, { once: true });
        }),
        pushBatch: async () => ({ ok: true }),
    });

    const running = runner.run();
    await waiting;
    runner.pause();
    assert.equal(runner.state.status, 'pause-requested');
    runner.pause();
    assert.equal(runner.state.status, 'pause-requested', 'a repeated request is idempotent');
    const result = await running;
    assert.equal(waitAborted, true);
    assert.equal(attempts, 1);
    assert.equal(result.status, 'paused');
    assert.equal(result.pauseReason, 'user');
    assert.equal(result.notReached, 1);
});

test('consecutive exhausted transients pause before requesting the next ascent', async () => {
    const calls = [];
    const runner = Core.createRunner({
        ascents: items,
        retryDelays: [],
        paceMs: 0,
        sleep: async () => {},
        loadItem: async item => { calls.push(item.aid); return { kind: 'transient', reason: 'offline' }; },
        pushBatch: async () => ({ ok: true }),
    });
    const result = await runner.run();
    assert.equal(result.status, 'paused');
    assert.equal(result.pauseReason, 'transient');
    assert.deepEqual(calls, [1, 2]);
    assert.equal(result.notReached, 1);
});

test('wrong content fails one ascent, skips existing folders, and continues', async () => {
    const loaded = [];
    const pushed = [];
    const runner = Core.createRunner({
        ascents: items,
        existingFolders: ['2026-01-01-peak-a1'],
        paceMs: 0,
        sleep: async () => {},
        loadItem: async item => { loaded.push(item.aid); return item.aid === 2 ? { kind: 'wrong-content', reason: 'signed out' } : ok; },
        pushBatch: async batch => { pushed.push(...batch.map(entry => entry.item.aid)); return { ok: true }; },
    });
    const result = await runner.run();
    assert.equal(result.status, 'complete');
    assert.equal(result.skipped, 1);
    assert.equal(result.backedUp, 1);
    assert.deepEqual(result.failures.map(failure => failure.aid), [2]);
    assert.deepEqual(loaded, [2, 3]);
    assert.deepEqual(pushed, [3]);
});

test('a GitHub failure pauses on the current ascent and resume retries it', async () => {
    const loaded = [];
    const pushed = [];
    let rejected = false;
    const runner = Core.createRunner({
        ascents: items,
        paceMs: 0,
        sleep: async () => {},
        loadItem: async item => { loaded.push(item.aid); return ok; },
        pushBatch: async batch => {
            pushed.push(batch.map(entry => entry.item.aid));
            if (!rejected) {
                rejected = true;
                return { ok: false, error: { code: 'rate-limit', message: 'GitHub is temporarily rate-limiting requests.' } };
            }
            return { ok: true };
        },
    });

    const paused = await runner.run();
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'github');
    assert.equal(paused.completed, 0);
    assert.equal(paused.backedUp, 0);
    assert.equal(paused.failures.length, 0);
    assert.equal(paused.notReached, 3);
    assert.equal(paused.buffered, 3);
    assert.equal(paused.pauseBatchSize, 3);
    assert.deepEqual(paused.pauseError, {
        aid: 1,
        peakName: 'Peak 1',
        ascentUrl: items[0].ascentUrl,
        reason: 'GitHub is temporarily rate-limiting requests.',
        kind: 'github',
    });
    assert.deepEqual(loaded, [1, 2, 3]);
    assert.deepEqual(pushed, [[1, 2, 3]]);

    const finished = await runner.resume();
    assert.equal(finished.status, 'complete');
    assert.equal(finished.pauseError, null);
    assert.equal(finished.backedUp, 3);
    assert.equal(finished.buffered, 0);
    assert.deepEqual(loaded, [1, 2, 3], 'resume reuses the retained batch instead of refetching Peakbagger');
    assert.deepEqual(pushed, [[1, 2, 3], [1, 2, 3]]);
});

test('cancelling aborts an in-flight read and stops before the GitHub write boundary', async () => {
    let started;
    const readStarted = new Promise(resolve => { started = resolve; });
    let aborted = false;
    let pushed = false;
    const runner = Core.createRunner({
        ascents: [items[0]],
        loadItem: async (_item, { signal }) => new Promise(resolve => {
            started();
            signal.addEventListener('abort', () => {
                aborted = true;
                resolve({ kind: 'transient', reason: 'cancelled' });
            }, { once: true });
        }),
        pushBatch: async () => { pushed = true; return { ok: true }; },
    });
    const running = runner.run();
    await readStarted;
    runner.cancel();
    assert.equal(runner.state.status, 'cancel-requested');
    runner.cancel();
    const result = await running;
    assert.equal(aborted, true);
    assert.equal(result.status, 'cancelled');
    assert.equal(pushed, false);
    assert.equal(result.notReached, 1);
});

test('pause during a GitHub mutation waits for that batch, counts it, and starts no later work', async () => {
    let releaseBatch;
    let batchStarted;
    const started = new Promise(resolve => { batchStarted = resolve; });
    const pending = new Promise(resolve => { releaseBatch = resolve; });
    const loaded = [];
    const batches = [];
    const runner = Core.createRunner({
        ascents: items,
        batchItems: 1,
        bufferItems: 1,
        paceMs: 0,
        sleep: async () => {},
        loadItem: async item => { loaded.push(item.aid); return ok; },
        pushBatch: async batch => {
            batches.push(batch.map(entry => entry.item.aid));
            batchStarted();
            await pending;
            return { ok: true };
        },
    });

    const running = runner.run();
    await started;
    runner.pause();
    assert.equal(runner.state.status, 'pause-requested');
    assert.equal(runner.state.uploading, 1);
    releaseBatch();
    const result = await running;
    assert.equal(result.status, 'paused');
    assert.equal(result.pauseReason, 'user');
    assert.equal(result.backedUp, 1, 'the unambiguous completed GitHub batch is counted');
    assert.equal(result.completed, 1);
    assert.equal(result.notReached, 2);
    assert.deepEqual(loaded, [1]);
    assert.deepEqual(batches, [[1]]);
});

test('cancel during a GitHub mutation waits for that batch and starts no later work', async () => {
    let releaseBatch;
    let batchStarted;
    const started = new Promise(resolve => { batchStarted = resolve; });
    const pending = new Promise(resolve => { releaseBatch = resolve; });
    const loaded = [];
    const runner = Core.createRunner({
        ascents: items,
        batchItems: 1,
        bufferItems: 1,
        paceMs: 0,
        sleep: async () => {},
        loadItem: async item => { loaded.push(item.aid); return ok; },
        pushBatch: async () => {
            batchStarted();
            await pending;
            return { ok: true };
        },
    });

    const running = runner.run();
    await started;
    runner.cancel();
    assert.equal(runner.state.status, 'cancel-requested');
    assert.equal(runner.state.uploading, 1);
    releaseBatch();
    const result = await running;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.backedUp, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.notReached, 2);
    assert.deepEqual(loaded, [1]);
});

test('the producer fills only the bounded buffer while a GitHub batch is in flight', async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ ...items[0], aid: index + 1, peakName: `Peak ${index + 1}` }));
    const loaded = [];
    const batches = [];
    let releaseFirstBatch;
    const firstBatchGate = new Promise(resolve => { releaseFirstBatch = resolve; });
    let resolveWaiting;
    const waiting = new Promise(resolve => { resolveWaiting = resolve; });
    const runner = Core.createRunner({
        ascents: many,
        batchItems: 2,
        batchBytes: 100,
        bufferItems: 4,
        bufferBytes: 100,
        paceMs: 0,
        sleep: async () => {},
        measureItem: () => 1,
        onState: state => { if (state.producerWaiting) resolveWaiting(); },
        loadItem: async item => { loaded.push(item.aid); return ok; },
        pushBatch: async batch => {
            batches.push(batch.map(entry => entry.item.aid));
            if (batches.length === 1) await firstBatchGate;
            return { ok: true };
        },
    });

    const running = runner.run();
    await waiting;
    assert.deepEqual(loaded, [1, 2, 3, 4], 'the in-flight batch counts toward the four-item memory bound');
    assert.deepEqual(batches, [[1, 2]]);
    releaseFirstBatch();
    const result = await running;

    assert.equal(result.status, 'complete');
    assert.deepEqual(batches, [[1, 2], [3, 4], [5, 6], [7, 8]]);
});

test('the producer and consumer commit full batches plus one final partial batch', async () => {
    const many = Array.from({ length: 23 }, (_, index) => ({ ...items[0], aid: index + 1, peakName: `Peak ${index + 1}` }));
    const sizes = [];
    const runner = Core.createRunner({
        ascents: many,
        paceMs: 0,
        sleep: async () => {},
        measureItem: () => 1,
        loadItem: async () => ok,
        pushBatch: async batch => { sizes.push(batch.length); return { ok: true }; },
    });
    const result = await runner.run();

    assert.equal(result.status, 'complete');
    assert.equal(result.backedUp, 23);
    assert.deepEqual(sizes, [10, 10, 3]);
});

test('payload measurement includes the snapshot and GPX bytes', () => {
    const withoutTrack = Core.backupPayloadBytes({ snapshot: { ascent: { id: 1 } }, gpx: null });
    const withTrack = Core.backupPayloadBytes({ snapshot: { ascent: { id: 1 } }, gpx: '<gpx>track</gpx>' });
    assert.ok(withoutTrack > 0);
    assert.equal(withTrack - withoutTrack, new TextEncoder().encode('<gpx>track</gpx>').byteLength);
});
