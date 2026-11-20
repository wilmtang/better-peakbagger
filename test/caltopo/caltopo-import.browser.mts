// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://caltopo.com
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CALTOPO_GPX_BYTES } from '../../src/caltopo/caltopo-import.ts';
import { GPX, run } from './caltopo-import-fixture.mts';

test('CalTopo receives the exact file and stops at its populated object review', async () => {
    const r = await run({ repeat: true });
    assert.equal(r.result.code, 'prepared');
    assert.equal(r.result.supplied, true);
    assert.equal(r.text, GPX);
    assert.equal(r.handoffs, 1);
    assert.equal(r.imports, 0);
    assert.equal(r.second!.code, 'existing-preview');
});

test('CalTopo rejects wrong origins, saved maps, queries, and invalid payloads before supply', async () => {
    // caltopo-import-other-origin.browser.mts covers a page on another site.
    for (const options of [{ url: 'https://caltopo.com/m/ABCD' },
        { url: 'https://caltopo.com/map.html?id=ABCD' }, { filename: 'other.gpx' },
        { gpx: 'x'.repeat(MAX_CALTOPO_GPX_BYTES + 1) }]) {
        const r = await run(options);
        assert.equal(r.result.ok, false); assert.equal(r.handoffs, 0); assert.equal(r.imports, 0);
    }
});

test('CalTopo refuses existing previews and ambiguous file controls', async () => {
    for (const options of [{ before: '<div class="yui-panel"><div class="hd">Import Data</div></div>' },
        { before: '<div class="yui-panel"><div class="hd">Importer</div></div>' }, { duplicate: true }]) {
        const r = await run(options);
        assert.equal(r.result.ok, false); assert.equal(r.result.supplied, false); assert.equal(r.handoffs, 0);
    }
});

test('CalTopo treats empty or stalled reviews as uncertain and never supplies twice', async () => {
    for (const options of [{ empty: true }, { ready: false }]) {
        const r = await run({ ...options, repeat: true });
        assert.equal(r.result.code, 'handoff-unconfirmed'); assert.equal(r.result.supplied, true);
        assert.match(String(r.result.message), /Check this CalTopo tab/);
        assert.equal(r.handoffs, 1); assert.equal(r.imports, 0);
        assert.equal(r.second!.ok, false);
    }
});
