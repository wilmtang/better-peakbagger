/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite, type DomContext } from '../../scripts/dom-tier.mts';
import { EARLY_THEME_STYLE_ID, THEME_CACHE_KEY } from '../../src/theme/theme-bootstrap.ts';

async function assertDarkScrollBoundary(page: DomContext['page'], styleId: string) {
    const state = await page.locator(`style#${styleId}`).evaluate(sheet => {
        const style = getComputedStyle(document.documentElement);
        return {
            css: sheet.textContent ?? '',
            overscroll: style.overscrollBehaviorY,
            background: style.backgroundColor,
        };
    });
    assert.equal(state.overscroll, 'none', `${styleId} must disable vertical root overscroll`);
    assert.equal(state.background, 'rgb(24, 26, 27)', `${styleId} must paint the dark root`);
    const root = /html\[data-bpb-theme="dark"\]\s*\{([^}]+)\}/.exec(state.css);
    assert.ok(root, `${styleId} must scope the root rules to the dark theme`);
    assert.match(root[1], /overscroll-behavior-y:\s*none/);
    assert.match(root[1], /background:\s*#181a1b/);
}

export default defineDomSuite({
    name: 'dark theme scroll boundaries',
    cases: [{
        name: 'the early and full dark site theme disable vertical bounce at the root',
        stub: { settings: { theme: 'dark' } },
        async run({ page, route, open, inject }) {
            const fixture = '/fixture/theme-scroll-boundaries.html';
            const wallpaper = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
            await route('/image/mewallp.gif', wallpaper, 'image/gif');
            await route(fixture, '<!doctype html><html><head><title>Theme fixture</title></head><body><p>Scroll boundary</p></body></html>');
            await open(fixture);
            await page.evaluate(key => localStorage.setItem(key, 'dark'), THEME_CACHE_KEY);

            await inject('content/theme-early.js');
            assert.equal(await page.locator('#bpb-site-dark').count(), 0);
            await assertDarkScrollBoundary(page, EARLY_THEME_STYLE_ID);

            await inject('content/theme.js');
            assert.equal(await page.locator(`#${EARLY_THEME_STYLE_ID}`).count(), 0);
            await assertDarkScrollBoundary(page, 'bpb-site-dark');
        },
    }],
});
