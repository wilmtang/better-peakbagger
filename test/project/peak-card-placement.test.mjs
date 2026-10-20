// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { readPeakSunPlacement } from '../../scripts/browser-verification-fixtures.mjs';

test('the shared browser gate accepts an independent card while retaining the native map link', () => {
    const dom = new JSDOM(`<table><tr id="map"><td><iframe id="Gmap"></iframe><a href="BigMap.aspx">Full Screen Map</a></td></tr>
        <tr id="bpb-peak-sun-row"><td><section class="bpb-sun-calculator" data-bpb-peak-card="sun"></section></td></tr></table>`,
    { runScripts: 'outside-only' });
    const doc = dom.window.document;
    const read = () => dom.window.eval(`(${readPeakSunPlacement.toString()})()`);
    try {
        assert.equal(read(), true);
        const sun = doc.querySelector('section');
        doc.querySelector('#map td').append(sun);
        assert.equal(read(), false, 'the obsolete map-cell placement must fail');
        doc.querySelector('#bpb-peak-sun-row td').append(sun);
        doc.getElementById('map').before(doc.getElementById('bpb-peak-sun-row'));
        assert.equal(read(), false, 'the card must follow the native map row');
        doc.getElementById('map').after(doc.getElementById('bpb-peak-sun-row'));
        doc.querySelector('a').remove();
        assert.equal(read(), false, 'losing the native full-screen link must fail');
    } finally { dom.window.close(); }
});

test('Chrome and Firefox broad gates serialize the same placement contract', async () => {
    const chrome = await readFile(new URL('../../scripts/verify-extension.mjs', import.meta.url), 'utf8');
    const firefox = await readFile(new URL('../../scripts/verify-firefox-extension.mjs', import.meta.url), 'utf8');
    assert.match(chrome, /waitForFunction\(readPeakSunPlacement\)/);
    assert.match(firefox, /webdriverScript\(readPeakSunPlacement\)/);
    for (const source of [chrome, firefox]) assert.doesNotMatch(source, /sunAfterLegend/);
});
