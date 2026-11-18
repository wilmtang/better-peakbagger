// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export type TerminalPhase =
    | 'ready'
    | 'no-matches'
    | 'no-gps'
    | 'error'
    | 'opening'
    | 'opened'
    | 'previewed';

export type ReusablePhase =
    | 'ready'
    | 'no-matches'
    | 'no-gps'
    | 'opening'
    | 'opened'
    | 'previewed';

export type ActivePhase =
    | 'validating-activity'
    | 'waiting-provider'
    | 'verifying-ownership'
    | 'checking-peakbagger'
    | 'exporting-gpx'
    | 'processing-track'
    | 'searching-summits'
    | 'preparing-results';

export type CapturePhase = TerminalPhase | ActivePhase;

const TERMINAL_PHASES: readonly string[] = Object.freeze([
    'ready',
    'no-matches',
    'no-gps',
    'error',
    'opening',
    'opened',
    'previewed',
]);
const REUSABLE_PHASES: readonly string[] = Object.freeze([
    'ready',
    'no-matches',
    'no-gps',
    'opening',
    'opened',
    'previewed',
]);
const ACTIVE_PHASES: readonly string[] = Object.freeze([
    'validating-activity',
    'waiting-provider',
    'verifying-ownership',
    'checking-peakbagger',
    'exporting-gpx',
    'processing-track',
    'searching-summits',
    'preparing-results',
]);

const terminalPhaseSet = new Set<string>(TERMINAL_PHASES);
const reusablePhaseSet = new Set<string>(REUSABLE_PHASES);
const activePhaseSet = new Set<string>(ACTIVE_PHASES);
const isTerminal = (phase: unknown): phase is TerminalPhase =>
    typeof phase === 'string' && terminalPhaseSet.has(phase);
const isReusable = (phase: unknown): phase is ReusablePhase =>
    typeof phase === 'string' && reusablePhaseSet.has(phase);
const isActive = (phase: unknown): phase is ActivePhase =>
    typeof phase === 'string' && activePhaseSet.has(phase);

export const capturePhases = {
    TERMINAL_PHASES,
    REUSABLE_PHASES,
    ACTIVE_PHASES,
    isTerminal,
    isReusable,
    isActive,
};
