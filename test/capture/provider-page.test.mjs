// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { MAX_GPX_BYTES } from '../../src/capture/capture-resource-limits.js';

// The built bundle (IIFE) evaluated in each page's jsdom realm, so the module
// reads that page's document/location — exactly as the injected script does.
const source = await fs.readFile(new URL('../../dist/provider-page.js', import.meta.url), 'utf8');
const fixture = name => fs.readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

const load = (html, url) => {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    dom.window.eval(source);
    return dom;
};

const until = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition not reached');
        await new Promise(resolve => setTimeout(resolve, 1));
    }
};

const stravaPage = ({ viewer = '42', author = '42', edit = true } = {}) => `
<!doctype html><body>
  <header id="global-header"><a href="/athletes/${viewer}">Viewer</a></header>
  <main><section id="heading" data-testid="activity-header"><a href="/athletes/${author}">Author</a>
    <span>4:13 PM on Saturday, July 11, 2026</span></section>
    ${edit ? '<a href="/activities/123/edit">Edit</a>' : ''}<h1>Morning hike</h1>
    <time datetime="2026-07-01T08:00:00-07:00"></time>
  </main>
</body>`;

const garminPage = ({ csrfToken = 'csrf-123' } = {}) => `
<!doctype html><html><head><meta name="csrf-token" content="${csrfToken}"></head><body>
  <header class="header"><a href="/app/profile/ABC-123">Viewer</a></header>
  <div class="ActivityHeaderContainer_headerContainer__hash"><a href="/app/profile/abc-123">Author</a>
    <button aria-label="Edit an Activity"></button><h1>Mountain hike</h1>
  </div>
</body></html>`;

test('provider activity URL parsing accepts supported Garmin and Strava hosts and fails closed', () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    const parse = dom.window.BPBProviderPage.providerFromUrl;

    assert.deepEqual({ ...parse('https://connect.garmin.com/app/activity/777?foo=bar') }, {
        provider: 'garmin', activityId: '777'
    });
    assert.deepEqual({ ...parse('https://connect.garmin.com/modern/activity/777') }, {
        provider: 'garmin', activityId: '777'
    });
    assert.deepEqual({ ...parse('https://m.strava.com/activities/456/overview') }, {
        provider: 'strava', activityId: '456'
    });
    for (const value of [
        'not a URL',
        '/activities/123',
        'https://connect.garmin.com/app/activity/not-a-number',
        'https://connect.garmin.com.evil.example/app/activity/777',
        'https://www.strava.com.evil.example/activities/123',
        'https://clubs.strava.com/activities/123',
        'https://www.strava.com/athletes/123'
    ]) {
        assert.equal(parse(value), null, value);
    }
});

test('Strava ownership requires matching profile IDs and the owner edit link', () => {
    const owned = load(stravaPage(), 'https://www.strava.com/activities/123');
    assert.deepEqual({ ...owned.window.BPBProviderPage.inspectOwnership() }, {
        ok: true,
        provider: 'strava',
        activityId: '123',
        viewerId: '42',
        authorId: '42'
    });

    const other = load(stravaPage({ author: '99' }), 'https://www.strava.com/activities/123');
    assert.equal(other.window.BPBProviderPage.inspectOwnership().code, 'not-owner');

    const noEdit = load(stravaPage({ edit: false }), 'https://www.strava.com/activities/123');
    assert.equal(noEdit.window.BPBProviderPage.inspectOwnership().code, 'ownership-unverified');
});

test('ownership rejects foreign, contradictory, and malformed profile evidence', () => {
    const foreign = load(stravaPage().replaceAll('/athletes/42', 'https://evil.example/athletes/42'),
        'https://www.strava.com/activities/123');
    assert.equal(foreign.window.BPBProviderPage.inspectOwnership().code, 'ownership-unverified');

    const contradictory = load(`<!doctype html><body>
      <header id="global-header"><a href="/athletes/42">Viewer</a></header>
      <header data-testid="global-header"><a href="/athletes/99">Other viewer</a></header>
      <main><section id="heading"><a href="/athletes/42">Author</a></section>
        <a href="/activities/123/edit">Edit</a></main>
    </body>`, 'https://www.strava.com/activities/123');
    assert.equal(contradictory.window.BPBProviderPage.inspectOwnership().code, 'ownership-unverified');

    const malformed = load(garminPage().replaceAll('ABC-123', '%E0%A4%A').replaceAll('abc-123', '%E0%A4%A'),
        'https://connect.garmin.com/app/activity/777');
    assert.equal(malformed.window.BPBProviderPage.inspectOwnership().code, 'ownership-unverified');
});

test('Strava ownership rejects a foreign edit link even when its path matches', () => {
    const html = stravaPage().replace('/activities/123/edit', 'https://evil.example/activities/123/edit');
    const dom = load(html, 'https://www.strava.com/activities/123');
    assert.equal(dom.window.BPBProviderPage.inspectOwnership().code, 'ownership-unverified');
});

test('Garmin ownership accepts matching UUID profiles only with Edit an Activity', () => {
    const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
    const result = dom.window.BPBProviderPage.inspectOwnership();
    assert.equal(result.ok, true);
    assert.equal(result.viewerId, 'abc-123');
});

test('ownership failure never calls the GPX export endpoint', async () => {
    const dom = load(stravaPage({ author: '99' }), 'https://www.strava.com/activities/123');
    let fetches = 0;
    dom.window.fetch = async () => { fetches++; throw new Error('must not fetch'); };
    const result = await dom.window.BPBProviderPage.capture();
    assert.equal(result.code, 'not-owner');
    assert.equal(fetches, 0);
});

test('signed-out and changed provider DOMs fail with distinct states', () => {
    const signedOut = load('<a href="/login">Log In</a>', 'https://www.strava.com/activities/123');
    assert.equal(signedOut.window.BPBProviderPage.inspectOwnership().code, 'provider-signed-out');
    const unknown = load('<main><h1>Activity</h1></main>', 'https://www.strava.com/activities/123');
    assert.equal(unknown.window.BPBProviderPage.inspectOwnership().code, 'ownership-unverified');
});

test('sanitized provider contract corpus pins structural ownership outcomes', async t => {
    const cases = [
        ['Strava owned', 'strava-owned.html', 'https://www.strava.com/activities/123', true, null],
        ['Strava localized owned', 'strava-owned-es.html', 'https://www.strava.com/activities/123', true, null],
        ['Strava other owner', 'strava-other-owner.html', 'https://www.strava.com/activities/123', false, 'not-owner'],
        ['Strava signed out', 'strava-signed-out.html', 'https://www.strava.com/activities/123', false, 'provider-signed-out'],
        ['Garmin owned', 'garmin-owned.html', 'https://connect.garmin.com/app/activity/777', true, null],
        ['Garmin other owner', 'garmin-other-owner.html', 'https://connect.garmin.com/app/activity/777', false, 'not-owner'],
        ['Garmin signed out', 'garmin-signed-out.html', 'https://connect.garmin.com/app/activity/777', false, 'provider-signed-out'],
        ['loading skeleton', 'provider-loading.html', 'https://www.strava.com/activities/123', false, 'ownership-unverified'],
        ['human check', 'provider-challenge.html', 'https://www.strava.com/activities/123', false, 'provider-human-check'],
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

test('ownership wait tolerates staged SPA rendering and returns only after proof is complete', async () => {
    const dom = load('<main><h1>Loading activity</h1></main>', 'https://www.strava.com/activities/123');
    const pending = dom.window.BPBProviderPage.waitForOwnership(
        { provider: 'strava', activityId: '123' },
        'staged-ownership',
        1000,
    );
    dom.window.document.body.insertAdjacentHTML('afterbegin',
        '<header id="global-header"><a href="/athletes/42">Viewer</a></header>');
    await Promise.resolve();
    dom.window.document.querySelector('main').insertAdjacentHTML('afterbegin',
        '<section id="heading"><a href="/athletes/42">Author</a></section>');
    await Promise.resolve();
    dom.window.document.querySelector('main').insertAdjacentHTML('beforeend',
        '<a href="/activities/123/edit">Edit</a>');

    assert.deepEqual({ ...await pending }, {
        ok: true,
        provider: 'strava',
        activityId: '123',
    });
});

test('ownership wait classifies stable blockers and bounded incomplete pages', async t => {
    const cases = [
        {
            name: 'signed out',
            html: '<a href="/login">Log In</a>',
            code: 'provider-signed-out',
            timeoutMs: 100,
        },
        {
            name: 'human check',
            html: '<form id="challenge-form"></form>',
            code: 'provider-human-check',
            timeoutMs: 100,
        },
        {
            name: 'not ready',
            html: '<main><h1>Loading</h1></main>',
            code: 'provider-page-not-ready',
            timeoutMs: 5,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const dom = load(item.html, 'https://www.strava.com/activities/123');
            const result = await dom.window.BPBProviderPage.waitForOwnership(
                { provider: 'strava', activityId: '123' },
                `wait-${item.name}`,
                item.timeoutMs,
            );
            assert.equal(result.code, item.code);
        });
    }
});

test('ownership wait is cancelled by its capture generation', async () => {
    const dom = load('<main><h1>Loading</h1></main>', 'https://www.strava.com/activities/123');
    const pending = dom.window.BPBProviderPage.waitForOwnership(
        { provider: 'strava', activityId: '123' },
        'cancel-ownership',
        1000,
    );
    assert.equal(dom.window.BPBProviderPage.cancelCapture('other-generation'), false);
    assert.equal(dom.window.BPBProviderPage.cancelCapture('cancel-ownership'), true);
    assert.equal((await pending).code, 'provider-page-cancelled');
});

test('successful capture fetches only the provider GPX endpoint', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    const requested = [];
    dom.window.fetch = async url => {
        requested.push(url);
        return {
            ok: true,
            text: async () => '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>'
        };
    };
    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.ok, true);
    assert.deepEqual(requested, ['/activities/123/export_gpx']);
    assert.equal(capture.segments[0].length, 2);
    assert.deepEqual(
        JSON.parse(JSON.stringify(capture.segments[0].map(point => [point.ele, point.time, point.invalidTime]))),
        [[null, null, false], [null, null, false]],
        'coordinate-only GPX must remain a successful capture'
    );
    assert.deepEqual([...capture.waypoints], []);
    assert.equal(capture.metadata.title, undefined);
    assert.equal(capture.metadata.displayedLocalStart, '2026-07-11T16:13:00');
    assert.equal('diagnostics' in capture, false, 'production capture output stays narrow by default');
});

test('opt-in provider diagnostics contain only local durations and aggregate counts', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    dom.window.fetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/gpx+xml' },
        text: async () => '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>',
    });

    const capture = await dom.window.BPBProviderPage.capture(
        {},
        'diagnostic-capture',
        1000,
        { provider: 'strava', activityId: '123' },
        true,
    );
    const diagnostics = JSON.parse(JSON.stringify(capture.diagnostics));
    assert.equal(capture.ok, true);
    assert.deepEqual(Object.keys(diagnostics.durationsMs).sort(), ['body', 'headers', 'metadata', 'parse']);
    assert.ok(Object.values(diagnostics.durationsMs).every(value => Number.isFinite(value) && value >= 0));
    assert.deepEqual(diagnostics.counts, { 'track-points': 2, segments: 1, waypoints: 0 });
    assert.doesNotMatch(JSON.stringify(diagnostics), /strava|activities|latitude|longitude|gpx/i);
});

test('provider capture excludes extension-owned and nested fake GPX geometry', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    dom.window.fetch = async () => ({
        ok: true,
        text: async () => `<gpx>
          <extensions><trk><trkseg><trkpt lat="99" lon="99"/></trkseg></trk></extensions>
          <trk><trkseg>
            <trkpt lat="1" lon="2"/>
            <extensions><trkpt lat="98" lon="98"/></extensions>
            <trkseg><trkpt lat="97" lon="97"/></trkseg>
            <trkpt lat="1" lon="2"/>
          </trkseg></trk>
        </gpx>`,
    });

    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.ok, true);
    assert.deepEqual(
        JSON.parse(JSON.stringify(capture.segments.map(segment =>
            segment.map(({ lat, lon }) => [lat, lon])))),
        [[[1, 2], [1, 2]]],
    );
});

test('capture rejects a same-tab activity change after the GPX body starts', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    let releaseBody;
    let bodyStarted;
    const bodyGate = new Promise(resolve => { releaseBody = resolve; });
    const started = new Promise(resolve => { bodyStarted = resolve; });
    dom.window.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => {
            bodyStarted();
            await bodyGate;
            return '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>';
        },
    });

    const pending = dom.window.BPBProviderPage.capture(
        {},
        'activity-identity',
        1000,
        { provider: 'strava', activityId: '123' },
    );
    await started;
    dom.window.history.pushState({}, '', '/activities/456');
    releaseBody();
    const capture = await pending;

    assert.deepEqual({ ...capture }, {
        ok: false,
        code: 'activity-changed',
        provider: 'strava',
        activityId: '123',
    });
    assert.equal('segments' in capture, false);
});

test('capture returns allowlisted waypoint and trip-name data for enabled settings', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    dom.window.fetch = async () => ({
        ok: true,
        text: async () => '<gpx><wpt lat="1.2" lon="2.3"><name>Camp</name><desc>secret</desc></wpt><trk><name>Overnight traverse</name><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>'
    });

    const capture = await dom.window.BPBProviderPage.capture({ retainWaypoints: true, includeTripName: true });
    assert.deepEqual(JSON.parse(JSON.stringify(capture.waypoints)), [{ lat: 1.2, lon: 2.3, name: 'Camp' }]);
    assert.equal(capture.metadata.title, 'Overnight traverse');
    assert.doesNotMatch(JSON.stringify(capture), /secret/);
});

test('Garmin current-session capture uses the gc-api route and same-page CSRF header', async () => {
    const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
    dom.window.USE_DI_SESSION = true;
    dom.window.URL_BUST_VALUE = '5.26.1.1a';
    const requested = [];
    dom.window.fetch = async (url, options) => {
        requested.push({ url, options });
        return {
            ok: true,
            text: async () => '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>'
        };
    };

    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.ok, true);
    assert.equal(requested.length, 1);
    assert.equal(requested[0].url, '/gc-api/download-service/export/gpx/activity/777');
    assert.equal(requested[0].options.headers['Connect-Csrf-Token'], 'csrf-123');
    assert.equal(requested[0].options.headers['X-app-ver'], '5.26.1.1a');
    assert.equal(requested[0].options.credentials, 'include');
});

test('Garmin unavailability returns bounded typed copy instead of page exception text', async () => {
    const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
    dom.window.USE_DI_SESSION = true;
    dom.window.fetch = async () => ({ ok: false, status: 503 });

    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.ok, false);
    assert.equal(capture.code, 'provider-unavailable');
    assert.equal(capture.message,
        'The provider could not complete the export. Wait a moment, then try again.');
    assert.doesNotMatch(capture.message, /503|Garmin/);
    assert.doesNotMatch(capture.message, /ownership/i);
});

test('provider export classifies response failures before GPX parsing', async t => {
    const now = Date.now();
    const cases = [
        { name: 'signed out', response: { ok: false, status: 401 }, code: 'provider-signed-out' },
        {
            name: 'challenge header',
            response: { ok: false, status: 403, headers: { 'cf-mitigated': 'challenge' } },
            code: 'provider-human-check',
        },
        {
            name: 'challenge body',
            response: { ok: false, status: 403, text: async () => '<title>Just a moment...</title>' },
            code: 'provider-human-check',
        },
        {
            name: 'forbidden',
            response: { ok: false, status: 403, text: async () => '<p>Forbidden</p>' },
            code: 'provider-forbidden',
        },
        { name: 'missing endpoint', response: { ok: false, status: 404 }, code: 'provider-response-changed' },
        {
            name: 'rate limited',
            response: { ok: false, status: 429, headers: { 'retry-after': '60' } },
            code: 'provider-rate-limited',
            retryAt: true,
        },
        { name: 'unavailable', response: { ok: false, status: 503 }, code: 'provider-unavailable' },
        {
            name: 'login redirect',
            response: { ok: true, status: 200, url: 'https://www.strava.com/login' },
            code: 'provider-signed-out',
        },
        {
            name: 'HTML interstitial',
            response: {
                ok: true,
                status: 200,
                headers: { 'content-type': 'text/html' },
                text: async () => '<!doctype html><p>Changed</p>',
            },
            code: 'provider-response-changed',
        },
        {
            name: 'JSON response',
            response: { ok: true, status: 200, headers: { 'content-type': 'application/json' } },
            code: 'provider-response-changed',
        },
        {
            name: 'invalid GPX',
            response: { ok: true, status: 200, text: async () => '<not-gpx/>' },
            code: 'invalid-gpx',
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
            dom.window.fetch = async () => item.response;
            const result = await dom.window.BPBProviderPage.capture();
            assert.equal(result.code, item.code);
            assert.doesNotMatch(JSON.stringify(result), /Forbidden|Just a moment|not-gpx/);
            if (item.retryAt) {
                assert.ok(result.retryAt >= now + 59000 && result.retryAt <= Date.now() + 61000);
            } else {
                assert.equal('retryAt' in result, false);
            }
        });
    }
});

test('a never-settling provider fetch ends at one public deadline and releases the socket', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    let aborted = false;
    dom.window.fetch = async (_url, options) => {
        options.signal?.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => {});
    };

    const capture = await dom.window.BPBProviderPage.capture({}, 'capture-timeout', 10);
    assert.equal(capture.ok, false);
    assert.equal(capture.code, 'provider-export-timeout');
    assert.equal(capture.message, 'Reload the activity, wait for it to finish, then capture again.');
    assert.equal(aborted, true);
});

test('the same provider deadline bounds a stalled GPX body read', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    let aborted = false;
    dom.window.fetch = async (_url, options) => {
        options.signal?.addEventListener('abort', () => { aborted = true; });
        return {
            ok: true,
            status: 200,
            text: async () => new Promise(() => {}),
        };
    };

    const capture = await dom.window.BPBProviderPage.capture({}, 'body-timeout', 10);
    assert.equal(capture.code, 'provider-export-timeout');
    assert.match(capture.message, /reload the activity/i);
    assert.equal(aborted, true);
});

test('provider GPX rejects an oversized declared body before reading it', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    let read = false;
    dom.window.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(MAX_GPX_BYTES + 1) }),
        text: async () => { read = true; return '<gpx/>'; },
    });

    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.code, 'gpx-too-large');
    assert.match(capture.message, /16 MiB.*20,000 track points/);
    assert.equal(read, false);
});

test('cancelling one provider generation aborts only its in-page request', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    let signal;
    dom.window.fetch = async (_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
    };

    const pending = dom.window.BPBProviderPage.capture({}, 'capture-cancel', 1000);
    await until(() => !!signal);
    assert.equal(dom.window.BPBProviderPage.cancelCapture('other-generation'), false);
    assert.equal(signal.aborted, false);
    assert.equal(dom.window.BPBProviderPage.cancelCapture('capture-cancel'), true);
    const capture = await pending;
    assert.equal(capture.code, 'provider-export-cancelled');
    assert.equal(signal.aborted, true);
    assert.equal(dom.window.BPBProviderPage.cancelCapture('capture-cancel'), false,
        'the completed generation no longer owns an abort controller');
});

test('an unavailable or trackless provider export is reported as no GPS data', async t => {
    const cases = [
        { name: 'no content', response: { ok: true, status: 204 } },
        { name: 'empty body', response: { ok: true, status: 200, text: async () => '  ' } },
        { name: 'GPX without trackpoints', response: { ok: true, status: 200, text: async () => '<gpx><trk><trkseg/></trk></gpx>' } }
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
            dom.window.fetch = async () => item.response;

            const capture = await dom.window.BPBProviderPage.capture();
            assert.equal(capture.ok, false);
            assert.equal(capture.code, 'no-gps-data');
            assert.match(capture.message, /no recorded route yet/i);
        });
    }
});

// The adapter's output to the worker is documented as narrow. Ownership is
// decided by comparing Garmin/Strava profile identifiers, and those compared
// values are third-party account identities that PRIVACY.md's capture
// allowlist does not include — they belong to the page realm that read them.
test('no provider profile identity crosses to the background worker', async () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    const api = dom.window.BPBProviderPage;

    const decision = api.inspectOwnership();
    assert.equal(decision.viewerId, '42', 'the page still resolves both identities to compare them');

    assert.deepEqual({ ...api.publicOwnership(decision) },
        { ok: true, provider: 'strava', activityId: '123' });
    assert.deepEqual({ ...api.publicOwnership(api.inspectOwnership.call(null, 'https://example.com/x')) },
        { ok: false, code: 'unsupported' });
    for (const value of [null, undefined, 'nope', 42]) {
        assert.deepEqual({ ...api.publicOwnership(value) },
            { ok: false, code: 'ownership-unverified' }, `unusable input: ${value}`);
    }

    dom.window.fetch = async () => ({
        ok: true,
        text: async () => '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>'
    });
    const captured = await api.capture();
    assert.equal(captured.ok, true);
    assert.deepEqual(Object.keys(captured).filter(key => /viewer|author|profile/i.test(key)), []);
    assert.equal('viewerId' in captured, false);
    assert.equal('authorId' in captured, false);
});
