// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { projectRoot, waitForCondition } from './browser-verification-fixtures.mjs';
import { weatherFixture } from '../test/helpers/weather-fixture.mjs';

// Production bundles and native nested-table structure; storage, Leaflet and
// weather transport are fixtures. No live requests or native window UI.
export async function verifyAscentColumnWidths(page, origin, variant, { asset, capture }) {
    const fixture = new JSDOM(await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascent.html'), 'utf8'));
    const doc = fixture.window.document;
    const cell = doc.getElementById('summarydata').insertRow().insertCell();
    cell.colSpan = 2;
    cell.innerHTML = '<p align="center"><iframe title="Route map" src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300" width="900" height="300"></iframe></p>'
        + '<p align="center"><a href="/map/BigMap.aspx?t=A">Click Here for a Full Screen Map</a></p>'
        + '<p><small>Note: GPS Tracks may not be accurate, and may not show the best route. Do not follow this route blindly.</small></p>';
    cell.append(doc.getElementById('gpxlinks'));
    doc.getElementById('page').insertAdjacentHTML('beforeend', '<p id="column-following">Following native content</p>');
    const style = doc.createElement('style');
    // Match native cell borders/padding. Do not impose a maximum table width:
    // that would conceal the auto-layout intrinsic sizing defect under test.
    style.textContent = 'body{margin:18px;font:13px/1.4 Tahoma,Arial,sans-serif}'
        + 'table.gray{border-collapse:collapse;background:#eee}'
        + 'table.gray td,table.gray th{border:2px solid #d3d3d3;padding:1px;text-align:left}';
    doc.head.append(style);
    const html = fixture.serialize();
    fixture.window.close();
    const held = [];
    let mode = 'complete';
    const release = () => held.splice(0).forEach(resolve => resolve());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) {
            if (url.pathname === '/climber/ascent.aspx') return route.fulfill({ contentType: 'text/html', body: html });
            return route.fallback();
        }
        if (['archive-api.open-meteo.com', 'historical-forecast-api.open-meteo.com'].includes(url.hostname)) {
            if (mode === 'pending') await new Promise(resolve => held.push(resolve));
            const query = url.searchParams;
            return route.fulfill({ status: mode === 'error' ? 503 : 200, contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(weatherFixture({
                    startDate: query.get('start_date'), fields: query.get('hourly').split(','),
                    hours: (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24,
                })) });
        }
        return route.abort();
    });
    await page.addInitScript(({ theme }) => {
        let preferences = { theme, units: 'metric', showWeather: true, enable3dMap: false, mapViewportWidth: 900, mapViewportHeight: 300 };
        const saved = {}, listeners = new Set();
        globalThis.chrome = {
            storage: { sync: { get: async () => ({ bpbSettings: preferences }) },
                local: { get: async () => saved, set: async values => Object.assign(saved, values) },
                onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) } },
            runtime: { sendMessage: async message => {
                if (message.type !== 'SETTINGS_PATCH') return { ok: false };
                const oldValue = preferences;
                preferences = { ...preferences, ...message.patch };
                listeners.forEach(listener => listener({ bpbSettings: { oldValue, newValue: preferences } }, 'sync'));
                return { ok: true, settings: preferences };
            } },
        };
    }, variant);
    const bounds = () => page.evaluate(() => {
        const rect = element => {
            const r = element.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height, right: r.right + window.scrollX };
        };
        return { column: rect(document.getElementById('bpb-ascent-summary-column')),
            table: rect(document.getElementById('summarydata')), gps: rect(document.getElementById('bpb-ascent-gpx-details')),
            weather: rect(document.getElementById('bpb-ascent-weather')), map: rect(document.getElementById('bpb-map-viewport')),
            heading: rect(document.querySelector('h1')), following: rect(document.getElementById('column-following')),
            scrollY: window.scrollY, scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth,
            overflow: [...document.querySelectorAll('#bpb-ascent-summary-column *')].filter(element =>
                element.getClientRects().length && !element.closest('[hidden]')
                && element.getBoundingClientRect().right > window.innerWidth + 1).map(element => ({
                tag: element.tagName, id: element.id, class: element.getAttribute('class'), width: element.getBoundingClientRect().width,
            })).slice(0, 12) };
    });
    const aligned = async label => {
        const state = await bounds();
        for (const key of ['table', 'gps', 'weather']) {
            assert.ok(Math.abs(state[key].right - state.column.right) <= 1,
                `${label}: ${key} right edge must match its column: ${JSON.stringify(state)}`);
        }
        assert.ok(state.map.right <= state.column.right + 1, `${label}: map must fit its column: ${JSON.stringify(state)}`);
        assert.ok(state.scrollWidth <= state.viewport + 1, `${label}: document must not scroll horizontally: ${JSON.stringify(state)}`);
        return state;
    };
    const stable = async (before, label) => {
        const after = await aligned(label);
        for (const selector of ['heading', 'table', 'gps', 'weather', 'following']) for (const key of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[selector][key] - after[selector][key]) <= 1,
                `${label}: ${selector}.${key} moved: ${JSON.stringify({ before, after })}`);
        }
        assert.equal(after.scrollY, before.scrollY, `${label}: reading position moved`);
    };
    try {
        await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
        await page.evaluate(({ theme }) => { document.documentElement.dataset.bpbTheme = theme; }, variant);
        for (const file of ['css/column-resize.css', 'css/ascent-layout.css', 'css/card-drag.css', 'css/ascent-weather.css', 'css/weather-hourly-table.css', 'css/sun-calculator.css']) {
            await page.addStyleTag({ content: (await asset(file)).toString() });
        }
        for (const file of ['content/theme.js', 'content/ascent-layout.js', 'content/ascent-bridge.js', 'vendor/chart.umd.min.js', 'content/gpx-analyzer.js', 'content/ascent-weather.js']) {
            await page.addScriptTag({ content: (await asset(file)).toString() });
        }
        await page.locator('#bpb-ascent-weather').scrollIntoViewIfNeeded();
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather')?.getAttribute('aria-busy') === 'false'
            && document.querySelector('#bpb-ascent-weather .bpb-weather-result')?.hidden === false
            && /^Interactive Stats:/.test(document.querySelector('.bpb-gpx-stats')?.textContent || ''));
        assert.equal(await page.locator('iframe').evaluate(frame => frame.closest('table')?.id), 'summarydata', 'map must remain nested in the native summary table');
        assert.equal(await page.locator('#bpb-ascent-report-column > table').evaluate(table => getComputedStyle(table).tableLayout), 'auto', 'report column sizing must remain content-driven');
        const handle = page.locator('#bpb-ascent-table-resize-handle');
        const desktop = variant.width > 680;
        for (const share of desktop ? ['Home', 'End', 'Home'] : ['stacked']) {
            if (desktop) { await handle.focus(); await handle.press(share); }
            await waitForCondition(() => page.evaluate(() => {
                const canvas = document.querySelector('#bpb-gpx-analysis canvas');
                return { canvas: canvas.getBoundingClientRect().width, container: canvas.parentElement.getBoundingClientRect().width,
                    animating: document.getElementById('bpb-ascent-weather').getAnimations().some(animation => animation.playState === 'running') };
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
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'true'
            && document.querySelector('.bpb-weather-model-description').textContent.includes('Updating'));
        await waitForCondition(() => held.length > 0, { description: 'held archive-model request' });
        await stable(before, 'pending model refresh');
        mode = 'error'; release();
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'false'
            && document.querySelector('.bpb-weather-status').textContent.length > 0);
        // Error details deliberately add a readable status and Retry action.
        // Their expansion must not reintroduce mismatched horizontal edges.
        const failed = await aligned('failed model refresh');
        await capture(page, `${variant.name}-ascent-columns-error`);
        mode = 'pending';
        // Web-first locator.press scrolls an offscreen control into view. Keep
        // that test-runner scroll separate from the UI's async transitions.
        await page.locator('.bpb-weather-retry').evaluate(button => button.focus({ preventScroll: true }));
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'true');
        await waitForCondition(() => held.length > 0, { description: 'held archive-model retry' });
        await stable(failed, 'retry pending');
        await capture(page, `${variant.name}-ascent-columns-pending`);
        mode = 'complete'; release();
        await page.waitForFunction(() => document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'false'
            && document.querySelector('.bpb-weather-model-description').textContent.includes('Using GFS'));
        await stable(before, 'retry complete');
    } finally { release(); }
}
