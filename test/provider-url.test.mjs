// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFromUrl, providerActivityUrl } from '../src/provider-url.js';

test('providerActivityUrl rebuilds canonical Garmin and Strava links', () => {
    assert.equal(providerActivityUrl({ provider: 'garmin', activityId: '123' }),
        'https://connect.garmin.com/app/activity/123');
    assert.equal(providerActivityUrl({ provider: 'strava', activityId: '456' }),
        'https://www.strava.com/activities/456');
});

test('providerActivityUrl round-trips through providerFromUrl', () => {
    for (const activity of [{ provider: 'garmin', activityId: '999' }, { provider: 'strava', activityId: '42' }]) {
        assert.deepEqual(providerFromUrl(providerActivityUrl(activity)), activity);
    }
});

test('providerActivityUrl returns null for junk ids, unknown providers, and local GPX', () => {
    assert.equal(providerActivityUrl({ provider: 'garmin', activityId: 'abc' }), null);
    assert.equal(providerActivityUrl({ provider: 'garmin', activityId: '' }), null);
    assert.equal(providerActivityUrl({ provider: 'garmin', activityId: null }), null);
    assert.equal(providerActivityUrl({ provider: 'garmin', activityId: undefined }), null);
    assert.equal(providerActivityUrl({ provider: 'unknown', activityId: '123' }), null);
    assert.equal(providerActivityUrl({}), null);
    assert.equal(providerActivityUrl(), null);
});
