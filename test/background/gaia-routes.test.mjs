// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGaiaRoutes } from '../../src/background/gaia-routes.js';
import { GAIA_MAP_URL, GAIA_PERMISSION } from '../../src/gaia/gaia-import.js';

const sender = {
    tab: { id: 7, windowId: 9 },
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=42',
};
const message = {
    type: 'GAIA_IMPORT_PREPARE',
    sourceUrl: sender.url,
    filename: 'peakbagger-42.gpx',
    gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>',
    generation: '1',
    grantToken: 'grant',
};

const harness = ({ outcome = { ok: true, supplied: true, code: 'prepared', message: 'Ready.' }, injectError = null } = {}) => {
    const tabs = new Map();
    let nextId = 20;
    const created = [];
    const updated = [];
    const focused = [];
    const injections = [];
    const consumed = [];
    const ext = {
        permissions: {
            request: async request => {
                assert.deepEqual(request, GAIA_PERMISSION);
                return true;
            },
            contains: async request => {
                assert.deepEqual(request, GAIA_PERMISSION);
                return true;
            },
        },
        runtime: { getURL: path => `moz-extension://test/${path}` },
        tabs: {
            create: async details => {
                created.push(details);
                const tab = { id: nextId++, windowId: details.windowId, url: details.url, status: 'complete' };
                tabs.set(tab.id, tab);
                return { ...tab };
            },
            get: async id => ({ ...tabs.get(id) }),
            update: async (id, patch) => { updated.push([id, patch]); return { ...tabs.get(id), ...patch }; },
        },
        windows: { update: async (id, patch) => { focused.push([id, patch]); } },
        scripting: {
            executeScript: async details => {
                injections.push(details);
                if (injectError) throw injectError;
                return [{ result: outcome }];
            },
        },
    };
    const routes = createGaiaRoutes({
        ext,
        isPeakbaggerSender: value => value?.url?.startsWith('https://www.peakbagger.com/'),
        trustedActions: {
            consumeGrant: async (...args) => { consumed.push(args); return true; },
        },
        action: 'gaia-import',
    });
    return { ext, tabs, routes, created, updated, focused, injections, consumed };
};

test('Gaia route consumes one-use authority, opens the map and prepares without saving', async () => {
    const h = harness();
    const result = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.deepEqual(result, { ok: true, supplied: true, code: 'prepared', message: 'Ready.', targetTabId: 20 });
    assert.deepEqual(h.created, [{ url: GAIA_MAP_URL, active: false, windowId: 9 }]);
    assert.equal(h.injections.length, 1);
    assert.deepEqual(h.injections[0].target, { tabId: 20 });
    assert.deepEqual(h.injections[0].args, [{ gpx: message.gpx, filename: message.filename }]);
    assert.equal(String(h.injections[0].func).includes('click Gaia’s Save'), false);
    assert.equal(h.consumed[0][2], 'gaia-import');
    assert.deepEqual(h.consumed[0][3], { oneUse: true });
    assert.deepEqual(h.updated, [[20, { active: true }]]);
    assert.deepEqual(h.focused, [[9, { focused: true }]]);
});

test('Gaia permission route requests directly and falls back to an extension tab when needed', async () => {
    const granted = harness();
    assert.deepEqual(await granted.routes.handlers.GAIA_PERMISSION_REQUEST({}, sender), { ok: true });
    assert.equal(granted.created.length, 0);

    const fallback = harness();
    fallback.ext.permissions.request = async () => { throw new Error('user input required'); };
    const result = await fallback.routes.handlers.GAIA_PERMISSION_REQUEST({}, sender);
    assert.equal(result.code, 'permission-setup-opened');
    assert.deepEqual(fallback.created, [{
        url: 'moz-extension://test/gaia/access.html', active: true, windowId: 9,
    }]);
});

test('signed-out Gaia tab can be reused after sign-in without another tab', async () => {
    const h = harness({ outcome: { ok: false, supplied: false, code: 'sign-in-required', message: 'Sign in.' } });
    const first = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.equal(first.targetTabId, 20);
    const second = await h.routes.handlers.GAIA_IMPORT_PREPARE({ ...message, targetTabId: 20 }, sender);
    assert.equal(second.targetTabId, 20);
    assert.equal(h.created.length, 1);
    assert.equal(h.injections.length, 2);
});

test('invalid sender payload is rejected before authority or Gaia access', async () => {
    const h = harness();
    for (const candidate of [
        { ...message, sourceUrl: 'https://evil.example/' },
        { ...message, filename: 'peakbagger-43.gpx' },
    ]) {
        const result = await h.routes.handlers.GAIA_IMPORT_PREPARE(candidate, sender);
        assert.equal(result.code, 'forbidden');
    }
    assert.equal(h.consumed.length, 0);
    assert.equal(h.created.length, 0);
});

test('an uncertain executeScript failure suppresses blind retry', async () => {
    const h = harness({ injectError: new Error('worker response lost') });
    const result = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.equal(result.ok, false);
    assert.equal(result.supplied, true);
    assert.equal(result.code, 'handoff-unconfirmed');
    assert.equal(result.targetTabId, 20);
});
