// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// The worker ships as one bundle (gpx-metrics + capture-core + settings-schema
// + settings + background). Boot the built bundle in a worker-like vm context,
// exactly as the service worker runs it.
const workerBundle = await fs.readFile(new URL('../../dist/background.js', import.meta.url), 'utf8');

const event = () => {
    const listeners = [];
    return { listeners, addListener: listener => listeners.push(listener) };
};

const waitForCondition = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('condition not reached');
        await new Promise(resolve => setTimeout(resolve, 1));
    }
};

const createHarness = ({ peakXml = null, captureResult = null, ownershipResult = null, settings = {}, beforePeakFetch = null,
    beforePeakbaggerLogin = null, beforePeakbaggerAccountEvidence = null,
    beforeProviderCapture = null, beforeBadgeText = null, beforeTabGet = null, beforeTabCreate = null,
    afterSessionSet = null, clock = null, groupError = null, faults = {},
    peakbaggerPageLoginResult = null, peakbaggerPagePeakResult = null,
    peakbaggerAccountEvidence = null, dropPeakbaggerHelperBeforeKind = null,
    peakbaggerPageRequestError = null,
    loginHtml = '<a href="climber/climber.aspx?cid=77">My Home Page</a>' } = {}) => {
    const values = {};
    const localValues = {};
    let sessionGetCalls = 0;
    const syncValues = { bpbSettings: structuredClone(settings) };
    const tabs = new Map([[1, {
        id: 1,
        windowId: 9,
        url: 'https://www.strava.com/activities/123',
        active: true,
        status: 'complete',
    }], [5, {
        id: 5,
        windowId: 9,
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77',
        active: false,
        status: 'complete',
    }]]);
    let nextTabId = 100;
    const runtimeMessage = event();
    const tabRemoved = event();
    const alarmEvent = event();
    const grouped = [];
    const groupUpdates = [];
    const badgeCalls = [];
    const scriptCalls = [];
    const providerCaptureCalls = [];
    const providerCancelCalls = [];
    const peakbaggerPageCalls = [];
    const peakbaggerPageCancelCalls = [];
    const peakbaggerPageRequests = new Map();
    const peakbaggerPageInjected = new Set();
    const droppedPeakbaggerHelpers = new Set();
    const tabMessages = [];
    const removedTabs = [];
    let tabCreateCalls = 0;
    let tabNavigationCalls = 0;
    let draftSetCalls = 0;
    let badgeTextCalls = 0;
    let tabGetCalls = 0;
    let peakbaggerPageProbeCalls = 0;
    let peakbaggerAccountEvidenceCalls = 0;
    const loggedErrors = [];
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
                get: async key => {
                    if (faults.sessionGet) throw new Error(faults.sessionGet);
                    sessionGetCalls++;
                    return { [key]: structuredClone(values[key]) };
                },
                set: async patch => {
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
                    Object.assign(values, structuredClone(patch));
                    if (afterSessionSet) await afterSessionSet(structuredClone(patch));
                }
            },
            sync: {
                get: async key => {
                    if (faults.syncGet) throw new Error(faults.syncGet);
                    return { [key]: structuredClone(syncValues[key]) };
                },
                set: async patch => Object.assign(syncValues, structuredClone(patch))
            },
            local: {
                get: async key => ({ [key]: structuredClone(localValues[key]) }),
                set: async patch => Object.assign(localValues, structuredClone(patch))
            },
            onChanged: event()
        },
        runtime: {
            onMessage: runtimeMessage,
            getURL: path => `chrome-extension://test-extension/${path}`
        },
        scripting: {
            executeScript: async details => {
                if (faults.scripting) throw new Error(faults.scripting);
                if (faults.peakbaggerScripting && details.target.tabId !== 1) {
                    throw new Error(faults.peakbaggerScripting);
                }
                scriptCalls.push(structuredClone({ files: details.files, args: details.args, world: details.world }));
                if (details.files) {
                    if (details.files.includes('peakbagger-page.js')) {
                        peakbaggerPageInjected.add(details.target.tabId);
                    }
                    return [];
                }
                const functionSource = String(details.func);
                const isOwnershipCheck = functionSource.includes('inspectOwnership')
                    || functionSource.includes('inspectExpectedOwnership');
                const isProviderCapture = functionSource.includes('BPBProviderPage.capture');
                const isProviderCancel = functionSource.includes('cancelCapture');
                const isPeakbaggerAccountEvidence = functionSource.includes('accountEvidence');
                const isPeakbaggerPageProbe = functionSource.includes('BPBPeakbaggerPage?.version');
                const isPeakbaggerPageRequest = functionSource.includes('api.request')
                    && functionSource.includes('bridge')
                    && functionSource.includes('missing');
                const isPeakbaggerPageCancel = functionSource.includes('BPBPeakbaggerPage?.cancel');
                if (isPeakbaggerAccountEvidence) {
                    peakbaggerAccountEvidenceCalls++;
                    if (beforePeakbaggerAccountEvidence) {
                        await beforePeakbaggerAccountEvidence({
                            number: peakbaggerAccountEvidenceCalls,
                            tabId: details.target.tabId,
                        });
                    }
                    if (!peakbaggerPageInjected.has(details.target.tabId)) return [{ result: null }];
                    const currentTab = tabs.get(details.target.tabId);
                    const fallback = {
                        pageUrl: currentTab?.url,
                        links: [
                            {
                                label: 'My Home Page',
                                href: 'https://www.peakbagger.com/climber/climber.aspx?cid=77',
                            },
                            {
                                label: 'Edit Account',
                                href: 'https://www.peakbagger.com/climber/climberedit.aspx?cid=77',
                            },
                        ],
                    };
                    const result = typeof peakbaggerAccountEvidence === 'function'
                        ? peakbaggerAccountEvidence({ tab: structuredClone(currentTab) })
                        : (peakbaggerAccountEvidence || fallback);
                    return [{ result: structuredClone(result) }];
                }
                if (isPeakbaggerPageProbe) {
                    peakbaggerPageProbeCalls++;
                    return [{ result: peakbaggerPageInjected.has(details.target.tabId) }];
                }
                if (isPeakbaggerPageCancel) {
                    const requestId = details.args?.[0];
                    peakbaggerPageCancelCalls.push(requestId);
                    const controller = peakbaggerPageRequests.get(requestId);
                    controller?.abort();
                    return [{ result: !!controller }];
                }
                if (isPeakbaggerPageRequest) {
                    const [, requestId, url, kind] = details.args;
                    if (dropPeakbaggerHelperBeforeKind === kind
                        && !droppedPeakbaggerHelpers.has(kind)) {
                        droppedPeakbaggerHelpers.add(kind);
                        peakbaggerPageInjected.delete(details.target.tabId);
                    }
                    if (!peakbaggerPageInjected.has(details.target.tabId)) {
                        return [{ result: { bridge: 'missing' } }];
                    }
                    if (peakbaggerPageRequestError) throw new Error(peakbaggerPageRequestError);
                    const controller = new AbortController();
                    peakbaggerPageRequests.set(requestId, controller);
                    const call = { requestId, url, kind, options: { signal: controller.signal } };
                    peakbaggerPageCalls.push(call);
                    const callback = kind === 'html' ? beforePeakbaggerLogin : beforePeakFetch;
                    const callbackResult = callback?.({
                        options: call.options,
                        number: peakbaggerPageCalls.filter(item => item.kind === kind).length,
                    });
                    if (callbackResult) {
                        await Promise.race([
                            callbackResult,
                            new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })),
                        ]);
                    }
                    peakbaggerPageRequests.delete(requestId);
                    if (controller.signal.aborted) {
                        return [{ result: { bridge: 'result', value: {
                            kind: 'transient', requestedUrl: url, url, status: 0, redirected: false,
                            error: { source: 'peakbagger', code: 'cancelled', resource: kind },
                        } } }];
                    }
                    const injectedResult = kind === 'html'
                        ? peakbaggerPageLoginResult
                        : peakbaggerPagePeakResult;
                    if (injectedResult) {
                        const result = typeof injectedResult === 'function'
                            ? injectedResult(call)
                            : injectedResult;
                        return [{ result: { bridge: 'result', value: structuredClone(result) } }];
                    }
                    const text = kind === 'html'
                        ? loginHtml
                        : (peakXml || '<p><t i="7" n="Test Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>');
                    return [{ result: { bridge: 'result', value: {
                        kind: 'ok', requestedUrl: url, url, status: 200, redirected: false, text,
                    } } }];
                }
                if (isProviderCancel) {
                    providerCancelCalls.push(details.args?.[0]);
                    return [{ result: true }];
                }
                if (isProviderCapture) {
                    const call = {
                        number: providerCaptureCalls.length + 1,
                        options: structuredClone(details.args?.[0]),
                        generation: details.args?.[1],
                    };
                    providerCaptureCalls.push(call);
                    if (beforeProviderCapture) await beforeProviderCapture(call);
                }
                const result = isOwnershipCheck && ownershipResult ? ownershipResult
                    : typeof captureResult === 'function' ? captureResult(providerCaptureCalls.at(-1))
                        : capture;
                return [{ result: structuredClone(result) }];
            }
        },
        action: {
            setBadgeBackgroundColor: async details => badgeCalls.push(['color', details]),
            setBadgeText: async details => {
                badgeCalls.push(['text', details]);
                badgeTextCalls++;
                if (beforeBadgeText) await beforeBadgeText({ number: badgeTextCalls, details });
            }
        },
        tabs: {
            get: async tabId => {
                tabGetCalls++;
                if (beforeTabGet) await beforeTabGet({ number: tabGetCalls, tabId, tabs });
                return structuredClone(tabs.get(tabId));
            },
            create: async details => {
                if (faults.tabCreate) throw new Error(faults.tabCreate);
                tabCreateCalls++;
                if (beforeTabCreate) await beforeTabCreate({ number: tabCreateCalls, details, tabs });
                if (faults.tabCreateAt === tabCreateCalls) {
                    const message = faults.tabCreateAtMessage || `tab create ${tabCreateCalls} failed`;
                    faults.tabCreateAt = null;
                    throw new Error(message);
                }
                const tab = {
                    id: nextTabId++, windowId: details.windowId, url: details.url,
                    active: details.active, status: 'complete',
                };
                tabs.set(tab.id, tab);
                return structuredClone(tab);
            },
            query: async details => [...tabs.values()]
                .filter(tab => details.windowId == null || tab.windowId === details.windowId)
                .filter(tab => !details.url || tab.url.startsWith(String(details.url).replace(/\*$/, '')))
                .map(tab => structuredClone(tab)),
            remove: async tabId => {
                removedTabs.push(tabId);
                tabs.delete(tabId);
            },
            update: async (tabId, patch) => {
                if (faults.tabUpdate) throw new Error(faults.tabUpdate);
                if (patch.url) {
                    tabNavigationCalls++;
                    if (faults.tabNavigateAt === tabNavigationCalls) {
                        const message = faults.tabNavigateAtMessage || `tab navigation ${tabNavigationCalls} failed`;
                        faults.tabNavigateAt = null;
                        throw new Error(message);
                    }
                }
                Object.assign(tabs.get(tabId), patch);
                return structuredClone(tabs.get(tabId));
            },
            sendMessage: async (tabId, message) => {
                tabMessages.push({ tabId, message: structuredClone(message) });
                return true;
            },
            group: async details => {
                grouped.push(structuredClone(details));
                if (groupError) throw new Error(groupError);
                return 3;
            },
            onRemoved: tabRemoved
        },
        tabGroups: { update: async (groupId, patch) => groupUpdates.push([groupId, structuredClone(patch)]) },
        alarms: { create: () => {}, onAlarm: alarmEvent }
    };

    const fetchCalls = [];
    const fetch = async (url, options = {}) => {
        const value = String(url);
        fetchCalls.push(value);
        if (value.includes('/Default.aspx')) {
            if (beforePeakbaggerLogin) await beforePeakbaggerLogin();
            return { ok: true, text: async () => loginHtml };
        }
        if (value.includes('/Async/pllbb2.aspx')) {
            if (beforePeakFetch) await beforePeakFetch({ options, number: fetchCalls.filter(call => call.includes('/Async/pllbb2.aspx')).length });
            return {
                ok: true,
                text: async () => peakXml || '<p><t i="7" n="Test Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
            };
        }
        throw new Error(`Unexpected fetch: ${value}`);
    };

    const workerConsole = Object.create(console);
    workerConsole.error = (...args) => { loggedErrors.push(args); };
    const WorkerDate = clock ? class extends Date { static now() { return clock.now; } } : Date;
    const context = vm.createContext({
        browser,
        fetch,
        URL,
        URLSearchParams,
        Math,
        Date: WorkerDate,
        console: workerConsole,
        structuredClone,
        btoa,
        AbortController,
        TextEncoder,
        TextDecoder,
    });
    context.globalThis = context;
    context.self = context;
    vm.runInContext(workerBundle, context, { filename: 'dist/background.js' });
    const listener = runtimeMessage.listeners[0];
    const send = (message, sender = {}) => new Promise(resolve => {
        assert.equal(listener(message, sender, resolve), true);
    });
    return {
        send, values, localValues, syncValues, tabs, grouped, groupUpdates, badgeCalls, fetchCalls, scriptCalls, tabMessages,
        removedTabs, providerCaptureCalls, providerCancelCalls,
        peakbaggerPageCalls, peakbaggerPageCancelCalls,
        peakbaggerPageProbeCalls: () => peakbaggerPageProbeCalls,
        peakbaggerAccountEvidenceCalls: () => peakbaggerAccountEvidenceCalls,
        sessionGetCalls: () => sessionGetCalls, loggedErrors, faults, tabRemoved, alarmEvent,
    };
};

test('background capture persists a private job, opens grouped drafts, and previews idempotently', async () => {
    const harness = createHarness();
    const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.matches.length, 1);
    assert.equal(ready.matches[0].classification, 'strong');
    assert.equal(ready.matches[0].selected, true);
    assert.equal(ready.uploadGpx, undefined, 'GPX must not be exposed to the popup response');
    assert.equal(ready.dayStats, undefined, 'day-level draft metrics must not be exposed to the popup response');
    assert.equal(ready.hasCachedGpx, true);
    assert.deepEqual(harness.peakbaggerPageCalls.map(call => call.kind), ['html', 'peaks']);
    assert.equal(harness.peakbaggerPageProbeCalls(), 2,
        'one helper injection check is shared by login and summit requests');
    assert.equal(harness.peakbaggerAccountEvidenceCalls(), 0,
        'an already-loaded user tab still receives the authoritative live login request');
    assert.equal(harness.fetchCalls.length, 0,
        'activity capture must use the signed-in Peakbagger page, not the worker fetch context');
    assert.equal(harness.removedTabs.includes(5), false,
        'an existing user Peakbagger tab must never become helper-tab cleanup');

    const storedJob = harness.values.bpbCaptureJobs['1'];
    assert.match(storedJob.uploadGpx,
        /<trkpt lat="0" lon="-0.001"><ele>100<\/ele><time>2026-07-01T15:00:00Z<\/time><\/trkpt>/);
    assert.doesNotMatch(storedJob.uploadGpx, /<extensions(?:\s|>)/i);
    assert.equal(JSON.stringify(storedJob).includes('heart'), false);
    assert.deepEqual(harness.providerCaptureCalls[0].options, {
        retainWaypoints: true,
        includeTripName: true
    });

    const opened = await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    assert.deepEqual([...opened.tabIds], [100]);
    assert.deepEqual(harness.grouped, [{ tabIds: [100], createProperties: { windowId: 9 } }]);
    assert.deepEqual(harness.groupUpdates, [[3, { title: 'Peak Drafts', color: 'green', collapsed: false }]]);
    assert.equal(harness.tabs.get(100).url, 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');

    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(apply.action, 'apply');
    assert.equal(apply.peakName, 'Test Peak');
    assert.equal(apply.fields.suffix, '');
    assert.equal(apply.fields.fillAscentDetails, true);
    // Default-on: the captured Strava link is rebuilt from provider+activityId.
    assert.equal(apply.fields.externalUrl, 'https://www.strava.com/activities/123');
    assert.match(apply.gpx, /<gpx/);
    assert.equal(await harness.send({ type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77 }, { tab: { id: 100 } }).then(value => value.ok), true);

    const banner = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'Your file is now successfully uploaded.' }
    }, { tab: { id: 100 } });
    assert.equal(banner.action, 'banner');
    assert.equal(banner.peakName, 'Test Peak');
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'previewed');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, null);

    const reopened = await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    assert.deepEqual([...reopened.tabIds], [100]);
    assert.equal(reopened.reused, true,
        'a previewed job must still refocus its draft for the user to review and save');
    assert.equal(harness.tabs.get(100).active, true);

    const duplicate = await harness.send({ type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77 }, { tab: { id: 100 } });
    assert.equal(duplicate.ok, false);
});

test('toolbar capture and local GPX create identical new sibling draft records', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0.0005" e="426.51" r="100" l="Test Range"/></p>',
        captureResult: {
            ok: true,
            provider: 'strava',
            activityId: '123',
            metadata: { title: 'Test Traverse', utcOffsetMinutes: 0 },
            segments: [[
                { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0) },
                { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0) },
                { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0) }
            ]]
        }
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7, 8] });
    const captureSibling = Object.values(harness.values.bpbDraftTabs)
        .find(draft => draft.sourceTabId === 1 && draft.pid === 8);

    const sender = {
        tab: { id: 5, windowId: 9 },
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77'
    };
    const selection = {
        pageSessionId: 'capture-parity-session',
        selectionGeneration: 1,
        fileIdentity: {
            name: 'test-traverse.gpx',
            size: 1234,
            lastModified: 1_786_000_000_001,
            type: 'application/gpx+xml'
        }
    };
    assert.equal(await harness.send({
        type: 'GPX_PROCESS_INVALIDATE', ...selection
    }, sender).then(result => result.ok), true);
    const processed = await harness.send({
        type: 'GPX_PROCESS_START',
        ...selection,
        trackName: 'Test Traverse',
        utcOffsetMinutes: 0,
        waypoints: [],
        segments: [[
            { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0) },
            { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0) },
            { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0) }
        ]]
    }, sender);
    assert.equal(processed.phase, 'ready');
    await harness.send({
        type: 'GPX_PROCESS_APPLY', ...selection,
        jobId: processed.jobId, selectedIds: [7, 8], primaryId: 7
    }, sender);
    const uploadSibling = Object.values(harness.values.bpbDraftTabs)
        .find(draft => draft.sourceTabId === 5 && draft.pid === 8);

    const comparable = draft => {
        const copy = structuredClone(draft);
        for (const key of ['tabId', 'jobId', 'sourceTabId', 'expiresAt']) delete copy[key];
        return copy;
    };
    assert.ok(captureSibling && uploadSibling);
    assert.equal(captureSibling.preserveExistingFields, false);
    assert.equal(uploadSibling.preserveExistingFields, false);
    assert.deepEqual(comparable(captureSibling), comparable(uploadSibling));
});

test('only a Peakbagger tab can open the report drafts manager', async () => {
    const harness = createHarness();
    const allowed = await harness.send(
        { type: 'OPEN_DRAFTS_MANAGER' },
        { tab: { id: 5 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?aid=1' }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(allowed)), { ok: true, tabId: 100 });
    // The manager is its own page; the worker opens it directly rather than
    // deep-linking into a Settings section that now only points at it.
    assert.equal(harness.tabs.get(100).url,
        'chrome-extension://test-extension/options/drafts.html');

    const before = harness.tabs.size;
    assert.deepEqual(JSON.parse(JSON.stringify(await harness.send(
        { type: 'OPEN_DRAFTS_MANAGER' },
        { tab: { id: 6 }, url: 'https://peakbagger.com.evil.example/climber/ascentedit.aspx' }
    ))), {
        ok: false,
        error: {
            code: 'forbidden',
            message: 'Report drafts can only be opened from a Peakbagger page.',
        },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await harness.send(
        { type: 'OPEN_DRAFTS_MANAGER' },
        { url: 'https://www.peakbagger.com/climber/ascentedit.aspx' }
    ))), {
        ok: false,
        error: {
            code: 'forbidden',
            message: 'Report drafts can only be opened from a Peakbagger page.',
        },
    });
    assert.equal(harness.tabs.size, before, 'forbidden senders must not create a tab');
});

test('only a Peakbagger tab can open the Has beta settings section', async () => {
    const harness = createHarness();
    const allowed = await harness.send(
        { type: 'OPEN_BETA_SETTINGS' },
        {
            tab: { id: 5, windowId: 9 },
            url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1039',
        }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(allowed)), { ok: true, tabId: 100 });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.tabs.get(100))), {
        id: 100,
        windowId: 9,
        url: 'chrome-extension://test-extension/options/options.html#beta',
        active: true,
        status: 'complete',
    });

    const before = harness.tabs.size;
    assert.deepEqual(JSON.parse(JSON.stringify(await harness.send(
        { type: 'OPEN_BETA_SETTINGS' },
        {
            tab: { id: 6, windowId: 9 },
            url: 'https://peakbagger.com.evil.example/climber/PeakAscents.aspx?pid=1039',
        }
    ))), {
        ok: false,
        error: {
            code: 'forbidden',
            message: 'Beta settings can only be opened from a Peakbagger page.',
        },
    });
    assert.equal(harness.tabs.size, before, 'forbidden senders must not create a tab');
});

test('browser, storage, and page-world exceptions stay behind the public worker boundary', async () => {
    const sentinel = 'RAW_BROWSER_SENTINEL: chrome.runtime.lastError';
    const expectedOuter = {
        phase: 'error',
        error: {
            code: 'unexpected',
            message: 'Better Peakbagger could not complete this action. Reload and try again.',
        },
    };
    const logText = harness => harness.loggedErrors
        .flatMap(args => args)
        .map(value => value instanceof Error ? value.message : String(value))
        .join('\n');
    const assertPrivate = (harness, response) => {
        assert.doesNotMatch(JSON.stringify(response), /RAW_BROWSER_SENTINEL|chrome\.runtime/);
        assert.doesNotMatch(JSON.stringify(harness.values), /RAW_BROWSER_SENTINEL|chrome\.runtime/);
        assert.match(logText(harness), /RAW_BROWSER_SENTINEL: chrome\.runtime\.lastError/);
    };

    const tabCreate = createHarness({ faults: { tabCreate: sentinel } });
    const createResponse = await tabCreate.send(
        { type: 'OPEN_DRAFTS_MANAGER' },
        { tab: { id: 5 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?aid=1' }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(createResponse)), {
        ok: false,
        error: {
            code: 'draft-manager-open-failed',
            message: 'Report drafts could not be opened. Try again.',
        },
    });
    assertPrivate(tabCreate, createResponse);

    const betaTabCreate = createHarness({ faults: { tabCreate: sentinel } });
    const betaCreateResponse = await betaTabCreate.send(
        { type: 'OPEN_BETA_SETTINGS' },
        {
            tab: { id: 5, windowId: 9 },
            url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1039',
        }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(betaCreateResponse)), {
        ok: false,
        error: {
            code: 'beta-settings-open-failed',
            message: 'Settings could not be opened. Try again.',
        },
    });
    assertPrivate(betaTabCreate, betaCreateResponse);

    const sessionStorage = createHarness({ faults: { sessionGet: sentinel } });
    const sessionResponse = await sessionStorage.send({ type: 'CAPTURE_STATUS', tabId: 1 });
    assert.deepEqual(JSON.parse(JSON.stringify(sessionResponse)), expectedOuter);
    assertPrivate(sessionStorage, sessionResponse);

    const syncStorage = createHarness({ faults: { syncGet: sentinel } });
    const syncResponse = await syncStorage.send(
        { type: 'SETTINGS_PATCH', patch: { units: 'metric' } },
        { url: 'chrome-extension://test-extension/options/options.html' }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(syncResponse)), expectedOuter);
    assertPrivate(syncStorage, syncResponse);

    const scripting = createHarness({ faults: { scripting: sentinel } });
    const scriptingResponse = await scripting.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(scriptingResponse.phase, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(scriptingResponse.error)), {
        code: 'capture-failed',
        message: 'Capture stopped unexpectedly. Reload the activity and try again.',
    });
    assertPrivate(scripting, scriptingResponse);

    const tabUpdate = createHarness();
    await tabUpdate.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    tabUpdate.faults.tabUpdate = sentinel;
    const updateResponse = await tabUpdate.send({
        type: 'CAPTURE_OPEN_DRAFTS',
        tabId: 1,
        selectedIds: [7],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(updateResponse)), {
        phase: 'error',
        error: {
            code: 'draft-open-failed',
            message: 'Drafts could not be opened. Try again.',
        },
    });
    assertPrivate(tabUpdate, updateResponse);
});

test('draft opening rolls back every partial toolbar attempt and remains retryable', async t => {
    const cases = [
        ['first tab creation', { tabCreateAt: 1 }],
        ['second tab creation', { tabCreateAt: 2 }],
        ['first draft write', { draftSetAt: 1 }],
        ['second draft write', { draftSetAt: 2 }],
        ['first tab navigation', { tabNavigateAt: 1 }],
        ['second tab navigation', { tabNavigateAt: 2 }],
        ['opened-job write', { openedJobSet: 'opened job write failed' }],
        ['job-and-draft finalization', { draftSetAt: 3 }],
    ];
    const peakXml = '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/>'
        + '<t i="8" n="Second Peak" a="0" o="0.0005" e="426.51" r="100" l="Test Range"/></p>';

    for (const [name, fault] of cases) {
        await t.test(name, async () => {
            const harness = createHarness({ peakXml, faults: structuredClone(fault) });
            await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
            const priorJob = structuredClone(harness.values.bpbCaptureJobs['1']);
            const response = await harness.send({
                type: 'CAPTURE_OPEN_DRAFTS',
                tabId: 1,
                selectedIds: [7, 8],
            });

            assert.deepEqual(JSON.parse(JSON.stringify(response)), {
                phase: 'error',
                error: {
                    code: 'draft-open-failed',
                    message: 'Drafts could not be opened. Try again.',
                },
            });
            assert.deepEqual(harness.values.bpbCaptureJobs['1'], priorJob,
                'the exact pre-attempt job must be restored');
            assert.deepEqual(harness.values.bpbDraftTabs, {},
                'no draft identity from the failed attempt may remain');
            assert.deepEqual([...harness.tabs.keys()].sort((a, b) => a - b), [1, 5],
                'no blank or navigated draft tab from the failed attempt may remain');

            const retried = await harness.send({
                type: 'CAPTURE_OPEN_DRAFTS',
                tabId: 1,
                selectedIds: [7, 8],
            });
            assert.equal(retried.reused, false);
            assert.equal(retried.tabIds.length, 2);
            assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'opened');
            assert.equal(Object.keys(harness.values.bpbDraftTabs).length, 2);
        });
    }
});

test('a stale recorded draft is pruned and replaced instead of falsely reused', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const first = await harness.send({
        type: 'CAPTURE_OPEN_DRAFTS',
        tabId: 1,
        selectedIds: [7],
    });
    assert.deepEqual([...first.tabIds], [100]);

    harness.tabs.delete(100);
    const reopened = await harness.send({
        type: 'CAPTURE_OPEN_DRAFTS',
        tabId: 1,
        selectedIds: [7],
    });

    assert.equal(reopened.reused, false);
    assert.deepEqual([...reopened.tabIds], [101]);
    assert.equal(harness.values.bpbDraftTabs['100'], undefined);
    assert.equal(harness.values.bpbDraftTabs['101'].pid, 7);
    assert.equal(harness.tabs.get(101).url,
        'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');
});

test('replacing a draft whose tab navigated away never closes the user-controlled tab', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await harness.send({
        type: 'CAPTURE_OPEN_DRAFTS',
        tabId: 1,
        selectedIds: [7],
    });
    harness.tabs.get(100).url = 'https://www.peakbagger.com/peak.aspx?pid=7';

    const reopened = await harness.send({
        type: 'CAPTURE_OPEN_DRAFTS',
        tabId: 1,
        selectedIds: [7],
    });

    assert.equal(reopened.reused, false);
    assert.deepEqual([...reopened.tabIds], [101]);
    assert.equal(harness.tabs.get(100).url, 'https://www.peakbagger.com/peak.aspx?pid=7',
        'a tab no longer owned by the draft transaction belongs to the user');
    assert.equal(harness.removedTabs.includes(100), false);
    assert.equal(harness.values.bpbDraftTabs['100'], undefined);
});

test('favorites mutations serialize in the worker and reject unrelated senders', async () => {
    const harness = createHarness();
    const mutation = cid => ({
        type: 'FAVORITES_MUTATE',
        mutation: {
            kind: 'add',
            entry: { cid, name: `Climber ${cid}`, addedAt: cid, source: 'manual' },
        },
    });

    const [fromOptions, fromPeakbagger] = await Promise.all([
        harness.send(mutation(81), {
            url: 'chrome-extension://test-extension/options/options.html',
        }),
        harness.send(mutation(82), {
            tab: { id: 5 },
            url: 'https://www.peakbagger.com/climber/climber.aspx?cid=82',
        }),
    ]);
    const forbidden = await harness.send(mutation(83), {
        tab: { id: 8 },
        url: 'https://peakbagger.com.evil.example/climber/climber.aspx?cid=83',
    });

    assert.equal(fromOptions.ok, true);
    assert.equal(fromPeakbagger.ok, true);
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error.code, 'forbidden');
    assert.deepEqual(harness.localValues.bpbFavoriteClimbers.entries.map(entry => entry.cid), [82, 81]);
});

test('worker settings patches serialize and reject unrelated senders', async () => {
    const harness = createHarness({ settings: { enable3dMap: false, units: 'imperial' } });
    const patch = value => ({ type: 'SETTINGS_PATCH', patch: value });

    const [fromOptions, fromPeakbagger] = await Promise.all([
        harness.send(patch({ units: 'metric' }), {
            url: 'chrome-extension://test-extension/options/options.html',
        }),
        harness.send(patch({ theme: 'dark' }), {
            tab: { id: 5 },
            url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=99',
        }),
    ]);
    const forbidden = await harness.send(patch({ enable3dMap: true }), {
        tab: { id: 8 },
        url: 'https://peakbagger.com.evil.example/climber/ascent.aspx?aid=99',
    });

    assert.equal(fromOptions.ok, true);
    assert.equal(fromPeakbagger.ok, true);
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error.code, 'forbidden');
    // Both accepted patches survive: the queue composes them instead of letting
    // the second write rebuild the record from a pre-first-write read.
    assert.equal(harness.syncValues.bpbSettings.units, 'metric');
    assert.equal(harness.syncValues.bpbSettings.theme, 'dark');
    assert.equal(harness.syncValues.bpbSettings.enable3dMap, false,
        'a rejected sender must not reach the feature gate');
});

test('toolbar capture fails closed when privacy settings cannot be read', async () => {
    const sentinel = 'SYNC_CAPTURE_SETTINGS_SENTINEL';
    const harness = createHarness({ faults: { syncGet: sentinel } });
    const response = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    assert.equal(response.phase, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(response.error)), {
        code: 'settings-unavailable',
        message: 'Capture settings could not be read. Reload and try again. Nothing was captured.',
    });
    assert.equal(harness.scriptCalls.length, 0, 'the provider page must not be injected');
    assert.equal(harness.fetchCalls.length, 0, 'no Peakbagger or coordinate request may start');
    assert.equal(harness.values.bpbCaptureJobs, undefined, 'no capture job may retain a payload');
    assert.match(
        harness.loggedErrors.flat().map(value => value instanceof Error ? value.message : String(value)).join('\n'),
        /SYNC_CAPTURE_SETTINGS_SENTINEL/
    );
});

test('Peakbagger login accepts signed-in account controls and reports ambiguous pages honestly', async () => {
    const accountControl = createHarness({
        loginHtml: '<a class="account" href="/climber/ClimberEdit.aspx?mode=profile&amp;cid=77">Edit Account</a>'
    });
    assert.equal((await accountControl.send({ type: 'CAPTURE_START', tabId: 1, force: false })).phase, 'ready');

    const ambiguous = createHarness({ loginHtml: '<a href="/climber/login.aspx">Log In</a>' });
    const failed = await ambiguous.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(failed.phase, 'error');
    assert.equal(failed.error.code, 'peakbagger-signed-out');
    assert.match(failed.error.message, /login could not be verified/i);
    assert.doesNotMatch(failed.error.message, /^Sign in to Peakbagger/);
});

test('toolbar capture preserves actionable Peakbagger human-check recovery', async () => {
    const url = 'https://www.peakbagger.com/Default.aspx';
    const harness = createHarness({
        peakbaggerPageLoginResult: {
            kind: 'challenged',
            requestedUrl: url,
            url,
            status: 403,
            redirected: false,
            error: { source: 'peakbagger', code: 'cloudflare', resource: 'html', status: 403 },
            reason: 'PRIVATE CHALLENGE BODY',
        },
    });

    const failed = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    assert.equal(failed.phase, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(failed.error)), {
        code: 'cloudflare',
        message: 'Peakbagger is asking for a human check. Open Peakbagger, complete the check, then try again.',
    });
    assert.doesNotMatch(JSON.stringify(harness.values), /PRIVATE CHALLENGE BODY/,
        'challenge HTML must not be retained with the capture job');
});

test('activity capture creates and removes an inactive Peakbagger request tab when needed', async () => {
    const harness = createHarness();
    harness.tabs.delete(5);

    const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    assert.equal(ready.phase, 'ready');
    assert.deepEqual(harness.peakbaggerPageCalls.map(call => call.kind), ['peaks'],
        'the freshly loaded account page must not be downloaded a second time');
    assert.equal(harness.peakbaggerAccountEvidenceCalls(), 1);
    assert.deepEqual(harness.removedTabs, [100]);
    assert.equal(harness.tabs.has(100), false);
    assert.equal(harness.tabs.get(1).active, true,
        'the provider tab remains active while the helper works in the background');
});

test('selecting a temporary Peakbagger request tab transfers cleanup ownership to the user', async () => {
    const harness = createHarness({
        beforePeakbaggerAccountEvidence: () => {
            harness.tabs.get(1).active = false;
            harness.tabs.get(100).active = true;
        },
    });
    harness.tabs.delete(5);

    const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    assert.equal(ready.phase, 'ready');
    assert.equal(harness.tabs.has(100), true);
    assert.deepEqual(harness.removedTabs, []);
});

test('ambiguous fresh account evidence falls back to the live login request', async () => {
    const cases = [
        {
            pageUrl: 'https://www.peakbagger.com/Default.aspx',
            links: [{
                label: 'My Home Page',
                href: 'https://www.peakbagger.com/climber/climber.aspx?cid=77',
            }],
        },
        {
            pageUrl: 'https://www.peakbagger.com/Default.aspx',
            links: [
                {
                    label: 'My Home Page',
                    href: 'https://www.peakbagger.com/climber/climber.aspx?cid=77',
                },
                {
                    label: 'Edit Account',
                    href: 'https://www.peakbagger.com/climber/climberedit.aspx?cid=88',
                },
            ],
        },
        {
            pageUrl: 'https://www.peakbagger.com/climber/climber.aspx?cid=77',
            links: [
                {
                    label: 'My Home Page',
                    href: 'https://www.peakbagger.com/climber/climber.aspx?cid=77',
                },
                {
                    label: 'Edit Account',
                    href: 'https://www.peakbagger.com/climber/climberedit.aspx?cid=77',
                },
            ],
        },
        {
            pageUrl: 'https://www.peakbagger.com/Default.aspx',
            links: [
                {
                    label: 'My Home Page',
                    href: 'https://www.peakbagger.com/climber/climber.aspx?cid=77',
                },
                {
                    label: 'Edit Account',
                    href: 'https://www.peakbagger.com/climber/climberedit.aspx?cid=77',
                },
            ],
            pageText: 'must not cross the narrow evidence boundary',
        },
    ];

    for (const evidence of cases) {
        const harness = createHarness({ peakbaggerAccountEvidence: evidence });
        harness.tabs.delete(5);
        const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

        assert.equal(ready.phase, 'ready');
        assert.equal(harness.peakbaggerAccountEvidenceCalls(), 1);
        assert.deepEqual(harness.peakbaggerPageCalls.map(call => call.kind), ['html', 'peaks']);
    }
});

test('a page helper lost during capture is reinjected once without repeating the summit request', async () => {
    const harness = createHarness({ dropPeakbaggerHelperBeforeKind: 'peaks' });

    const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    assert.equal(ready.phase, 'ready');
    assert.equal(harness.peakbaggerPageProbeCalls(), 4,
        'initial injection and one recovery injection each use a bounded before/after probe');
    assert.equal(harness.peakbaggerPageCalls.filter(call => call.kind === 'peaks').length, 1);
});

test('the worker rejects page-world summit content that does not match the requested resource', async () => {
    const sentinel = 'UNTRUSTED_PAGE_RESULT_SENTINEL';
    const harness = createHarness({
        peakbaggerPagePeakResult: call => ({
            kind: 'ok',
            requestedUrl: call.url,
            url: call.url,
            status: 200,
            redirected: false,
            text: `<html>${sentinel}</html>`,
        }),
    });

    const failed = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    assert.equal(failed.phase, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(failed.error)), {
        code: 'peakbagger-response-invalid',
        message: 'Peakbagger returned summit data that could not be verified. Reload Peakbagger and try the capture again.',
    });
    assert.doesNotMatch(JSON.stringify(harness.values), new RegExp(sentinel));
});

test('Peakbagger tab setup failures identify the failed step and a recovery action', async () => {
    const harness = createHarness({ faults: { tabCreate: 'popup blocked' } });
    harness.tabs.delete(5);

    const failed = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    assert.equal(failed.phase, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(failed.error)), {
        code: 'peakbagger-tab-open-failed',
        message: 'Better Peakbagger could not open Peakbagger for account verification. Open Peakbagger in this browser window, then try again.',
    });
});

test('Peakbagger page connection failures distinguish an open tab from a changed tab', async () => {
    const connected = createHarness({ peakbaggerPageRequestError: 'page realm unavailable' });
    const connectionFailure = await connected.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.deepEqual(JSON.parse(JSON.stringify(connectionFailure.error)), {
        code: 'peakbagger-page-connect-failed',
        message: 'Better Peakbagger could not connect to the open Peakbagger page. Reload that page, wait for it to finish, then try again.',
    });

    const changed = createHarness({
        peakbaggerPageRequestError: 'page realm unavailable',
        beforeTabGet: ({ tabId, tabs }) => {
            if (tabId === 5) tabs.get(5).url = 'https://example.com/';
        },
    });
    const changedFailure = await changed.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.deepEqual(JSON.parse(JSON.stringify(changedFailure.error)), {
        code: 'peakbagger-tab-changed',
        message: 'The Peakbagger tab closed or changed during capture. Keep a Peakbagger page open until summit detection finishes, then try again.',
    });
});

test('coordinate-only provider GPX still produces a valid Peakbagger draft', async () => {
    const harness = createHarness({
        captureResult: {
            ok: true,
            provider: 'strava',
            activityId: '123',
            metadata: { displayedLocalStart: '2026-07-01T08:00:00', utcOffsetMinutes: null },
            segments: [[
                { lat: 0, lon: -0.001, ele: null, time: null },
                { lat: 0, lon: 0, ele: null, time: null },
                { lat: 0, lon: 0.001, ele: null, time: null }
            ]]
        }
    });

    const ready = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.matches[0].classification, 'probable');
    assert.equal(ready.matches[0].confidence, 69);
    assert.deepEqual([...ready.selectedIds], []);
    assert.equal(ready.hasCachedGpx, true);

    const storedJob = harness.values.bpbCaptureJobs['1'];
    assert.equal((storedJob.uploadGpx.match(/<trkpt /g) || []).length, 3);
    assert.doesNotMatch(storedJob.uploadGpx, /<(?:ele|time)>/);
    assert.equal(storedJob.trackSummary.breakCounts.missingElevation, 3);
    assert.equal(storedJob.trackSummary.breakCounts.missingTime, 3);
    assert.equal(storedJob.matches[0].draftFields.date, '2026-07-01');
    assert.equal(storedJob.matches[0].draftFields.time, '');
    assert.equal(storedJob.matches[0].draftFields.startElevationM, null);
    assert.equal(storedJob.matches[0].draftFields.endElevationM, null);

    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(apply.action, 'apply');
    assert.equal(apply.preserveExistingFields, false,
        'capture-opened fresh drafts keep their existing full-fill behavior');
    assert.doesNotMatch(apply.gpx, /<(?:ele|time)>/);
    assert.equal(apply.fields.upDuration, null);
    assert.equal(apply.fields.downDuration, null);
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

test('discarding a cached capture removes its GPX and draft identities before recapture', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const firstJobId = harness.values.bpbCaptureJobs['1'].id;
    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    assert.match(harness.values.bpbCaptureJobs['1'].uploadGpx, /<gpx/);
    assert.equal(harness.values.bpbDraftTabs['100'].jobId, firstJobId);

    const cleared = await harness.send({ type: 'CAPTURE_CLEAR', tabId: 1 });
    assert.deepEqual({ ...cleared }, { ok: true, removedGpx: true, removedDraftCount: 1 });
    assert.equal(harness.values.bpbCaptureJobs['1'], undefined);
    assert.equal(harness.values.bpbDraftTabs['100'], undefined);
    assert.deepEqual(harness.tabMessages, [{ tabId: 100, message: { type: 'DRAFT_CLEARED' } }]);
    assert.equal(await harness.send({ type: 'CAPTURE_STATUS', tabId: 1 }), null);

    const recaptured = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(recaptured.phase, 'ready');
    assert.equal(recaptured.hasCachedGpx, true);
    assert.notEqual(harness.values.bpbCaptureJobs['1'].id, firstJobId);
});

test('status reads hide expired jobs without running global cleanup', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    harness.values.bpbCaptureJobs['1'].expiresAt = Date.now() - 1;
    const readsBefore = harness.sessionGetCalls();

    assert.equal(await harness.send({ type: 'CAPTURE_STATUS', tabId: 1 }), null);
    assert.equal(harness.sessionGetCalls() - readsBefore, 1,
        'a status poll should read only jobs, not mutate drafts, jobs, and snapshots');
    assert.ok(harness.values.bpbCaptureJobs['1'],
        'lazy filtering hides stale data; the periodic alarm owns physical cleanup');
});

test('detached tab and alarm cleanup failures are contained and reported independently', async () => {
    const harness = createHarness({ faults: { sessionGet: 'session unavailable' } });
    const waitForError = async expected => {
        const deadline = Date.now() + 2000;
        while (!harness.loggedErrors.some(args => String(args[0]).includes(expected))) {
            if (Date.now() > deadline) throw new Error('cleanup errors were not reported');
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    };

    assert.doesNotThrow(() => harness.tabRemoved.listeners[0](1));
    await Promise.all([
        waitForError('photo tab cleanup failed'),
        waitForError('report draft tab cleanup failed'),
        waitForError('capture tab cleanup failed'),
    ]);
    const tabRemovalLogs = harness.loggedErrors.map(args => String(args[0]));
    assert.ok(tabRemovalLogs.some(message => message.includes('photo tab cleanup failed')));
    assert.ok(tabRemovalLogs.some(message => message.includes('report draft tab cleanup failed')));
    assert.ok(tabRemovalLogs.some(message => message.includes('capture tab cleanup failed')));

    assert.doesNotThrow(() => harness.alarmEvent.listeners[0]({ name: 'bpb-capture-cleanup' }));
    await waitForError('expired capture cleanup failed');
    assert.ok(harness.loggedErrors.some(args => String(args[0]).includes('expired capture cleanup failed')));
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
    await until(() => harness.peakbaggerPageCalls.some(call => call.kind === 'peaks'));
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

test('capture follows canonical provider identity across Garmin redirects and URL decoration', async () => {
    const owned = { ok: true, provider: 'garmin', activityId: '123', viewerId: '42', authorId: '42' };
    const exported = {
        ok: true,
        provider: 'garmin',
        activityId: '123',
        metadata: { title: 'Garmin hike', utcOffsetMinutes: 0 },
        segments: [[
            { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0) },
            { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0) },
            { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0) },
        ]],
    };
    for (const [clickedUrl, redirectedUrl] of [
        [
            'https://connect.garmin.com/modern/activity/123',
            'https://connect.garmin.com/app/activity/123',
        ],
        [
            'https://connect.garmin.com/app/activity/123?source=toolbar#summary',
            'https://connect.garmin.com/app/activity/123?source=redirect#details',
        ],
    ]) {
        const harness = createHarness({
            ownershipResult: owned,
            captureResult: exported,
            beforeTabGet: ({ number, tabs }) => {
                if (number === 2) tabs.get(1).url = redirectedUrl;
            },
        });
        harness.tabs.get(1).url = clickedUrl;

        const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
        assert.equal(result.phase, 'ready', `${clickedUrl} -> ${redirectedUrl}`);
        assert.equal(result.provider, 'garmin');
        assert.equal(result.activityId, '123');
        assert.equal(harness.providerCaptureCalls.length, 1);
    }
});

test('capture rejects a different activity or unsupported origin at the first worker recheck', async () => {
    for (const nextUrl of [
        'https://www.strava.com/activities/456',
        'http://www.strava.com/activities/123',
        'https://www.strava.com.evil.example/activities/123',
    ]) {
        const harness = createHarness({
            beforeTabGet: ({ number, tabs }) => {
                if (number === 2) tabs.get(1).url = nextUrl;
            },
        });
        const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
        assert.equal(result.phase, 'error', nextUrl);
        assert.equal(result.error.code, 'activity-changed', nextUrl);
        assert.equal(harness.scriptCalls.length, 0, 'no provider page code runs after identity changes');
        assert.equal(harness.peakbaggerPageCalls.length, 0,
            'no page-context login or summit request runs after identity changes');
    }
});

test('capture rejects a provider-reported SPA navigation after the GPX read', async () => {
    const harness = createHarness({
        ownershipResult: { ok: true, provider: 'strava', activityId: '123', viewerId: '42', authorId: '42' },
        captureResult: {
            ok: false,
            code: 'activity-changed',
            provider: 'strava',
            activityId: '456',
        },
    });
    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'error');
    assert.equal(result.error.code, 'activity-changed');
    assert.equal(harness.providerCaptureCalls.length, 1);
    assert.equal(harness.peakbaggerPageCalls.filter(call => call.kind === 'peaks').length, 0,
        'coordinates from the replacement activity never reach summit lookup');
});

test('capture does not follow a same-tab activity navigation after ownership approval', async () => {
    let releaseLogin;
    let loginReached;
    const loginGate = new Promise(resolve => { releaseLogin = resolve; });
    const reached = new Promise(resolve => { loginReached = resolve; });
    const harness = createHarness({
        beforePeakbaggerLogin: async () => {
            loginReached();
            await loginGate;
        },
    });

    const capture = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await reached;
    harness.tabs.get(1).url = 'https://www.strava.com/activities/456';
    releaseLogin();
    const result = await capture;

    assert.equal(result.phase, 'error');
    assert.equal(result.error.code, 'activity-changed');
    assert.equal(harness.providerCaptureCalls.length, 0,
        'the provider export is never requested for the replacement activity');
    assert.equal(harness.peakbaggerPageCalls.filter(call => call.kind === 'peaks').length, 0,
        'no coordinates from the replacement activity reach summit analysis');
});

test('overlapping starts serialize admission before either capture process is registered', async () => {
    let releaseAdmissions;
    const admissionGate = new Promise(resolve => { releaseAdmissions = resolve; });
    const harness = createHarness({
        beforeBadgeText: async call => {
            if (call.number <= 2) await admissionGate;
        },
    });

    const firstStart = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const secondStart = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseAdmissions();
    const [first, second] = await Promise.all([firstStart, secondStart]);

    assert.equal(first.phase, 'ready');
    assert.equal(second.phase, 'ready');
    assert.equal(first.id, second.id, 'both callers must observe the one admitted job');
    assert.equal(harness.providerCaptureCalls.length, 1, 'only one provider pipeline may start');
});

test('cancel during capture admission prevents provider access and reports success', async () => {
    let releaseAdmission;
    let admissionReached;
    const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
    const reached = new Promise(resolve => { admissionReached = resolve; });
    const harness = createHarness({
        beforeBadgeText: async call => {
            if (call.number !== 1) return;
            admissionReached();
            await admissionGate;
        },
    });

    const capture = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await reached;
    const cancellation = harness.send({ type: 'CAPTURE_CANCEL', tabId: 1 });
    releaseAdmission();

    const [started, cancelled] = await Promise.all([capture, cancellation]);
    assert.equal(started, null);
    assert.deepEqual({ ...cancelled }, { ok: true, cancelled: true, job: null });
    assert.equal(harness.values.bpbCaptureJobs?.['1'], undefined);
    assert.equal(harness.scriptCalls.length, 0,
        'ownership inspection and provider capture must not start after the cancellation intent');
    assert.equal(harness.peakbaggerPageCalls.length, 0,
        'Peakbagger login and corridor requests must not start after the cancellation intent');
});

test('cancelling an in-progress capture discards its job and ignores later results', async () => {
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

    const capture = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await until(() => harness.peakbaggerPageCalls.some(call => call.kind === 'peaks'));
    const cancelled = await harness.send({ type: 'CAPTURE_CANCEL', tabId: 1 });
    assert.deepEqual({ ...cancelled }, { ok: true, cancelled: true, job: null });
    assert.equal(harness.values.bpbCaptureJobs['1'], undefined);

    releasePeakFetch();
    assert.equal(await capture, null);
    assert.equal(harness.values.bpbCaptureJobs['1'], undefined,
        'the abandoned process must not recreate or retain its late result');
});

test('cancelling during corridor lookup aborts the background request owner immediately', async () => {
    let peakSignal;
    let reached;
    const peakReached = new Promise(resolve => { reached = resolve; });
    const harness = createHarness({
        beforePeakFetch: ({ options }) => {
            peakSignal = options.signal;
            reached();
            return new Promise(() => {});
        },
    });

    const capture = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await peakReached;
    const generation = harness.values.bpbCaptureJobs['1'].id;
    const cancelled = await harness.send({ type: 'CAPTURE_CANCEL', tabId: 1 });

    assert.equal(cancelled.cancelled, true);
    assert.equal(await capture, null);
    assert.equal(peakSignal.aborted, true, 'the background Peakbagger socket owner is aborted');
    assert.equal(harness.values.bpbCaptureJobs['1'], undefined);
    assert.deepEqual(harness.providerCancelCalls, [generation],
        'the page-owned provider request is cancelled independently too');
    assert.deepEqual(harness.peakbaggerPageCancelCalls,
        [harness.peakbaggerPageCalls.find(call => call.kind === 'peaks').requestId],
        'the page-owned Peakbagger request is also aborted');
    assert.equal(harness.peakbaggerPageCalls.filter(call => call.kind === 'peaks').length, 1,
        'cancellation cannot start the retry attempt');
});

test('expiry during corridor lookup aborts work and removes the expired generation', async () => {
    let peakSignal;
    let reached;
    const peakReached = new Promise(resolve => { reached = resolve; });
    const clock = { now: Date.now() };
    const harness = createHarness({
        clock,
        beforePeakFetch: ({ options }) => {
            peakSignal = options.signal;
            reached();
            return new Promise(() => {});
        },
    });

    const capture = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await peakReached;
    clock.now += 30 * 60 * 1000 + 1;
    harness.alarmEvent.listeners[0]({ name: 'bpb-capture-cleanup' });

    assert.equal(await capture, null);
    assert.equal(peakSignal.aborted, true);
    await waitForCondition(() => !harness.values.bpbCaptureJobs?.['1']);
});

test('cancel followed immediately by retry starts a new provider generation', async () => {
    let releaseFirstCapture;
    const firstCaptureGate = new Promise(resolve => { releaseFirstCapture = resolve; });
    const harness = createHarness({
        beforeProviderCapture: call => call.number === 1 ? firstCaptureGate : undefined,
    });
    const until = async predicate => {
        const deadline = Date.now() + 2000;
        while (!predicate()) {
            if (Date.now() > deadline) {
                throw new Error(
                    `condition not reached; captures=${harness.providerCaptureCalls.length}`
                        + ` cancellations=${harness.providerCancelCalls.length}`,
                );
            }
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    };

    const abandoned = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await until(() => harness.providerCaptureCalls.length === 1);
    const firstGeneration = harness.values.bpbCaptureJobs['1'].id;

    const cancelled = await harness.send({ type: 'CAPTURE_CANCEL', tabId: 1 });
    assert.deepEqual({ ...cancelled }, { ok: true, cancelled: true, job: null });
    assert.deepEqual(harness.providerCancelCalls, [firstGeneration]);

    const retry = harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await until(() => harness.providerCaptureCalls.length === 2);
    const retried = await retry;
    assert.equal(retried.phase, 'ready');
    assert.notEqual(retried.id, firstGeneration);
    assert.equal(harness.values.bpbCaptureJobs['1'].id, retried.id);

    releaseFirstCapture();
    assert.equal(await abandoned, null,
        'the cancelled generation returns no later job, even after the retry completes');
    assert.equal(harness.values.bpbCaptureJobs['1'].id, retried.id);
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'ready');
});

test('a tab-grouping failure is a flag, never raw exception text handed to a surface', async () => {
    const harness = createHarness({ groupError: 'tabs.group is not a function' });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const opened = await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });

    assert.equal(opened.groupWarning, true, 'grouping is cosmetic: report it, do not fail the open');
    assert.deepEqual([...opened.tabIds], [100], 'the drafts still opened');
    assert.equal(harness.values.bpbCaptureJobs['1'].groupWarning, true);
    assert.doesNotMatch(JSON.stringify(opened), /tabs\.group is not a function/,
        'the exception message must not reach a user-facing surface');
});

test('an opened job refuses selection writes and hands the popup its locked state', async () => {
    const harness = createHarness({
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0.0005" e="426.51" r="100" l="Test Range"/></p>'
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    const opened = await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7, 8] });
    assert.equal(opened.reused, false);
    assert.equal(opened.job.phase, 'opened',
        'the popup needs the post-open job to lock its selection without a reopen');
    assert.deepEqual([...opened.job.selectedIds], [7, 8]);
    assert.equal(opened.job.uploadGpx, undefined, 'the returned job stays a public job');

    // The drafts already exist, so this write could never take effect.
    const refused = await harness.send({ type: 'CAPTURE_SELECTION', tabId: 1, selectedIds: [7] });
    assert.deepEqual([...refused.selectedIds], [7, 8], 'the response reports the selection that opened');
    assert.deepEqual([...harness.values.bpbCaptureJobs['1'].selectedIds], [7, 8],
        'and nothing was stored');
});

test('selection cannot change after a draft opening generation starts', async () => {
    let releaseCreate;
    let createReached;
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    const reached = new Promise(resolve => { createReached = resolve; });
    const harness = createHarness({
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>',
        beforeTabCreate: async ({ number }) => {
            if (number !== 1) return;
            createReached();
            await createGate;
        },
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    const opening = harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    await reached;
    const lateSelection = harness.send({ type: 'CAPTURE_SELECTION', tabId: 1, selectedIds: [8] });
    releaseCreate();

    const [opened, selected] = await Promise.all([opening, lateSelection]);
    assert.deepEqual([...opened.tabIds], [100]);
    assert.deepEqual([...selected.selectedIds], [7]);
    assert.deepEqual([...harness.values.bpbCaptureJobs['1'].selectedIds], [7]);
    assert.equal(harness.values.bpbDraftTabs['100'].pid, 7);
    assert.equal(harness.tabs.has(101), false, 'the late selection never opens another peak');
});

test('clearing during draft opening cancels the generation and leaves no orphan state or tab', async () => {
    let releaseCreate;
    let createReached;
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    const reached = new Promise(resolve => { createReached = resolve; });
    const harness = createHarness({
        beforeTabCreate: async ({ number }) => {
            if (number !== 1) return;
            createReached();
            await createGate;
        },
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });

    const opening = harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    await reached;
    const clearing = harness.send({ type: 'CAPTURE_CLEAR', tabId: 1 });
    releaseCreate();

    const [openResult, clearResult] = await Promise.all([opening, clearing]);
    assert.equal(openResult.phase, 'error');
    assert.equal(openResult.error.code, 'draft-open-cancelled');
    assert.equal(clearResult.ok, true);
    assert.equal(harness.values.bpbCaptureJobs['1'], undefined);
    assert.deepEqual(harness.values.bpbDraftTabs || {}, {});
    assert.equal(harness.tabs.has(100), false);
    assert.deepEqual(harness.removedTabs, [100]);
});

test('source-tab closure during draft opening cancels and cleans the generation idempotently', async () => {
    let releaseCreate;
    let createReached;
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    const reached = new Promise(resolve => { createReached = resolve; });
    const harness = createHarness({
        beforeTabCreate: async ({ number }) => {
            if (number !== 1) return;
            createReached();
            await createGate;
        },
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const opening = harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    await reached;

    const readsBeforeClose = harness.sessionGetCalls();
    harness.tabs.delete(1);
    harness.tabRemoved.listeners[0](1);
    await waitForCondition(() => harness.sessionGetCalls() >= readsBeforeClose + 2);
    await Promise.resolve();
    releaseCreate();

    const openResult = await opening;
    assert.equal(openResult.phase, 'error');
    assert.equal(openResult.error.code, 'draft-open-cancelled');
    await waitForCondition(() => !harness.values.bpbCaptureJobs?.['1']
        && !harness.values.bpbDraftTabs?.['100']);
    assert.equal(harness.tabs.has(100), false);
    assert.deepEqual(harness.removedTabs, [100]);
    harness.tabRemoved.listeners[0](1);
    await Promise.resolve();
    assert.equal(harness.values.bpbCaptureJobs?.['1'], undefined, 'repeated source cleanup stays harmless');
});

test('expiry during draft opening cancels the generation and removes all expired state', async () => {
    let releaseCreate;
    let createReached;
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    const reached = new Promise(resolve => { createReached = resolve; });
    const clock = { now: Date.now() };
    const harness = createHarness({
        clock,
        beforeTabCreate: async ({ number }) => {
            if (number !== 1) return;
            createReached();
            await createGate;
        },
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const opening = harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    await reached;

    clock.now += 30 * 60 * 1000 + 1;
    const readsBeforeExpiry = harness.sessionGetCalls();
    harness.alarmEvent.listeners[0]({ name: 'bpb-capture-cleanup' });
    await waitForCondition(() => harness.sessionGetCalls() >= readsBeforeExpiry + 2);
    await Promise.resolve();
    releaseCreate();

    const openResult = await opening;
    assert.equal(openResult.phase, 'error');
    assert.equal(openResult.error.code, 'draft-open-cancelled');
    await waitForCondition(() => !harness.values.bpbCaptureJobs?.['1']
        && !harness.values.bpbDraftTabs?.['100']);
    assert.equal(harness.tabs.has(100), false);
    assert.deepEqual(harness.removedTabs, [100]);
});

test('draft opening cannot restore or mutate a replacement job generation', async () => {
    let releaseCreate;
    let createReached;
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    const reached = new Promise(resolve => { createReached = resolve; });
    const harness = createHarness({
        beforeTabCreate: async ({ number }) => {
            if (number !== 1) return;
            createReached();
            await createGate;
        },
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const opening = harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    await reached;
    harness.values.bpbCaptureJobs['1'] = {
        ...structuredClone(harness.values.bpbCaptureJobs['1']),
        id: 'replacement-job',
        phase: 'ready',
        selectedIds: [7],
        uploadGpx: '<gpx>replacement</gpx>',
    };
    releaseCreate();

    const openResult = await opening;
    assert.equal(openResult.phase, 'error');
    assert.equal(openResult.error.code, 'draft-open-cancelled');
    assert.equal(harness.values.bpbCaptureJobs['1'].id, 'replacement-job');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, '<gpx>replacement</gpx>');
    assert.equal(harness.tabs.has(100), false);
    assert.deepEqual(harness.values.bpbDraftTabs || {}, {});
});

test('installing a replacement job removes records owned by the prior generation', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const firstJobId = harness.values.bpbCaptureJobs['1'].id;
    const opened = await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    assert.equal(harness.values.bpbDraftTabs[String(opened.tabIds[0])].jobId, firstJobId);

    const replacement = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: true });

    assert.notEqual(replacement.id, firstJobId);
    assert.equal(harness.values.bpbCaptureJobs['1'].id, replacement.id);
    assert.deepEqual(harness.values.bpbDraftTabs, {},
        'completed draft tabs may remain open for review, but no stale record may join the replacement lifecycle');
    assert.equal(harness.tabs.has(opened.tabIds[0]), true,
        'replacement does not close a completed user-visible draft tab');
});

test('an old Preview completion cannot clear a replacement job GPX', async () => {
    let releaseCompletion;
    let completionReached;
    let held = false;
    const completionGate = new Promise(resolve => { releaseCompletion = resolve; });
    const reached = new Promise(resolve => { completionReached = resolve; });
    const harness = createHarness({
        afterSessionSet: async patch => {
            if (held || !Object.values(patch.bpbDraftTabs || {}).some(draft => draft.complete)) return;
            held = true;
            completionReached();
            await completionGate;
        },
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77,
    }, { tab: { id: 100 } });

    const completion = harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' },
    }, { tab: { id: 100 } });
    await reached;
    const replacement = {
        ...structuredClone(harness.values.bpbCaptureJobs['1']),
        id: 'replacement-job',
        phase: 'ready',
        uploadGpx: '<gpx>replacement</gpx>',
    };
    harness.values.bpbCaptureJobs['1'] = replacement;
    releaseCompletion();

    assert.equal((await completion).action, 'banner');
    assert.equal(harness.values.bpbCaptureJobs['1'].id, 'replacement-job');
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'ready');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, '<gpx>replacement</gpx>');
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
    assert.equal(confirmed.dayStatsPending, true);
    assert.deepEqual(confirmed.dayStats.map(row => row.date), ['2026-07-01', '2026-07-02', '2026-07-03']);
    assert.equal(await harness.send({
        type: 'DRAFT_DAY_STATS_APPLIED', jobId: first.jobId, pid: 7, cid: 77
    }, { tab: { id: 100 } }).then(value => value.ok), false,
    'a day-stat acknowledgment must remain bound to its draft identity');
    assert.equal(await harness.send({
        type: 'DRAFT_DAY_STATS_APPLIED', jobId: first.jobId, pid: 8, cid: 77
    }, { tab: { id: 100 } }).then(value => value.ok), true);
    assert.equal(harness.values.bpbDraftTabs['100'].dayStatsPending, false);
    assert.deepEqual(harness.tabMessages, [{ tabId: 101, message: { type: 'DRAFT_PROCEED' } }]);
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'opened');
    assert.match(harness.values.bpbCaptureJobs['1'].uploadGpx, /<gpx/);

    const second = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 101 } });
    assert.deepEqual({ ...second.fields.tripInfo }, { sequence: 2, name: 'Afternoon Hike', nightsOut: 2 });
    assert.equal(first.fields.wildernessNightsOut, 2);
    assert.equal(second.fields.wildernessNightsOut, 2);
    assert.equal(first.fields.fillAscentDetails, true);
    assert.equal(first.fields.dayStats.length, 3);
    assert.equal(await harness.send({
        type: 'DRAFT_PREVIEW_STARTED', jobId: second.jobId, pid: 7, cid: 77
    }, { tab: { id: 101 } }).then(value => value.ok), true);
    const finished = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    }, { tab: { id: 101 } });
    assert.equal(finished.action, 'banner');
    assert.equal(finished.dayStatsPending, true);
    assert.equal(await harness.send({
        type: 'DRAFT_DAY_STATS_APPLIED', jobId: second.jobId, pid: 7, cid: 77
    }, { tab: { id: 101 } }).then(value => value.ok), true);
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

test('disabled draft autofill settings leave ascent details, trip, and wilderness fields untouched', async () => {
    const harness = createHarness({
        settings: { fillAscentDetails: false, fillTripInfo: false, fillWildernessNights: false, fillExternalUrl: false },
        peakXml: '<p><t i="7" n="First Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/><t i="8" n="Second Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>'
    });
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7, 8] });
    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(apply.fields.fillAscentDetails, false);
    assert.deepEqual([...apply.fields.dayStats], []);
    assert.equal(apply.fields.tripInfo, null);
    assert.equal(apply.fields.wildernessNightsOut, null);
    assert.equal(apply.fields.externalUrl, null, 'the external-URL setting off writes nothing');
});

test('changing capture settings invalidates a reusable job for the same activity', async () => {
    const harness = createHarness();
    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    const firstId = harness.values.bpbCaptureJobs['1'].id;
    harness.syncValues.bpbSettings.retainWaypoints = false;

    await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.notEqual(harness.values.bpbCaptureJobs['1'].id, firstId);
    assert.deepEqual(harness.providerCaptureCalls.at(-1).options, {
        retainWaypoints: false,
        includeTripName: true
    });
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
    assert.equal(harness.peakbaggerPageCalls.length, 0,
        'ownership must fail before any Peakbagger or GPS-coordinate request');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, undefined);
});

test('provider export failures discard page-world exception text without misreporting ownership', async () => {
    const harness = createHarness({
        ownershipResult: { ok: true, provider: 'strava', activityId: '123', viewerId: '42', authorId: '42' },
        captureResult: {
            ok: false,
            code: 'provider-export-failed',
            provider: 'strava',
            activityId: '123',
            message: 'RAW_PAGE_SENTINEL: chrome.runtime.lastError'
        }
    });
    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'error');
    assert.equal(result.error.code, 'provider-export-failed');
    assert.equal(result.error.message,
        'The activity provider could not export this GPX. Reload the activity and try again.');
    assert.doesNotMatch(JSON.stringify(result), /RAW_PAGE_SENTINEL|chrome\.runtime/);
    assert.doesNotMatch(JSON.stringify(harness.values), /RAW_PAGE_SENTINEL|chrome\.runtime/);
    assert.doesNotMatch(result.error.message, /ownership changed/i);
});

test('provider export timeouts preserve the public retryable timeout contract', async () => {
    const harness = createHarness({
        ownershipResult: { ok: true, provider: 'strava', activityId: '123', viewerId: '42', authorId: '42' },
        captureResult: {
            ok: false,
            code: 'provider-export-timeout',
            provider: 'strava',
            activityId: '123',
            message: 'RAW_PAGE_SENTINEL: internal timeout details'
        }
    });

    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(result.error)), {
        code: 'provider-export-timeout',
        message: 'The activity provider took too long to export this GPX. Try again.'
    });
    assert.doesNotMatch(JSON.stringify(result), /RAW_PAGE_SENTINEL|internal timeout/i);
    assert.doesNotMatch(JSON.stringify(harness.values), /RAW_PAGE_SENTINEL|internal timeout/i);
});

test('an activity without a provider GPX ends in a neutral, reusable no-GPS state', async () => {
    const harness = createHarness({
        ownershipResult: { ok: true, provider: 'strava', activityId: '123', viewerId: '42', authorId: '42' },
        captureResult: {
            ok: false,
            code: 'no-gps-data',
            provider: 'strava',
            activityId: '123',
            message: 'This activity has no recorded route to capture.'
        }
    });

    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'no-gps');
    assert.equal(result.error, null);
    assert.equal(result.message, 'This activity has no recorded route to capture.');
    assert.equal(result.hasCachedGpx, false);
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, null);
    assert.equal(harness.peakbaggerPageCalls.filter(call => call.kind === 'peaks').length, 0);
    assert.equal(harness.badgeCalls.some(([kind, details]) => kind === 'text' && details.text === '!'), false);

    const firstJobId = result.id;
    const captureCalls = () => harness.providerCaptureCalls.length;
    assert.equal(captureCalls(), 1);
    const reused = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(reused.id, firstJobId);
    assert.equal(captureCalls(), 1);
    const checkedAgain = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: true });
    assert.notEqual(checkedAgain.id, firstJobId);
    assert.equal(checkedAgain.phase, 'no-gps');
    assert.equal(captureCalls(), 2);
});

test('a nominally successful export with no usable points also ends without an error', async () => {
    const harness = createHarness({
        captureResult: {
            ok: true,
            provider: 'strava',
            activityId: '123',
            metadata: {},
            segments: [[]]
        }
    });

    const result = await harness.send({ type: 'CAPTURE_START', tabId: 1, force: false });
    assert.equal(result.phase, 'no-gps');
    assert.equal(result.error, null);
    assert.equal(result.hasCachedGpx, false);
    assert.equal(harness.peakbaggerPageCalls.filter(call => call.kind === 'peaks').length, 0);
});
