// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';
import { evalBundle, fireTrustedEvent, waitFor } from '../helpers/load-page.mjs';

test('trusted onX access-page click grants only the Web Map host', async () => {
    const html = await readFile(new URL('../../src/onx/access.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'moz-extension://test/onx/access.html', runScripts: 'outside-only' });
    const requests = [];
    dom.window.browser = {
        permissions: {
            request: async value => { requests.push(structuredClone(value)); return true; },
        },
    };
    await evalBundle(dom.window, 'onx/access.js');
    fireTrustedEvent(dom.window.document.getElementById('allow-onx'), 'click');
    await waitFor(dom, () => /Return to the Peakbagger ascent/.test(
        dom.window.document.getElementById('onx-access-status').textContent,
    ));
    assert.deepEqual(requests, [{ origins: ['https://webmap.onxmaps.com/*'] }]);
    assert.equal(dom.window.document.getElementById('close-onx').hidden, false);
    assert.deepEqual(ENTRIES.find(entry => entry.out === 'onx/access.js')?.sources,
        ['onx/onx-import.js', 'onx/access.js']);
    assert.ok(COPY_FILES.some(entry => entry[1] === 'onx/access.html'));
    dom.window.close();
});
