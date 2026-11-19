// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mts';
import { createResourceStack } from './resource-stack.mts';
import { createVerificationRoot, launchVerificationChrome, PEAKBAGGER_HOST_RULE } from './verification-launch.mts';
import { weatherFixture } from '../test/helpers/weather-fixture.mts';

function nepalPeakFixture(html: string): string {
    const rainierCoordinates = '46.851731, -121.760395 (Dec Deg)'
        + "<br>46° 51' 6'' N, 121° 45' 37'' W (DMS)<br>594502 E, 5189434 N, Zone 10 (UTM)";
    const rows = [
        ['Latitude/Longitude (WGS84)', rainierCoordinates, '27.7, 85.3 (Dec Deg)'],
        ['Nation', 'United States', 'Nepal'],
    ];
    for (const [label, current, replacement] of rows) {
        const valueCell = `<tr><td valign="top">${label}</td><td>`;
        const original = `${valueCell}${current}</td></tr>`;
        // The no-GPX ascent links to the Rainier fixture. Fail explicitly if
        // it no longer contains the two rows this verifier needs to replace.
        assert.equal(html.split(original).length, 2, `expected one Rainier fixture row for ${label}`);
        html = html.replace(original, `${valueCell}${replacement}</td></tr>`);
    }
    return html;
}

if (process.argv.length > 2) throw new Error('Usage: node scripts/verify-weather-intervals.mts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = createResourceStack();
const temporaryRoot = await createVerificationRoot(resources, 'bpb-weather-intervals-', 'weather interval profile');
const output = process.env.BPB_WEATHER_INTERVALS_OUTPUT;
const requests: string[] = [];
let failure: unknown = null;
try {
    if (output) await mkdir(output, { recursive: true });
    // Preserve the required helper option despite its incomplete JS-inferred signature.
    const fixture = await createBrowserFixtureServer({ temporaryRoot } as never);
    resources.defer('weather interval HTTPS fixture', () => fixture.close());
    const context = await launchVerificationChrome(resources, 'weather interval browser', temporaryRoot, {
        viewport: { width: 1440, height: 1000 }, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        trustArgs: fixture.chromeTrustArgs, extension: `${root}/dist`, hosts: [PEAKBAGGER_HOST_RULE],
    });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (/^(api|archive-api|historical-forecast-api)\.open-meteo\.com$/.test(url.hostname)) {
            requests.push(url.href);
            const startDate = url.searchParams.get('start_date')!, endDate = url.searchParams.get('end_date')!;
            const body = weatherFixture({ startDate,
                hours: (Date.parse(endDate) - Date.parse(startDate)) / 3600_000 + 24,
                latitude: Number(url.searchParams.get('latitude')), longitude: Number(url.searchParams.get('longitude')),
                elevation: Number(url.searchParams.get('elevation')), fields: url.searchParams.get('hourly')!.split(',') });
            (body.hourly as unknown as Record<string, number[]>).precipitation.fill(1);
            return route.fulfill({ json: body });
        }
        if (url.hostname === 'www.peakbagger.com' && (!url.port || /^\/peak\.aspx$/i.test(url.pathname))) {
            // ignoreHTTPSErrors is not a typed route.fetch option; it was always passed and is kept unchanged.
            const response = await route.fetch({ url: `https://127.0.0.1:${fixture.port}${url.pathname}${url.search}`, ignoreHTTPSErrors: true } as Parameters<typeof route.fetch>[0]);
            if (/^\/peak\.aspx$/i.test(url.pathname)) {
                return route.fulfill({ response, body: nepalPeakFixture(await response.text()) });
            }
            return route.fulfill({ response });
        }
        if (url.protocol === 'https:' && url.hostname !== 'www.peakbagger.com') return route.abort();
        return route.continue();
    });
    const registry = await context.newPage(); await registry.goto('chrome://extensions-internals/');
    const extension = await registry.waitForFunction(() => JSON.parse(document.body.innerText).find((row: { name: string; id: string }) => row.name === 'Better Peakbagger')).then(handle => handle.jsonValue());
    const options = await context.newPage(); await options.goto(`chrome-extension://${extension.id}/options/options.html`);
    const setSettings = (values: object) => options.evaluate(bpbSettings => chrome.storage.sync.set({ bpbSettings }), { showSunMoon: false, showWeather: true, units: 'metric', theme: 'light', ...values });
    await setSettings({});
    const page = await context.newPage();
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
    await page.locator('#bpb-ascent-weather').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.bpb-weather-model-description')?.textContent?.includes('Using'));
    await page.selectOption('.bpb-weather-model select', 'ecmwf_ifs');
    await page.waitForFunction(() => document.querySelector('.bpb-weather-model-description')?.textContent?.includes('Using ECMWF IFS'));
    await page.locator('.bpb-weather-disclosure').click();
    await page.locator('[data-metric="precipitation"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.bpb-weather-bar').length === 25);
    const rain = await page.evaluate(() => ({
        total: document.querySelector('[data-weather-value="precipitation"]')!.textContent,
        sum: [...document.querySelectorAll<HTMLElement>('.bpb-weather-bar')].reduce((sum, bar) => sum + Number(bar.dataset.value), 0),
        first: document.querySelector('.bpb-weather-hover title')!.textContent || '',
        last: [...document.querySelectorAll('.bpb-weather-hover title')].at(-1)!.textContent || '',
    }));
    assert.equal(rain.total, '24.0 mm'); assert.equal(rain.sum, 24);
    assert.match(rain.first, /12:00 AM.*12:45 AM.*Estimated boundary interval/);
    assert.match(rain.last, /11:45 PM.*12:00 AM.*next midnight.*Estimated boundary interval/);
    if (output) await page.locator('#bpb-ascent-weather').screenshot({ path: path.join(output, 'fractional-rain.png') });
    await page.locator('.bpb-weather-chart-frame').focus(); await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('.bpb-weather-readout')!.textContent!.includes('Estimated boundary interval'));
    assert.match(await page.locator('.bpb-weather-readout').innerText(), /12:00 AM.*12:45 AM/);
    console.log(JSON.stringify({ browser: context.browser()!.version(), hidden: true, rain, requests: requests.length, profile: temporaryRoot }));
} catch (error) { failure = error; }
await resources.dispose(failure as null);
