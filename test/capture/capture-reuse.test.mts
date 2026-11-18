// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameCapturePreferences, timestampsTurnedOnSince } from '../../src/capture/capture-reuse.ts';

const prefs = (removeGpxTimestamps: boolean) => ({ retainWaypoints: true, removeGpxTimestamps, fillAscentDetails: true,
    fillTripInfo: true, fillWildernessNights: true, fillExternalUrl: true });

test('turning timestamp removal on retires an earlier capture; turning it off does not', () => {
    assert.equal(sameCapturePreferences(prefs(false), prefs(true)), false, 'off → on must capture again');
    assert.equal(sameCapturePreferences(prefs(true), prefs(false)), true, 'on → off reuses; the timed copy was kept');
    assert.equal(sameCapturePreferences(prefs(true), prefs(true)), true);
    assert.equal(sameCapturePreferences(prefs(false), prefs(false)), true);
    assert.equal(sameCapturePreferences(prefs(true), { ...prefs(true), retainWaypoints: false }), false);
});

test('a capture made with timestamps kept cannot be delivered once removal is on', () => {
    assert.equal(timestampsTurnedOnSince(prefs(false), true), true);
    assert.equal(timestampsTurnedOnSince(undefined, true), true, 'an unknown capture preference fails closed');
    assert.equal(timestampsTurnedOnSince(prefs(true), true), false, 'a capture made with removal on has its timeless copy');
    assert.equal(timestampsTurnedOnSince(prefs(false), false), false);
});
