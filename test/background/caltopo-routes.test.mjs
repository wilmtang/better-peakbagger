// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMapImportHarness } from '../helpers/map-import-routes-harness.mjs';
import { createCaltopoRoutes } from '../../src/background/caltopo-routes.js';
import { CALTOPO_IMPORT_URL, CALTOPO_PERMISSION } from '../../src/caltopo/caltopo-import.js';

const sender = {
    tab: { id: 7, windowId: 9 },
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=42',
};
const message = {
    type: 'CALTOPO_IMPORT_PREPARE',
    sourceUrl: sender.url,
    filename: 'peakbagger-42.gpx',
    gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>',
    generation: '1',
    grantToken: 'grant',
};

const harness = options => createMapImportHarness({
    createRoutes: createCaltopoRoutes,
    permission: CALTOPO_PERMISSION,
    action: 'caltopo-import',
}, options);

test('CalTopo route opens the exact blank map and consumes one-use authority', async () => {
    const h = harness();
    const result = await h.routes.handlers.CALTOPO_IMPORT_PREPARE(message, sender);
    assert.deepEqual(result, { ok: true, supplied: true, code: 'prepared', message: 'Ready.', targetTabId: 20 });
    assert.deepEqual(h.created, [{ url: CALTOPO_IMPORT_URL, active: false, windowId: 9 }]);
    assert.equal(h.injections.length, 1);
    assert.deepEqual(h.injections[0].args, [{ gpx: message.gpx, filename: message.filename }]);
    assert.equal(h.consumed[0][2], 'caltopo-import');
    assert.deepEqual(h.consumed[0][3], { oneUse: true });
});

test('CalTopo permission fallback uses an extension-owned setup page', async () => {
    const h = harness();
    h.ext.permissions.request = async () => { throw new Error('user input required'); };
    const result = await h.routes.handlers.CALTOPO_PERMISSION_REQUEST({}, sender);
    assert.equal(result.code, 'permission-setup-opened');
    assert.deepEqual(h.created, [{
        url: 'moz-extension://test/caltopo/access.html', active: true, windowId: 9,
    }]);
});

test('CalTopo login redirect focuses the tab without supplying GPX', async () => {
    const h = harness({ redirectUrl: 'https://caltopo.com/login' });
    const result = await h.routes.handlers.CALTOPO_IMPORT_PREPARE(message, sender);
    assert.equal(result.code, 'sign-in-required');
    assert.equal(result.supplied, false);
    assert.equal(result.targetTabId, 20);
    assert.equal(h.injections.length, 0);
});

test('CalTopo route rejects mismatched saved-ascent payloads before using authority', async () => {
    const h = harness();
    const result = await h.routes.handlers.CALTOPO_IMPORT_PREPARE({
        ...message,
        filename: 'peakbagger-43.gpx',
    }, sender);
    assert.equal(result.code, 'forbidden');
    assert.equal(h.consumed.length, 0);
    assert.equal(h.created.length, 0);
});
