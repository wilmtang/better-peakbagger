/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference types="chrome" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { projectRoot, waitForCondition, withOfflineFixturePage } from './browser-verification-fixtures.mts';
import { weatherFixture } from '../test/helpers/weather-fixture.mjs';

export interface ColumnWidthVariant {
    name: string;
    theme: string;
    width: number;
    [field: string]: unknown;
}

export interface ColumnWidthHelpers {
    asset: (file: string) => Promise<Buffer>;
    capture: (page: Page, label: string, reference?: boolean) => Promise<unknown>;
}

// Production bundles and native nested-table structure; storage, Leaflet and
// weather transport are fixtures. No live requests or native window UI.
export async function verifyAscentColumnWidths(
    page: Page,
    origin: string,
    variant: ColumnWidthVariant,
    { asset, capture }: ColumnWidthHelpers,
): Promise<void> {
    const source = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    const html = await withOfflineFixturePage(page.context(), fixturePage => fixturePage.evaluate(markup => {
        const doc = new DOMParser().parseFromString(markup, 'text/html');
        const cell = (doc.getElementById('summarydata') as HTMLTableElement).insertRow().insertCell();
        cell.colSpan = 2;
        cell.innerHTML = '<p align="center"><iframe title="Route map" src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300" width="900" height="300"></iframe></p>'
            + '<p align="center"><a href="/map/BigMap.aspx?t=A">Click Here for a Full Screen Map</a></p>'
            + '<p><small>Note: GPS Tracks may not be accurate, and may not show the best route. Do not follow this route blindly.</small></p>';
        cell.append(doc.getElementById('gpxlinks')!);
        doc.getElementById('page')!.insertAdjacentHTML('beforeend', '<p id="column-following">Following native content</p>');
        const style = doc.createElement('style');
        // Match native cell borders/padding. A maximum table width would
        // conceal the auto-layout intrinsic sizing defect under test.
        style.textContent = 'body{margin:18px;font:13px/1.4 Tahoma,Arial,sans-serif}'
            + 'table.gray{border-collapse:collapse;background:#eee}'
            + 'table.gray td,table.gray th{border:2px solid #d3d3d3;padding:1px;text-align:left}';
        doc.head.append(style);
        const serializer = new XMLSerializer();
        return [...doc.childNodes].map(node => node === doc.documentElement
            ? doc.documentElement.outerHTML : serializer.serializeToString(node)).join('');
    }, source));
    const held: (() => void)[] = [];
    let mode = 'complete';
    const release = () => held.splice(0).forEach(resolve => resolve());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) {
            if (url.pathname === '/climber/ascent.aspx') return route.fulfill({ contentType: 'text/html', body: html });
            return route.fallback();
        }
        if (['archive-api.open-meteo.com', 'historical-forecast-api.open-meteo.com'].includes(url.hostname)) {
            if (mode === 'pending') await new Promise<void>(resolve => held.push(resolve));
            const query = url.searchParams;
            return route.fulfill({ status: mode === 'error' ? 503 : 200, contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(weatherFixture({
                    startDate: query.get('start_date') ?? undefined, fields: query.get('hourly')!.split(','),
                    hours: (Date.parse(query.get('end_date')!) - Date.parse(query.get('start_date')!)) / 3600_000 + 24,
                })) });
        }
        return route.abort();
    });
    await page.addInitScript(({ theme }: { theme: string }) => {
        let preferences: Record<string, unknown> = { theme, units: 'metric', showWeather: true, enable3dMap: false, mapViewportWidth: 900, mapViewportHeight: 300 };
        const saved: Record<string, unknown> = {};
        const listeners = new Set<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void>();
        globalThis.chrome = {
            storage: { sync: { get: async () => ({ bpbSettings: preferences }) },
                local: { get: async () => saved, set: async (values: Record<string, unknown>) => Object.assign(saved, values) },
                onChanged: {
                    addListener: (listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => listeners.add(listener),
                    removeListener: (listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => listeners.delete(listener),
                } },
            runtime: { sendMessage: async (message: { type?: string; patch?: Record<string, unknown> }) => {
                if (message.type !== 'SETTINGS_PATCH') return { ok: false };
                const oldValue = preferences;
                preferences = { ...preferences, ...message.patch };
                listeners.forEach(listener => listener({ bpbSettings: { oldValue, newValue: preferences } }, 'sync'));
                return { ok: true, settings: preferences };
            } },
        } as unknown as typeof chrome;
    }, variant);
    const bounds = () => page.evaluate(() => {
        const rect = (element: Element) => {
            const r = element.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height, right: r.right + window.scrollX };
        };
        return { column: rect(document.getElementById('bpb-ascent-summary-column')!),
            table: rect(document.getElementById('summarydata')!), gps: rect(document.getElementById('bpb-ascent-gpx-details')!),
            weather: rect(document.getElementById('bpb-ascent-weather')!), map: rect(document.getElementById('bpb-map-viewport')!),
            heading: rect(document.querySelector('h1')!), following: rect(document.getElementById('column-following')!),
            scrollY: window.scrollY, scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth,
            overflow: [...document.querySelectorAll('#bpb-ascent-summary-column *')].filter(element =>
                element.getClientRects().length && !element.closest('[hidden]')
                && element.getBoundingClientRect().right > window.innerWidth + 1).map(element => ({
                tag: element.tagName, id: element.id, class: element.getAttribute('class'), width: element.getBoundingClientRect().width,
            })).slice(0, 12) };
    });
    const aligned = async (label: string) => {
        const state = await bounds();
        for (const key of ['table', 'gps', 'weather'] as const) {
            assert.ok(Math.abs(state[key].right - state.column.right) <= 1,
                `${label}: ${key} right edge must match its column: ${JSON.stringify(state)}`);
        }
        assert.ok(state.map.right <= state.column.right + 1, `${label}: map must fit its column: ${JSON.stringify(state)}`);
        assert.ok(state.scrollWidth <= state.viewport + 1, `${label}: document must not scroll horizontally: ${JSON.stringify(state)}`);
        return state;
    };
    const stable = async (before: Awaited<ReturnType<typeof bounds>>, label: string) => {
        const after = await aligned(label);
        for (const selector of ['heading', 'table', 'gps', 'weather', 'following'] as const) for (const key of ['x', 'y', 'width', 'height'] as const) {
            assert.ok(Math.abs(before[selector][key] - after[selector][key]) <= 1,
                `${label}: ${selector}.${key} moved: ${JSON.stringify({ before, after })}`);
        }
        assert.equal(after.scrollY, before.scrollY, `${label}: reading position moved`);
    };
    try {
        await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
        await page.evaluate(({ theme }: { theme: string }) => { document.documentElement.dataset.bpbTheme = theme; }, variant);
        for (const file of ['css/column-resize.css', 'css/ascent-layout.css', 'css/card-drag.css', 'css/ascent-weather.css', 'css/weather-hourly-table.css', 'css/sun-calculator.css']) {
            await page.addStyleTag({ content: (await asset(file)).toString() });
        }
        for (const file of ['content/theme.js', 'content/ascent-layout.js', 'content/ascent-bridge.js', 'vendor/chart.umd.min.js', 'content/gpx-analyzer.js', 'content/ascent-weather.js']) {
            await page.addScriptTag({ content: (await asset(file)).toString() });
        }
        await page.locator('#bpb-ascent-weather').scrollIntoViewIfNeeded();
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather')?.getAttribute('aria-busy') === 'false'
            && document.querySelector<HTMLElement>('#bpb-ascent-weather .bpb-weather-result')?.hidden === false
            && /^Interactive Stats:/.test(document.querySelector('.bpb-gpx-stats')?.textContent || ''));
        assert.equal(await page.locator('iframe').evaluate((frame: Element) => frame.closest('table')?.id), 'summarydata', 'map must remain nested in the native summary table');
        assert.equal(await page.locator('#bpb-ascent-report-column > table').evaluate((table: Element) => getComputedStyle(table).tableLayout), 'auto', 'report column sizing must remain content-driven');
        const summaryWidths = await page.locator('#summarydata').evaluate((table: HTMLTableElement) => {
            const row = [...table.rows].find(candidate => candidate.cells.length === 2 && (candidate.cells[0].textContent || '').includes('Total Elevation Gain'))!;
            return [...row.cells].map(summaryCell => summaryCell.getBoundingClientRect().width);
        });
        assert.ok(Math.abs(summaryWidths[0] - summaryWidths[1]) > 2,
            `summary labels and values must size to their different content, not equal halves: ${JSON.stringify(summaryWidths)}`);
        await page.locator('#summarydata').evaluate((table: Element) => table.scrollIntoView({ block: 'start' }));
        await capture(page, `${variant.name}-native-summary-columns`);
        const handle = page.locator('#bpb-ascent-table-resize-handle');
        const desktop = variant.width > 680;
        for (const share of desktop ? ['Home', 'End', 'Home'] : ['stacked']) {
            if (desktop) { await handle.focus(); await handle.press(share); }
            await waitForCondition(() => page.evaluate(() => {
                const canvas = document.querySelector('#bpb-gpx-analysis canvas')!;
                return { canvas: canvas.getBoundingClientRect().width, container: canvas.parentElement!.getBoundingClientRect().width,
                    animating: document.getElementById('bpb-ascent-weather')!.getAnimations().some(animation => animation.playState === 'running') };
            }), { description: 'GPX chart settles after column resizing',
                isReady: state => !state.animating && Math.abs(state.canvas - state.container) <= 1 });
            await aligned(`${variant.name}/${share}`);
        }
        if (desktop) {
            const before = await handle.getAttribute('aria-valuenow');
            await handle.dispatchEvent('pointerdown', { button: 0, pointerId: 7, clientX: 400 });
            await handle.dispatchEvent('pointermove', { pointerId: 7, clientX: 450 });
            await handle.dispatchEvent('pointercancel', { pointerId: 7 });
            assert.equal(await handle.getAttribute('aria-valuenow'), before, 'pointer cancellation restores column width');
            await aligned('cancelled column drag');
        }
        await page.locator('#bpb-ascent-weather').scrollIntoViewIfNeeded();
        await capture(page, `${variant.name}-ascent-columns`);
        const picker = page.locator('#bpb-ascent-weather-model');
        await picker.focus();
        const before = await aligned('before model refresh');
        mode = 'pending'; await picker.selectOption('gfs_global');
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather')!.getAttribute('aria-busy') === 'true'
            && (document.querySelector('.bpb-weather-model-description')!.textContent || '').includes('Updating'));
        await waitForCondition(() => held.length > 0, { description: 'held archive-model request' });
        await stable(before, 'pending model refresh');
        mode = 'error'; release();
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather')!.getAttribute('aria-busy') === 'false'
            && (document.querySelector('.bpb-weather-status')!.textContent || '').length > 0);
        // Error details deliberately add a readable status and Retry action.
        // Their expansion must not reintroduce mismatched horizontal edges.
        const failed = await aligned('failed model refresh');
        await capture(page, `${variant.name}-ascent-columns-error`);
        mode = 'pending';
        // Web-first locator.press scrolls an offscreen control into view. Keep
        // that test-runner scroll separate from the UI's async transitions.
        await page.locator('.bpb-weather-retry').evaluate((button: HTMLElement) => button.focus({ preventScroll: true }));
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather')!.getAttribute('aria-busy') === 'true');
        await waitForCondition(() => held.length > 0, { description: 'held archive-model retry' });
        await stable(failed, 'retry pending');
        await capture(page, `${variant.name}-ascent-columns-pending`);
        mode = 'complete'; release();
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather')!.getAttribute('aria-busy') === 'false'
            && (document.querySelector('.bpb-weather-model-description')!.textContent || '').includes('Using GFS'));
        await stable(before, 'retry complete');
    } finally { release(); }
}

// Native peak metadata, the production split/map owners and an oversized saved
// map preference. Storage and the frame response remain fixture-owned.
export async function verifyPeakColumnWidths(
    page: Page,
    origin: string,
    variant: ColumnWidthVariant,
    { asset, capture }: ColumnWidthHelpers,
): Promise<void> {
    const html = (await readFile(path.join(projectRoot, 'test/fixtures/pages/peak-rainier.html'), 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('https://**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.route('**/peak.aspx**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.addInitScript(({ theme }: { theme: string }) => {
        localStorage.setItem('pbPeakMapViewport.v1', JSON.stringify({ width: 900, height: 425 }));
        const area = { get: async () => ({ bpbSettings: { theme, enable3dMap: false } }) };
        globalThis.chrome = { storage: { sync: area, local: { get: async () => ({}) },
            onChanged: { addListener() {}, removeListener() {} } } } as unknown as typeof chrome;
    }, variant);
    await page.goto(`${origin}/peak.aspx?pid=2296`);
    for (const file of ['css/column-resize.css', 'css/peak-card-layout.css', 'css/terrain-map.css', 'css/sun-calculator.css']) {
        await page.addStyleTag({ content: (await asset(file)).toString() });
    }
    for (const file of ['content/theme.js', 'content/peak-cards.js', 'content/peak-map.js']) {
        await page.addScriptTag({ content: (await asset(file)).toString() });
    }
    await page.locator('.bpb-peak-map-region #bpb-map-viewport').waitFor();
    const inspect = async (label: string) => {
        const state = await page.evaluate(() => {
            const rect = (element: Element) => {
                const r = element.getBoundingClientRect(); return { right: r.right, width: r.width };
            };
            return [...document.querySelectorAll<HTMLTableElement>('#bpb-peak-table-split .bpb-peak-native-table')].map(table => {
                const row = [...table.rows].find(candidate => candidate.cells.length === 2 && candidate.cells[0].colSpan === 1)!;
                const map = table.querySelector('#bpb-map-viewport');
                return { table: rect(table), column: rect(table.parentElement!),
                    cells: [...row.cells].map(cell => rect(cell).width),
                    map: map ? rect(map) : null };
            });
        });
        assert.equal(state.length, 2, `${label}: both native metadata tables`);
        for (const item of state) {
            assert.ok(Math.abs(item.cells[0] - item.cells[1]) > 2,
                `${label}: metadata labels and values must size to content: ${JSON.stringify(item)}`);
            assert.ok(item.table.right <= item.column.right + 1,
                `${label}: natural table sizing must stay within its column: ${JSON.stringify(item)}`);
            if (item.map) assert.ok(item.map.right <= item.column.right + 1,
                `${label}: the saved 900px map must shrink to its column: ${JSON.stringify(item)}`);
        }
    };
    await inspect('initial peak columns');
    if (await page.evaluate(() => window.innerWidth > 680)) {
        for (const key of ['Home', 'End', 'Home']) {
            await page.locator('#bpb-peak-table-resize-handle').press(key);
            await inspect(`peak divider ${key}`);
        }
    }
    await page.locator('#bpb-peak-details-column > .bpb-peak-native-table').evaluate((table: Element) => table.scrollIntoView({ block: 'start' }));
    await capture(page, `${variant.name}-peak-columns`);
}
