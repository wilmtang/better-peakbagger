// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const TERMINAL_PHASES = Object.freeze([
    'ready',
    'no-matches',
    'no-gps',
    'error',
    'opened',
    'previewed',
]);

const terminalPhaseSet = new Set(TERMINAL_PHASES);
const isTerminal = phase => terminalPhaseSet.has(phase);

export const capturePhases = { TERMINAL_PHASES, isTerminal };
