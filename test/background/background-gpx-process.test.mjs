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
import { loadPage, waitFor, fireTrustedEvent, PAGE_FIXTURES } from '../helpers/load-page.mjs';

const workerBundle = await fs.readFile(new URL('../../dist/background.js', import.meta.url), 'utf8');

const PAGE_URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77';
const SENDER = { tab: { id: 5, windowId: 9 }, url: PAGE_URL };

const SEGMENTS = [[
    { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0), invalidTime: false },
    { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0), invalidTime: false },
    { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0), invalidTime: false }
]];
const uploadSelection = generation => ({
    pageSessionId: 'explicit-page-session',
    selectionGeneration: generation,
    selectionNonce: `selection-${generation}-nonce`,
});

const createHarness = ({ peakXml = null, settings = {}, failPeakFetch = false, beforePeakFetch = null,
    syncGetError = null, beforeSyncGet = null, setTimeoutImpl = setTimeout, faults = {},
    loginHtml = '<a href="climber/climber.aspx?cid=77">My Home Page</a>', sessionInitial = {} } = {}) => {
    const values = structuredClone(sessionInitial);
    const localValues = {};
    const syncValues = { bpbSettings: structuredClone(settings) };
    const tabs = new Map([[5, { id: 5, windowId: 9, url: PAGE_URL, active: true }]]);
    let nextTabId = 100;
    const tabMessages = [];
    const fetchCalls = [];
    const grouped = [];
    const groupUpdates = [];
    const navigations = [];
    const removedTabs = [];
    const runtimeMessages = [];
    let syncGetCalls = 0;
    let tabCreateCalls = 0;
    let tabNavigationCalls = 0;
    let draftSetCalls = 0;
    const sessionSetPatches = [];

    const browser = {
        storage: {
            session: {
                get: async key => key === null
                    ? structuredClone(values)
                    : { [key]: structuredClone(values[key]) },
                set: async patch => {
                    const payloadKeys = Object.keys(patch)
                        .filter(key => key.startsWith('bpbCapturePayload:'));
                    if (payloadKeys.length && faults.payloadSet) {
                        const message = faults.payloadSet;
                        delete faults.payloadSet;
                        throw new Error(message);
                    }
                    if (patch.bpbDraftTabs) {
                        draftSetCalls++;
                        if (faults.draftSet || faults.draftSetAt === draftSetCalls) {
                            const message = faults.draftSet
                                || faults.draftSetAtMessage
                                || `draft write ${draftSetCalls} failed`;
                            delete faults.draftSet;
                            faults.draftSetAt = null;
                            throw new Error(message);
                        }
                    }
                    if (patch.bpbCaptureJobs
                        && Object.values(patch.bpbCaptureJobs).some(job => job?.phase === 'opened')
                        && faults.openedJobSet) {
                        const message = faults.openedJobSet;
                        delete faults.openedJobSet;
                        throw new Error(message);
                    }
                    if (patch.bpbCaptureJobs
                        && Object.values(patch.bpbCaptureJobs).some(job => job?.payloadKey)
                        && faults.payloadMetadataSet) {
                        const message = faults.payloadMetadataSet;
                        delete faults.payloadMetadataSet;
                        throw new Error(message);
                    }
                    sessionSetPatches.push(structuredClone(patch));
                    Object.assign(values, structuredClone(patch));
                },
                remove: async keys => {
                    (Array.isArray(keys) ? keys : [keys]).forEach(key => { delete values[key]; });
                },
            },
            sync: {
                get: async key => {
                    syncGetCalls++;
                    if (beforeSyncGet) await beforeSyncGet(syncGetCalls);
                    if (syncGetError) throw new Error(syncGetError);
                    return { [key]: structuredClone(syncValues[key]) };
                },
                set: async patch => Object.assign(syncValues, structuredClone(patch))
            },
            local: {
                get: async key => ({ [key]: structuredClone(localValues[key]) }),
                set: async patch => Object.assign(localValues, structuredClone(patch))
            },
            onChanged: { addListener: () => {} }
        },
        runtime: {
            getURL: path => `chrome-extension://test-extension/${path}`,
            onMessage: { listeners: [], addListener(listener) { this.listeners.push(listener); } },
        },
        scripting: { executeScript: async () => [] },
        action: {
            setBadgeBackgroundColor: async () => {},
            setBadgeText: async () => {}
        },
        tabs: {
            get: async tabId => structuredClone(tabs.get(tabId)),
            create: async details => {
                tabCreateCalls++;
                if (faults.tabCreateAt === tabCreateCalls) {
                    const message = faults.tabCreateAtMessage || `tab create ${tabCreateCalls} failed`;
                    faults.tabCreateAt = null;
                    throw new Error(message);
                }
                const tab = { id: nextTabId++, windowId: details.windowId, url: details.url, active: details.active };
                tabs.set(tab.id, tab);
                return structuredClone(tab);
            },
            remove: async tabId => {
                removedTabs.push(tabId);
                tabs.delete(tabId);
            },
            update: async (tabId, patch) => {
                if (patch.url) {
                    tabNavigationCalls++;
                    if (faults.tabNavigateAt === tabNavigationCalls) {
                        const message = faults.tabNavigateAtMessage || `tab navigation ${tabNavigationCalls} failed`;
                        faults.tabNavigateAt = null;
                        throw new Error(message);
                    }
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

    const fetch = async (url, options = {}) => {
        const value = String(url);
        fetchCalls.push(value);
        if (value.includes('/Default.aspx')) return { ok: true, text: async () => loginHtml };
        if (value.includes('/Async/pllbb2.aspx')) {
            if (beforePeakFetch) {
                await beforePeakFetch({
                    options,
                    number: fetchCalls.filter(call => call.includes('/Async/pllbb2.aspx')).length,
                });
            }
            if (failPeakFetch) throw new Error('network unreachable');
            return {
                ok: true,
                text: async () => peakXml || '<p><t i="7" n="Test Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
            };
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };

    browser.tabs.group = async details => { grouped.push(structuredClone(details)); return 3; };

    const context = vm.createContext({
        browser, fetch, URL, URLSearchParams, Math, Date, console, structuredClone, btoa,
        AbortController, TextEncoder, TextDecoder, setTimeout: setTimeoutImpl, clearTimeout,
    });
    context.globalThis = context;
    context.self = context;
    vm.runInContext(workerBundle, context, { filename: 'dist/background.js' });
    const listener = browser.runtime.onMessage.listeners[0];
    const rawSend = (message, sender = SENDER) => new Promise(resolve => {
        runtimeMessages.push(structuredClone(message));
        assert.equal(listener(message, sender, resolve), true);
    });
    let selectionGeneration = 0;
    let currentSelection = null;
    const send = async (message, sender = SENDER) => {
        let routed = message;
        if (message?.type === 'GPX_PROCESS_START' && !message.pageSessionId) {
            currentSelection = {
                pageSessionId: 'test-page-session',
                selectionGeneration: ++selectionGeneration,
                selectionNonce: `selection-${selectionGeneration}-nonce`,
            };
            await rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...currentSelection }, sender);
            routed = { ...message, ...currentSelection };
        } else if (message?.type === 'GPX_PROCESS_APPLY' && !message.pageSessionId && currentSelection) {
            routed = { ...message, ...currentSelection };
        }
        return rawSend(routed, sender);
    };
    return {
        send, rawSend, values, tabs, tabMessages, fetchCalls, grouped, groupUpdates, navigations, removedTabs,
        runtimeMessages, sessionSetPatches,
        syncGetCalls: () => syncGetCalls, faults,
    };
};

const storedCaptureGpx = (harness, tabId = 5) => {
    const job = harness.values.bpbCaptureJobs?.[String(tabId)];
    return job?.payloadKey ? harness.values[job.payloadKey]?.gpx : undefined;
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
    assert.equal(job.uploadGpx, undefined, 'job metadata must not embed the immutable GPX');
    assert.match(storedCaptureGpx(harness), /<trkpt lat="0" lon="-0.001"><ele>100<\/ele><time>2026-07-01T15:00:00Z<\/time><\/trkpt>/);
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
        message: 'Capture settings could not be read. Reload and try again. Nothing was captured.',
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
    assert.match(result.error.message, /could not reach Peakbagger for the nearby summit data/i);
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'error');
    assert.equal(harness.values.bpbCaptureJobs['5'].uploadGpx, undefined);
    assert.equal(harness.fetchCalls.filter(url => url.includes('/Async/pllbb2.aspx')).length, 2,
        'one box receives exactly the documented two-attempt budget');
});

test('the worker rejects point and corridor limits before issuing summit requests', async () => {
    const tooManyPoints = createHarness();
    const point = { lat: 0, lon: 0, ele: null, time: null };
    const pointsResult = await tooManyPoints.send({
        type: 'GPX_PROCESS_START',
        segments: [Array(20_001).fill(point)],
        waypoints: [],
        trackName: '',
        utcOffsetMinutes: 0,
    });
    assert.equal(pointsResult.error.code, 'gpx-too-large');
    assert.match(pointsResult.error.message, /20,000 track points/);
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
    let firstSignal;
    let reached;
    const firstReached = new Promise(resolve => { reached = resolve; });
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

    assert.equal(firstSignal.aborted, true);
    assert.equal(abandoned.error.code, 'capture-cancelled');
    assert.equal(replacement.phase, 'ready');
    assert.equal(harness.values.bpbCaptureJobs['5'].id, replacement.jobId);
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'ready');
});

test('selection invalidation supersedes a start still waiting for capture settings', async () => {
    let releaseSettings;
    let reachedSettings;
    const settingsReached = new Promise(resolve => { reachedSettings = resolve; });
    const harness = createHarness({
        beforeSyncGet: calls => {
            if (calls !== 1) return undefined;
            reachedSettings();
            return new Promise(resolve => { releaseSettings = resolve; });
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
    releaseSettings();

    const abandoned = await first;
    assert.equal(abandoned.error.code, 'superseded');
    assert.equal(harness.values.bpbCaptureJobs['5'].phase, 'selection');
    assert.equal(harness.values.bpbCaptureJobs['5'].selectionNonce, secondSelection.selectionNonce);
    assert.equal(harness.fetchCalls.some(url => url.includes('/Async/pllbb2.aspx')), false);
});

test('selection invalidation aborts an A corridor lookup without requiring B processing', async () => {
    let firstSignal;
    let reached;
    const firstReached = new Promise(resolve => { reached = resolve; });
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

    assert.equal(firstSignal.aborted, true);
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
    let signal;
    let expire;
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
    assert.equal(signal.aborted, true);
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
    assert.doesNotMatch(storedCaptureGpx(harness), /<wpt/);
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
    assert.doesNotMatch(storedCaptureGpx(harness), /<time>/);
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
    assert.equal(siblingNavigation.url, 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=8&cid=77');
    assert.equal(siblingNavigation.draftRegistered, true, 'the sibling draft exists before its tab navigates');
    assert.deepEqual(harness.tabMessages, [{ tabId: 5, message: { type: 'DRAFT_PROCEED' } }]);

    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' });
    assert.equal(apply.action, 'apply');
    assert.equal(apply.fields.suffix, 'a');
    const waiting = await harness.send({ type: 'DRAFT_READY', pid: '8', cid: '77' }, { tab: { id: 100 }, url: 'https://peakbagger.com/climber/ascentedit.aspx?pid=8&cid=77' });
    assert.equal(waiting.action, 'wait', 'the sibling waits for the current tab’s Preview');
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
    harness.values.bpbDraftTabs = { 5: structuredClone(previousDraft) };
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
    assert.deepEqual([...harness.tabs.keys()], [5], 'the sibling about:blank tab must be closed');
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
    harness.tabs.get(5).url = unboundUrl;
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
    harness.values.bpbDraftTabs = { 5: structuredClone(previousDraft) };
    const priorJob = structuredClone(harness.values.bpbCaptureJobs['5']);

    const failed = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    }, unboundSender);

    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'draft-open-failed');
    assert.deepEqual(harness.values.bpbDraftTabs, { 5: previousDraft });
    assert.deepEqual(harness.values.bpbCaptureJobs['5'], priorJob);
    assert.deepEqual([...harness.tabs.keys()], [5]);
    assert.equal(harness.tabs.get(5).url, unboundUrl);

    const retried = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    }, unboundSender);
    assert.equal(retried.ok, true);
    assert.equal(harness.tabs.get(5).url,
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
    assert.equal(navigation.url, 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');
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
        type: 'GPX_PROCESS_START', segments: SEGMENTS, waypoints: [], trackName: '  Bound   traverse  ', utcOffsetMinutes: 0
    });
    assert.equal(ready.phase, 'ready');
    assert.deepEqual(JSON.parse(JSON.stringify(ready.matches.map(match => match.id))), [8],
        'detection stays fail-closed: the off-track bound peak is not a silent match');
    assert.equal(ready.boundFallback.id, 7);
    assert.ok(ready.boundFallback.closestApproachM > 150 && ready.boundFallback.closestApproachM < 300,
        `closest approach should be ~222 m, got ${ready.boundFallback.closestApproachM}`);
    assert.equal(ready.boundFallback.selected, false);
    assert.equal(harness.values.bpbCaptureJobs['5'].tripName, 'Bound traverse',
        'a selectable fallback must not make the worker discard the GPX track name');

    // "Use ⟨peak⟩ anyway" fills the current page from the closest-approach
    // point and still opens the detected summit as a sibling draft.
    const applied = await harness.send({
        type: 'GPX_PROCESS_APPLY', jobId: ready.jobId, selectedIds: [7, 8], primaryId: 7
    });
    assert.equal(applied.ok, true);
    assert.equal(harness.values.bpbDraftTabs['5'].pid, 7);
    assert.equal(harness.values.bpbDraftTabs['100'].pid, 8);
    assert.equal(harness.values.bpbDraftTabs['5'].tripInfo.name, 'Bound traverse');
    assert.equal(harness.values.bpbDraftTabs['100'].tripInfo.name, 'Bound traverse');
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
    await waitFor(dom, () => dom.window.document.querySelector('.bpb-process-button'));

    const button = dom.window.document.querySelector('.bpb-process-button');
    assert.ok(button, 'the Process button replaces native Preview');
    button.click();

    try {
        await waitFor(dom, () => previewClicks === 1);
    } catch (error) {
        const status = dom.window.document.querySelector('.bpb-upload-status')?.textContent || '';
        const job = harness.values.bpbCaptureJobs?.['5'];
        throw new Error(`${error.message}; upload status=${status}; job phase=${job?.phase || 'none'}; messages=${JSON.stringify(harness.runtimeMessages)}`);
    } finally {
        clearInterval(pumpTimer);
    }

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

    // The native peak picker is empty on this pid-bound fixture. The prepared
    // match name must still reach report autosave so the manager can render a
    // human title while retaining the pid-based storage key.
    const richEditor = dom.window.document.getElementById('bpb-report-editor')._bpbEditors.rich;
    richEditor.commands.setContent('<p>Summit report</p>', { emitUpdate: true });
    const reportKey = 'bpbReportDraft:77:p7';
    await waitFor(dom, () => dom.chrome._localStore[reportKey]);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[reportKey].label)), {
        peak: 'Test Peak',
        date: '2026-07-01'
    });

    // Simulated post-Preview reload: the second DRAFT_READY yields the banner,
    // never a second Preview.
    const afterReload = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    });
    assert.equal(afterReload.action, 'banner');
    assert.equal(afterReload.peakName, 'Test Peak');
    assert.equal(previewClicks, 1);
});
