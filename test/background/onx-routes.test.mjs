// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOnxRoutes } from '../../src/background/onx-routes.js';
import { ONX_IMPORT_URL, ONX_PERMISSION } from '../../src/onx/onx-import.js';

const sender = {
    tab: { id: 7, windowId: 9 },
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=42',
};
const message = {
    type: 'ONX_IMPORT_PREPARE',
    sourceUrl: sender.url,
    filename: 'peakbagger-42.gpx',
    gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>',
    generation: '1',
    grantToken: 'grant',
};

const harness = ({ outcome = { ok: true, supplied: true, code: 'prepared', message: 'Ready.' }, redirectUrl } = {}) => {
    const tabs = new Map();
    const created = [];
    const injections = [];
    const consumed = [];
    let nextId = 20;
    const ext = {
        permissions: {
            request: async request => { assert.deepEqual(request, ONX_PERMISSION); return true; },
            contains: async request => { assert.deepEqual(request, ONX_PERMISSION); return true; },
        },
        runtime: { getURL: path => `moz-extension://test/${path}` },
        tabs: {
            create: async details => {
                created.push(details);
                const tab = {
                    id: nextId++,
                    windowId: details.windowId,
                    url: redirectUrl || details.url,
                    status: 'complete',
                };
                tabs.set(tab.id, tab);
                return { ...tab };
            },
            get: async id => ({ ...tabs.get(id) }),
            update: async () => {},
        },
        windows: { update: async () => {} },
        scripting: {
            executeScript: async details => { injections.push(details); return [{ result: outcome }]; },
        },
    };
    const routes = createOnxRoutes({
        ext,
        isPeakbaggerSender: value => value?.url?.startsWith('https://www.peakbagger.com/'),
        trustedActions: {
            consumeGrant: async (...args) => { consumed.push(args); return true; },
        },
        action: 'onx-import',
    });
    return { ext, routes, created, injections, consumed };
};

test('onX route opens the exact Backcountry importer and consumes one-use authority', async () => {
    const h = harness();
    const result = await h.routes.handlers.ONX_IMPORT_PREPARE(message, sender);
    assert.deepEqual(result, { ok: true, supplied: true, code: 'prepared', message: 'Ready.', targetTabId: 20 });
    assert.equal(ONX_IMPORT_URL, 'https://backcountry.onxmaps.com/backcountry/map/content/import');
    assert.deepEqual(ONX_PERMISSION, { origins: ['https://backcountry.onxmaps.com/*'] });
    assert.deepEqual(h.created, [{ url: ONX_IMPORT_URL, active: false, windowId: 9 }]);
    assert.equal(h.injections.length, 1);
    assert.deepEqual(h.injections[0].args, [{ gpx: message.gpx, filename: message.filename }]);
    assert.equal(h.consumed[0][2], 'onx-import');
    assert.deepEqual(h.consumed[0][3], { oneUse: true });
});

test('onX permission fallback uses an extension-owned setup page', async () => {
    const h = harness();
    h.ext.permissions.request = async () => { throw new Error('user input required'); };
    const result = await h.routes.handlers.ONX_PERMISSION_REQUEST({}, sender);
    assert.equal(result.code, 'permission-setup-opened');
    assert.deepEqual(h.created, [{
        url: 'moz-extension://test/onx/access.html', active: true, windowId: 9,
    }]);
});

test('onX redirect to sign-in focuses the tab without supplying GPX', async () => {
    const h = harness({ redirectUrl: 'https://identity.onxmaps.com/login?flow=test' });
    const result = await h.routes.handlers.ONX_IMPORT_PREPARE(message, sender);
    assert.equal(result.code, 'sign-in-required');
    assert.equal(result.supplied, false);
    assert.equal(result.targetTabId, 20);
    assert.equal(h.injections.length, 0);
});

test('onX route rejects mismatched saved-ascent payloads before using authority', async () => {
    const h = harness();
    const result = await h.routes.handlers.ONX_IMPORT_PREPARE({
        ...message,
        filename: 'peakbagger-43.gpx',
    }, sender);
    assert.equal(result.code, 'forbidden');
    assert.equal(h.consumed.length, 0);
    assert.equal(h.created.length, 0);
});
