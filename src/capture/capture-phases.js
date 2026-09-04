// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const TERMINAL_PHASES = Object.freeze([
    'ready',
    'no-matches',
    'no-gps',
    'error',
    'opening',
    'opened',
    'previewed',
]);
const REUSABLE_PHASES = Object.freeze([
    'ready',
    'no-matches',
    'no-gps',
    'opening',
    'opened',
    'previewed',
]);
const ACTIVE_PHASES = Object.freeze([
    'validating-activity',
    'waiting-provider',
    'verifying-ownership',
    'checking-peakbagger',
    'exporting-gpx',
    'processing-track',
    'searching-summits',
    'preparing-results',
]);

const terminalPhaseSet = new Set(TERMINAL_PHASES);
const reusablePhaseSet = new Set(REUSABLE_PHASES);
const activePhaseSet = new Set(ACTIVE_PHASES);
const isTerminal = phase => terminalPhaseSet.has(phase);
const isReusable = phase => reusablePhaseSet.has(phase);
const isActive = phase => activePhaseSet.has(phase);

export const capturePhases = {
    TERMINAL_PHASES,
    REUSABLE_PHASES,
    ACTIVE_PHASES,
    isTerminal,
    isReusable,
    isActive,
};
