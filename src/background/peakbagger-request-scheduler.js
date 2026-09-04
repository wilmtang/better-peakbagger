// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One origin-wide request owner for user-triggered Peakbagger reads. Capture
// jobs provide their own page transport, but none of them owns an independent
// concurrency pool: a refusal in one job must be able to stop queued and
// in-flight siblings before they add more traffic.

const abortError = () => Object.assign(new Error('Peakbagger request cancelled.'), {
    name: 'AbortError',
});

export const createPeakbaggerRequestScheduler = ({ concurrency = 4 } = {}) => {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new TypeError('Peakbagger request concurrency must be a positive integer.');
    }

    const queue = [];
    const active = new Set();
    let stoppedReason = null;

    const settle = (entry, kind, value) => {
        if (entry.settled) return;
        entry.settled = true;
        entry.signal?.removeEventListener('abort', entry.cancel);
        entry[kind](value);
    };

    const drain = () => {
        if (stoppedReason) return;
        while (active.size < concurrency && queue.length) {
            const entry = queue.shift();
            if (entry.settled) continue;
            if (entry.signal?.aborted) {
                settle(entry, 'reject', abortError());
                continue;
            }
            entry.started = true;
            active.add(entry);
            void Promise.resolve()
                .then(() => entry.operation(entry.controller.signal))
                .then(
                    value => settle(entry, entry.stopReason ? 'reject' : 'resolve', entry.stopReason || value),
                    error => settle(entry, 'reject', entry.stopReason || error),
                )
                .finally(() => {
                    active.delete(entry);
                    drain();
                });
        }
    };

    const run = (operation, { signal = null } = {}) => {
        if (typeof operation !== 'function') return Promise.reject(new TypeError('Request operation is required.'));
        if (stoppedReason) return Promise.reject(stoppedReason);
        if (signal?.aborted) return Promise.reject(abortError());

        return new Promise((resolve, reject) => {
            const entry = {
                operation,
                signal,
                controller: new AbortController(),
                resolve,
                reject,
                started: false,
                settled: false,
                stopReason: null,
                cancel: null,
            };
            entry.cancel = () => {
                if (entry.started) entry.controller.abort();
                else {
                    const index = queue.indexOf(entry);
                    if (index >= 0) queue.splice(index, 1);
                    settle(entry, 'reject', abortError());
                }
            };
            signal?.addEventListener('abort', entry.cancel, { once: true });
            queue.push(entry);
            drain();
        });
    };

    const stop = (reason, { exceptSignal = null } = {}) => {
        if (!reason) throw new TypeError('A stop reason is required.');
        if (stoppedReason) return false;
        stoppedReason = reason;
        for (const entry of queue.splice(0)) settle(entry, 'reject', reason);
        for (const entry of active) {
            if (entry.controller.signal === exceptSignal) continue;
            entry.stopReason = reason;
            entry.controller.abort();
        }
        return true;
    };

    const resume = () => {
        if (active.size) return false;
        stoppedReason = null;
        drain();
        return true;
    };

    const state = () => Object.freeze({
        active: active.size,
        queued: queue.length,
        stopped: !!stoppedReason,
        reason: stoppedReason,
    });

    return Object.freeze({ run, stop, resume, state });
};
