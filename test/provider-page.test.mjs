// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await fs.readFile(new URL('../src/provider-page.js', import.meta.url), 'utf8');

const load = (html, url) => {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    dom.window.eval(source);
    return dom;
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

test('GPX extraction selects only analysis fields and preserves segments', () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    const gpx = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"
      xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
      <metadata><name>Private activity</name></metadata><trk><name>Secret</name>
      <trkseg><trkpt lat="47" lon="-121"><ele>100</ele><time>2026-07-01T15:00:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>175</gpxtpx:hr><gpxtpx:cad>92</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>
      </trkpt></trkseg><trkseg><trkpt lat="48" lon="-122"><time>bad</time></trkpt></trkseg></trk></gpx>`;
    const segments = dom.window.BPBProviderPage.parseGpxData(gpx).segments;
    assert.equal(segments.length, 2);
    assert.deepEqual(Object.keys(segments[0][0]).sort(), ['ele', 'invalidTime', 'lat', 'lon', 'time']);
    assert.equal(segments[0][0].ele, 100);
    assert.equal(segments[1][0].invalidTime, true);
    assert.doesNotMatch(JSON.stringify(segments), /175|92|Private|Secret|hr|cad/);
});

test('waypoint coordinates, names, and the track name leave the page only when requested', () => {
    const dom = load(stravaPage(), 'https://www.strava.com/activities/123');
    const gpx = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="47.1" lon="-121.2"><ele>999</ele><time>2026-07-01T00:00:00Z</time>
        <name> Camp &amp; Water </name><desc>Private note</desc><sym>Tent</sym></wpt>
      <wpt lat="" lon=""><name>Invalid</name></wpt>
      <trk><name> Afternoon Hike </name><trkseg>
        <trkpt lat="47" lon="-121"/><trkpt lat="47.2" lon="-121.3"/>
      </trkseg></trk></gpx>`;

    const defaults = dom.window.BPBProviderPage.parseGpxData(gpx);
    assert.deepEqual([...defaults.waypoints], []);
    assert.equal(defaults.trackName, '');

    const retained = dom.window.BPBProviderPage.parseGpxData(gpx, {
        retainWaypoints: true,
        includeTripName: true
    });
    assert.equal(retained.waypoints.length, 2);
    assert.equal(retained.waypoints[1].lat, null);
    assert.equal(retained.waypoints[1].lon, null);
    const sanitizedWaypoints = retained.waypoints.filter(waypoint => waypoint.lat !== null && waypoint.lon !== null);
    assert.deepEqual(JSON.parse(JSON.stringify(sanitizedWaypoints)), [
        { lat: 47.1, lon: -121.2, name: 'Camp & Water' }
    ]);
    assert.equal(retained.trackName, 'Afternoon Hike');
    assert.doesNotMatch(JSON.stringify(retained.waypoints), /999|Private|Tent|2026/);
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
    assert.deepEqual([...capture.waypoints], []);
    assert.equal(capture.metadata.title, undefined);
    assert.equal(capture.metadata.displayedLocalStart, '2026-07-11T16:13:00');
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

test('Garmin export failures are returned explicitly instead of masquerading as ownership changes', async () => {
    const dom = load(garminPage(), 'https://connect.garmin.com/app/activity/777');
    dom.window.USE_DI_SESSION = true;
    dom.window.fetch = async () => ({ ok: false, status: 404 });

    const capture = await dom.window.BPBProviderPage.capture();
    assert.equal(capture.ok, false);
    assert.equal(capture.code, 'provider-export-failed');
    assert.match(capture.message, /Garmin GPX export failed with HTTP 404/);
    assert.doesNotMatch(capture.message, /ownership/i);
});
