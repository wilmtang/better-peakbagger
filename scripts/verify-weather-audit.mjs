// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, chrome, getComputedStyle */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { weatherFixture } from '../test/helpers/weather-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp('/tmp/bpb-weather-audit-verify-');
const output = process.env.BPB_WEATHER_AUDIT_OUTPUT;
let context, fixture, fractional = false;
const requests = [];
try {
    if (output) await mkdir(output, { recursive: true });
    fixture = await createBrowserFixtureServer({ temporaryRoot });
    assertChromeLaunchAllowed();
    context = await chromium.launchPersistentContext(temporaryRoot, {
        channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], args: [...fixture.chromeTrustArgs,
            `--disable-extensions-except=${root}/dist`, `--load-extension=${root}/dist`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (/^(api|archive-api|historical-forecast-api)\.open-meteo\.com$/.test(url.hostname)) {
            requests.push(url.href);
            const body = weatherFixture({ startDate: url.searchParams.get('start_date'),
                hours: (Date.parse(url.searchParams.get('end_date')) - Date.parse(url.searchParams.get('start_date'))) / 3600_000 + 24,
                latitude: Number(url.searchParams.get('latitude')), longitude: Number(url.searchParams.get('longitude')),
                elevation: Number(url.searchParams.get('elevation')), fields: url.searchParams.get('hourly').split(',') });
            if (fractional) body.hourly.precipitation.fill(1);
            return route.fulfill({ json: body });
        }
        if (url.hostname === 'www.peakbagger.com' && (!url.port || (fractional && /^\/peak\.aspx$/i.test(url.pathname)))) {
            const response = await route.fetch({ url: `https://127.0.0.1:${fixture.port}${url.pathname}${url.search}`, ignoreHTTPSErrors: true });
            if (fractional && /^\/peak\.aspx$/i.test(url.pathname)) {
                const html = new JSDOM(await response.text());
                const rows = [...html.window.document.querySelectorAll('tr')].filter(row => row.cells.length === 2);
                rows.find(row => row.cells[0].textContent.trim() === 'Latitude/Longitude (WGS84)').cells[1].textContent = '27.7, 85.3 (Dec Deg)';
                rows.find(row => row.cells[0].textContent.trim() === 'Nation').cells[1].textContent = 'Nepal';
                const body = html.serialize(); html.window.close();
                return route.fulfill({ response, body });
            }
            return route.fulfill({ response });
        }
        if (url.protocol === 'https:' && url.hostname !== 'www.peakbagger.com') return route.abort();
        return route.continue();
    });
    const registry = await context.newPage(); await registry.goto('chrome://extensions-internals/');
    const extension = await registry.waitForFunction(() => JSON.parse(document.body.innerText).find(row => row.name === 'Better Peakbagger')).then(handle => handle.jsonValue());
    const options = await context.newPage(); await options.goto(`chrome-extension://${extension.id}/options/options.html`);
    const setSettings = values => options.evaluate(values => chrome.storage.sync.set({ bpbSettings: values }), { showSunMoon: false, showWeather: true, units: 'metric', theme: 'light', ...values });
    await setSettings({});
    const page = await context.newPage();
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    fractional = true;
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
    await page.locator('#bpb-ascent-weather').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.bpb-weather-model-description')?.textContent.includes('Using'));
    await page.selectOption('.bpb-weather-model select', 'ecmwf_ifs');
    await page.waitForFunction(() => document.querySelector('.bpb-weather-model-description')?.textContent.includes('Using ECMWF IFS'));
    await page.locator('.bpb-weather-disclosure').click();
    await page.locator('[data-metric="precipitation"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.bpb-weather-bar').length === 25);
    const rain = await page.evaluate(() => ({
        total: document.querySelector('[data-weather-value="precipitation"]').textContent,
        sum: [...document.querySelectorAll('.bpb-weather-bar')].reduce((sum, bar) => sum + Number(bar.dataset.value), 0),
        first: document.querySelector('.bpb-weather-hover title').textContent,
        last: [...document.querySelectorAll('.bpb-weather-hover title')].at(-1).textContent,
    }));
    assert.equal(rain.total, '24.0 mm'); assert.equal(rain.sum, 24);
    assert.match(rain.first, /12:00 AM.*12:45 AM.*Estimated boundary interval/);
    assert.match(rain.last, /11:45 PM.*12:00 AM.*next midnight.*Estimated boundary interval/);
    if (output) await page.locator('#bpb-ascent-weather').screenshot({ path: path.join(output, 'fractional-rain.png') });
    await page.locator('.bpb-weather-chart-frame').focus(); await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('.bpb-weather-readout').textContent.includes('Estimated boundary interval'));
    assert.match(await page.locator('.bpb-weather-readout').innerText(), /12:00 AM.*12:45 AM/);
    for (const theme of ['light', 'dark']) {
        await setSettings({ theme });
        await page.waitForFunction(theme => document.documentElement.dataset.bpbTheme === theme, theme);
        const tabs = await page.evaluate(() => [...document.querySelectorAll('.bpb-weather-tabs button')].map(button => ({
            selected: button.getAttribute('aria-selected') === 'true', background: getComputedStyle(button).backgroundColor,
            color: getComputedStyle(button).color,
        })));
        assert.notEqual(tabs.find(tab => tab.selected).background, tabs.find(tab => !tab.selected).background);
        assert.notEqual(tabs.find(tab => tab.selected).color, tabs.find(tab => !tab.selected).color);
        assert.equal(await page.locator('.bpb-weather-disclosure').evaluate(button => getComputedStyle(button).borderTopWidth), '1px');
        await page.setViewportSize({ width: 375, height: 1000 });
        await page.waitForFunction(() => document.querySelector('.bpb-weather-chart').getAttribute('viewBox').split(' ')[2] - document.querySelector('.bpb-weather-chart').getBoundingClientRect().width < 1);
        if (output) await page.locator('#bpb-ascent-weather').screenshot({ path: path.join(output, `ascent-reading-${theme}-375.png`) });
    }
    fractional = false;
    await setSettings({ showWeather: false });
    const requestsBeforeOptOut = requests.length;
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321&weather=gpx`);
    await page.waitForFunction(() => document.querySelector('#bpb-ascent-weather')?.hidden);
    assert.equal(await page.locator('#bpb-ascent-gpx-details').count(), 0);
    const original = await page.locator('#gpxlinks').evaluate(node => {
        node.dataset.originalWeatherParent = node.parentElement.id || node.parentElement.tagName;
        return node.dataset.originalWeatherParent;
    });
    assert.equal(requests.length, requestsBeforeOptOut);
    await setSettings({ showWeather: true });
    await page.waitForFunction(() => document.querySelector('#bpb-ascent-gpx-details #gpxlinks'));
    await setSettings({ showWeather: false });
    await page.waitForFunction(() => !document.querySelector('#bpb-ascent-gpx-details') && document.querySelector('#bpb-ascent-weather').hidden);
    assert.equal(await page.locator('#gpxlinks').evaluate(node => node.parentElement.id || node.parentElement.tagName), original);
    assert.equal(await page.locator('#gpxlinks').isVisible(), true);
    if (output) await page.locator('#gpxlinks').screenshot({ path: path.join(output, 'weather-disabled-native-gps.png') });
    await setSettings({ showWeather: true });
    fractional = false;
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.goto(`${origin}/peak.aspx?pid=2296&week-weather=map`);
    await page.locator('#bpb-peak-weather').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.bpb-week-day').length === 16);
    await page.locator('.bpb-week-day:first-child > summary').click();
    await page.locator('.bpb-week-day:nth-child(2) > summary').click();
    await page.locator('.bpb-week-day[open] [data-metric="temperature"]').click();
    await page.waitForFunction(() => document.querySelector('.bpb-week-day:nth-child(2)[open] .bpb-week-line'));
    if (output) await page.locator('.bpb-week-day:nth-child(2)').screenshot({ path: path.join(output, 'peak-day-switch-375.png') });
    console.log(JSON.stringify({ browser: context.browser().version(), hidden: true, rain, requests: requests.length, profile: temporaryRoot }));
} finally {
    try { await context?.close(); } finally {
        try { await fixture?.close(); } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
    }
}
