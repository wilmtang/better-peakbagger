/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Host-page Svelte island check: mounts SummitCloudControls inside
// dist/content/summit-cloud.js alongside dist/content/peak-cards.js on the
// Peakbagger Peak fixture in real Chromium and Firefox.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defineDomSuite, type DomContext } from '../../scripts/dom-tier.mts';
import { cloudResponseForUrl } from '../helpers/summit-cloud-fixture.mts';

const rawRainierHtml = await readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8');
const PEAK_PAGE_HTML = rawRainierHtml
    .replace(/background-image\s*:\s*url\([^)]*\)\s*;?/gi, '')
    .replace(/<link\b[^>]*rel=["']shortcut icon["'][^>]*>/gi, '')
    .replace(/<img\b[^>]*>/gi, '<span></span>')
    .replace(
        '</head>',
        [
            '<link rel="stylesheet" href="/dist/css/column-resize.css">',
            '<link rel="stylesheet" href="/dist/css/peak-card-layout.css">',
            '<link rel="stylesheet" href="/dist/css/summit-cloud.css">',
            '</head>',
        ].join(''),
    );

type OpenMeteoMode = 'ok' | 'rate-limit';

interface OpenedPeakPage {
    readonly requests: string[];
    setMode(next: OpenMeteoMode): void;
}

const openPeakPage = async (context: DomContext): Promise<OpenedPeakPage> => {
    const requests: string[] = [];
    let mode: OpenMeteoMode = 'ok';
    await context.route('/peak.aspx', PEAK_PAGE_HTML);
    await context.route('/map/MasterMap.aspx', '<!doctype html><html><body></body></html>');
    await context.page.route('https://api.open-meteo.com/**', async route => {
        const url = route.request().url();
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/data/')) {
            const nowSec = Math.floor(Date.now() / 1000);
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    last_run_initialisation_time: nowSec - 3600,
                    last_run_availability_time: nowSec - 600,
                    update_interval_seconds: 21600,
                }),
            });
            return;
        }
        requests.push(url);
        if (mode === 'rate-limit') {
            await route.fulfill({
                status: 429,
                headers: { 'retry-after': '60' },
                contentType: 'text/plain',
                body: '',
            });
            return;
        }
        const payload = cloudResponseForUrl(url);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(payload),
        });
    });

    await context.open('/peak.aspx?pid=2296');
    await context.inject('content/summit-cloud.js', 'content/peak-cards.js');
    await context.page.locator('#bpb-summit-cloud [data-summit-cloud-controls] #bpb-summit-cloud-model').waitFor();
    await context.page.evaluate(() => document.getElementById('bpb-summit-cloud')!.scrollIntoView({ block: 'center' }));
    await context.page.waitForFunction(() => document.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.');
    return {
        requests,
        setMode(next) { mode = next; },
    };
};

export default defineDomSuite({
    name: 'summit cloud island',
    cases: [
        {
            name: 'coexists with peak-cards, persists model and date changes, isolates form submission, and snaps back on cooldown',
            viewport: { width: 1280, height: 900 },
            stub: {
                settings: {
                    showSummitCloud: true,
                    bpbSummitCloudModel: 'icon_global',
                },
            },
            async run(context) {
                const { page } = context;
                const harness = await openPeakPage(context);

                const structure = await page.evaluate(() => {
                    const card = document.getElementById('bpb-summit-cloud')!;
                    const host = card.querySelector<HTMLElement>('[data-summit-cloud-controls]')!;
                    const model = document.getElementById('bpb-summit-cloud-model') as HTMLSelectElement;
                    const date = document.getElementById('bpb-summit-cloud-date') as HTMLSelectElement;
                    const refresh = card.querySelector<HTMLButtonElement>('.bpb-cloud-refresh')!;
                    return {
                        cardTag: card.dataset.bpbPeakCard,
                        rowId: card.closest('tr')?.id ?? null,
                        insideBody: Boolean(host.closest('.bpb-peak-card-body')),
                        directChildren: [...host.children].map(child => child.tagName.toLowerCase()),
                        modelFormAttr: model.getAttribute('form'),
                        dateFormAttr: date.getAttribute('form'),
                        modelFormProp: model.form,
                        dateFormProp: date.form,
                        modelValue: model.value,
                        refreshDisabled: refresh.getAttribute('aria-disabled'),
                        hasForm1: Boolean(document.getElementById('Form1')),
                        hasGmap: Boolean(document.getElementById('Gmap')),
                    };
                });

                assert.equal(structure.cardTag, 'cloud');
                assert.equal(structure.rowId, 'bpb-summit-cloud-row');
                assert.equal(structure.insideBody, true);
                assert.deepEqual(structure.directChildren, ['label', 'label', 'button']);
                assert.equal(structure.modelFormAttr, '');
                assert.equal(structure.dateFormAttr, '');
                assert.equal(structure.modelFormProp, null, 'model select must stay detached from host ASP.NET form');
                assert.equal(structure.dateFormProp, null, 'date select must stay detached from host ASP.NET form');
                assert.equal(structure.modelValue, 'icon_global');
                assert.equal(structure.refreshDisabled, 'false');
                assert.equal(structure.hasForm1, true);
                assert.equal(structure.hasGmap, true);

                // Select a different model and verify persistence + network query.
                const beforeCount = harness.requests.length;
                await page.locator('#bpb-summit-cloud-model').selectOption('gfs_global');
                await page.waitForFunction(expected => (
                    document.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.'
                    && (document.getElementById('bpb-summit-cloud-model') as HTMLSelectElement).value === expected
                    && ((globalThis as unknown as { __bpbDomTier?: { messages: { patch?: Record<string, unknown> }[] } })
                        .__bpbDomTier?.messages ?? []).some(msg => msg.patch?.bpbSummitCloudModel === expected)
                ), 'gfs_global');
                assert.ok(harness.requests.slice(beforeCount).some(url => new URL(url).searchParams.get('models') === 'gfs_global'));

                // Change date using a non-bubbling DOM change event (mirroring existing host/test callers).
                const secondDate = await page.evaluate(() => {
                    const select = document.getElementById('bpb-summit-cloud-date') as HTMLSelectElement;
                    return select.options[1]?.value ?? '';
                });
                assert.ok(secondDate.length > 0);
                const beforeDateCount = harness.requests.length;
                await page.evaluate(value => {
                    const select = document.getElementById('bpb-summit-cloud-date') as HTMLSelectElement;
                    select.value = value;
                    select.dispatchEvent(new Event('change'));
                }, secondDate);
                await page.waitForFunction(expected => (
                    document.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.'
                    && (document.getElementById('bpb-summit-cloud-date') as HTMLSelectElement).value === expected
                ), secondDate);
                assert.ok(harness.requests.length > beforeDateCount);

                // Rate limit locks controls and snaps back direct non-bubbling DOM mutations immediately.
                harness.setMode('rate-limit');
                await page.locator('.bpb-cloud-refresh').click();
                await page.waitForFunction(() => (
                    document.querySelector('.bpb-cloud-status')?.textContent === 'Cloud requests limited. Try again later.'
                    && document.getElementById('bpb-summit-cloud-model')?.getAttribute('aria-disabled') === 'true'
                    && document.querySelector('.bpb-cloud-refresh')?.getAttribute('aria-disabled') === 'true'
                ));
                const blockedSnapshot = await page.evaluate(() => {
                    const select = document.getElementById('bpb-summit-cloud-model') as HTMLSelectElement;
                    select.value = 'auto';
                    select.dispatchEvent(new Event('change'));
                    return {
                        modelAfterBlocked: select.value,
                        modelDisabled: select.getAttribute('aria-disabled'),
                        dateDisabled: document.getElementById('bpb-summit-cloud-date')?.getAttribute('aria-disabled'),
                    };
                });
                assert.equal(blockedSnapshot.modelAfterBlocked, 'gfs_global');
                assert.equal(blockedSnapshot.modelDisabled, 'true');
                assert.equal(blockedSnapshot.dateDisabled, 'true');
            },
        },
        {
            name: 'survives collapse, wide and narrow column reparenting, BFCache lifecycle, and disposes cleanly',
            viewport: { width: 1280, height: 900 },
            stub: {
                settings: {
                    showSummitCloud: true,
                    bpbSummitCloudModel: 'gfs_global',
                },
            },
            async run(context) {
                const { page } = context;
                await openPeakPage(context);

                const measureControls = () => page.evaluate(() => {
                    const card = document.getElementById('bpb-summit-cloud')!;
                    const host = card.querySelector<HTMLElement>('[data-summit-cloud-controls]')!;
                    const cardRect = card.getBoundingClientRect();
                    const hostRect = host.getBoundingClientRect();
                    const controls = [...host.querySelectorAll<HTMLElement>('select, button')].map(el => {
                        const rect = el.getBoundingClientRect();
                        return { id: el.id || el.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
                    });
                    return {
                        cardOverflow: card.scrollWidth > card.clientWidth + 1,
                        cardRight: cardRect.right,
                        hostWidth: hostRect.width,
                        hostHeight: hostRect.height,
                        controls,
                        columnTableAlign: card.closest('table.gray')?.getAttribute('align') ?? null,
                    };
                });

                const wideBefore = await measureControls();
                assert.equal(wideBefore.cardOverflow, false, 'wide desktop card must not horizontally overflow');
                assert.ok(wideBefore.hostWidth > 0 && wideBefore.hostHeight > 0);
                for (const item of wideBefore.controls) {
                    assert.ok(item.width > 0 && item.height > 0, `${item.id} has visible box`);
                    assert.ok(item.right <= wideBefore.cardRight + 1, `${item.id} stays inside card width`);
                }

                // Collapse and expand through peak-card-layout toggle without losing the mounted island.
                await page.locator('#bpb-summit-cloud .bpb-peak-card-toggle').click();
                await page.waitForFunction(() => document.getElementById('bpb-summit-cloud')?.dataset.bpbCardCollapsed === 'true');
                assert.equal(await page.locator('#bpb-summit-cloud .bpb-peak-card-body').isHidden(), true);
                await page.locator('#bpb-summit-cloud .bpb-peak-card-toggle').click();
                await page.waitForFunction(() => document.getElementById('bpb-summit-cloud')?.dataset.bpbCardCollapsed === 'false');
                assert.equal(await page.locator('#bpb-summit-cloud-model').inputValue(), 'gfs_global');

                // Resize to narrow mobile viewport, triggering column-layout/container-query adaptation.
                await page.setViewportSize({ width: 390, height: 900 });
                await page.waitForFunction(() => {
                    const card = document.getElementById('bpb-summit-cloud');
                    return Boolean(card && card.getBoundingClientRect().width <= 390);
                });
                const narrow = await measureControls();
                assert.equal(narrow.cardOverflow, false, 'narrow card must not horizontally overflow');
                for (const item of narrow.controls) {
                    assert.ok(item.right <= narrow.cardRight + 1, `${item.id} stays inside narrow card`);
                }

                // Restore desktop viewport and verify controls still respond.
                await page.setViewportSize({ width: 1280, height: 900 });
                await page.waitForFunction(() => {
                    const card = document.getElementById('bpb-summit-cloud');
                    return Boolean(card && card.getBoundingClientRect().width > 390);
                });

                // BFCache suspend + resume + final pagehide disposal.
                await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
                await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
                assert.equal(await page.locator('#bpb-summit-cloud').count(), 1);
                await page.locator('#bpb-summit-cloud-model').selectOption('icon_global');
                await page.waitForFunction(() => (
                    document.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.'
                    && (document.getElementById('bpb-summit-cloud-model') as HTMLSelectElement).value === 'icon_global'
                ));

                await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
                await page.waitForFunction(() => (
                    document.querySelector('#bpb-summit-cloud [data-summit-cloud-controls]')?.children.length === 0
                ));
            },
        },
    ],
});
