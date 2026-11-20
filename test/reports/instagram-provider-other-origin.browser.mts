// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://other.test
//
// The non-Instagram case of instagram-provider.browser.mts, which needs a
// page on another site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { installInstagramDisplay } from '../../src/reports/instagram-provider.ts';

test('non-Instagram documents cannot install the theme helper', () => {
    const dom = new FixtureDom('<div class="Embed"></div>', { url: 'https://other.test/p/Fixture/embed/captioned/' });
    try {
        const display = installInstagramDisplay(dom.window.document, 'chrome-extension://fixture');
        assert.equal(display, null);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: null, origin: 'chrome-extension://fixture',
            data: { __bpbInstagramDisplay: true, enabled: true, theme: 'dark' } }));
        assert.equal(dom.window.document.documentElement.hasAttribute('data-bpb-instagram-theme'), false);
    } finally { dom.window.close(); }
});
