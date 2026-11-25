/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite, type DomContext } from '../../../scripts/dom-tier.mts';

const bundle = 'content/peak-links.js';
const panelSelector = '#bpb-peak-links';
const nationRow = (value: string) => `<tr><td>Nation</td><td>${value}</td></tr>`;

const invalidNationRows = [
    ['missing row', ''],
    ['duplicate row', nationRow('Canada') + nationRow('Canada')],
    ['conflicting rows', nationRow('Canada') + nationRow('United States')],
    ['one cell', '<tr><td>Nation</td></tr>'],
    ['three cells', '<tr><td>Nation</td><td>Canada</td><td>United States</td></tr>'],
    ['nested table inside the Nation cell', nationRow(`<table>${nationRow('Canada')}</table>`)],
    ['Nation row inside a nested table', `<tr><td colspan="2"><table>${nationRow('Canada')}</table></td></tr>`],
];

function guardPlanningRequests() {
    const calls: string[] = [];
    const forbid = (label: string) => function () {
        calls.push(label);
        throw new Error(`Planning links must resolve locally (${label})`);
    };
    const api = {
        runtime: { sendMessage: forbid('runtime message') },
        storage: { sync: { get: forbid('sync storage') } },
    };
    Object.assign(window, { fetch: forbid('fetch'), XMLHttpRequest: forbid('XMLHttpRequest'), chrome: api, browser: api });
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: forbid('geolocation') } });
    Object.defineProperty(window, 'planningRequests', { value: calls });
}

async function openPeak({ page, route, open, inject }: DomContext, rows: string, extra = '') {
    await route('/Peak.aspx', `<!doctype html><table id="peak">
        <tr><td>Latitude/Longitude (WGS84)</td><td>49.850562, -123.004672 (Dec Deg)</td></tr>
        ${rows}<tr><td colspan="2"><b>Links</b><br><br><a id="native" href="https://example.com/">Native link</a></td></tr>
        </table>${extra}`);
    await open('/Peak.aspx?pid=875');
    await page.evaluate(guardPlanningRequests);
    const native = await page.locator('#native').evaluate(element => element.outerHTML);
    await inject(bundle);
    return native;
}

async function assertNoRequests({ page }: DomContext) {
    const requests = await page.evaluate(() => (window as Window & { planningRequests?: string[] }).planningRequests);
    assert.deepEqual(requests, [], 'links must not start network, extension or location requests');
}

export default defineDomSuite({
    name: 'avalanche planning links',
    cases: [
        ...invalidNationRows.map(([label, rows]) => ({
            name: `omits country-specific links for ${label}`,
            async run(context: DomContext) {
                await openPeak(context, rows, `<table>${nationRow('United States')}</table>`);
                const panel = context.page.locator(panelSelector);
                assert.match(await panel.innerText(), /No forecast source configured for this location/);
                assert.equal(await panel.locator('a').count(), 2);
                await assertNoRequests(context);
            },
        })),
        {
            name: 'reads independently delimited countries from the native peak table',
            async run(context) {
                await openPeak(context, nationRow('<a>Canada</a><br><a>United States</a>')
                    + `<tr><td colspan="2"><table>${nationRow('France')}</table></td></tr>`);
                const links = context.page.locator(`${panelSelector} a`);
                assert.equal(await links.count(), 5);
                const sources = await links.evaluateAll(anchors => anchors.map(anchor => (anchor as HTMLAnchorElement).hostname));
                assert.deepEqual(sources.filter(host => ['avalanche.ca', 'avalanche.org'].includes(host)), ['avalanche.ca', 'avalanche.org']);
                assert.ok(!sources.includes('eaws-bulletin-map.legner.me'));
                await assertNoRequests(context);
            },
        },
        ...['Canada', 'USA', 'Canada<br>United States', 'France<br>Italy',
            'France<br>Switzerland', 'India', 'Australia', 'Canada / Chile'].map(country => ({
            name: `keeps links safe and idempotent for ${country.replaceAll('<br>', ' / ')}`,
            async run(context: DomContext) {
                const { page, inject } = context;
                const native = await openPeak(context, nationRow(country));
                const panel = page.locator(panelSelector);
                const links = panel.locator('a');
                const anchors = await links.evaluateAll(items => items.map(item => {
                    const { href, target, rel, textContent } = item as HTMLAnchorElement;
                    return { href, target, rel, textContent };
                }));
                assert.ok(anchors.length >= 2);
                for (const anchor of anchors) {
                    assert.equal(new URL(anchor.href).protocol, 'https:');
                    assert.equal(anchor.target, '_blank');
                    assert.equal(anchor.rel, 'noopener noreferrer');
                    assert.doesNotMatch(anchor.href, /pid=|cid=|aid=|gpx|date=/i);
                }
                assert.equal(anchors.some(anchor => anchor.textContent === 'AirNow fire & smoke'), /Canada|USA/.test(country));
                assert.equal(await panel.locator('iframe, img, script, link').count(), 0);
                if (country === 'India') {
                    const directory = links.filter({ hasText: 'DGRE' });
                    assert.equal(await directory.getAttribute('href'), 'https://drdo.gov.in/drdo/en/documents/avalanche-warning-bulletin?page=0');
                    assert.equal(await directory.evaluate(anchor => anchor.nextElementSibling?.textContent),
                        'Find avalanche warning bulletins for Indian Himalayan districts.');
                    assert.doesNotMatch(await panel.innerText(), /No forecast source configured/);
                    assert.equal(anchors.length, 3);
                }
                const before = await panel.evaluate(element => element.outerHTML);
                await inject(bundle);
                assert.equal(await panel.count(), 1, 'reinjecting must leave one planning panel');
                assert.equal(await panel.evaluate(element => element.outerHTML), before);
                assert.equal(await page.locator('#native').evaluate(element => element.outerHTML), native);
                await assertNoRequests(context);
            },
        })),
    ],
});
