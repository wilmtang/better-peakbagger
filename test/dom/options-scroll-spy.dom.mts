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

type Page = DomContext['page'];
const OPTIONS = '/dist/options/options.html';
// The spy's marker: a section is current once its top is at most 40px below
// the content pane's top edge (src/ui/section-nav.js).
const MARKER = 40;

const openOptions = async ({ open, page }: DomContext) => {
    await open(OPTIONS);
    await page.locator('.side-nav [aria-current="true"]').waitFor();
};

// Sidebar entries whose section is laid out, in document order.
const visibleTargets = (page: Page) => page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('.side-nav a.nav-item, .side-nav a.nav-subitem')]
        .filter(link => !link.closest('[hidden]'))
        .map(link => link.hash.slice(1))
        .filter(id => { const section = document.getElementById(id); return !!section && !section.hidden && section.getClientRects().length > 0; }));

const activeHash = (page: Page) =>
    page.evaluate(() => (document.querySelector('.side-nav [aria-current="true"]') as HTMLAnchorElement | null)?.hash ?? null);

// Scrolls the pane so the section's top sits `offset` px below the pane's top
// edge, without smooth scrolling, and returns the offset actually reached.
const placeSection = (page: Page, id: string, offset: number) => page.evaluate(placement => {
    const content = document.querySelector<HTMLElement>('.content')!;
    const section = document.getElementById(placement.id)!;
    const delta = section.getBoundingClientRect().top - content.getBoundingClientRect().top - placement.offset;
    content.scrollTo({ top: content.scrollTop + delta, behavior: 'instant' });
    return section.getBoundingClientRect().top - content.getBoundingClientRect().top;
}, { id, offset });

// Gates on the spy's own output rather than on frames or time.
const waitForActive = async (page: Page, hash: string, label: string) => {
    try {
        await page.waitForFunction(expected => (document.querySelector('.side-nav [aria-current="true"]') as HTMLAnchorElement | null)?.hash === expected,
            hash, { timeout: 3000 });
    } catch {
        assert.equal(await activeHash(page), hash, label);
    }
};

// What the spy should report at the current scroll position, computed from
// real layout independently of the implementation.
const expectedActive = (page: Page, marker: number) => page.evaluate(limit => {
    const content = document.querySelector<HTMLElement>('.content')!;
    const entries = [...document.querySelectorAll<HTMLAnchorElement>('.side-nav a.nav-item, .side-nav a.nav-subitem')]
        .map(link => ({ link, section: document.getElementById(link.hash.slice(1)) }))
        .filter(({ link, section }) => section && !section.hidden && !link.closest('[hidden]'));
    if (content.scrollHeight > content.clientHeight && content.scrollTop + content.clientHeight >= content.scrollHeight - 2) {
        return entries.at(-1)!.link.hash;
    }
    const top = content.getBoundingClientRect().top + limit;
    let active = entries[0]!.link.hash;
    for (const { link, section } of entries) {
        if (section!.getBoundingClientRect().top <= top) active = link.hash;
        else break;
    }
    return active;
}, marker);

interface ScrollRecord { seen: (string | null)[]; ended: boolean }

export default defineDomSuite({
    name: 'options scroll spy',
    cases: [
        {
            name: 'a section becomes current at the 40px activation marker, to the pixel',
            async run(context) {
                await openOptions(context);
                const { page } = context;
                const targets = await visibleTargets(page);
                assert.ok(targets.length >= 6, `expected a laid-out sidebar, found ${targets.join(', ')}`);
                // A middle section, far from the bottom clamp.
                const index = Math.floor(targets.length / 3), target = targets[index]!, previous = targets[index - 1]!;
                // Scroll positions are whole pixels but layout offsets need not
                // be, so find the last reachable offset at or inside the marker.
                let inside = await placeSection(page, target, MARKER);
                if (inside > MARKER) inside = await placeSection(page, target, MARKER - 1);
                assert.ok(inside <= MARKER && inside > MARKER - 1, `${target} placed at ${inside}px`);
                await waitForActive(page, `#${target}`, `${target} at ${inside}px is within the marker`);
                const outside = await placeSection(page, target, inside + 1);
                assert.ok(outside > MARKER && outside <= MARKER + 1, `${target} placed at ${outside}px`);
                await waitForActive(page, `#${previous}`, `${target} at ${outside}px has not reached the marker`);
            },
        },
        {
            name: 'a trusted sidebar click keeps its link current through the smooth scroll and after it settles',
            async run(context) {
                await openOptions(context);
                const { page } = context;
                // Start from a scroll position whose target lies inside the
                // smooth-scroll limit (two viewports or 1200px) with sections
                // in between, so the spy would sweep through them if the click
                // did not lock the highlight.
                const plan = await page.evaluate(() => {
                    const content = document.querySelector<HTMLElement>('.content')!;
                    const limit = Math.min(content.clientHeight * 2, 1200) - 40;
                    const links = [...document.querySelectorAll<HTMLAnchorElement>('.side-nav a.nav-item, .side-nav a.nav-subitem')]
                        .filter(link => !link.closest('[hidden]'));
                    const distance = (link: HTMLAnchorElement) => document.getElementById(link.hash.slice(1))!.getBoundingClientRect().top
                        - content.getBoundingClientRect().top;
                    for (const start of links) {
                        content.scrollTo({ top: content.scrollTop + distance(start), behavior: 'instant' });
                        if (Math.abs(distance(start)) > 1) continue;
                        const candidates = links.filter(link => distance(link) > 200 && distance(link) < limit);
                        for (const target of candidates.reverse()) {
                            const passed = links.filter(link => distance(link) > 40 && distance(link) < distance(target)).length;
                            if (passed >= 2) return { start: start.hash, hash: target.hash, passed };
                        }
                    }
                    return null;
                });
                assert.ok(plan, 'expected a smooth-scroll target with sections in between');
                await waitForActive(page, await expectedActive(page, MARKER), 'the starting position settles');
                await page.evaluate(() => {
                    const record: ScrollRecord = { seen: [], ended: false };
                    const content = document.querySelector('.content')!;
                    const read = () => (document.querySelector('.side-nav [aria-current="true"]') as HTMLAnchorElement | null)?.hash ?? null;
                    content.addEventListener('scroll', () => record.seen.push(read()));
                    content.addEventListener('scrollend', () => { record.seen.push(read()); record.ended = true; });
                    Object.defineProperty(globalThis, '__scrollRecord', { value: record });
                });
                const record = () => page.evaluate(() => (globalThis as unknown as { __scrollRecord: ScrollRecord }).__scrollRecord);
                await page.locator(`.side-nav a[href="${plan.hash}"]`).click();
                await page.waitForFunction(() => (globalThis as unknown as { __scrollRecord: ScrollRecord }).__scrollRecord.ended, null, { timeout: 5000 });
                const { seen } = await record();
                assert.ok(seen.length >= 3, `the click must animate through several scroll events, saw ${seen.length}`);
                assert.deepEqual([...new Set(seen)], [plan.hash], 'the highlight never sweeps through intermediate sections');
                const aligned = await page.evaluate(hash => {
                    const content = document.querySelector('.content')!, section = document.getElementById(hash.slice(1))!;
                    const margin = parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
                    return section.getBoundingClientRect().top - content.getBoundingClientRect().top - margin;
                }, plan.hash);
                assert.ok(Math.abs(aligned) <= 1, `the section lands on its scroll margin (off by ${aligned}px)`);
                assert.equal(await activeHash(page), plan.hash, 'the lock releases without recomputing the highlight');
                assert.equal(await page.evaluate(() => document.scrollingElement!.scrollTop), 0, 'only the content pane scrolls');
            },
        },
        {
            name: 'with the report editor off, every scroll position reports the visible section the layout puts at the marker',
            stub: { settings: { enableReportEditor: false } },
            async run(context) {
                await openOptions(context);
                const { page } = context;
                // Editor-dependent navigation hides only after the asynchronous settings read populates the page.
                await page.waitForFunction(() => [...document.querySelectorAll('.side-nav a')].some(link => link.closest('[hidden]')));
                const hiddenLinks = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('.side-nav a')]
                    .filter(link => link.closest('[hidden]')).map(link => link.hash));
                for (const target of await visibleTargets(page)) {
                    await placeSection(page, target, 0);
                    const expected = await expectedActive(page, MARKER);
                    assert.ok(!hiddenLinks.includes(expected), `the independent expectation chose hidden ${expected}`);
                    await waitForActive(page, expected, `${target} at the pane top`);
                }
            },
        },
    ],
});
