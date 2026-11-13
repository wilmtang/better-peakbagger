/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The settings sidebar's scroll spy and anchor alignment depend on real
// layout and trusted clicks. jsdom reports every rect as zero, so its suite
// could only check that the spy does not throw; these cases prove the offset
// math. Run with `npm run verify -- dom`.

import assert from 'node:assert/strict';
import { defineDomSuite, type DomContext } from '../../scripts/dom-tier.mts';

const OPTIONS = '/dist/options/options.html';
// The spy's marker: a section is current once its top passes 40px below the
// content pane's top edge (src/ui/section-nav.js).
const MARKER = 40;

const openOptions = async ({ open, page }: DomContext) => {
    await open(OPTIONS);
    await page.locator('.side-nav [aria-current="true"]').waitFor();
};

// Sidebar entries whose section is laid out, in document order.
const visibleTargets = (page: DomContext['page']) => page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('.side-nav a.nav-item, .side-nav a.nav-subitem')]
        .filter(link => !link.closest('[hidden]'))
        .map(link => link.hash.slice(1))
        .filter(id => { const section = document.getElementById(id); return !!section && !section.hidden && section.getClientRects().length > 0; }));

const activeHash = (page: DomContext['page']) =>
    page.locator('.side-nav [aria-current="true"]').evaluate(link => (link as HTMLAnchorElement).hash);

// Scrolls the content pane so the section's top sits `offset` px below the
// pane's top edge, without smooth scrolling.
const placeSection = (page: DomContext['page'], id: string, offset: number) => page.evaluate(placement => {
    const content = document.querySelector<HTMLElement>('.content')!;
    const section = document.getElementById(placement.id)!;
    const delta = section.getBoundingClientRect().top - content.getBoundingClientRect().top - placement.offset;
    content.scrollTo({ top: content.scrollTop + delta, behavior: 'instant' });
    return section.getBoundingClientRect().top - content.getBoundingClientRect().top;
}, { id, offset });

const waitForActive = async (page: DomContext['page'], hash: string, label: string) => {
    try {
        await page.waitForFunction(expected => (document.querySelector('.side-nav [aria-current="true"]') as HTMLAnchorElement | null)?.hash === expected,
            hash, { timeout: 3000 });
    } catch {
        assert.equal(await activeHash(page), hash, label);
    }
};

export default defineDomSuite({
    name: 'options scroll spy',
    cases: [
        {
            name: 'a section becomes current exactly when its top passes the activation marker',
            async run(context) {
                await openOptions(context);
                const { page } = context;
                const targets = await visibleTargets(page);
                assert.ok(targets.length >= 6, `expected a laid-out sidebar, found ${targets.join(', ')}`);
                // A middle section, far from the bottom clamp.
                const index = Math.floor(targets.length / 3), target = targets[index]!, previous = targets[index - 1]!;
                const above = await placeSection(page, target, MARKER - 2);
                assert.ok(Math.abs(above - (MARKER - 2)) <= 1, `${target} placed at ${above}px`);
                await waitForActive(page, `#${target}`, `${target} at ${above}px is past the marker`);
                const below = await placeSection(page, target, MARKER + 2);
                assert.ok(Math.abs(below - (MARKER + 2)) <= 1, `${target} placed at ${below}px`);
                await waitForActive(page, `#${previous}`, `${target} at ${below}px has not reached the marker`);
            },
        },
        {
            name: 'a trusted sidebar click aligns its section to the scroll margin and keeps it current',
            async run(context) {
                await openOptions(context);
                const { page } = context;
                const targets = await visibleTargets(page);
                const target = targets[Math.floor(targets.length / 2)]!;
                await page.locator(`.side-nav a[href="#${target}"]`).click();
                await page.waitForFunction(id => {
                    const content = document.querySelector('.content')!, section = document.getElementById(id)!;
                    const margin = parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
                    return Math.abs(section.getBoundingClientRect().top - content.getBoundingClientRect().top - margin) <= 1;
                }, target, { timeout: 5000 });
                await waitForActive(page, `#${target}`, 'the clicked link stays current after the scroll settles');
                assert.equal(await page.evaluate(() => document.scrollingElement!.scrollTop), 0, 'only the content pane scrolls');
            },
        },
        {
            name: 'with the report editor off, scrolling never makes a hidden editor section current',
            stub: { settings: { enableReportEditor: false } },
            async run(context) {
                await openOptions(context);
                const { page } = context;
                const hiddenLinks = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('.side-nav a')]
                    .filter(link => link.closest('[hidden]')).map(link => link.hash));
                assert.ok(hiddenLinks.length > 0, 'the fixture must hide editor-dependent navigation');
                const visible = await visibleTargets(page);
                for (const target of visible) {
                    await placeSection(page, target, 0);
                    // Scroll events dispatch before the next rendering frame.
                    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    const active = await activeHash(page);
                    assert.ok(!hiddenLinks.includes(active), `${target} at the pane top made hidden ${active} current`);
                    assert.ok(visible.includes(active.slice(1)), `${target} at the pane top made ${active} current`);
                }
            },
        },
    ],
});
