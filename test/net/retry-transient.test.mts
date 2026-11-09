// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { retryTransient } from '../../src/net/retry-transient.ts';

test('a fetch rejection from an embedded map realm receives one recovery attempt', async () => {
    const failure: unknown = runInNewContext("new TypeError('Failed to fetch')");
    assert.equal(failure instanceof TypeError, false, 'exercise the embedded window boundary');
    let attempts = 0;
    const result = await retryTransient(async () => {
        if (++attempts === 1) throw failure;
        return 'painted slope tile';
    }, { delayMs: 0 });
    assert.equal(result, 'painted slope tile');
    assert.equal(attempts, 2);
});

test('a persistent foreign fetch failure stops after one retry', async () => {
    const failure: unknown = runInNewContext("new TypeError('Failed to fetch')");
    let attempts = 0;
    await assert.rejects(retryTransient(async () => { attempts++; throw failure; }, { delayMs: 0 }), error => error === failure);
    assert.equal(attempts, 2);
});

test('rate limits, cancellation, permission errors and validation errors are not retried', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    for (const [failure, signal] of [
        [Object.assign(new TypeError('Limited'), { code: 'rate-limit' }), undefined],
        [new TypeError('Cancelled fetch'), cancelled.signal],
        [Object.assign(new Error('Allow BC maps'), { code: 'bc-permission-required' }), undefined],
        [new Error('Invalid map response'), undefined],
    ] as const) {
        let attempts = 0;
        await assert.rejects(retryTransient(async () => { attempts++; throw failure; }, { signal, delayMs: 0 }), error => error === failure);
        assert.equal(attempts, 1);
    }
});
