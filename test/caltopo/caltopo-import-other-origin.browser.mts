// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://example.com
//
// The wrong-origin case of caltopo-import.browser.mts, which needs a page on
// another site.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './caltopo-import-fixture.mts';

test('CalTopo import refuses a page on another origin before supply', async () => {
    const r = await run({ url: 'https://example.com/map.html' });
    assert.equal(r.result.ok, false); assert.equal(r.handoffs, 0); assert.equal(r.imports, 0);
});
