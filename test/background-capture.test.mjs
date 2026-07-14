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

const event = () => {
    const listeners = [];
    return { listeners, addListener: listener => listeners.push(listener) };
};

const createHarness = ({ peakXml = null, captureResult = null, ownershipResult = null } = {}) => {
    const values = {};
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
            }
        },
        runtime: { onMessage: runtimeMessage },
        scripting: {
            executeScript: async details => {
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
    vm.runInContext(source, context, { filename: 'background.js' });
    const listener = runtimeMessage.listeners[0];
    const send = (message, sender = {}) => new Promise(resolve => {
        assert.equal(listener(message, sender, resolve), true);
    });
    return { send, values, tabs, grouped, groupUpdates, badgeCalls, fetchCalls };
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
    assert.match(storedJob.uploadGpx, /<trkpt lat="0" lon="-0.001">/);
    assert.doesNotMatch(storedJob.uploadGpx, /<(?:ele|time|extensions)(?:\s|>)/i);
    assert.equal(JSON.stringify(storedJob).includes('heart'), false);

    const opened = await harness.send({ type: 'CAPTURE_OPEN_DRAFTS', tabId: 1, selectedIds: [7] });
    assert.deepEqual([...opened.tabIds], [100]);
    assert.deepEqual(harness.grouped, [{ tabIds: [100], createProperties: { windowId: 9 } }]);
    assert.deepEqual(harness.groupUpdates, [[3, { title: 'Peak Drafts', color: 'green', collapsed: false }]]);
    assert.equal(harness.tabs.get(100).url, 'https://peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77');

    const apply = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(apply.action, 'apply');
    assert.match(apply.gpx, /<gpx/);
    assert.equal(await harness.send({ type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77 }, { tab: { id: 100 } }).then(value => value.ok), true);

    const banner = await harness.send({ type: 'DRAFT_READY', pid: '7', cid: '77' }, { tab: { id: 100 } });
    assert.equal(banner.action, 'banner');
    assert.equal(harness.values.bpbCaptureJobs['1'].phase, 'previewed');
    assert.equal(harness.values.bpbCaptureJobs['1'].uploadGpx, null);

    const duplicate = await harness.send({ type: 'DRAFT_PREVIEW_STARTED', jobId: apply.jobId, pid: 7, cid: 77 }, { tab: { id: 100 } });
    assert.equal(duplicate.ok, false);
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
