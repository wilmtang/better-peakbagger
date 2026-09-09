// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPeakbaggerRequestScheduler } from '../../src/background/peakbagger-request-scheduler.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

test('the Peakbagger scheduler owns one FIFO concurrency cap across callers', async () => {
    const scheduler = createPeakbaggerRequestScheduler({ concurrency: 2 });
    const releases = [deferred(), deferred(), deferred(), deferred()];
    const started = [];
    let inFlight = 0;
    let maximum = 0;
    const requests = releases.map((gate, index) => scheduler.run(async () => {
        started.push(index);
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        await gate.promise;
        inFlight--;
        return index;
    }));

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(started, [0, 1]);
    releases[1].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(started, [0, 1, 2], 'the oldest queued request starts next');
    releases[0].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(started, [0, 1, 2, 3]);
    releases[2].resolve();
    releases[3].resolve();
    assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3]);
    assert.equal(maximum, 2);
});

test('a terminal refusal aborts active siblings and rejects queued work with one reason', async () => {
    const scheduler = createPeakbaggerRequestScheduler({ concurrency: 2 });
    const refusal = Object.assign(new Error('wait'), { code: 'rate-limit' });
    const firstStarted = deferred();
    let firstSignal;
    const first = scheduler.run(signal => {
        firstSignal = signal;
        firstStarted.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const second = scheduler.run(async signal => {
        scheduler.stop(refusal, { exceptSignal: signal });
        throw refusal;
    });
    const third = scheduler.run(async () => 'must not start');

    await firstStarted.promise;
    await assert.rejects(first, error => error === refusal);
    await assert.rejects(second, error => error === refusal);
    await assert.rejects(third, error => error === refusal);
    assert.equal(firstSignal.aborted, true);
    assert.deepEqual(scheduler.state(), {
        active: 0, queued: 0, stopped: true, reason: refusal,
    });
    assert.equal(scheduler.resume(), true);
    assert.equal(await scheduler.run(async () => 'resumed'), 'resumed');
});

test('caller cancellation removes queued work without stopping unrelated requests', async () => {
    const scheduler = createPeakbaggerRequestScheduler({ concurrency: 1 });
    const gate = deferred();
    const first = scheduler.run(() => gate.promise);
    const controller = new AbortController();
    const cancelled = scheduler.run(async () => 'must not start', { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(scheduler.state().stopped, false);
    gate.resolve('first');
    assert.equal(await first, 'first');
});

