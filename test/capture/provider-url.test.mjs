// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isProviderHost,
    providerFromUrl,
    providerActivityUrl,
    providerProfileId,
} from '../../src/capture/provider-url.js';

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

test('providerFromUrl accepts Garmin activity URLs on both sides of its redirect', () => {
    const activity = { provider: 'garmin', activityId: '999' };
    assert.deepEqual(providerFromUrl('https://connect.garmin.com/app/activity/999'), activity);
    assert.deepEqual(providerFromUrl('https://connect.garmin.com/modern/activity/999'), activity);
});

test('providerFromUrl ignores URL spelling but rejects unsupported origins', () => {
    const activity = { provider: 'garmin', activityId: '999' };
    assert.deepEqual(providerFromUrl('https://connect.garmin.com/app/activity/999?source=redirect#details'), activity);
    for (const url of [
        'http://connect.garmin.com/app/activity/999',
        'https://connect.garmin.com.evil.example/app/activity/999',
        'ftp://www.strava.com/activities/999',
        'https://clubs.strava.com/activities/999',
        'https://evil.strava.com/activities/999',
    ]) assert.equal(providerFromUrl(url), null, url);
});

test('provider profile identity accepts only supported same-provider origins', () => {
    assert.equal(providerProfileId('/athletes/42', 'strava', 'https://www.strava.com/activities/1'), '42');
    assert.equal(providerProfileId('https://m.strava.com/athletes/42', 'strava',
        'https://www.strava.com/activities/1'), '42');
    assert.equal(providerProfileId('https://evil.example/athletes/42', 'strava',
        'https://www.strava.com/activities/1'), null);
    assert.equal(providerProfileId('/app/profile/ABC%2D123', 'garmin',
        'https://connect.garmin.com/app/activity/1'), 'abc-123');
    assert.equal(providerProfileId('/app/profile/%E0%A4%A', 'garmin',
        'https://connect.garmin.com/app/activity/1'), null);
    assert.equal(isProviderHost('strava', 'STRAVA.COM'), true);
    assert.equal(isProviderHost('strava', 'clubs.strava.com'), false);
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
