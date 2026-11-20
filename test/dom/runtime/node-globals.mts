/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Node globals that in-page browser tests use, installed before a test file
// loads. setImmediate runs its callback in a later task, as in Node: after
// pending promise reactions, before timers that are due later.

type Immediate = { cancelled: boolean };
if (typeof (globalThis as { setImmediate?: unknown }).setImmediate !== 'function') {
    const channel = new MessageChannel();
    const queue: [Immediate, () => void][] = [];
    channel.port1.onmessage = () => {
        const next = queue.shift();
        if (next && !next[0].cancelled) next[1]();
    };
    Object.assign(globalThis, {
        setImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]) {
            const handle: Immediate = { cancelled: false };
            queue.push([handle, () => callback(...args)]);
            channel.port2.postMessage(null);
            return handle;
        },
        clearImmediate(handle?: Immediate) { if (handle) handle.cancelled = true; },
    });
}
