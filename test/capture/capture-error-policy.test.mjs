// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CAPTURE_ERROR_CODES,
    captureErrorPolicy,
} from '../../src/capture/capture-error-policy.js';

const REQUIRED_CODES = [
    'unsupported', 'activity-changed', 'provider-page-not-ready', 'provider-page-timeout',
    'provider-signed-out', 'provider-human-check', 'provider-rate-limited',
    'provider-forbidden', 'provider-unavailable', 'provider-response-changed',
    'provider-export-timeout', 'provider-export-failed', 'provider-export-cancelled',
    'invalid-gpx', 'no-gps-data', 'not-owner', 'ownership-unverified',
    'peakbagger-signed-out', 'cloudflare', 'rate-limit',
    'peakbagger-tab-access-failed', 'peakbagger-tab-open-failed',
    'peakbagger-tab-load-failed', 'peakbagger-tab-load-timeout', 'peakbagger-tab-changed',
    'peakbagger-page-connect-failed', 'peakbagger-page-unavailable',
    'peakbagger-page-timeout', 'peakbagger-response-invalid', 'peakbagger-unavailable',
    'settings-unavailable', 'gpx-too-large', 'track-too-large',
    'capture-analysis-too-large', 'peak-response-too-large', 'too-many-waypoints',
    'invalid-track', 'capture-timeout', 'capture-payload-missing', 'capture-busy',
    'capture-cancelled', 'capture-failed',
];

test('every public capture failure has one complete recovery policy', () => {
    assert.deepEqual([...CAPTURE_ERROR_CODES].sort(), [...REQUIRED_CODES].sort());
    for (const code of REQUIRED_CODES) {
        const entry = captureErrorPolicy(code);
        assert.match(entry.title, /\S/, `${code} title`);
        assert.match(entry.message, /\S/, `${code} message`);
        assert.ok(['none', 'settings', 'focus-provider', 'reload-provider', 'provider-sign-in',
            'open-peakbagger', 'wait', 'retry', 'check-again'].includes(entry.recovery),
        `${code} recovery`);
        assert.ok(['never', 'after-user', 'after-wait', 'safe'].includes(entry.retry),
            `${code} retry`);
    }
});

test('unknown capture failures use the bounded generic policy', () => {
    assert.equal(captureErrorPolicy('internal-secret-code'), captureErrorPolicy('capture-failed'));
});
