// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://connect.garmin.com

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, garminPage, load } from './provider-page-harness.mts';

test('Garmin ownership accepts matching UUID profiles only with Edit an Activity and rejects malformed profile evidence', () => {
    const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
    const result = dom.window.BPBProviderPage.inspectOwnership();
    assert.equal(result.ok, true);
    assert.equal(result.viewerId, 'abc-123');
    dom.window.close();

    const malformed = load(garminPage().replaceAll('ABC-123', '%E0%A4%A').replaceAll('abc-123', '%E0%A4%A'),
        'https://connect.garmin.com/app/activity/777');
    assert.equal(malformed.window.BPBProviderPage.inspectOwnership().code, 'ownership-unverified');
    malformed.window.close();
});

test('sanitized Garmin contract corpus pins structural ownership outcomes', async t => {
    const cases: [string, string, string, boolean, string | null][] = [
        ['Garmin owned', 'garmin-owned.html', 'https://connect.garmin.com/app/activity/777', true, null],
        ['Garmin other owner', 'garmin-other-owner.html', 'https://connect.garmin.com/app/activity/777', false, 'not-owner'],
        ['Garmin signed out', 'garmin-signed-out.html', 'https://connect.garmin.com/app/activity/777', false, 'provider-signed-out'],
    ];
    for (const [name, file, url, ok, code] of cases) {
        await t.test(name, async () => {
            const dom = load(await fixture(file), url);
            const result = dom.window.BPBProviderPage.inspectOwnership();
            assert.equal(result.ok, ok);
            if (code) assert.equal(result.code, code);
            dom.window.close();
        });
    }
});

test('Garmin current-session capture uses the gc-api route and same-page CSRF header', async () => {
    const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
    dom.window.USE_DI_SESSION = true;
    dom.window.URL_BUST_VALUE = '5.26.1.1a';
    const requested: { url: string; options: { headers: Record<string, string>; credentials?: string } }[] = [];
    dom.window.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
        requested.push({
            url: String(url),
            options: options as unknown as { headers: Record<string, string>; credentials?: string },
        });
        return {
            ok: true,
            text: async () => '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>',
        };
    }) as unknown as typeof fetch;

    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.ok, true);
    assert.equal(requested.length, 1);
    assert.equal(requested[0]!.url, '/gc-api/download-service/export/gpx/activity/777');
    assert.equal(requested[0]!.options.headers['Connect-Csrf-Token'], 'csrf-123');
    assert.equal(requested[0]!.options.headers['X-app-ver'], '5.26.1.1a');
    assert.equal(requested[0]!.options.credentials, 'include');
    dom.window.close();
});

test('Garmin unavailability returns bounded typed copy instead of page exception text', async () => {
    const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
    dom.window.USE_DI_SESSION = true;
    dom.window.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.ok, false);
    assert.equal(capture.code, 'provider-unavailable');
    assert.equal(capture.message,
        'The provider could not complete the export. Wait a moment, then try again.');
    assert.doesNotMatch(capture.message!, /503|Garmin/);
    assert.doesNotMatch(capture.message!, /ownership/i);
    dom.window.close();
});

test('Garmin waits for session initialization in the document head without accessing GPS', async () => {
    const dom = load(garminPage({ csrfToken: '' }), 'https://connect.garmin.com/app/activity/777');
    dom.window.USE_DI_SESSION = true;
    let fetches = 0;
    dom.window.fetch = (async () => { fetches++; throw new Error('must not fetch'); }) as unknown as typeof fetch;
    let settled = false;
    const pending = dom.window.BPBProviderPage.waitForOwnership(
        { provider: 'garmin', activityId: '777' }, 'session-init', 1000,
    ).then(result => { settled = true; return result; });
    await Promise.resolve();
    assert.equal(settled, false, 'ownership cues alone do not make the Garmin session ready');
    dom.window.document.querySelector('meta[name="csrf-token"]').setAttribute('content', 'PRIVATE_TOKEN');
    const result = await pending;
    assert.deepEqual({ ...result }, { ok: true, provider: 'garmin', activityId: '777' });
    assert.equal(fetches, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|csrf/i);
    assert.equal(dom.window.BPBProviderPage.cancelCapture('session-init'), false);
    dom.window.close();
});

test('missing Garmin session state returns a typed failure before export and can recover in the same page', async () => {
    const dom = load(garminPage({ csrfToken: '' }), 'https://connect.garmin.com/app/activity/777');
    dom.window.USE_DI_SESSION = true;
    let fetches = 0;
    dom.window.fetch = (async () => {
        fetches++;
        return { ok: true, text: async () => '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>' };
    }) as unknown as typeof fetch;
    const ownership = await dom.window.BPBProviderPage.waitForOwnership(
        { provider: 'garmin', activityId: '777' }, 'missing-session', 5,
    );
    assert.equal(ownership.code, 'provider-session-not-ready');
    const missing = await dom.window.BPBProviderPage.capture({}, 'missing-export');
    assert.equal(missing.code, 'provider-session-not-ready');
    assert.equal(fetches, 0);
    assert.equal(dom.window.BPBProviderPage.cancelCapture('missing-export'), false);
    dom.window.document.querySelector('meta[name="csrf-token"]').setAttribute('content', 'PRIVATE_TOKEN');
    const recovered = await dom.window.BPBProviderPage.capture();
    assert.equal(recovered.ok, true);
    assert.equal(fetches, 1);
    assert.doesNotMatch(JSON.stringify([missing, recovered]), /PRIVATE_TOKEN|csrf/i);
    dom.window.close();
});

test('Garmin session wait remains cancellable and fails closed when ownership changes', async t => {
    for (const outcome of ['cancel', 'not-owner'] as const) {
        await t.test(outcome, async () => {
            const dom = load(garminPage({ csrfToken: '' }), 'https://connect.garmin.com/app/activity/777');
            dom.window.USE_DI_SESSION = true;
            const pending = dom.window.BPBProviderPage.waitForOwnership(
                { provider: 'garmin', activityId: '777' }, 'session-wait', 1000,
            );
            if (outcome === 'cancel') dom.window.BPBProviderPage.cancelCapture('session-wait');
            else dom.window.document.querySelector('[class*="ActivityHeaderContainer"] a')
                .setAttribute('href', '/app/profile/foreign-owner');
            assert.equal((await pending).code, outcome === 'cancel' ? 'provider-page-cancelled' : 'not-owner');
            dom.window.close();
        });
    }
});

test('provider download failures distinguish fetch and body failures without exposing exception text', async t => {
    for (const stage of ['fetch', 'body'] as const) {
        await t.test(stage, async () => {
            const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
            dom.window.USE_DI_SESSION = true;
            const fail = () => { throw new TypeError('PRIVATE_NETWORK_EXCEPTION'); };
            dom.window.fetch = (stage === 'fetch' ? fail : async () => ({ ok: true, text: fail })) as unknown as typeof fetch;
            const result = await dom.window.BPBProviderPage.capture();
            assert.equal(result.code, 'provider-download-failed');
            assert.match(result.message!, /Reopen it in a new tab/);
            assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NETWORK_EXCEPTION/);
            dom.window.close();
        });
    }
});
