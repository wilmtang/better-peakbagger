// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../src/capture-core.js');
const source = await fs.readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const schemaSource = await fs.readFile(new URL('../src/settings-schema.js', import.meta.url), 'utf8');
const settingsSource = await fs.readFile(new URL('../src/settings.js', import.meta.url), 'utf8');

const event = () => {
    const listeners = [];
    return { listeners, addListener: listener => listeners.push(listener) };
};

const createHarness = ({ peakXml = null, captureResult = null, ownershipResult = null, settings = {}, beforePeakFetch = null } = {}) => {
    const values = {};
    const syncValues = { bpbSettings: structuredClone(settings) };
    const tabs = new Map([[1, {
        id: 1,
        windowId: 9,
        url: 'https://www.strava.com/activities/123',
        active: true
    }]]);
    let nextTabId = 100;
    const runtimeMessage = event();
    const tabRemoved = event();
    const alarmEvent = event();
    const grouped = [];
    const groupUpdates = [];
    const badgeCalls = [];
    const scriptCalls = [];
    const tabMessages = [];
    const capture = captureResult || {
        ok: true,
        provider: 'strava',
        activityId: '123',
        metadata: { title: 'Test hike', localStart: '2026-07-01T08:00:00-07:00', utcOffsetMinutes: null },
        segments: [[
            { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0) },
            { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0) },
            { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0) }
        ]]
    };

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
        runtime: { onMessage: runtimeMessage },
        scripting: {
            executeScript: async details => {
                scriptCalls.push(structuredClone({ files: details.files, args: details.args, world: details.world }));
                if (details.files) return [];
                const isOwnershipCheck = String(details.func).includes('inspectOwnership');
                const result = isOwnershipCheck && ownershipResult ? ownershipResult : capture;
                return [{ result: structuredClone(result) }];
            }
        },
        action: {
            setBadgeBackgroundColor: async details => badgeCalls.push(['color', details]),
            setBadgeText: async details => badgeCalls.push(['text', details])
        },
        tabs: {
            get: async tabId => structuredClone(tabs.get(tabId)),
            create: async details => {
                const tab = { id: nextTabId++, windowId: details.windowId, url: details.url, active: details.active };
                tabs.set(tab.id, tab);
                return structuredClone(tab);
            },
            update: async (tabId, patch) => {
                Object.assign(tabs.get(tabId), patch);
                return structuredClone(tabs.get(tabId));
            },
            sendMessage: async (tabId, message) => {
                tabMessages.push({ tabId, message: structuredClone(message) });
                return true;
            },
            group: async details => { grouped.push(structuredClone(details)); return 3; },
            onRemoved: tabRemoved
        },
        tabGroups: { update: async (groupId, patch) => groupUpdates.push([groupId, structuredClone(patch)]) },
        alarms: { create: () => {}, onAlarm: alarmEvent }
    };

    const fetchCalls = [];
    const fetch = async url => {
        const value = String(url);
        fetchCalls.push(value);
        if (value.includes('/Default.aspx')) {
            return { ok: true, text: async () => '<a href="climber/climber.aspx?cid=77">My Home Page</a>' };
        }
        if (value.includes('/Async/pllbb2.aspx')) {
            if (beforePeakFetch) await beforePeakFetch();
            return {
                ok: true,
                text: async () => peakXml || '<p><t i="7" n="Test Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
            };
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };

    const context = vm.createContext({
        browser,
        BPBCaptureCore: Core,
        fetch,
        URL,
        URLSearchParams,
        Math,
        Date,
        console,
        structuredClone
    });
    vm.runInContext(schemaSource, context, { filename: 'settings-schema.js' });
    vm.runInContext(settingsSource, context, { filename: 'settings.js' });
    vm.runInContext(source, context, { filename: 'background.js' });
    const listener = runtimeMessage.listeners[0];
    const send = (message, sender = {}) => new Promise(resolve => {
        assert.equal(listener(message, sender, resolve), true);
    });
    return { send, values, syncValues, tabs, grouped, groupUpdates, badgeCalls, fetchCalls, scriptCalls, tabMessages };
};

test('background capture persists a private job, opens grouped drafts, and previews idempotently', async () => {
    const harness = createHarness();
    const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.matches.length, 1);
    assert.equal(ready.matches[0].classification, 'strong');
    assert.equal(ready.matches[0].selected, true);
    assert.equal(ready.uploadGpx, undefined, 'GPX must not be exposed to the popup response');

    const storedJob = harness.values.bpbCaptureJobs['1'];
    assert.match(storedJob.uploadGpx,
        /<trkpt lat="0" lon="-0.001"><ele>100<\/ele><time>2026-07-01T15:00:00Z<\/time><\/trkpt>/);
    assert.doesNotMatch(storedJob.uploadGpx, /<extensions(?:\s|>)/i);
    assert.equal(JSON.stringify(storedJob).includes('heart'), false);
    assert.deepEqual(harness.scriptCalls.find(call => call.args)?.args, [{
        retainWaypoints: true,
        includeTripName: true
    }]);

    const opened = await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    assert.deepEqual([...opened.tabIds], [100]);
    assert.deepEqual(harness.grouped, [{ tabIds: [100], createProperties: { windowId: 9 } }]);
    assert.deepEqual(harness.groupUpdates, [[3, { title: 'Peak Drafts', color: 'green', collapsed: false }]]);
    assert.equal(harness.tabs.get(100).url, 'https://peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');

    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(apply.action, 'apply');
    assert.equal(apply.fields.suffix, '');
    assert.match(apply.gpx, /<gpx/);
    assert.equal(await harness.send({ type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77 }, { tab: { id: 100 } }).then(value => value.ok), true);

    const banner = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'Your file is now successfully uploaded.' }
    }, { tab: { id: 100 } });
    assert.equal(banner.action, 'banner');
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'previewed');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, null);

    const duplicate = await harness.send({ type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77 }, { tab: { id: 100 } });
    assert.equal(duplicate.ok, false);
});

test('a failed Peakbagger Preview keeps the GPX and permits an explicit retry', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77
    }, { tab: { id: 100 } }).then(value => value.ok), true);

    const failure = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'error', message: 'Invalid GPX file.' }
    }, { tab: { id: 100 } });
    assert.equal(failure.action, 'preview-error');
    assert.match(failure.message, /Invalid GPX file/);
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'opened');
    assert.match(harness.values.bpbCaptureJobs['1'].uploadGpx, /<gpx/);
    assert.equal(harness.values.bpbDraftTabs['100'].previewStarted, false);
    assert.equal(harness.values.bpbDraftTabs['100'].complete, false);

    const retry = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(retry.action, 'apply');
    assert.match(retry.gpx, /<ele>100<\/ele><time>2026-07-01T15:00:00Z<\/time>/);
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: retry.jobId, pid: 7, cid: 77
    }, { tab: { id: 100 } }).then(value => value.ok), true);
    const unconfirmed = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'unknown', message: 'Processing GPS data.' }
    }, { tab: { id: 100 } });
    assert.equal(unconfirmed.action, 'preview-error');
    assert.match(unconfirmed.message, /did not confirm/);
    assert.match(harness.values.bpbCaptureJobs['1'].uploadGpx, /<gpx/);
});

test('a capture that finishes for a different activity is not reused after navigation', async () => {
    let releasePeakFetch;
    const peakFetchGate = new Promise(resolve => { releasePeakFetch = resolve; });
    const harness = createHarness({ beforePeakFetch: () => peakFetchGate });
    const until = async predicate => {
        const deadline = Date.now() + 2000;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error('condition not reached');
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    };

    // Hold the first capture at the summit lookup, navigate the tab to a
    // different activity, then request a capture for the new activity. The
    // second request must be parked on the still-pending first process before
    // the lookup is released, or it would resolve through the (already
    // guarded) same-activity fast path instead of the in-flight one.
    const first = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await until(() => harness.fetchCalls.some(call => call.includes('/Async/pllbb2.aspx')));
    harness.tabs.get(1).url = 'https://www.strava.com/activities/456';
    const second = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    releasePeakFetch();

    const firstJob = await first;
    const secondJob = await second;
    assert.equal(firstJob.phase, 'ready');
    assert.notEqual(secondJob.id, firstJob.id,
        'the completed job for the previous activity must not answer a capture of the new activity');
});

test('same-day suffixes include only selected ascents and follow track order', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const job = harness.values.bpbCaptureJobs['1'];
    const base = job.matches[0];
    job.matches = [
        { ...structuredClone(base), id: 7, confidence: 95, draftFields: { ...base.draftFields, upDistanceM: 300 } },
        { ...structuredClone(base), id: 8, confidence: 90, draftFields: { ...base.draftFields, upDistanceM: 100 } },
        { ...structuredClone(base), id: 9, confidence: 85, draftFields: { ...base.draftFields, upDistanceM: 200 } }
    ];

    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7, 9] });
    const later = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    const earlier = await harness.send({ type: 'DRAFT_READY', pid: '9', cid: '77' }, { tab: { id: 101 } });

    assert.equal(later.fields.suffix, 'b');
    assert.equal(earlier.action, 'wait');
    assert.equal(harness.values.bpbDraftTabs['101'].suffix, 'a');
});

test('retained waypoints share the 3,000-point budget and multi-peak drafts receive one sequenced trip', async () => {
    const harness = createHarness({
        settings: { retainWaypoints: true },
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>',
        captureResult: {
            ok: true,
            provider: 'strava',
            activityId: '123',
            metadata: { title: 'Afternoon Hike', utcOffsetMinutes: 0 },
            waypoints: [{ lat: 0.01, lon: 0.02, name: 'Camp & Water', ele: 999, desc: 'private' }],
            segments: [[
                { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 23, 0) },
                { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 2, 12, 0) },
                { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 3, 1, 0) }
            ]]
        }
    });

    const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(ready.matches.length, 2);
    const storedJob = harness.values.bpbCaptureJobs['1'];
    assert.match(storedJob.uploadGpx, /<wpt lat="0\.01" lon="0\.02"><name>Camp &amp; Water<\/name><\/wpt>/);
    assert.equal(storedJob.trackSummary.retainedPointCount + storedJob.trackSummary.retainedWaypointCount <= 3000, true);
    assert.doesNotMatch(storedJob.uploadGpx, /999|private/);
    storedJob.matches.find(match => match.id === 7).confidence = 80;
    storedJob.matches.find(match => match.id === 7).draftFields.upDistanceM = 300;
    storedJob.matches.find(match => match.id === 8).confidence = 95;
    storedJob.matches.find(match => match.id === 8).draftFields.upDistanceM = 100;

    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7, 8] });
    const first = await harness.send({ type: 'DRAFT_READY', pid: '8', cid: '77' }, { tab: { id: 100 } });
    const waiting = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 101 } });
    assert.equal(first.allowWaypoints, true);
    assert.deepEqual({ ...first.fields.tripInfo }, { sequence: 1, name: 'Afternoon Hike', nightsOut: 2 });
    assert.equal(waiting.action, 'wait');
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: first.jobId, pid: 7, cid: 77
    }, { tab: { id: 101 } }).then(value => value.ok), false,
    'a queued draft must not start a concurrent Preview');

    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: first.jobId, pid: 8, cid: 77
    }, { tab: { id: 100 } }).then(value => value.ok), true);
    const confirmed = await harness.send({
        type: 'DRAFT_READY', pid: '8', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    }, { tab: { id: 100 } });
    assert.equal(confirmed.action, 'banner');
    assert.deepEqual(harness.tabMessages, [{ tabId: 101, message: { type: 'DRAFT_PROCEED' } }]);
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'opened');
    assert.match(harness.values.bpbCaptureJobs['1'].uploadGpx, /<gpx/);

    const second = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 101 } });
    assert.deepEqual({ ...second.fields.tripInfo }, { sequence: 2, name: 'Afternoon Hike', nightsOut: 2 });
    assert.equal(first.fields.wildernessNightsOut, null);
    assert.equal(second.fields.wildernessNightsOut, null);
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: second.jobId, pid: 7, cid: 77
    }, { tab: { id: 101 } }).then(value => value.ok), true);
    const finished = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    }, { tab: { id: 101 } });
    assert.equal(finished.action, 'banner');
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'previewed');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, null);
});

test('waypoints cannot crowd a usable track out of Peakbagger’s total-point limit', async () => {
    const harness = createHarness({
        settings: { retainWaypoints: true },
        captureResult: {
            ok: true,
            provider: 'strava',
            activityId: '123',
            metadata: { title: 'Too many waypoints', utcOffsetMinutes: 0 },
            waypoints: Array.from({ length: 2999 }, (_, index) => ({ lat: 0.01, lon: index / 10000, name: `W${index}` })),
            segments: [[
                { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0) },
                { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0) },
                { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0) }
            ]]
        }
    });
    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'error');
    assert.equal(result.error.code, 'too-many-waypoints');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, undefined);
});

test('single-peak overnight captures fill wilderness nights without creating Trip Info', async () => {
    const harness = createHarness({
        captureResult: {
            ok: true,
            provider: 'strava',
            activityId: '123',
            metadata: { title: 'Overnight hike', utcOffsetMinutes: 0 },
            segments: [[
                { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 23, 0) },
                { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 2, 12, 0) },
                { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 3, 1, 0) }
            ]]
        }
    });

    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(apply.fields.tripInfo, null);
    assert.equal(apply.fields.wildernessNightsOut, 2);
});

test('disabled draft autofill settings leave trip and wilderness fields untouched', async () => {
    const harness = createHarness({
        settings: { fillTripInfo: false, fillWildernessNights: false },
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7, 8] });
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(apply.fields.tripInfo, null);
    assert.equal(apply.fields.wildernessNightsOut, null);
});

test('changing capture settings invalidates a reusable job for the same activity', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const firstId = harness.values.bpbCaptureJobs['1'].id;
    harness.syncValues.bpbSettings.retainWaypoints = false;

    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.notEqual(harness.values.bpbCaptureJobs['1'].id, firstId);
    assert.deepEqual(harness.scriptCalls.filter(call => call.args).at(-1).args, [{
        retainWaypoints: false,
        includeTripName: true
    }]);
});

test('Possible and Weak matches are hidden and no coordinate upload is retained', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="8" n="Side Peak" a="0.000765" o="0" e="426.51" r="100" l="Test Range"/></p>'
    });
    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'no-matches');
    assert.deepEqual([...result.matches], []);
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, null);
});

test('non-owned activities show the failure badge and never query coordinates', async () => {
    const harness = createHarness({
        captureResult: { ok: false, code: 'not-owner', provider: 'strava', activityId: '123' }
    });
    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'error');
    assert.equal(result.error.code, 'not-owner');
    assert.ok(harness.badgeCalls.some(([kind, details]) => kind === 'text' && details.text === '!'));
    assert.equal(harness.fetchCalls.length, 0, 'ownership must fail before any Peakbagger or GPS-coordinate request');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, undefined);
});

test('provider export failures preserve the real error instead of reporting an ownership change', async () => {
    const harness = createHarness({
        ownershipResult: { ok: true, provider: 'garmin', activityId: '777', viewerId: 'abc', authorId: 'abc' },
        captureResult: {
            ok: false,
            code: 'provider-export-failed',
            provider: 'garmin',
            activityId: '777',
            message: 'Garmin GPX export failed with HTTP 404. Reload the activity and try again.'
        }
    });
    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'error');
    assert.equal(result.error.code, 'provider-export-failed');
    assert.equal(result.error.message, 'Garmin GPX export failed with HTTP 404. Reload the activity and try again.');
    assert.doesNotMatch(result.error.message, /ownership changed/i);
});
