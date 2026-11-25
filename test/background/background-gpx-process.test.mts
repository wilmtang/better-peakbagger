// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The local-file GPX processing pipeline in the background worker
// (GPX_PROCESS_START / GPX_PROCESS_APPLY): capture-shaped jobs, fail-closed
// gates and current-tab draft delivery. The end-to-end page pass lives in
// background-gpx-process.browser.mts.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { MAX_GPX_TRACK_POINTS } from '../../src/capture/capture-resource-limits.ts';
import {
    createHarness as createWorkerHarness, SEGMENTS, uploadSelection, storedCaptureGpx,
    type DraftTab, type WorkerGlobals,
} from '../helpers/gpx-process-harness.mts';

const workerBundle = await fs.readFile(new URL('../../dist/background.js', import.meta.url), 'utf8');

// The worker runs with only the globals a service worker has, so a route
// that reaches for document, DOMParser or storage APIs fails here.
const runWorker = (globals: WorkerGlobals) => {
    const context = vm.createContext({
        ...globals, URL, URLSearchParams, Math, Date, console, structuredClone, btoa,
        AbortController, TextEncoder, TextDecoder, clearTimeout,
    });
    context.globalThis = context;
    context.self = context;
    vm.runInContext(workerBundle, context, { filename: 'dist/background.js' });
};
const createHarness = (options: Omit<Parameters<typeof createWorkerHarness>[0], 'runWorker'> = {}) =>
    createWorkerHarness({ ...options, runWorker });

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
    assert.equal(harness.workerFetchCalls.length, 0,
        'login and summit reads must stay in the authenticated Peakbagger page');
    assert.equal(harness.fetchCalls.filter(url => url.includes('/Default.aspx')).length, 1);
    assert.equal(harness.fetchCalls.filter(url => url.includes('/Async/pllbb2.aspx')).length, 1);

    const job = harness.values.bpbCaptureJobs['5'];
    assert.equal(job.provider, 'upload');
    assert.equal(job.boundPid, 7);
    assert.equal(job.cid, '77');
    assert.equal(job.uploadGpx, undefined, 'job metadata must not embed the immutable GPX');
    assert.match(storedCaptureGpx(harness) ?? '', /<trkpt lat="0" lon="-0.001"><ele>100<\/ele><time>2026-07-01T15:00:00Z<\/time><\/trkpt>/);
    assert.ok(job.expiresAt > Date.now(), 'the job carries the 30-minute TTL');
    assert.ok(Array.isArray(job.dayStats));

    // The popup's status view never surfaces a local-file job.
    assert.equal(await harness.send({ type: 'CAPTURE_STATUS', tabId: 5 }, {
        url: 'chrome-extension://test-extension/popup/popup.html',
    }), null);

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
    assert.equal(apply.peakName, 'Test Peak');
    assert.equal(apply.preserveExistingFields, true);
    assert.match(apply.gpx, /<gpx/);
    assert.equal(apply.fields.date, '2026-07-01');
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77,
        applyLeaseToken: apply.applyLeaseToken,
    }).then(value => value.ok), true);
    const banner = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    });
    assert.equal(banner.action, 'banner');
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'previewed');
    assert.equal(harness.values.bpbCaptureJobs['5'].payloadKey, undefined);
    assert.equal(storedCaptureGpx(harness), undefined);
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77,
        applyLeaseToken: apply.applyLeaseToken,
    }).then(value => value.ok), false, 'Preview fires exactly once per draft');
});

test('processing fails closed when Peakbagger is signed out or the account differs', async () => {
    const signedOut = createHarness({ loginHtml: '<a href="/climber/login.aspx">Log In</a>' });
    const rejected = await signedOut.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.equal(rejected.phase, 'error');
    assert.equal(rejected.error.code, 'peakbagger-signed-out');
    assert.equal(signedOut.values.bpbCaptureJobs['5'].phase, 'selection',
        'only the non-processable selection sentinel remains for a signed-out user');
    assert.equal(signedOut.values.bpbCaptureJobs['5'].uploadGpx, undefined);

    const otherAccount = createHarness();
    const mismatch = await otherAccount.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    }, { tab: { id: 5, windowId: 9 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=999' });
    assert.equal(mismatch.phase, 'error');
    assert.equal(mismatch.error.code, 'identity-mismatch');
});

test('a page-transport login failure retains the local-file selection identity', async () => {
    const harness = createHarness({ loginFailure: 'cloudflare' });

    const rejected = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });

    assert.equal(rejected.phase, 'error');
    assert.equal(rejected.error.code, 'cloudflare');
    assert.deepEqual({
        pageSessionId: rejected.pageSessionId,
        selectionGeneration: rejected.selectionGeneration,
        selectionNonce: rejected.selectionNonce,
    }, {
        pageSessionId: 'test-page-session',
        selectionGeneration: 1,
        selectionNonce: 'selection-1-nonce',
    }, 'the page must be able to accept and render a failed preflight reply');
    assert.equal(harness.workerFetchCalls.length, 0);
    assert.equal(harness.fetchCalls.filter(url => url.includes('/Default.aspx')).length, 1);
    assert.equal(harness.fetchCalls.some(url => url.includes('/Async/pllbb2.aspx')), false);
});

test('the worker independently rejects a local upload when capture settings are unavailable', async () => {
    const harness = createHarness({ syncGetError: 'SYNC_WORKER_SETTINGS_SENTINEL' });
    const response = await harness.send({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [{ lat: 0, lon: 0, name: 'Private camp' }],
        trackName: 'Private traverse',
        utcOffsetMinutes: 0,
    });

    assert.equal(harness.syncGetCalls(), 1);
    assert.equal(response.phase, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(response.error)), {
        code: 'settings-unavailable',
        message: 'Reload the extension and try again. Nothing was captured.',
    });
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'selection');
    assert.equal(harness.values.bpbCaptureJobs['5'].uploadGpx, undefined);
    assert.equal(harness.fetchCalls.length, 0, 'the login and summit queries stay behind the settings gate');
    assert.doesNotMatch(JSON.stringify(harness.values), /Private camp|Private traverse/);
});

test('non-ascent-form senders are refused outright', async () => {
    const harness = createHarness();
    for (const url of [
        'https://connect.garmin.com/modern/activity/1',
        'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        'https://www.peakbagger.com/climber/ascentedit.aspx?aid=123',
        'https://www.peakbagger.com/climber/ascentedit.aspx?aid=123&pid=7&cid=77',
        'https://evil.example/climber/ascentedit.aspx'
    ]) {
        const result = await harness.send({
            type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
        }, { tab: { id: 5 }, url });
        assert.equal(result.phase, 'error');
        assert.equal(result.error.code, 'forbidden');
        const applied = await harness.send({ type: 'GPX_PROCESS_APPLY' }, { tab: { id: 5 }, url });
        assert.equal(applied.ok, false);
    }
    assert.equal(harness.fetchCalls.length, 0, 'a refused sender must trigger no network traffic');
});

test('a partial corridor lookup fails closed as an error, never as "no peaks"', async () => {
    const harness = createHarness({ failPeakFetch: true });
    const result = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.equal(result.phase, 'error');
    assert.match(result.error.message, /could not reach Peakbagger for the nearby summit data/i);
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'error');
    assert.equal(harness.values.bpbCaptureJobs['5'].uploadGpx, undefined);
    assert.equal(harness.fetchCalls.filter(url => url.includes('/Async/pllbb2.aspx')).length, 2,
        'one box receives exactly the documented two-attempt budget');
});

test('the worker admits the complete 100,000-point recording at the shared limit', async () => {
    const harness = createHarness({ peakXml: '<p/>' });
    const segments = [Array.from({ length: MAX_GPX_TRACK_POINTS }, (_, index) => ({
        lat: 0,
        lon: -0.001 + index * 0.002 / (MAX_GPX_TRACK_POINTS - 1),
        ele: 100,
        time: Date.UTC(2026, 6, 1, 15) + index * 1000,
    }))];
    const result = await harness.send({
        type: 'GPX_PROCESS_START', segments, waypoints: [], trackName: '', utcOffsetMinutes: 0,
    });
    assert.equal(result.phase, 'no-matches');
    assert.equal(harness.values.bpbCaptureJobs['5'].trackSummary.originalPointCount, MAX_GPX_TRACK_POINTS);
    assert.equal(harness.fetchCalls.filter(url => url.includes('/Async/pllbb2.aspx')).length, 1);
});

test('the worker rejects point and corridor limits before issuing summit requests', async () => {
    const tooManyPoints = createHarness();
    const point = { lat: 0, lon: 0, ele: null, time: null };
    const pointsResult = await tooManyPoints.send({
        type: 'GPX_PROCESS_START',
        segments: [Array(MAX_GPX_TRACK_POINTS + 1).fill(point)],
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
    });
    assert.equal(pointsResult.error.code, 'gpx-too-large');
    assert.match(pointsResult.error.message, /100,000 track points/);
    assert.equal(tooManyPoints.fetchCalls.filter(url => url.includes('/Async/pllbb2.aspx')).length, 0);

    const fragmented = createHarness();
    const longTrack = Array.from({ length: 66 }, (_, index) => ({
        lat: 0,
        lon: index * 0.085,
        ele: 100,
        time: index * 100_000,
    }));
    const corridorResult = await fragmented.send({
        type: 'GPX_PROCESS_START',
        segments: [longTrack],
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
    });
    assert.equal(corridorResult.error.code, 'track-too-large');
    assert.match(corridorResult.error.message, /safe limit is 64/);
    assert.equal(fragmented.fetchCalls.filter(url => url.includes('/Async/pllbb2.aspx')).length, 0);
});

test('re-processing aborts an older local corridor lookup without mutating the replacement', async () => {
    let firstSignal: AbortSignal | undefined;
    let reached!: () => void;
    const firstReached = new Promise<void>(resolve => { reached = resolve; });
    const harness = createHarness({
        beforePeakFetch: ({ number, options }) => {
            if (number !== 1) return undefined;
            firstSignal = options.signal;
            reached();
            return new Promise(() => {});
        },
    });
    const message = {
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0,
    };

    const first = harness.send(message);
    await firstReached;
    const replacement = await harness.send(message);
    const abandoned = await first;

    assert.equal(firstSignal!.aborted, true);
    assert.equal(abandoned.error.code, 'capture-cancelled');
    assert.equal(replacement.phase, 'ready');
    assert.equal(harness.values.bpbCaptureJobs['5'].id, replacement.jobId);
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'ready');
});

test('selection invalidation supersedes a start still waiting for capture settings', async () => {
    let releaseSettings: (() => void) | undefined;
    let reachedSettings!: () => void;
    const settingsReached = new Promise<void>(resolve => { reachedSettings = resolve; });
    const harness = createHarness({
        beforeSyncGet: calls => {
            if (calls !== 1) return undefined;
            reachedSettings();
            return new Promise<void>(resolve => { releaseSettings = resolve; });
        },
    });
    const firstSelection = uploadSelection(1);
    const secondSelection = uploadSelection(2);
    assert.equal((await harness.rawSend({
        type: 'GPX_PROCESS_INVALIDATE', ...firstSelection,
    })).ok, true);
    const first = harness.rawSend({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
        ...firstSelection,
    });
    await settingsReached;
    assert.equal((await harness.rawSend({
        type: 'GPX_PROCESS_INVALIDATE', ...secondSelection,
    })).ok, true);
    releaseSettings!();

    const abandoned = await first;
    assert.equal(abandoned.error.code, 'superseded');
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'selection');
    assert.equal(harness.values.bpbCaptureJobs['5'].selectionNonce, secondSelection.selectionNonce);
    assert.equal(harness.fetchCalls.some(url => url.includes('/Async/pllbb2.aspx')), false);
});

test('selection invalidation aborts an A corridor lookup without requiring B processing', async () => {
    let firstSignal: AbortSignal | undefined;
    let reached!: () => void;
    const firstReached = new Promise<void>(resolve => { reached = resolve; });
    const harness = createHarness({
        beforePeakFetch: ({ options }) => {
            firstSignal = options.signal;
            reached();
            return new Promise(() => {});
        },
    });
    const firstSelection = uploadSelection(1);
    await harness.rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...firstSelection });
    const first = harness.rawSend({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
        ...firstSelection,
    });
    await firstReached;
    await harness.rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...uploadSelection(2) });
    const abandoned = await first;

    assert.equal(firstSignal!.aborted, true);
    assert.equal(abandoned.error.code, 'capture-cancelled');
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'selection');
    assert.equal(harness.values.bpbCaptureJobs['5'].selectionNonce,
        uploadSelection(2).selectionNonce);
});

test('selection generations reject late invalidation without disturbing the newer sentinel', async () => {
    const harness = createHarness();
    const newer = uploadSelection(2);
    assert.equal((await harness.rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...newer })).ok, true);

    const stale = await harness.rawSend({
        type: 'GPX_PROCESS_INVALIDATE',
        ...uploadSelection(1),
    });

    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'superseded');
    assert.equal(harness.values.bpbCaptureJobs['5'].selectionGeneration, 2);
    assert.equal(harness.values.bpbCaptureJobs['5'].selectionNonce, newer.selectionNonce);
});

test('a worker restart retains the current local-file selection binding', async () => {
    const selection = uploadSelection(1);
    const firstWorker = createHarness();
    await firstWorker.rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...selection });

    const restarted = createHarness({ sessionInitial: firstWorker.values });
    const result = await restarted.rawSend({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
        ...selection,
    });

    assert.equal(result.phase, 'ready');
    assert.equal(restarted.values.bpbCaptureJobs['5'].selectionNonce, selection.selectionNonce);
});

test('legacy local-file metadata is discarded before the selection reaches session storage', async () => {
    const harness = createHarness();
    const result = await harness.rawSend({
        type: 'GPX_PROCESS_INVALIDATE',
        ...uploadSelection(1),
        fileIdentity: {
            name: 'private-worker-sentinel.gpx',
            type: 'application/x-private-worker-sentinel',
            size: 1_234_567,
            lastModified: 1_977_609_599_123,
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result).sort(),
        ['ok', 'pageSessionId', 'selectionGeneration', 'selectionNonce']);
    assert.doesNotMatch(JSON.stringify(harness.values),
        /private-worker-sentinel|1234567|1977609599123/);
});

test('B selection invalidates A ready and apply generations before any draft opens', async () => {
    const harness = createHarness();
    const firstSelection = uploadSelection(1);
    await harness.rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...firstSelection });
    const ready = await harness.rawSend({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
        ...firstSelection,
    });
    assert.equal(ready.phase, 'ready');
    const firstPayloadKey = harness.values.bpbCaptureJobs['5'].payloadKey;
    await harness.rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...uploadSelection(2) });
    assert.equal(harness.values[firstPayloadKey], undefined,
        'the new file selection must remove the superseded GPX generation');

    const stale = await harness.rawSend({
        type: 'GPX_PROCESS_APPLY',
        jobId: ready.jobId,
        selectedIds: [7],
        primaryId: 7,
        ...firstSelection,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'job-expired');
    assert.equal(harness.values.bpbDraftTabs, undefined);
});

test('the one total corridor deadline aborts a stalled body and reports actionable timeout copy', async () => {
    let signal: AbortSignal | undefined;
    let expire!: () => void;
    const harness = createHarness({
        setTimeoutImpl: (callback, delay, ...args) => {
            if (delay === 60_000) {
                expire = () => callback(...args);
                return null;
            }
            return setTimeout(callback, delay, ...args);
        },
        beforePeakFetch: ({ options }) => {
            signal = options.signal;
            expire();
            return new Promise(() => {});
        },
    });

    const result = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0,
    });

    assert.equal(result.phase, 'error');
    assert.equal(result.error.code, 'capture-timeout');
    assert.match(result.error.message, /shorter or less fragmented GPX/);
    assert.equal(signal!.aborted, true);
    assert.equal(harness.fetchCalls.filter(url => url.includes('/Async/pllbb2.aspx')).length, 1,
        'the total deadline aborts before a retry can begin');
});

test('a corridor with no detectable summit reports no-matches honestly', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="8" n="Far Peak" a="0.02" o="0.02" e="426.51" r="100" l="Test Range"/></p>'
    });
    const result = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    assert.equal(result.phase, 'no-matches');
    assert.equal(harness.values.bpbCaptureJobs['5'].payloadKey, undefined);
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
    assert.doesNotMatch(storedCaptureGpx(harness) ?? '', /<wpt/);
    assert.equal(job.tripName, '');
    assert.doesNotMatch(JSON.stringify(job), /Should not appear|Camp/);
});

test('a timeless GPX keeps a blank derived date and unavailable durations', async () => {
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
    assert.equal(job.matches[0].draftFields.upDuration, null);
    assert.equal(job.matches[0].draftFields.downDuration, null);
    assert.doesNotMatch(storedCaptureGpx(harness) ?? '', /<time>/);
});

test('the worker rejects an out-of-range local-upload timezone offset', async () => {
    const harness = createHarness();
    const ready = await harness.send({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 4020,
    });

    assert.equal(ready.phase, 'ready');
    assert.equal(ready.matches[0].date, '2026-07-01');
    assert.equal(ready.matches[0].time, '16:00',
        'invalid page metadata must not shift the encounter by multiple days');
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
    assert.equal(harness.values.bpbCaptureJobs['5'].tripName, '2026-07-01');

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
    assert.deepEqual(JSON.parse(JSON.stringify(current.tripInfo)), { sequence: 1, name: '2026-07-01', nightsOut: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(sibling.tripInfo)), { sequence: 2, name: '2026-07-01', nightsOut: 0 });

    assert.deepEqual(JSON.parse(JSON.stringify(harness.grouped)), [{ tabIds: [100], createProperties: { windowId: 9 } }]);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.groupUpdates)), [[3, { title: 'Peak Drafts', color: 'green', collapsed: false }]]);
    const siblingNavigation = harness.navigations.find(entry => entry.tabId === 100);
    assert.equal(siblingNavigation!.url, 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=8&cid=77');
    assert.equal(siblingNavigation!.draftRegistered, true, 'the sibling draft exists before its tab navigates');
    assert.deepEqual(harness.tabMessages, [{ tabId: 5, message: { type: 'DRAFT_PROCEED' } }]);

    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
    assert.equal(apply.action, 'apply');
    assert.equal(apply.fields.suffix, 'a');
    const waiting = await harness.send({ type: 'DRAFT_READY', pid: '8', cid: '77' }, { tab: { id: 100 }, url: 'https://peakbagger.com/climber/ascentedit.aspx?pid=8&cid=77' });
    assert.equal(waiting.action, 'wait', 'the sibling waits for the current tab’s Preview');
    await harness.send({ type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77, applyLeaseToken: apply.applyLeaseToken });
    await harness.send({ type: 'DRAFT_READY', pid: 7, cid: 77, previewResult: { state: 'success', message: 'GPX uploaded.' } });
    const repair = await harness.rawSend({ type: 'GPX_PROCESS_INVALIDATE', pageSessionId: 'repair-page-session', selectionGeneration: 2, selectionNonce: 'repair-selection-nonce' });
    assert.equal(repair.preserved, true);
    assert.equal(harness.values.bpbCaptureJobs['5'].id, ready.jobId);
    assert.equal(storedCaptureGpx(harness), apply.gpx);
    assert.equal(harness.values.bpbDraftTabs['100'].jobId, ready.jobId);
});

test('a failed sibling open restores the exact current-tab draft and upload job before retry', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/>'
            + '<t i="8" n="Second Peak" a="0" o="0.0005" e="426.51" r="100" l="Test Range"/></p>',
        faults: { openedJobSet: 'LOCAL_OPENED_JOB_SENTINEL' },
    });
    const ready = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    });
    const previousDraft = {
        tabId: 5,
        jobId: 'previous-job',
        sourceTabId: 5,
        pid: 7,
        cid: 77,
        complete: false,
        expiresAt: Date.now() + 60_000,
    };
    // An older draft record, written in its own shape.
    harness.values.bpbDraftTabs = { 5: structuredClone(previousDraft) as unknown as DraftTab };
    const priorJob = structuredClone(harness.values.bpbCaptureJobs['5']);

    const failed = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    });

    assert.deepEqual(JSON.parse(JSON.stringify(failed)), {
        ok: false,
        error: {
            code: 'draft-open-failed',
            message: 'The prepared drafts could not be opened. Try again.',
        },
    });
    assert.deepEqual(harness.values.bpbDraftTabs, { 5: previousDraft },
        'the current-tab record overwritten by this attempt must be restored exactly');
    assert.deepEqual(harness.values.bpbCaptureJobs['5'], priorJob);
    assert.deepEqual([...harness.tabs.keys()], [5], 'the sibling staging tab must be closed');
    assert.deepEqual(harness.tabMessages, [], 'the current form must not proceed after rollback');

    const retried = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    });
    assert.equal(retried.ok, true);
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'opened');
    assert.equal(harness.values.bpbDraftTabs['5'].jobId, ready.jobId);
    assert.equal(harness.values.bpbDraftTabs['101'].pid, 8);
});

test('a failed unbound current-tab navigation rolls back the sibling and restores prior state', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/>'
            + '<t i="8" n="Second Peak" a="0" o="0.0005" e="426.51" r="100" l="Test Range"/></p>',
        faults: { tabNavigateAt: 2 },
    });
    const unboundUrl = 'https://www.peakbagger.com/climber/ascentedit.aspx';
    const unboundSender = { tab: { id: 5, windowId: 9 }, url: unboundUrl };
    harness.tabs.get(5)!.url = unboundUrl;
    const ready = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '', utcOffsetMinutes: 0
    }, unboundSender);
    const previousDraft = {
        tabId: 5,
        jobId: 'previous-job',
        sourceTabId: 5,
        pid: 99,
        cid: 77,
        complete: false,
        expiresAt: Date.now() + 60_000,
    };
    // An older draft record, written in its own shape.
    harness.values.bpbDraftTabs = { 5: structuredClone(previousDraft) as unknown as DraftTab };
    const priorJob = structuredClone(harness.values.bpbCaptureJobs['5']);

    const failed = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    }, unboundSender);

    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'draft-open-failed');
    assert.deepEqual(harness.values.bpbDraftTabs, { 5: previousDraft });
    assert.deepEqual(harness.values.bpbCaptureJobs['5'], priorJob);
    assert.deepEqual([...harness.tabs.keys()], [5]);
    assert.equal(harness.tabs.get(5)!.url, unboundUrl);

    const retried = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    }, unboundSender);
    assert.equal(retried.ok, true);
    assert.equal(harness.tabs.get(5)!.url,
        'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');
    assert.equal(harness.values.bpbDraftTabs['101'].pid, 8);
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
    assert.equal(navigation!.url, 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');
    assert.equal(navigation!.draftRegistered, true, 'registration precedes the URL change');
    assert.equal(harness.tabMessages.length, 0, 'the reloaded page runs its own ready handshake');

    // The reloaded page (now bound) delivers through the standard handshake.
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
    assert.equal(apply.action, 'apply');
});

test('unbound draft navigation preserves the committed upload through old-page teardown', async () => {
    const harness = createHarness();
    const unboundSender = { tab: { id: 5, windowId: 9 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx' };
    const selection = uploadSelection(1);
    await harness.rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...selection }, unboundSender);
    const ready = await harness.rawSend({
        type: 'GPX_PROCESS_START',
        segments: SEGMENTS,
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
        ...selection,
    }, unboundSender);
    const payloadKey = harness.values.bpbCaptureJobs['5'].payloadKey;

    const applied = await harness.rawSend({
        type: 'GPX_PROCESS_APPLY',
        jobId: ready.jobId,
        selectedIds: [7],
        primaryId: 7,
        ...selection,
    }, unboundSender);
    assert.equal(applied.ok, true);

    const teardown = await harness.rawSend({
        type: 'GPX_PROCESS_INVALIDATE',
        ...uploadSelection(2),
        reason: 'page-lifecycle',
    }, unboundSender);
    assert.equal(teardown.preserved, true,
        'the old page must transfer ownership instead of deleting its committed draft');
    assert.equal(harness.values.bpbCaptureJobs['5'].id, ready.jobId);
    assert.ok(harness.values[payloadKey], 'the private GPX remains available to the reloaded draft page');

    const apply = await harness.send(
        { type: 'DRAFT_READY', pid: '7', cid: '77' },
        { tab: { id: 5, windowId: 9 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77' },
    );
    assert.equal(apply.action, 'apply');
});

test('a bound peak the track only brushes surfaces as an explicit closest-approach fallback', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="Bound Peak" a="0.002" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="On Track Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
    });
    const ready = await harness.send({
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '  Bound   traverse  ', utcOffsetMinutes: 0
    });
    assert.equal(ready.phase, 'ready');
    assert.deepEqual(JSON.parse(JSON.stringify(ready.matches.map(match => match.id))), [8],
        'detection stays fail-closed: the off-track bound peak is not a silent match');
    assert.equal(ready.boundFallback.id, 7);
    assert.ok(ready.boundFallback.closestApproachM > 150 && ready.boundFallback.closestApproachM < 300,
        `closest approach should be ~222 m, got ${ready.boundFallback.closestApproachM}`);
    assert.equal(ready.boundFallback.selected, false);
    assert.equal(harness.values.bpbCaptureJobs['5'].tripName, '2026-07-01',
        'a selectable fallback must not make the worker discard the trip start date');

    // "Use ⟨peak⟩ anyway" fills the current page from the closest-approach
    // point and still opens the detected summit as a sibling draft.
    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    });
    assert.equal(applied.ok, true);
    assert.equal(harness.values.bpbDraftTabs['5'].pid, 7);
    assert.equal(harness.values.bpbDraftTabs['100'].pid, 8);
    assert.equal(harness.values.bpbDraftTabs['5'].tripInfo.name, '2026-07-01');
    assert.equal(harness.values.bpbDraftTabs['100'].tripInfo.name, '2026-07-01');
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
    assert.equal(harness.values.bpbDraftTabs === undefined, true, 'nothing may be registered on a refused apply');

    // Without a primary, the same selection opens sibling drafts only and the
    // current page keeps its native path.
    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [8], primaryId: null
    });
    assert.equal(applied.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(applied.tabIds)), [100]);
    assert.equal(harness.values.bpbDraftTabs['5'], undefined);
    assert.equal(harness.values.bpbDraftTabs['100']!.pid, 8);
    assert.equal(harness.values.bpbDraftTabs['100']!.focusOnReady, true,
        'with no primary, the first sibling draft takes focus when ready');
    const sibling = await harness.send(
        { type: 'DRAFT_READY', pid: '8', cid: '77' },
        { tab: { id: 100 }, url: 'https://peakbagger.com/climber/ascentedit.aspx?pid=8&cid=77' },
    );
    assert.equal(sibling.action, 'apply');
});

test('local Process removes upload timestamps by default and honors only an explicit per-file exception', async () => {
    for (const includeTimestampsOnce of [false, true, 'true']) {
        const harness = createHarness({ settings: { removeGpxTimestamps: true } });
        const ready = await harness.send({ type: 'GPX_PROCESS_START', segments: SEGMENTS, includeTimestampsOnce });
        assert.equal(ready.phase, 'ready');
        const applied = await harness.send({ type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7], primaryId: 7 });
        assert.equal(applied.ok, true);
        const draft = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
        assert.equal(draft.action, 'apply');
        assert.equal(/<time>/.test(draft.gpx), includeTimestampsOnce === true);
        assert.equal(draft.fields.date, '2026-07-01');
    }
});
