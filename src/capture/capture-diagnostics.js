// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Local capture timing hooks. They are inert unless explicitly enabled in a
// developer/test realm, emit once to the supplied reporter, and accept only
// hard-coded duration/count labels. No URL, identity, coordinate, GPX, page
// text, response body, or persistent storage belongs in this channel.

const DURATION_LABELS = new Set([
    'admission.active-tab',
    'admission.unsupported',
    'admission.settings',
    'admission.jobs',
    'admission.storage',
    'activity.validation',
    'provider.injection',
    'provider.ownership',
    'peakbagger.account',
    'provider.capture',
    'provider.headers',
    'provider.body',
    'provider.parse',
    'provider.metadata',
    'local.sanitize',
    'local.boxes',
    'peakbagger.corridor',
    'local.matching',
    'local.reduction',
    'local.derivation',
    'storage.publish',
    'storage.failure',
]);
const COUNT_LABELS = new Set([
    'provider.track-points',
    'provider.segments',
    'provider.waypoints',
    'track.source-points',
    'track.sanitized-points',
    'track.waypoints',
    'track.matches',
    'peakbagger.areas',
    'peakbagger.candidates',
]);
const OUTCOMES = new Set([
    'cancelled',
    'cooldown',
    'error',
    'joined',
    'no-gps',
    'no-matches',
    'ready',
    'reused',
    'unsupported',
]);
const finiteNonNegative = value => Number.isFinite(Number(value)) && Number(value) >= 0;
const rounded = value => Math.round(Number(value) * 10) / 10;

export const createCaptureDiagnostics = ({
    enabled = false,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    report = () => {},
} = {}) => {
    if (!enabled) {
        return Object.freeze({
            enabled: false,
            mark: () => {},
            add: () => {},
            count: () => {},
            finish: () => null,
        });
    }
    const startedAt = now();
    let checkpoint = startedAt;
    let finished = false;
    const durationsMs = Object.create(null);
    const counts = Object.create(null);

    const add = (label, value) => {
        if (!DURATION_LABELS.has(label) || !finiteNonNegative(value)) return;
        durationsMs[label] = rounded((durationsMs[label] || 0) + Number(value));
    };
    const mark = label => {
        const timestamp = now();
        add(label, timestamp - checkpoint);
        checkpoint = timestamp;
    };
    const count = (label, value) => {
        if (!COUNT_LABELS.has(label) || !finiteNonNegative(value)) return;
        counts[label] = Math.trunc(Number(value));
    };
    const finish = outcome => {
        if (finished) return null;
        finished = true;
        const endedAt = now();
        const snapshot = {
            version: 1,
            outcome: OUTCOMES.has(outcome) ? outcome : 'error',
            totalMs: rounded(Math.max(0, endedAt - startedAt)),
            durationsMs: { ...durationsMs },
            counts: { ...counts },
        };
        report(snapshot);
        return snapshot;
    };

    return Object.freeze({ enabled: true, mark, add, count, finish });
};
