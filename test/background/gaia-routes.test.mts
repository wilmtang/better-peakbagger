// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGaiaRoutes } from '../../src/background/gaia-routes.ts';
import { GAIA_MAP_URL, GAIA_PERMISSION, prepareGaiaImport } from '../../src/gaia/gaia-import.ts';

import { createMapImportHarness, savedAscentSender as sender, type MapImportHarnessOptions } from '../helpers/map-import-routes-harness.mts';
import { fieldsOf } from '../helpers/result-fields.mts';
const message = {
    type: 'GAIA_IMPORT_PREPARE',
    sourceUrl: sender.url,
    filename: 'peakbagger-42.gpx',
    gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>',
    generation: '1',
    grantToken: 'grant',
};

const harness = (options?: MapImportHarnessOptions) => createMapImportHarness({
    createRoutes: createGaiaRoutes,
    permission: GAIA_PERMISSION,
    action: 'gaia-import',
}, options);

test('Gaia route consumes one-use authority, opens the map and prepares without saving', async () => {
    const h = harness();
    const result = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.deepEqual(result, { ok: true, supplied: true, code: 'prepared', message: 'Ready.', targetTabId: 20 });
    assert.deepEqual(h.created, [{ url: GAIA_MAP_URL, active: false, windowId: 9 }]);
    assert.equal(h.injections.length, 1);
    assert.deepEqual(h.injections[0].target, { tabId: 20 });
    assert.deepEqual(h.injections[0].args, [{ gpx: message.gpx, filename: message.filename }]);
    assert.equal(h.injections[0].func, prepareGaiaImport);
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
    fallback.ext.permissions.contains = async () => false;
    const result = await fallback.routes.handlers.GAIA_PERMISSION_REQUEST({}, sender);
    assert.equal(fieldsOf(result).code, 'permission-setup-opened');
    assert.deepEqual(fallback.created, [{
        url: 'moz-extension://test/gaia/access.html', active: true, windowId: 9,
    }]);
});

test('signed-out Gaia tab can be reused after sign-in without another tab', async () => {
    const h = harness({ outcome: { ok: false, supplied: false, code: 'sign-in-required', message: 'Sign in.' } });
    const first = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.equal(fieldsOf(first).targetTabId, 20);
    const second = await h.routes.handlers.GAIA_IMPORT_PREPARE({ ...message, targetTabId: 20 }, sender);
    assert.equal(fieldsOf(second).targetTabId, 20);
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
        assert.equal(fieldsOf(result).code, 'forbidden');
    }
    assert.equal(h.consumed.length, 0);
    assert.equal(h.created.length, 0);
});

test('an uncertain executeScript failure suppresses blind retry', async () => {
    const h = harness({ injectError: new Error('worker response lost') });
    const result = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.equal(result.ok, false);
    assert.equal(fieldsOf(result).supplied, true);
    assert.equal(fieldsOf(result).code, 'handoff-unconfirmed');
    assert.equal(fieldsOf(result).targetTabId, 20);
});

test('handoff waits past a provisional complete blank tab before injecting', async () => {
    const h = harness(); const get = h.ext.tabs.get; let reads = 0;
    h.ext.tabs.get = async id => ++reads === 1 ? { id, status: 'complete', url: 'about:blank' } : get(id);
    const result = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(reads, 2); assert.equal(h.injections.length, 1);
});
test('completed login redirects return recovery without waiting for the import URL', async () => {
    const h = harness();
    h.ext.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: 'https://www.gaiagps.com/login/' });
    const result = await h.routes.handlers.GAIA_IMPORT_PREPARE(message, sender);
    assert.equal(result.ok, false); assert.equal(h.injections.length, 0);
    assert.equal(fieldsOf(result).targetTabId, 20);
});


test('an existing map permission survives a request gesture error without opening setup', async () => {
    const h = harness();
    h.ext.permissions.request = async () => { throw new Error('user input required'); };
    h.ext.permissions.contains = async () => true;
    assert.deepEqual(await h.routes.handlers.GAIA_PERMISSION_REQUEST({}, sender), { ok: true });
    assert.equal(h.created.length, 0);
});
