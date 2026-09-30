// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';
import { evalBundle, fireTrustedEvent, waitFor } from '../helpers/load-page.mjs';

test('trusted CalTopo access-page click grants only the CalTopo web app', async () => {
    const html = await readFile(new URL('../../src/caltopo/access.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'moz-extension://test/caltopo/access.html', runScripts: 'outside-only' });
    const requests = [];
    dom.window.browser = {
        permissions: {
            request: async value => { requests.push(structuredClone(value)); return true; },
        },
    };
    await evalBundle(dom.window, 'caltopo/access.js');
    fireTrustedEvent(dom.window.document.getElementById('allow-caltopo'), 'click');
    await waitFor(dom, () => /Return to the Peakbagger ascent/.test(
        dom.window.document.getElementById('caltopo-access-status').textContent,
    ));
    assert.deepEqual(requests, [{ origins: ['https://caltopo.com/*'] }]);
    assert.equal(dom.window.document.getElementById('close-caltopo').hidden, false);
    assert.deepEqual(ENTRIES.find(entry => entry.out === 'caltopo/access.js')?.sources,
        ['caltopo/caltopo-import.js', 'caltopo/access.js']);
    assert.ok(COPY_FILES.some(entry => entry[1] === 'caltopo/access.html'));
    dom.window.close();
});
