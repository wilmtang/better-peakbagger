// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';
import { evalBundle, fireTrustedEvent, waitFor } from '../helpers/load-page.mjs';

for (const [id, name, origin] of [
    ['gaia', 'Gaia', 'https://www.gaiagps.com/*'],
    ['onx', 'onX', 'https://backcountry.onxmaps.com/*'],
    ['alltrails', 'AllTrails', 'https://www.alltrails.com/*'],
    ['caltopo', 'CalTopo', 'https://caltopo.com/*'],
]) {
    test(`${name} packaged access preserves trusted permission, retry, focus, and close behavior`, async t => {
        const html = await readFile(new URL(`../../src/${id}/access.html`, import.meta.url), 'utf8');
        assert.deepEqual(ENTRIES.find(entry => entry.out === `${id}/access.js`)?.sources,
            [`${id}/${id}-import.js`, `${id}/access.js`]);
        assert.deepEqual(ENTRIES.find(entry => entry.out === `${id}/access-head.js`)?.sources,
            ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js']);
        assert.ok(COPY_FILES.some(entry => entry[1] === `${id}/access.html`));
        assert.match(html, /<script src="access-head\.js"><\/script>\s*<link rel="stylesheet" href="\.\.\/css\/panel\.css">/);
        const dom = new JSDOM(html, { url: `moz-extension://test/${id}/access.html`, runScripts: 'outside-only' });
        t.after(dom.window.close.bind(dom.window));
        const requests = [];
        let outcome = false, closes = 0;
        dom.window.browser = { permissions: { request: async value => {
            requests.push(structuredClone(value));
            if (outcome instanceof Error) throw outcome;
            return outcome;
        } } };
        dom.window.close = () => { closes++; };
        await evalBundle(dom.window, `${id}/access.js`);
        const button = dom.window.document.getElementById(`allow-${id}`);
        const close = dom.window.document.getElementById(`close-${id}`);
        const status = dom.window.document.getElementById(`${id}-access-status`);
        button.click(); close.click();
        assert.equal(requests.length, 0, 'synthetic clicks cannot request permission');
        assert.equal(closes, 0, 'synthetic clicks cannot close the page');
        for (const [result, message] of [[false, 'not granted'], [new Error('browser error'), 'could not change'], [true, 'Return to']]) {
            outcome = result;
            const before = requests.length;
            fireTrustedEvent(button, 'click');
            assert.equal(requests.length, before + 1, 'permission request must start within the trusted event');
            assert.deepEqual(requests.at(-1), { origins: [origin] });
            await waitFor(dom, () => status.textContent.includes(message));
            assert.equal(button.disabled, result === true);
            assert.equal(close.hidden, result !== true);
        }
        assert.equal(button.textContent, `${name} access enabled`);
        assert.equal(dom.window.document.activeElement, close);
        fireTrustedEvent(close, 'click');
        assert.equal(closes, 1);
    });
}
