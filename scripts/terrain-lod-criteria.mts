// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// How long a tilt's fallback deeper than one level may last. Both budgets are
// judgements, not measurements of a user's threshold. MapLibre falls back to
// whatever it has already loaded, so depth belongs to the detail ladder and
// duration belongs to warming; only duration is judged here.
//
// A few frames of coarser terrain on screen read as a soft edge, half a second
// as a blink. Hence the tight visible budget.
export const VISIBLE_TRANSIENT_BUDGET_MS = 120;
// A tile that wants a level it has not got is a collapse waiting for the ridge
// in front of it to move, so hidden tiles stay bounded and excusing them would
// make the criterion depend on the fixture's scenery. Nobody sees this wait
// until that ridge moves, so it gets more room: the full-detail drape measured
// 99-225 ms on Apple M3 Pro under MapLibre 6.14 and 6.15, with nothing on screen
// falling short. A slowdown past that range still fails.
export const HIDDEN_TILE_TRANSIENT_BUDGET_MS = 250;

export interface TransientStep {
    visibleLevels: number;
    visibleShortUntilMs: number;
    tileLevels: number;
    tileShortUntilMs: number;
}

export interface TransientFailure {
    scope: 'visible' | 'hidden tile';
    durationMs: number;
    budgetMs: number;
}

// One level of shortfall is the ordinary soft edge between adjacent zooms and
// has no time limit. Tile counts include visible tiles, so a visible miss is
// reported first and the tile budget judges what is left.
export function tiltTransientFailure(step: TransientStep): TransientFailure | null {
    if (step.visibleLevels > 1 && step.visibleShortUntilMs > VISIBLE_TRANSIENT_BUDGET_MS) {
        return { scope: 'visible', durationMs: step.visibleShortUntilMs, budgetMs: VISIBLE_TRANSIENT_BUDGET_MS };
    }
    if (step.tileLevels > 1 && step.tileShortUntilMs > HIDDEN_TILE_TRANSIENT_BUDGET_MS) {
        return { scope: 'hidden tile', durationMs: step.tileShortUntilMs, budgetMs: HIDDEN_TILE_TRANSIENT_BUDGET_MS };
    }
    return null;
}
