/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Read-only regression check. Use --expect-regression with a disposable
// build that produces the original duplicate wind-axis label.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { defineDomSuite, runDomTier, type DomEngine } from '../../../scripts/dom-tier.mts';
import { weatherFixture } from '../../../test/helpers/weather-fixture.mts';

const usage = 'Usage: node docs/plans/evidence/card-reuse-audit.mts [--expect-regression] [--dist DIR]';
const args = process.argv.slice(2);
const expectRegression = args.includes('--expect-regression');
const domArgs = args.filter(argument => argument !== '--expect-regression');
if ((args.length - domArgs.length > 1) || (domArgs.length &&
    (domArgs.length !== 2 || domArgs[0] !== '--dist' || !domArgs[1] || domArgs[1].startsWith('--')))) {
    throw new Error(usage);
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ascentPath = '/climber/ascent.aspx';
const weatherBundle = 'content/ascent-weather.js';
const [ascent, peak, ascentOwner, chartOwner] = await Promise.all([
    readFile('test/fixtures/pages/climber-ascent.html', 'utf8'),
    readFile('test/fixtures/pages/peak-rainier.html', 'utf8'),
    readFile('src/ascent/ascent-weather.ts'),
    readFile('src/weather/peak-weather-hourly.ts'),
]);
const weather = weatherFixture();
const calm = weather.hourly.time.map(() => 0);
Object.assign(weather.hourly, { wind_speed_10m: calm, wind_gusts_10m: calm });
const results: { engine: DomEngine; axisLabels: string[]; unit: string; hash: string }[] = [];

await runDomTier(domArgs, [defineDomSuite({
    name: 'saved-ascent chart evidence',
    cases: [{
        name: expectRegression ? 'reproduces the duplicate wind-axis label'
            : 'renders distinct integer wind-axis labels for a calm archive day',
        stub: { settings: { units: 'metric', showWeather: true } },
        async run({ built, engine, open, page, route }) {
            await route(ascentPath, ascent.replaceAll('Sunday, July 12, 2026', 'Friday, July 12, 2024'));
            await open(`${ascentPath}?aid=7654321`);
            await page.evaluate(({ peakHtml, archive }) => {
                globalThis.fetch = async input => {
                    const url = new URL(input instanceof Request ? input.url : input, location.href);
                    if (url.origin === location.origin) {
                        return new Response(peakHtml, { headers: { 'content-type': 'text/html' } });
                    }
                    if (url.origin === 'https://archive-api.open-meteo.com') {
                        return new Response(archive, { headers: { 'content-type': 'application/json' } });
                    }
                    throw new Error(`Unexpected weather evidence request: ${url.origin}`);
                };
            }, { peakHtml: peak, archive: JSON.stringify(weather) });
            const [styles, layout, bundle] = await Promise.all([
                built('css/ascent-weather.css'), built('content/ascent-layout.js'), built(weatherBundle),
            ]);
            await page.addStyleTag({ content: styles.toString('utf8') });
            await page.addScriptTag({ content: layout.toString('utf8') });
            await page.addScriptTag({ content: bundle.toString('utf8') });
            await page.waitForFunction(() => {
                const reading = document.querySelector('.bpb-weather-metrics dd')?.textContent;
                return Boolean(reading && reading !== '—'
                    && document.getElementById('bpb-ascent-weather')?.getAttribute('aria-busy') === 'false');
            });
            await page.locator('.bpb-weather-disclosure').click();
            await page.locator('[data-metric="wind"]').click();
            const chart = page.locator('.bpb-weather-chart');
            await chart.locator('title').filter({ hasText: 'Wind (km/h)' }).waitFor({ state: 'attached' });
            const axisLabels = (await chart.locator('text[text-anchor="end"]').allTextContents())
                .filter(value => /^\d+$/.test(value));
            assert.equal(axisLabels.length, 3);
            if (expectRegression) assert.deepEqual(axisLabels, ['0', '1', '1']);
            else assert.equal(new Set(axisLabels).size, 3, `Axis labels must be distinct: ${axisLabels}`);
            const units = await chart.locator('text').allTextContents();
            assert.ok(units.includes('km/h'), 'the displayed axis must use km/h');
            results.push({ engine, axisLabels, unit: 'km/h', hash: sha256(bundle) });
        },
    }],
})], record => console.error(JSON.stringify(record)));

const [first, second] = results;
assert.deepEqual(second.axisLabels, first.axisLabels, 'both engines must render the same wind scale');
assert.equal(second.hash, first.hash);
console.log(JSON.stringify({
    auditedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ascentSourceSha256: sha256(ascentOwner),
    peakChartSourceSha256: sha256(chartOwner),
    ascentBundleSha256: first.hash,
    inputWindKmh: 0,
    displayedUnit: first.unit,
    axisLabels: first.axisLabels,
    method: `Shipped bundles in hidden ${first.engine} and ${second.engine} at 1000 × 760, with routed Peakbagger markup and stubbed weather and settings`,
}, null, 2));
