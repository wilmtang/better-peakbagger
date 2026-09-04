// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyProviderBody,
    classifyProviderResponse,
} from '../../src/capture/provider-response.js';

const response = (status, {
    headers = {},
    url = 'https://www.strava.com/activities/123/export_gpx',
} = {}) => ({ status, ok: status >= 200 && status < 300, headers, url });

test('provider response classification separates auth, challenge, rate, and endpoint failures', () => {
    assert.equal(classifyProviderResponse(response(401), { provider: 'strava' }).code,
        'provider-signed-out');
    assert.equal(classifyProviderResponse(response(403, {
        headers: { 'CF-MitIGated': 'challenge' },
    }), { provider: 'strava' }).code, 'provider-human-check');
    assert.equal(classifyProviderResponse(response(403), { provider: 'strava' }).needsBodyProbe, true);
    assert.equal(classifyProviderResponse(response(403), {
        provider: 'strava', bodyText: '<title>Just a moment...</title>',
    }).code, 'provider-human-check');
    assert.equal(classifyProviderResponse(response(403), {
        provider: 'strava', bodyText: '<p>Forbidden</p>',
    }).code, 'provider-forbidden');
    assert.equal(classifyProviderResponse(response(404), { provider: 'strava' }).code,
        'provider-response-changed');
    assert.equal(classifyProviderResponse(response(503), { provider: 'strava' }).code,
        'provider-unavailable');
});

test('provider rate limits expose only a bounded validated retry timestamp', () => {
    const now = Date.UTC(2026, 8, 3, 12);
    assert.deepEqual(classifyProviderResponse(response(429, {
        headers: { 'retry-after': '120' },
    }), { provider: 'strava', now }), {
        ok: false,
        code: 'provider-rate-limited',
        retryAt: now + 120000,
    });
    for (const value of ['-1', '9999999', 'not-a-date']) {
        assert.deepEqual(classifyProviderResponse(response(429, {
            headers: { 'retry-after': value },
        }), { provider: 'strava', now }), {
            ok: false,
            code: 'provider-rate-limited',
        });
    }
});

test('provider response classification validates final URL and content type', () => {
    assert.equal(classifyProviderResponse(response(200, {
        url: 'https://www.strava.com/login',
    }), { provider: 'strava' }).code, 'provider-signed-out');
    assert.equal(classifyProviderResponse(response(200, {
        url: 'https://evil.example/activities/123/export_gpx',
    }), { provider: 'strava' }).code, 'provider-response-changed');
    assert.equal(classifyProviderResponse(response(200, {
        headers: { 'content-type': 'application/json' },
    }), { provider: 'strava' }).code, 'provider-response-changed');
    assert.equal(classifyProviderResponse(response(200, {
        headers: { 'content-type': 'text/html' },
    }), { provider: 'strava' }).needsBodyProbe, true);
    assert.equal(classifyProviderResponse(response(200), { provider: 'strava' }).ok, true);
});

test('provider body classification distinguishes empty, login, challenge, and changed bodies', () => {
    assert.equal(classifyProviderBody('  ').code, 'no-gps-data');
    assert.equal(classifyProviderBody('<form id="challenge-form"></form>').code,
        'provider-human-check');
    assert.equal(classifyProviderBody('<form id="login"><input type="password"></form>').code,
        'provider-signed-out');
    assert.equal(classifyProviderBody('<!doctype html><p>Changed</p>').code,
        'provider-response-changed');
    assert.equal(classifyProviderBody('{"error":"changed"}').code,
        'provider-response-changed');
    assert.equal(classifyProviderBody('<gpx></gpx>').ok, true);
});
