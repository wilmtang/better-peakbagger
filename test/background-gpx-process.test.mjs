// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The local-file GPX processing pipeline in the background worker
// (GPX_PROCESS_START / GPX_PROCESS_APPLY): capture-shaped jobs, fail-closed
// gates, current-tab draft delivery, and — at the end — a full jsdom
// end-to-end pass wiring the real ascentedit fixture page (built content
// bundle) to the real built worker.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { loadPage, waitFor, fireTrustedEvent, PAGE_FIXTURES } from './helpers/load-page.mjs';

const workerBundle = await fs.readFile(new URL('../dist/background.js', import.meta.url), 'utf8');

const PAGE_URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77';
const SENDER = { tab: { id: 5, windowId: 9 }, url: PAGE_URL };

const SEGMENTS = [[
    { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0), invalidTime: false },
    { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0), invalidTime: false },
    { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0), invalidTime: false }
]];

const createHarness = ({ peakXml = null, settings = {}, failPeakFetch = false,
    loginHtml = '<a href="climber/climber.aspx?cid=77">My Home Page</a>' } = {}) => {
    const values = {};
    const syncValues = { bpbSettings: structuredClone(settings) };
    const tabs = new Map([[5, { id: 5, windowId: 9, url: PAGE_URL, active: true }]]);
    let nextTabId = 100;
    const tabMessages = [];
    const fetchCalls = [];
    const grouped = [];
    const groupUpdates = [];
    const navigations = [];

    const browser = {
        storage: {
            session: {
                get: async key => ({ [key]: structuredClone(values[key]) }),
                set: async patch => Object.assign(values, structuredClone(patch))
            },
            sync: {
                get: async key => ({ [key]: structuredClone(syncValues[key]) }),
                set: async patch => Object.assign(syncValues, structuredClone(patch))
            }
        },
        runtime: { onMessage: { listeners: [], addListener(listener) { this.listeners.push(listener); } } },
        scripting: { executeScript: async () => [] },
        action: {
            setBadgeBackgroundColor: async () => {},
            setBadgeText: async () => {}
        },
        tabs: {
            get: async tabId => structuredClone(tabs.get(tabId)),
            create: async details => {
                const tab = { id: nextTabId++, windowId: details.windowId, url: details.url, active: details.active };
                tabs.set(tab.id, tab);
                return structuredClone(tab);
            },
            update: async (tabId, patch) => {
                if (patch.url) {
                    // Pin the invariant that a draft is registered before its
                    // tab's URL ever changes.
                    navigations.push({
                        tabId,
                        url: patch.url,
                        draftRegistered: !!(values.bpbDraftTabs || {})[String(tabId)]
                    });
                }
                Object.assign(tabs.get(tabId), patch);
                return structuredClone(tabs.get(tabId));
            },
            sendMessage: async (tabId, message) => { tabMessages.push({ tabId, message: structuredClone(message) }); return true; },
            onRemoved: { addListener: () => {} }
        },
        tabGroups: { update: async (groupId, patch) => groupUpdates.push([groupId, structuredClone(patch)]) },
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
    };

    const fetch = async url => {
        const value = String(url);
        fetchCalls.push(value);
        if (value.includes('/Default.aspx')) return { ok: true, text: async () => loginHtml };
        if (value.includes('/Async/pllbb2.aspx')) {
            if (failPeakFetch) throw new Error('network unreachable');
            return {
                ok: true,
                text: async () => peakXml || '<p><t i="7" n="Test Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
            };
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };

    browser.tabs.group = async details => { grouped.push(structuredClone(details)); return 3; };

    const context = vm.createContext({ browser, fetch, URL, URLSearchParams, Math, Date, console, structuredClone });
    context.globalThis = context;
    context.self = context;
    vm.runInContext(workerBundle, context, { filename: 'dist/background.js' });
    const listener = browser.runtime.onMessage.listeners[0];
    const send = (message, sender = SENDER) => new Promise(resolve => {
        assert.equal(listener(message, sender, resolve), true);
    });
    return { send, values, tabs, tabMessages, fetchCalls, grouped, groupUpdates, navigations };
};

test('a processed upload produces a capture-shaped job and delivers the current-tab draft', async () => {
    const harness = createHarness();
    const ready = await harness.send({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [],
        trackName: 'Test hike',
        utcOffsetMinutes: 0
    });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.boundPid, 7);
    assert.equal(ready.matches.length, 1);
    assert.equal(ready.matches[0].id, 7);
    assert.equal(ready.matches[0].classification, 'strong');
    assert.equal(ready.matches[0].selected, true);
    assert.equal(ready.matches[0].date, '2026-07-01');
    assert.equal(ready.uploadGpx, undefined, 'the GPX must not ride along in the response');
    assert.equal(ready.matches[0].draftFields, undefined, 'derived field payloads stay in the worker');

    const job = harness.values.bpbCaptureJobs['5'];
    assert.equal(job.provider, 'upload');
    assert.equal(job.boundPid, 7);
    assert.equal(job.cid, '77');
    assert.match(job.uploadGpx, /<trkpt lat="0" lon="-0.001"><ele>100<\/ele><time>2026-07-01T15:00:00Z<\/time><\/trkpt>/);
    assert.ok(job.expiresAt > Date.now(), 'the job carries the 30-minute TTL');
    assert.ok(Array.isArray(job.dayStats));

    // The popup's status view never surfaces a local-file job.
    assert.equal(await harness.send({ type: 'CAPTURE_STATUS', tabId: 5 }), null);

    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7], primaryId: 7
    });
    assert.deepEqual(JSON.parse(JSON.stringify(applied)), { ok: true, tabIds: [5], groupWarning: null });
    const draft = harness.values.bpbDraftTabs['5'];
    assert.equal(draft.pid, 7);
    assert.equal(draft.cid, '77');
    assert.equal(draft.previewOrder, 0);
    assert.equal(draft.suffix, '', 'a singleton date keeps the suffix blank');
    assert.deepEqual(harness.tabMessages, [{ tabId: 5, message: { type: 'DRAFT_PROCEED' } }]);
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'opened');

    // The existing draft handshake takes over: apply → preview-once → banner.
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
    assert.equal(apply.action, 'apply');
    assert.equal(apply.preserveExistingFields, true);
    assert.match(apply.gpx, /<gpx/);
    assert.equal(apply.fields.date, '2026-07-01');
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77
    }).then(value => value.ok), true);
    const banner = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    });
    assert.equal(banner.action, 'banner');
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'previewed');
    assert.equal(harness.values.bpbCaptureJobs['5'].uploadGpx, null);
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77
    }).then(value => value.ok), false, 'Preview fires exactly once per draft');
});

test('processing fails closed when Peakbagger is signed out or the account differs', async () => {
    const signedOut = createHarness({ loginHtml: '<a href="/climber/login.aspx">Log In</a>' });
    const rejected = await signedOut.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.equal(rejected.phase, 'error');
    assert.equal(rejected.error.code, 'peakbagger-signed-out');
    assert.equal(signedOut.values.bpbCaptureJobs, undefined, 'nothing is prepared for a signed-out user');

    const otherAccount = createHarness();
    const mismatch = await otherAccount.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    }, { tab: { id: 5, windowId: 9 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=999' });
    assert.equal(mismatch.phase, 'error');
    assert.equal(mismatch.error.code, 'identity-mismatch');
});

test('non-ascent-form senders are refused outright', async () => {
    const harness = createHarness();
    for (const url of [
        'https://connect.garmin.com/modern/activity/1',
        'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        'https://evil.example/climber/ascentedit.aspx'
    ]) {
        const result = await harness.send({
            type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
        }, { tab: { id: 5 }, url });
        assert.equal(result.phase, 'error');
        assert.equal(result.error.code, 'forbidden');
    }
    assert.equal(harness.fetchCalls.length, 0, 'a refused sender must trigger no network traffic');
});

test('a partial corridor lookup fails closed as an error, never as "no peaks"', async () => {
    const harness = createHarness({ failPeakFetch: true });
    const result = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.equal(result.phase, 'error');
    assert.match(result.error.message, /summit lookup failed/i);
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'error');
    assert.equal(harness.values.bpbCaptureJobs['5'].uploadGpx, undefined);
});

test('a corridor with no detectable summit reports no-matches honestly', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="8" n="Far Peak" a="0.02" o="0.02" e="426.51" r="100" l="Test Range"/></p>'
    });
    const result = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.equal(result.phase, 'no-matches');
    assert.equal(harness.values.bpbCaptureJobs['5'].uploadGpx, null);
});

test('re-processing supersedes the tab’s job; an apply against the old job is rejected', async () => {
    const harness = createHarness();
    const first = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    const second = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.notEqual(second.jobId, first.jobId);
    assert.equal(harness.values.bpbCaptureJobs['5'].id, second.jobId);

    const stale = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: first.jobId, selectedIds: [7], primaryId: 7
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'job-expired');

    harness.values.bpbCaptureJobs['5'].expiresAt = Date.now() - 1;
    const expired = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: second.jobId, selectedIds: [7], primaryId: 7
    });
    assert.equal(expired.ok, false, 'the 30-minute freshness gate rejects an expired job');
});

test('capture privacy settings govern the upload flow identically', async () => {
    const harness = createHarness({ settings: { retainWaypoints: false, fillTripInfo: false } });
    const ready = await harness.send({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        // Even if a compromised page script sent waypoints, the worker's own
        // preference gate drops them again.
        waypoints: [{ lat: 0.01, lon: 0.02, name: 'Camp' }],
        trackName: 'Should not appear',
        utcOffsetMinutes: 0
    });
    assert.equal(ready.phase, 'ready');
    const job = harness.values.bpbCaptureJobs['5'];
    assert.doesNotMatch(job.uploadGpx, /<wpt/);
    assert.equal(job.tripName, '');
    assert.doesNotMatch(JSON.stringify(job), /Should not appear|Camp/);
});

test('a timeless GPX keeps a blank derived date and zero durations', async () => {
    const harness = createHarness();
    const ready = await harness.send({
        type: 'GPX_PROCESS_START',
        segments: [SEGMENTS[0].map(point => ({ ...point, time: null }))],
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: -420
    });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.matches[0].date, '', 'no invented date — the page keeps its autofilled today');
    const job = harness.values.bpbCaptureJobs['5'];
    assert.deepEqual({ ...job.matches[0].draftFields.upDuration }, { days: 0, hours: 0, minutes: 0 });
    assert.doesNotMatch(job.uploadGpx, /<time>/);
});

test('a multi-summit selection fills the current tab and opens grouped sibling drafts with suffix and trip parity', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0.0005" e="426.51" r="100" l="Test Range"/></p>'
    });
    const ready = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: 'Grand Traverse', utcOffsetMinutes: 0
    });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.matches.length, 2);
    assert.equal(harness.values.bpbCaptureJobs['5'].tripName, 'Grand Traverse');

    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    });
    assert.equal(applied.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(applied.tabIds)), [5, 100]);

    const current = harness.values.bpbDraftTabs['5'];
    const sibling = harness.values.bpbDraftTabs['100'];
    assert.equal(current.pid, 7);
    assert.equal(current.previewOrder, 0, 'the current tab previews first');
    assert.equal(sibling.pid, 8);
    assert.equal(sibling.previewOrder, 1);
    // Peak 7 sits earlier along the track than peak 8, and both share the
    // ascent date, so track order assigns the alphabetical suffixes.
    assert.equal(current.suffix, 'a');
    assert.equal(sibling.suffix, 'b');
    assert.deepEqual(JSON.parse(JSON.stringify(current.tripInfo)), { sequence: 1, name: 'Grand Traverse', nightsOut: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(sibling.tripInfo)), { sequence: 2, name: 'Grand Traverse', nightsOut: 0 });

    assert.deepEqual(JSON.parse(JSON.stringify(harness.grouped)), [{ tabIds: [100], createProperties: { windowId: 9 } }]);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.groupUpdates)), [[3, { title: 'Peak Drafts', color: 'green', collapsed: false }]]);
    const siblingNavigation = harness.navigations.find(entry => entry.tabId === 100);
    assert.equal(siblingNavigation.url, 'https://peakbagger.com/climber/ascentedit.aspx?pid=8&cid=77');
    assert.equal(siblingNavigation.draftRegistered, true, 'the sibling draft exists before its tab navigates');
    assert.deepEqual(harness.tabMessages, [{ tabId: 5, message: { type: 'DRAFT_PROCEED' } }]);

    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
    assert.equal(apply.action, 'apply');
    assert.equal(apply.fields.suffix, 'a');
    const waiting = await harness.send({ type: 'DRAFT_READY', pid: '8', cid: '77' }, { tab: { id: 100 }, url: 'https://peakbagger.com/climber/ascentedit.aspx?pid=8&cid=77' });
    assert.equal(waiting.action, 'wait', 'the sibling waits for the current tab’s Preview');
});

test('an unbound page registers its draft first and then navigates to the chosen peak', async () => {
    const harness = createHarness();
    const unboundSender = { tab: { id: 5, windowId: 9 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx' };
    const ready = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    }, unboundSender);
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.boundPid, null);

    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7], primaryId: 7
    }, unboundSender);
    assert.equal(applied.ok, true);
    const navigation = harness.navigations.find(entry => entry.tabId === 5);
    assert.equal(navigation.url, 'https://peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');
    assert.equal(navigation.draftRegistered, true, 'registration precedes the URL change');
    assert.equal(harness.tabMessages.length, 0, 'the reloaded page runs its own ready handshake');

    // The reloaded page (now bound) delivers through the standard handshake.
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
    assert.equal(apply.action, 'apply');
});

test('a bound peak the track only brushes surfaces as an explicit closest-approach fallback', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="Bound Peak" a="0.002" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="On Track Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
    });
    const ready = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.equal(ready.phase, 'ready');
    assert.deepEqual(JSON.parse(JSON.stringify(ready.matches.map(match => match.id))), [8],
        'detection stays fail-closed: the off-track bound peak is not a silent match');
    assert.equal(ready.boundFallback.id, 7);
    assert.ok(ready.boundFallback.closestApproachM > 150 && ready.boundFallback.closestApproachM < 300,
        `closest approach should be ~222 m, got ${ready.boundFallback.closestApproachM}`);
    assert.equal(ready.boundFallback.selected, false);

    // "Use ⟨peak⟩ anyway" fills the current page from the closest-approach
    // point and still opens the detected summit as a sibling draft.
    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    });
    assert.equal(applied.ok, true);
    assert.equal(harness.values.bpbDraftTabs['5'].pid, 7);
    assert.equal(harness.values.bpbDraftTabs['100'].pid, 8);
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
    assert.equal(apply.action, 'apply');
    assert.ok(Number.isFinite(apply.fields.upDistanceM));
});

test('a bound page can only ever fill itself for its own peak', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0.0005" e="426.51" r="100" l="Test Range"/></p>'
    });
    const ready = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    const rejected = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 8
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'identity-mismatch');
    assert.equal(harness.values.bpbDraftTabs, undefined, 'nothing may be registered on a refused apply');

    // Without a primary, the same selection opens sibling drafts only and the
    // current page keeps its native path.
    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [8], primaryId: null
    });
    assert.equal(applied.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(applied.tabIds)), [100]);
    assert.equal(harness.values.bpbDraftTabs['5'], undefined);
    assert.equal(harness.values.bpbDraftTabs['100'].pid, 8);
    assert.equal(harness.values.bpbDraftTabs['100'].focusOnReady, true,
        'with no primary, the first sibling draft takes focus when ready');
});

// ---- End to end: real fixture page + built content bundle + built worker ----

// The sink carries worker→page delivery outside the harness's tab objects,
// which must stay structuredClone-able for the worker's tabs.get stub.
const wireWorkerToPage = (harness, sink) => dom => {
    dom.window.tzlookup = () => 'UTC';
    const pageListeners = [];
    dom.chrome.runtime.sendMessage = message =>
        harness.send(structuredClone(message), { tab: { id: 5, windowId: 9 }, url: dom.window.location.href });
    dom.chrome.runtime.onMessage = { addListener: listener => pageListeners.push(listener) };
    sink.deliver = (tabId, message) => {
        if (tabId === 5) pageListeners.forEach(listener => listener(message));
    };
    class DataTransferMock {
        constructor() {
            this.files = [];
            this.items = { add: file => this.files.push(file) };
        }
    }
    dom.window.DataTransfer = DataTransferMock;
    const upload = dom.window.document.getElementById('GPXUpload');
    Object.defineProperty(upload, 'files', { value: [], configurable: true, writable: true });
};

test('end to end: user file pick → Process → filled form → exactly one GPS Preview', async () => {
    const harness = createHarness();
    // Route worker→tab messages to the page's runtime listeners.
    const sink = {};
    const dom = await loadPage('climber-ascentedit.html', {
        url: PAGE_URL,
        bundles: ['vendor/marked.umd.js', 'content/ascent-editor.js'],
        fixtures: PAGE_FIXTURES,
        prepare: wireWorkerToPage(harness, sink)
    });
    // Deliver DRAFT_PROCEED (recorded by the harness) into the page.
    const pump = () => {
        while (harness.tabMessages.length) {
            const { tabId, message } = harness.tabMessages.shift();
            sink.deliver?.(tabId, message);
        }
    };
    const pumpTimer = setInterval(pump, 5);

    let previewClicks = 0;
    const preview = dom.window.document.getElementById('GPXPreview');
    preview.addEventListener('click', event => {
        previewClicks++;
        event.preventDefault();
    });

    const gpx = `<?xml version="1.0"?><gpx creator="SourceApp" xmlns="http://www.topografix.com/GPX/1/1"
      xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
      <trk><name>Secret name</name><trkseg>
        <trkpt lat="0" lon="-0.001"><ele>100</ele><time>2026-07-01T15:00:00Z</time>
          <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>171</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
        <trkpt lat="0" lon="0"><ele>130</ele><time>2026-07-01T16:00:00Z</time></trkpt>
        <trkpt lat="0" lon="0.001"><ele>100</ele><time>2026-07-01T17:00:00Z</time></trkpt>
      </trkseg></trk></gpx>`;
    const input = dom.window.document.getElementById('GPXUpload');
    input.files = [new dom.window.File([gpx], 'myclimb.gpx', { type: 'application/gpx+xml' })];
    fireTrustedEvent(input, 'change', { bubbles: true });

    const button = dom.window.document.querySelector('.bpb-process-button');
    assert.ok(button, 'the Process button replaces native Preview');
    button.click();

    await waitFor(dom, () => previewClicks === 1);
    clearInterval(pumpTimer);

    assert.equal(dom.window.document.getElementById('DateText').value, '2026-07-01');
    assert.equal(dom.window.document.getElementById('StartM').value, '100');
    assert.equal(dom.window.document.getElementById('EndM').value, '100');

    const uploaded = input.files[0];
    assert.equal(uploaded.name, 'track.gpx', 'the upload field holds the newly serialized copy');
    const uploadedText = await uploaded.text();
    assert.match(uploadedText, /creator="Better Peakbagger"/);
    assert.doesNotMatch(uploadedText, /SourceApp|extensions|hr>|Secret name/,
        'the cleaned serialization carries nothing from the source XML');

    assert.equal(previewClicks, 1);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /confidence/);

    // Simulated post-Preview reload: the second DRAFT_READY yields the banner,
    // never a second Preview.
    const afterReload = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    });
    assert.equal(afterReload.action, 'banner');
    assert.equal(previewClicks, 1);
});
