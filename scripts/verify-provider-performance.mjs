// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hidden native-browser responsiveness gate for the provider-page GPX parser.
// It never navigates to Garmin or Strava and makes no network request.

import fs from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

const providerBundle = await fs.readFile(new URL('../dist/provider-page.js', import.meta.url), 'utf8');
const VIEWPORT = { width: 1280, height: 720 };
const CASES = Object.freeze([
    { points: 1000, maxMs: 200 },
    { points: 5000, maxMs: 300 },
    { points: 20000, maxMs: 500 },
]);
const LIMIT_REJECTION_MAX_MS = 300;

const measure = (page, points, overLimit = false) => page.evaluate(({ count, reject }) => {
    const trackPoints = Array.from({ length: count }, (_, index) =>
        `<trkpt lat="${47 + index / 100000}" lon="${-122 + index / 100000}">`
        + `<ele>${100 + index % 100}</ele><time>2026-09-03T12:00:00Z</time></trkpt>`).join('');
    const gpx = `<gpx><trk><trkseg>${trackPoints}</trkseg></trk></gpx>`;
    const started = performance.now();
    try {
        const parsed = globalThis.BPBProviderPage.parseGpxData(gpx);
        return {
            elapsedMs: performance.now() - started,
            parsedPoints: parsed.segments[0]?.length || 0,
            rejected: false,
        };
    } catch (error) {
        return {
            elapsedMs: performance.now() - started,
            parsedPoints: 0,
            rejected: error?.code === 'gpx-too-large',
            expectedRejection: reject,
        };
    }
}, { count: points, reject: overLimit });

const verifyBrowser = async ({ name, engine, launch }) => {
    let browser = null;
    try {
        browser = await engine.launch({ headless: true, ...launch });
        const page = await browser.newPage({ viewport: VIEWPORT });
        await page.route('**/*', route => route.abort());
        await page.setContent('<!doctype html><main></main>');
        await page.addScriptTag({ content: providerBundle });
        const measurements = [];
        for (const item of CASES) {
            const result = await measure(page, item.points);
            if (result.rejected || result.parsedPoints !== item.points || result.elapsedMs > item.maxMs) {
                throw new Error(`${name} ${item.points}-point parse failed its ${item.maxMs} ms bound: ${JSON.stringify(result)}`);
            }
            measurements.push({ points: item.points, parseMs: Math.round(result.elapsedMs * 10) / 10 });
        }
        const rejected = await measure(page, 20001, true);
        if (!rejected.rejected || rejected.elapsedMs > LIMIT_REJECTION_MAX_MS) {
            throw new Error(`${name} limit rejection failed its ${LIMIT_REJECTION_MAX_MS} ms bound: ${JSON.stringify(rejected)}`);
        }
        console.log(JSON.stringify({
            browser: name,
            version: browser.version(),
            hidden: true,
            viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
            measurements,
            limitRejectionMs: Math.round(rejected.elapsedMs * 10) / 10,
        }));
    } finally {
        await browser?.close();
    }
};

await verifyBrowser({ name: 'Chrome for Testing', engine: chromium, launch: { channel: 'chromium' } });
await verifyBrowser({ name: 'Firefox', engine: firefox, launch: {} });
