// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// A known retry time disables only the affected request action, never cached
// results or local editing. Lifecycle owners park the one timer on suspension.
export function createRetryCooldown(update, { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
    let until = 0, timer = null, suspended = false;
    const active = () => until > now();
    const refresh = () => {
        if (timer !== null) cancel(timer);
        timer = null;
        if (suspended) return;
        update(active());
        if (active()) timer = schedule(refresh, until - now());
    };
    return {
        active,
        set(value) { until = Number.isFinite(value) && value > now() && value <= now() + 24 * 3600_000 ? value : 0; refresh(); },
        refresh,
        suspend() { suspended = true; if (timer !== null) cancel(timer); timer = null; },
        resume() { suspended = false; refresh(); },
        dispose() { suspended = true; until = 0; if (timer !== null) cancel(timer); timer = null; },
    };
}
