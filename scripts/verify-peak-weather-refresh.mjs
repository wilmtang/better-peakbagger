// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, waitForCondition } from './browser-verification-fixtures.mjs';
import { weatherFixture, weatherModelFixture } from '../test/helpers/weather-fixture.mjs';
import { PEAK_WEATHER_MODELS } from '../src/weather/peak-weather-models.js';

// Runs in the layout verifier's hidden browser, with real shipped assets and
// held provider responses. No live account, map or weather requests are made.
export async function verifyPeakWeatherRefresh(page, origin, variant, { asset, capture }) {
    // Share a fixed clock with the response horizon. After UTC midnight, the
    // live clock can still be yesterday at Rainier and add a sixteenth date.
    const now = new Date('2026-10-10T12:00:00Z');
    await page.clock.setFixedTime(now);
    const html = (await readFile(path.join(projectRoot, 'test/fixtures/pages/peak-rainier.html'), 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
    const held = [];
    let mode = 'complete', requests = 0;
    const release = () => held.splice(0).forEach(resolve => resolve());
    const transport = async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname.toLowerCase() === '/peak.aspx') {
            return route.fulfill({ contentType: 'text/html', body: html });
        }
        if (url.hostname === 'api.open-meteo.com' && url.pathname === '/v1/forecast') {
            requests++;
            if (mode === 'loading') await new Promise(resolve => held.push(resolve));
            const query = url.searchParams;
            const body = weatherFixture({ startDate: query.get('start_date'), fields: query.get('hourly').split(','),
                hours: (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24 });
            return route.fulfill({ status: mode === 'error' ? 400 : 200, contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' },
                body: mode === 'error' ? 'Unavailable' : JSON.stringify(weatherModelFixture(body, query.get('models').split(','),
                    Object.fromEntries(PEAK_WEATHER_MODELS.map(model => [model.id,
                        Date.parse(now.toISOString().slice(0, 10)) / 1000 + model.forecastDays * 86400])))) });
        }
        return route.abort();
    };
    await page.route('**/*', transport);
    await page.addInitScript(({ theme }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { storage: { sync: { get: async () => ({ bpbSettings: { theme, units: 'metric' } }) },
            local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {}, removeListener() {} } } };
    }, variant);
    const geometry = () => page.evaluate(() => {
        const card = document.getElementById('bpb-peak-weather');
        const bounds = element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
        };
        return { card: bounds(card), picker: bounds(card.querySelector('select')), refresh: bounds(card.querySelector('.bpb-week-refresh')),
            days: bounds(card.querySelector('.bpb-week-days')), footer: bounds(card.querySelector('footer')),
            scrollY: window.scrollY, focus: document.activeElement.id,
            sameDays: !window.__weatherDays || window.__weatherDays.every((node, index) => node === card.querySelectorAll('.bpb-week-day')[index]) };
    });
    const stable = (before, after, label, keys = ['card', 'picker', 'refresh', 'days', 'footer']) => {
        for (const selector of keys) for (const key of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[selector][key] - after[selector][key]) <= 1,
                `${label}: ${selector}.${key} moved; ${JSON.stringify({ before, after })}`);
        }
        assert.equal(after.scrollY, before.scrollY, `${label}: viewport scrolled`);
        assert.equal(after.focus, before.focus, `${label}: focus moved`);
    };
    const pending = async (model, count) => {
        await page.selectOption('#bpb-peak-weather-model', model);
        await page.waitForFunction(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'true'
            && document.querySelector('.bpb-week-status').textContent.startsWith('Updating… Showing'));
        await waitForCondition(() => requests >= count, { description: 'held model request' });
    };
    try {
        for (const zoom of [1, 2]) for (const period of ['forecast', 'past']) {
            mode = 'complete'; release();
            await page.goto(`${origin}/peak.aspx?pid=2296`);
            await page.addStyleTag({ content: (await asset('css/peak-weather.css')).toString() });
            await page.addScriptTag({ content: (await asset('content/peak-weather.js')).toString() });
            await page.locator('#bpb-peak-weather').scrollIntoViewIfNeeded();
            await page.waitForFunction(() => document.querySelectorAll('.bpb-week-day').length === 16
                && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false');
            if (period === 'past') await page.click('[data-period="past"]');
            if (variant.width > 600) await page.locator('#bpb-peak-weather').evaluate(card => {
                // Exercise side-by-side controls as well as the native narrow
                // right column. This is a fixture-only column sizing change.
                card.closest('table').style.width = `${window.innerWidth - 32}px`;
            });
            if (zoom === 2) await page.addStyleTag({ content: '#bpb-peak-weather .bpb-week-status{font-size:24px}' });
            await page.locator('.bpb-week-day > summary').first().click();
            await page.locator('.bpb-week-day[open] [data-metric="temperature"]').click();
            await page.evaluate(() => {
                const card = document.getElementById('bpb-peak-weather');
                card.scrollIntoView({ block: 'start', behavior: 'instant' });
                card.querySelector('select').focus({ preventScroll: true });
                window.__weatherDays = [...card.querySelectorAll('.bpb-week-day')];
            });
            const before = await geometry(), label = `${variant.name}-${period}-${zoom}`;
            mode = 'loading'; await pending('best_match', requests + 1);
            stable(before, await geometry(), `${label} pending`);
            assert.equal((await geometry()).sameDays, true, 'loaded weather stays mounted while loading');
            // More selections before the first response must not bounce the
            // picker or commit the abandoned model's result.
            await pending('icon_global', requests + 1);
            stable(before, await geometry(), `${label} repeated pending`);
            await pending('best_match', requests + 1);
            stable(before, await geometry(), `${label} latest pending`);
            await capture(page, `${label}-pending`);
            mode = 'complete'; release();
            await page.waitForFunction(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false'
                && document.querySelector('.bpb-week-models').textContent.startsWith('Best Match'));
            stable(before, await geometry(), `${label} complete`);
            await capture(page, `${label}-complete`);
            await page.evaluate(() => { window.__weatherDays = [...document.querySelectorAll('.bpb-week-day')]; });
            mode = 'loading'; await pending('ecmwf_ifs025', requests + 1);
            const complete = await geometry();
            mode = 'error'; release();
            await page.waitForFunction(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false'
                && document.querySelector('.bpb-week-status').textContent.includes('Showing Best Match'));
            // A necessary error may add readable rows below the controls, but
            // must not move the picker or Refresh, nor hide the retained data.
            stable(complete, await geometry(), `${label} error`, ['picker', 'refresh']);
            assert.equal((await geometry()).sameDays, true, 'failure retains the latest successful weather');
            const errorDays = await page.locator('.bpb-week-day').count();
            await capture(page, `${label}-error`);
            mode = 'loading';
            await page.evaluate(() => document.querySelector('.bpb-week-refresh').focus({ preventScroll: true }));
            const retryBefore = await geometry(), count = requests + 1;
            await page.keyboard.press('Enter');
            await waitForCondition(() => requests >= count, { description: 'keyboard retry request' });
            stable(retryBefore, await geometry(), `${label} keyboard retry`, ['picker', 'refresh']);
            mode = 'complete'; release();
            await page.waitForFunction(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false'
                && document.querySelector('.bpb-week-models').textContent.startsWith('IFS 0.25°'));
            assert.equal(errorDays, 16, 'failed request keeps the full Best Match forecast/history');
            assert.equal(await page.locator('.bpb-week-day').count(), period === 'past' ? 16 : 15,
                'a successful model may deliberately shorten its forecast horizon');
            stable(retryBefore, await geometry(), `${label} retry complete`, ['picker', 'refresh']);
        }
    } catch (error) {
        const live = await page.locator('#bpb-peak-weather').evaluate(card => ({ busy: card.getAttribute('aria-busy'),
            status: card.querySelector('.bpb-week-status').textContent, model: card.querySelector('select').value,
            source: card.querySelector('.bpb-week-models').textContent }));
        throw new Error(`${error.message}; live UI: ${JSON.stringify(live)}; requests: ${requests}; mode: ${mode}`, { cause: error });
    } finally { release(); await page.unroute('**/*', transport); }
}
