// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initBCLandAccess } from '../../src/maps/bc-land-access.js';

test('packaged BC setup retains focus, guards duplicate work and notifies only its source tab', async () => {
    const dom = new JSDOM('<button id="allow-bc-land">Allow access</button><p id="bc-land-access-status"></p>', { url: 'https://extension.test/bc-land/access.html?tab=7' });
    const button = dom.window.document.querySelector('button'), notifications = []; let handler, requests = 0, resolve, closed = 0;
    button.addEventListener = (_type, listener) => { handler = listener; };
    initBCLandAccess({ document: dom.window.document, ext: { permissions: { request: () => { requests++; return new Promise(done => { resolve = done; }); } },
        tabs: { sendMessage: async (...args) => notifications.push(args) } }, close: () => { closed++; } });
    try {
        button.focus(); await handler({ isTrusted: false }); assert.equal(requests, 0);
        const first = handler({ isTrusted: true }); await handler({ isTrusted: true }); assert.equal(requests, 1);
        assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(dom.window.document.activeElement, button);
        resolve(false); await first; assert.equal(button.textContent, 'Allow access'); assert.equal(notifications.length, 0);
        const retry = handler({ isTrusted: true }); resolve(true); await retry;
        assert.equal(button.textContent, 'Return to map'); assert.equal(dom.window.document.activeElement, button);
        assert.deepEqual(notifications, [[7, { type: 'BC_LAND_PERMISSION_GRANTED' }]]);
        await handler({ isTrusted: true }); assert.equal(closed, 1); assert.equal(requests, 2);
    } finally { dom.window.close(); }
});
