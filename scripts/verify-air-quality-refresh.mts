// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic renderer edge cases supplement the real-extension weather
// harness. Provider responses and time are stubbed; host markup and shipped CSS
// are real. This tier does not prove manifest/permission or native AT behavior.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { airQualityFixture } from '../test/helpers/air-quality-fixture.mjs';
import type { createAirQualityView } from '../src/weather/air-quality-view.ts';

declare global { interface Window {
    __airClock: number; __airView: ReturnType<typeof createAirQualityView>;
    __airPoint: { latitude: number; longitude: number };
    AirModule: { createAirQualityView: typeof createAirQualityView };
} }
const selection = process.argv[2] || 'chrome';
if (process.argv.length > 3 || !['chrome', 'firefox'].includes(selection)) throw new Error('Usage: node scripts/verify-air-quality-refresh.mts [chrome|firefox]');
const root = fileURLToPath(new URL('../', import.meta.url)), resources = createResourceStack();
// Deliberately remove one sizing reservation in a disposable fixture so the
// geometry assertion proves it detects header collapse or page scroll clamping.
const reproduce = process.env.BPB_VERIFY_AIR_REGRESSION;
if (reproduce && !['header', 'loaded'].includes(reproduce)) throw new Error(`Unknown AQI regression: ${reproduce}`);
// Legacy JS inference omits its required, default-less temporaryRoot option.
const createFixtures = createBrowserFixtureServer as (options: { temporaryRoot: string }) => ReturnType<typeof createBrowserFixtureServer>;
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-air-refresh-'));
resources.defer('AQI fixture/profile', () => rm(temporaryRoot, { recursive: true, force: true }));
try {
    const fixture = await createFixtures({ temporaryRoot });
    resources.defer('AQI HTTPS server', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const html = (await readFile(path.join(root, 'test/fixtures/pages/peak-rainier.html'), 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
    const built = await build({ entryPoints: [path.join(root, 'src/weather/air-quality-view.ts')], bundle: true, write: false, format: 'iife', globalName: 'AirModule' });
    if (selection === 'chrome') assertChromeLaunchAllowed();
    const context = await (selection === 'chrome' ? chromium : firefox).launchPersistentContext(path.join(temporaryRoot, 'profile'), {
        ...(selection === 'chrome' ? { channel: 'chromium', ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
            : { firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }),
        headless: true, ignoreHTTPSErrors: true, viewport: { width: 1000, height: 1000 },
    });
    resources.defer('AQI hidden browser', () => context.close());
    const now = Date.parse('2024-11-03T08:30:00Z'); // 01:30 PDT; next hour is 01:30 PST.
    await context.addInitScript(clock => { window.__airClock = clock; Date.now = () => window.__airClock; }, now);
    let requests = 0;
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'air-quality-api.open-meteo.com') {
            requests++;
            const clock = await route.request().frame().page().evaluate(() => window.__airClock);
            const body = airQualityFixture({ now: clock, latitude: Number(url.searchParams.get('latitude')), longitude: Number(url.searchParams.get('longitude')) }); body.hourly.us_aqi.fill(35); body.hourly.pm2_5.fill(10);
            await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        } else if (url.origin === origin && url.pathname === '/peak.aspx') await route.fulfill({ status: 200, contentType: 'text/html', body: html });
        else await route.abort();
    });
    const cases = [];
    const scenarios = [
        { name: 'pacific', now, point: { latitude: 46.85, longitude: -121.75 }, next: /01:00 AM PST/ },
        { name: 'lord-howe', now: Date.parse('2024-04-06T14:30:00Z'), point: { latitude: -31.55, longitude: 159.08 }, next: /01:30 AM GMT\+10:30/ },
    ];
    for (const scenario of scenarios) for (const width of [1000, 390]) {
        const page = await context.newPage();
        try {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(`${origin}/peak.aspx?pid=2296&aqi-layout=1`);
            await page.evaluate(state => { window.__airClock = state.now; window.__airPoint = state.point; }, { now: scenario.now, point: scenario.point });
            for (const css of ['card.css', 'peak-weather.css', 'weather-hourly-table.css']) await page.addStyleTag({ path: path.join(root, 'dist/css', css) });
            await page.evaluate(() => {
                const native = document.querySelector<HTMLTableElement>('table.gray[align="right"]')!;
                native.style.width = 'min(760px, 100%)'; native.style.float = 'none'; document.body.replaceChildren(native);
                const cell = document.createElement('td'); cell.colSpan = 2;
                const card = document.createElement('section'); card.id = 'bpb-peak-weather'; card.dataset.bpbCard = 'weather';
                const heading = document.createElement('h2'); heading.textContent = 'Summit weather'; card.append(heading); cell.append(card);
                const row = document.createElement('tr'); row.append(cell); native.tBodies[0].append(row);
                const following = document.createElement('p'); following.id = 'after-weather'; following.textContent = 'Following native content'; document.body.append(following);
            });
            await page.addScriptTag({ content: built.outputFiles[0].text });
            if (reproduce === 'header') await page.addStyleTag({ content: '#bpb-peak-weather .bpb-air-table [data-sizing-only]{display:none}' });
            if (reproduce === 'loaded') await page.addStyleTag({ content: '#bpb-peak-weather .bpb-air-loaded [data-sizing-text]{display:none}' });
            await page.evaluate(() => {
                window.__airView = window.AirModule.createAirQualityView({ readLocation: () => window.__airPoint, available: () => true });
                document.getElementById('bpb-peak-weather')!.append(window.__airView.panel); window.__airView.select(true);
            });
            await page.waitForFunction(() => document.querySelector<HTMLTableElement>('.bpb-air-table')?.tBodies[0].rows.length === 2 && document.querySelector('#bpb-peak-weather-air')?.getAttribute('aria-busy') === 'false');
            await page.locator('.bpb-air-hours').focus(); await page.keyboard.press('ArrowRight');
            const live = await page.locator('.bpb-air-readout').evaluate(node => ({ atomic: node.getAttribute('aria-atomic'), live: node.getAttribute('aria-live'), time: node.querySelector('.bpb-air-time')?.textContent }));
            assert.equal(live.atomic, 'true'); assert.equal(live.live, 'polite'); assert.match(live.time!, scenario.next);
            const visibleZones = await page.locator('.bpb-air-table .bpb-weather-hour-zone:not([data-sizing-only])').allTextContents();
            assert.ok(visibleZones.every(label => label.length <= 6), `timezone headers overflow compact columns: ${visibleZones}`);
            const selected = scenario.now - 1800000 + 6 * 3600000;
            await page.locator('[aria-label="Refresh air quality"]').scrollIntoViewIfNeeded();
            await page.evaluate(timestamp => { document.querySelector<HTMLElement>(`th[data-air-time="${timestamp}"]`)!.click(); document.querySelector<HTMLElement>('.bpb-air-hours')!.scrollLeft = 347; }, selected);
            const measure = () => page.evaluate(() => {
                const list = document.querySelector<HTMLElement>('.bpb-air-hours')!, rect = list.getBoundingClientRect();
                const table = document.querySelector<HTMLTableElement>('.bpb-air-table')!, pinned = table.tHead!.rows[1].cells[0].getBoundingClientRect().width;
                const visible = [...table.tHead!.rows[1].cells].slice(1).find(cell => cell.getBoundingClientRect().right > rect.left + pinned)!;
                return { first: visible.dataset.airTime, offset: visible.getBoundingClientRect().left - rect.left,
                    height: rect.height, button: document.querySelector('[aria-label="Refresh air quality"]')!.getBoundingClientRect().top,
                    following: document.getElementById('after-weather')!.getBoundingClientRect().top, scroll: window.scrollY,
                    documentHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight, clientHeight: document.documentElement.clientHeight,
                    selected: table.querySelector<HTMLElement>('[aria-current="time"]')?.dataset.airTime };
            });
            const before = await measure();
            await page.locator('[aria-label="Refresh air quality"]').focus();
            const focused = await measure();
            await page.evaluate(() => { window.__airClock += 3600000; }); await page.keyboard.press('Enter');
            await page.waitForFunction(first => document.querySelector<HTMLTableElement>('.bpb-air-table')!.tHead!.rows[1].cells[1].dataset.airTime === String(first)
                && document.querySelector('#bpb-peak-weather-air')!.getAttribute('aria-busy') === 'false', scenario.now - 1800000 + 3600000);
            const after = await measure();
            assert.equal(after.first, before.first, 'first visible UTC hour changes on refresh'); assert.equal(after.selected, String(selected));
            for (const key of ['offset', 'height', 'button', 'following', 'scroll'] as const) assert.ok(Math.abs(after[key] - before[key]) <= 1, `DST refresh ${key} moved: ${JSON.stringify({ width, before, focused, after })}`);
            assert.equal(await page.locator('.bpb-air-table .bpb-weather-hour-zone:not([data-sizing-only])').count(), 0, 'post-fold headers no longer need visible timezone labels');
            cases.push({ scenario: scenario.name, width, before, after, live });
            await page.evaluate(() => window.__airView.dispose());
        } finally { await page.close(); }
    }
    assert.equal(cases.length, 4); assert.equal(requests, 8);
    console.log(JSON.stringify({ browser: selection, version: context.browser()?.version(), hidden: true, profile: temporaryRoot, cases, requests }));
} finally { await resources.dispose(); }
