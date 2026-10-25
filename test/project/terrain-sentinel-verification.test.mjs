// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createMapLayerControl } from '../../src/maps/map-layer-control.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { readSentinelCooldown } from '../../scripts/verify-terrain-provider-ui.mjs';

test('terrain cooldown verification reads the actual shared control and requires an intercepted catalog request', t => {
    const dom = new JSDOM('<iframe id="bpb-terrain-frame"></iframe>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const doc = dom.window.document, frame = doc.querySelector('iframe').contentWindow;
    const control = createMapLayerControl({ document: doc });
    t.after(() => control.dispose());
    doc.body.append(control.element);
    const state = Schema.mapOverlayState({ sentinel: { enabled: true } });
    const statuses = { sentinel: { error: true, retry: true, retryAt: Date.now() + 120000,
        message: 'Satellite service is busy. Try again later.' } };
    control.render({ state, statuses, zoom: 13 });
    control.trigger.click();
    doc.querySelector('[data-layer="sentinel"] button').click();
    frame.__bpbTerrainTestMap = { getZoom: () => 13 };
    const read = () => dom.window.eval(`(${readSentinelCooldown})()`);
    assert.equal(read().ready, false, 'a matching message without the HTTP 429 probe cannot pass');
    frame.__bpbCatalogLimitRequests = 1;
    assert.equal(read().ready, true);
    assert.match(read().message, /Service busy.*Retry after/);
    assert.equal(doc.querySelector('[data-overlay="sentinel"]').textContent.includes('Satellite service is busy'), false,
        'the former verifier waited for session copy replaced by the shared cooldown presentation');
    for (const status of [{ pending: true }, { error: true, retry: true }, {}]) {
        control.render({ state, statuses: { sentinel: status }, zoom: 13 });
        assert.equal(read().ready, false, JSON.stringify(status));
    }
    control.render({ state, statuses, zoom: 8 });
    assert.equal(read().ready, false, 'zoom guidance is not evidence of a cooldown');
});
