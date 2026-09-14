// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';
import { evalBundle, fireTrustedEvent, waitFor } from '../helpers/load-page.mjs';

const load = async granted => {
    const html = await readFile(new URL('../../src/gaia/access.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'moz-extension://test/gaia/access.html', runScripts: 'outside-only' });
    const requests = [];
    dom.window.browser = {
        permissions: {
            request: async value => { requests.push(structuredClone(value)); return granted; },
        },
    };
    await evalBundle(dom.window, 'gaia/access.js');
    return { dom, requests };
};

test('Gaia access page is a complete packaged extension surface', async () => {
    const html = await readFile(new URL('../../src/gaia/access.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../src/gaia/access.css', import.meta.url), 'utf8');
    assert.deepEqual(ENTRIES.find(entry => entry.out === 'gaia/access-head.js')?.sources,
        ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js']);
    assert.deepEqual(ENTRIES.find(entry => entry.out === 'gaia/access.js')?.sources,
        ['gaia/gaia-import.js', 'gaia/access.js']);
    assert.ok(COPY_FILES.some(entry => entry[1] === 'gaia/access.html'));
    assert.ok(COPY_FILES.some(entry => entry[1] === 'css/gaia-access.css'));
    assert.match(html, /<script src="access-head\.js"><\/script>\s*<link rel="stylesheet" href="\.\.\/css\/panel\.css">/);
    assert.doesNotMatch(css, /--(?:light|dark)-(?:bg|card|border|text|accent)/);
});

test('trusted access-page click grants only Gaia and shows the return action', async () => {
    const { dom, requests } = await load(true);
    fireTrustedEvent(dom.window.document.getElementById('allow-gaia'), 'click');
    await waitFor(dom, () => /Return to the Peakbagger ascent/.test(
        dom.window.document.getElementById('gaia-access-status').textContent,
    ));
    assert.deepEqual(requests, [{ origins: ['https://www.gaiagps.com/*'] }]);
    assert.equal(dom.window.document.getElementById('allow-gaia').textContent, 'Gaia access enabled');
    assert.equal(dom.window.document.getElementById('close-gaia').hidden, false);
});

test('denied access stays retryable and synthetic clicks are ignored', async () => {
    const denied = await load(false);
    fireTrustedEvent(denied.dom.window.document.getElementById('allow-gaia'), 'click');
    await waitFor(denied.dom, () => /not granted/.test(
        denied.dom.window.document.getElementById('gaia-access-status').textContent,
    ));
    assert.equal(denied.dom.window.document.getElementById('allow-gaia').disabled, false);

    const forged = await load(true);
    forged.dom.window.document.getElementById('allow-gaia').dispatchEvent(new forged.dom.window.Event('click'));
    await new Promise(resolve => forged.dom.window.setTimeout(resolve, 20));
    assert.equal(forged.requests.length, 0);
});
