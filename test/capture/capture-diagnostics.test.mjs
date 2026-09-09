// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCaptureDiagnostics } from '../../src/capture/capture-diagnostics.js';

test('capture diagnostics are inert by default', () => {
    let reports = 0;
    const diagnostics = createCaptureDiagnostics({ report: () => { reports++; } });
    diagnostics.mark('provider.headers');
    diagnostics.add('provider.body', 12);
    diagnostics.count('track.points', 99);
    assert.equal(diagnostics.finish('ready'), null);
    assert.equal(reports, 0);
});

test('enabled diagnostics report only bounded durations, counts, and an outcome', () => {
    const clock = { now: 10 };
    const reports = [];
    const diagnostics = createCaptureDiagnostics({
        enabled: true,
        now: () => clock.now,
        report: value => reports.push(value),
    });
    clock.now = 16.24;
    diagnostics.mark('admission.settings');
    diagnostics.add('provider.body', 2.22);
    diagnostics.add('provider.body', 1.11);
    diagnostics.count('track.source-points', 123.9);
    diagnostics.add('https://private.example/activities/7', 999);
    diagnostics.count('track.coordinates', -1);
    clock.now = 25.01;

    assert.deepEqual(diagnostics.finish('ready'), {
        version: 1,
        outcome: 'ready',
        totalMs: 15,
        durationsMs: { 'admission.settings': 6.2, 'provider.body': 3.3 },
        counts: { 'track.source-points': 123 },
    });
    assert.equal(diagnostics.finish('error'), null, 'one capture emits at most once');
    assert.equal(reports.length, 1);
});
