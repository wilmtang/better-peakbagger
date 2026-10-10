// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMapImportHarness } from '../helpers/map-import-routes-harness.mjs';
import { createAlltrailsRoutes } from '../../src/background/alltrails-routes.js';
import { ALLTRAILS_IMPORT_URL, ALLTRAILS_PERMISSION } from '../../src/alltrails/alltrails-import.js';

const sender = {
    tab: { id: 7, windowId: 9 },
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=42',
};
const message = {
    type: 'ALLTRAILS_IMPORT_PREPARE',
    sourceUrl: sender.url,
    filename: 'peakbagger-42.gpx',
    gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>',
    generation: '1',
    grantToken: 'grant',
};

const harness = options => createMapImportHarness({
    createRoutes: createAlltrailsRoutes,
    permission: ALLTRAILS_PERMISSION,
    action: 'alltrails-import',
}, options);

test('AllTrails route opens the exact custom route builder and consumes one-use authority', async () => {
    const h = harness();
    const result = await h.routes.handlers.ALLTRAILS_IMPORT_PREPARE(message, sender);
    assert.deepEqual(result, { ok: true, supplied: true, code: 'prepared', message: 'Ready.', targetTabId: 20 });
    assert.deepEqual(h.created, [{ url: ALLTRAILS_IMPORT_URL, active: false, windowId: 9 }]);
    assert.equal(h.injections.length, 1);
    assert.deepEqual(h.injections[0].args, [{ gpx: message.gpx, filename: message.filename }]);
    assert.equal(h.consumed[0][2], 'alltrails-import');
    assert.deepEqual(h.consumed[0][3], { oneUse: true });
});

test('AllTrails permission fallback uses an extension-owned setup page', async () => {
    const h = harness();
    h.ext.permissions.request = async () => { throw new Error('user input required'); };
    const result = await h.routes.handlers.ALLTRAILS_PERMISSION_REQUEST({}, sender);
    assert.equal(result.code, 'permission-setup-opened');
    assert.deepEqual(h.created, [{
        url: 'moz-extension://test/alltrails/access.html', active: true, windowId: 9,
    }]);
});

test('AllTrails login redirect focuses the tab without supplying GPX', async () => {
    const h = harness({ redirectUrl: 'https://www.alltrails.com/login?returnTo=%2Fexplore%2Fcustom-routes%2Fnew' });
    const result = await h.routes.handlers.ALLTRAILS_IMPORT_PREPARE(message, sender);
    assert.equal(result.code, 'sign-in-required');
    assert.equal(result.supplied, false);
    assert.equal(result.targetTabId, 20);
    assert.equal(h.injections.length, 0);
});

test('AllTrails route rejects mismatched saved-ascent payloads before using authority', async () => {
    const h = harness();
    const result = await h.routes.handlers.ALLTRAILS_IMPORT_PREPARE({
        ...message,
        filename: 'peakbagger-43.gpx',
    }, sender);
    assert.equal(result.code, 'forbidden');
    assert.equal(h.consumed.length, 0);
    assert.equal(h.created.length, 0);
});
