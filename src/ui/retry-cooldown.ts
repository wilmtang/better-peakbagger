// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// A known retry time disables only the affected request action, never cached
// results or local editing. Lifecycle owners park the one timer on suspension.
export type RetryCooldownTimer = ReturnType<typeof setTimeout> | number;

export interface RetryCooldownOptions {
    now?: () => number;
    schedule?: (fn: () => void, delayMs: number) => RetryCooldownTimer;
    cancel?: (timer: RetryCooldownTimer) => void;
}

export interface RetryCooldown {
    active(): boolean;
    set(value?: number | null): void;
    refresh(): void;
    suspend(): void;
    resume(): void;
    dispose(): void;
}

export function createRetryCooldown(
    update: (blocked: boolean) => void,
    { now = Date.now, schedule = setTimeout, cancel = clearTimeout }: RetryCooldownOptions = {}
): RetryCooldown {
    let until = 0, timer: RetryCooldownTimer | null = null, suspended = false;
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
        set(value) { until = typeof value === 'number' && Number.isFinite(value) && value > now() && value <= now() + 24 * 3600_000 ? value : 0; refresh(); },
        refresh,
        suspend() { suspended = true; if (timer !== null) cancel(timer); timer = null; },
        resume() { suspended = false; refresh(); },
        dispose() { suspended = true; until = 0; if (timer !== null) cancel(timer); timer = null; },
    };
}
