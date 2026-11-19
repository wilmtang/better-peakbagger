// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleBuildGroups } from '../../docs/plans/experiments/wxt-candidate.mts';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}

test('WXT keeps build work bounded and returns the result for each requested group', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const thirdStarted = deferred<void>();
    const started: string[] = [];
    const build = scheduleBuildGroups(['head', 'worker', 'frame'], 2, async group => {
        started.push(group);
        if (group === 'head') return first.promise;
        if (group === 'worker') return second.promise;
        thirdStarted.resolve();
        return 'frame bytes';
    });

    const head = build('head');
    assert.deepEqual(started, ['head', 'worker']);
    second.resolve('worker bytes');
    await thirdStarted.promise;
    assert.deepEqual(started, ['head', 'worker', 'frame']);
    first.resolve('head bytes');
    assert.equal(await head, 'head bytes');
    assert.equal(await build('worker'), 'worker bytes');
    assert.equal(await build('frame'), 'frame bytes');
    assert.deepEqual(started, ['head', 'worker', 'frame']);
});

test('WXT stops queuing work and waits for active builds after a failure', async () => {
    const active = deferred<string>();
    const error = new Error('bundle failed');
    const started: string[] = [];
    let returned = false;
    const build = scheduleBuildGroups(['broken', 'active', 'queued'], 2, async group => {
        started.push(group);
        if (group === 'active') return active.promise;
        throw error;
    });
    const failure = assert.rejects(build('broken'), reason => reason === error).then(() => {
        returned = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['broken', 'active']);
    assert.equal(returned, false);
    active.resolve('active bytes');
    await failure;
    assert.deepEqual(started, ['broken', 'active']);
});
