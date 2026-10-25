// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Own a latest-only read, without choosing identity, cache or UI policy.
// A stale success/error/finalizer cannot finish a newer transaction.
export function createLatestRead() {
    let active = null;
    return {
        get pending() { return active !== null; },
        cancel() { const previous = active; active = null; previous?.abort(); },
        start() {
            const previous = active, controller = new AbortController();
            active = controller; previous?.abort();
            const isCurrent = () => active === controller && !controller.signal.aborted;
            return {
                signal: controller.signal, isCurrent,
                finish() { if (!isCurrent()) return false; active = null; return true; },
            };
        },
    };
}
