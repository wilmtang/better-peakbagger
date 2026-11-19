// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs sanitized provider-shaped pages at their real HTTPS origins without
// contacting either provider. Every request is intercepted; unknown requests
// are aborted. This proves browser DOM/fetch contracts, not live compatibility.
/// <reference lib="dom" />

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, firefox, type Browser, type BrowserType, type LaunchOptions, type Route } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';

type RouteResponse = Parameters<Route['fulfill']>[0];

interface OwnershipResult {
    ok: boolean;
    code?: string;
}

interface CaptureDiagnostics {
    counts: Record<string, number>;
    [key: string]: unknown;
}

interface CaptureResult {
    ok: boolean;
    code?: string;
    diagnostics: CaptureDiagnostics;
    totalMs?: number;
}

interface ExpectedActivity {
    provider: 'strava' | 'garmin';
    activityId: string;
}

interface ProviderPageApi {
    inspectOwnership(): OwnershipResult;
    waitForOwnership(expected: ExpectedActivity, reason: string, timeoutMs: number): Promise<OwnershipResult>;
    capture(
        options: Record<string, unknown>,
        reason: string,
        timeoutMs: number,
        expected: ExpectedActivity,
        diagnostics?: boolean,
    ): Promise<CaptureResult>;
}

interface ProviderPageGlobals {
    BPBProviderPage: ProviderPageApi;
    USE_DI_SESSION?: boolean;
}

interface OpenFixtureOptions {
    url: string;
    html: string;
    routes?: Map<string, RouteResponse>;
}

interface OwnershipCase {
    name: string;
    fixture: string;
    url: string;
    ok: boolean;
    code?: string;
}

interface BrowserTarget {
    name: string;
    engine: BrowserType;
    launch: LaunchOptions;
}

type ResponseCase =
    | { name: string; response: RouteResponse; routes?: undefined; code: string }
    | { name: string; routes: Map<string, RouteResponse>; response?: undefined; code: string };

const ROOT = new URL('../test/capture/fixtures/', import.meta.url);
const bundle = await fs.readFile(new URL('../dist/provider-page.js', import.meta.url), 'utf8');
const fixture = (name: string): Promise<string> => fs.readFile(new URL(name, ROOT), 'utf8');
const fixtures: Record<string, string> = Object.fromEntries(await Promise.all([
    'strava-owned.html',
    'strava-owned-es.html',
    'strava-other-owner.html',
    'strava-signed-out.html',
    'garmin-owned.html',
    'garmin-other-owner.html',
    'garmin-signed-out.html',
    'provider-loading.html',
    'provider-challenge.html',
    'provider-login-response.html',
    'provider-valid.gpx',
    'provider-trackless.gpx',
].map(async (name): Promise<[string, string]> => [name, await fixture(name)])));

const VIEWPORT = { width: 1280, height: 720 };
const STRAVA_URL = 'https://www.strava.com/activities/123';
const GARMIN_URL = 'https://connect.garmin.com/app/activity/777';
const STRAVA_EXPORT = 'https://www.strava.com/activities/123/export_gpx';
const STRAVA_LOGIN = 'https://www.strava.com/login';
const GARMIN_EXPORT = 'https://connect.garmin.com/gc-api/download-service/export/gpx/activity/777';

const openFixture = async (browser: Browser, { url, html, routes = new Map() }: OpenFixtureOptions) => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const network = { fulfilled: 0, aborted: 0 };
    await page.route('**/*', async route => {
        const requestUrl = route.request().url();
        if (requestUrl === url) {
            network.fulfilled++;
            await route.fulfill({ status: 200, contentType: 'text/html', body: html });
            return;
        }
        const response = routes.get(requestUrl);
        if (response) {
            network.fulfilled++;
            await route.fulfill(response);
            return;
        }
        network.aborted++;
        await route.abort('blockedbyclient');
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: bundle });
    return { context, page, network };
};

const inspectCase = async (browser: Browser, item: OwnershipCase) => {
    const opened = await openFixture(browser, {
        url: item.url,
        html: fixtures[item.fixture],
    });
    try {
        const started = performance.now();
        const result = await opened.page.evaluate(() => (globalThis as unknown as ProviderPageGlobals).BPBProviderPage.inspectOwnership());
        const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
        assert.equal(result.ok, item.ok, item.name);
        if (item.code) assert.equal(result.code, item.code, item.name);
        return { name: item.name, outcome: result.ok ? 'owned' : result.code, elapsedMs };
    } finally {
        await opened.context.close();
    }
};

const verifyBrowser = async ({ name, engine, launch }: BrowserTarget) => {
    let browser: Browser | null = null;
    try {
        if (engine === chromium) assertChromeLaunchAllowed();
        browser = await engine.launch({ headless: true, ...launch });
        const ownershipCases: { name: string; outcome: string | undefined; elapsedMs: number }[] = [];
        const cases: OwnershipCase[] = [
            { name: 'strava-owned', fixture: 'strava-owned.html', url: STRAVA_URL, ok: true },
            { name: 'strava-owned-es', fixture: 'strava-owned-es.html', url: STRAVA_URL, ok: true },
            { name: 'strava-other-owner', fixture: 'strava-other-owner.html', url: STRAVA_URL, ok: false, code: 'not-owner' },
            { name: 'strava-signed-out', fixture: 'strava-signed-out.html', url: STRAVA_URL, ok: false, code: 'provider-signed-out' },
            { name: 'garmin-owned', fixture: 'garmin-owned.html', url: GARMIN_URL, ok: true },
            { name: 'garmin-other-owner', fixture: 'garmin-other-owner.html', url: GARMIN_URL, ok: false, code: 'not-owner' },
            { name: 'garmin-signed-out', fixture: 'garmin-signed-out.html', url: GARMIN_URL, ok: false, code: 'provider-signed-out' },
            { name: 'loading', fixture: 'provider-loading.html', url: STRAVA_URL, ok: false, code: 'ownership-unverified' },
            { name: 'human-check', fixture: 'provider-challenge.html', url: STRAVA_URL, ok: false, code: 'provider-human-check' },
        ];
        for (const item of cases) ownershipCases.push(await inspectCase(browser, item));

        const spa = await openFixture(browser, { url: STRAVA_URL, html: fixtures['strava-owned.html'] });
        let spaOutcome: OwnershipResult;
        try {
            spaOutcome = await spa.page.evaluate(async () => {
                globalThis.history.pushState({}, '', '/activities/456');
                return (globalThis as unknown as ProviderPageGlobals).BPBProviderPage.waitForOwnership(
                    { provider: 'strava', activityId: '123' },
                    'fixture-navigation',
                    500,
                );
            });
            assert.equal(spaOutcome.code, 'activity-changed');
        } finally {
            await spa.context.close();
        }

        const strava = await openFixture(browser, {
            url: STRAVA_URL,
            html: fixtures['strava-owned.html'],
            routes: new Map([[STRAVA_EXPORT, {
                status: 200,
                contentType: 'application/gpx+xml',
                body: fixtures['provider-valid.gpx'],
            }]]),
        });
        let stravaCapture: CaptureResult;
        try {
            const started = performance.now();
            stravaCapture = await strava.page.evaluate(() => (globalThis as unknown as ProviderPageGlobals).BPBProviderPage.capture(
                {},
                'strava-fixture',
                2000,
                { provider: 'strava', activityId: '123' },
                true,
            ));
            stravaCapture.totalMs = Math.round((performance.now() - started) * 10) / 10;
            assert.equal(stravaCapture.ok, true);
            assert.equal(stravaCapture.diagnostics.counts['track-points'], 2);
            assert.equal(strava.network.aborted, 0);
        } finally {
            await strava.context.close();
        }

        const garmin = await openFixture(browser, {
            url: GARMIN_URL,
            html: fixtures['garmin-owned.html'],
            routes: new Map([[GARMIN_EXPORT, {
                status: 200,
                contentType: 'application/gpx+xml',
                body: fixtures['provider-valid.gpx'],
            }]]),
        });
        let garminCapture: CaptureResult;
        try {
            garminCapture = await garmin.page.evaluate(() => {
                (globalThis as unknown as ProviderPageGlobals).USE_DI_SESSION = true;
                return (globalThis as unknown as ProviderPageGlobals).BPBProviderPage.capture(
                    {},
                    'garmin-fixture',
                    2000,
                    { provider: 'garmin', activityId: '777' },
                    true,
                );
            });
            assert.equal(garminCapture.ok, true);
            assert.equal(garminCapture.diagnostics.counts['track-points'], 2);
            assert.equal(garmin.network.aborted, 0);
        } finally {
            await garmin.context.close();
        }

        const responseCases: { name: string; outcome: string }[] = [];
        const responseItems: ResponseCase[] = [
            {
                name: 'managed-challenge',
                response: { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }, body: fixtures['provider-challenge.html'] },
                code: 'provider-human-check',
            },
            {
                name: 'rate-limit',
                response: { status: 429, headers: { 'retry-after': '60', 'content-type': 'text/plain' }, body: '' },
                code: 'provider-rate-limited',
            },
            {
                name: 'html-login',
                response: { status: 200, contentType: 'text/html', body: fixtures['provider-login-response.html'] },
                code: 'provider-signed-out',
            },
            {
                name: 'login-redirect',
                routes: new Map([
                    [STRAVA_EXPORT, { status: 302, headers: { location: '/login' }, body: '' }],
                    [STRAVA_LOGIN, { status: 200, contentType: 'text/html', body: fixtures['provider-login-response.html'] }],
                ]),
                code: 'provider-signed-out',
            },
            {
                name: 'trackless-gpx',
                response: { status: 200, contentType: 'application/gpx+xml', body: fixtures['provider-trackless.gpx'] },
                code: 'no-gps-data',
            },
        ];
        for (const item of responseItems) {
            const opened = await openFixture(browser, {
                url: STRAVA_URL,
                html: fixtures['strava-owned.html'],
                routes: item.routes ? item.routes : new Map([[STRAVA_EXPORT, item.response]]),
            });
            try {
                const result = await opened.page.evaluate(() => (globalThis as unknown as ProviderPageGlobals).BPBProviderPage.capture(
                    {},
                    'response-fixture',
                    2000,
                    { provider: 'strava', activityId: '123' },
                ));
                assert.equal(result.code, item.code, item.name);
                responseCases.push({ name: item.name, outcome: item.code });
            } finally {
                await opened.context.close();
            }
        }

        console.log(JSON.stringify({
            browser: name,
            version: browser.version(),
            hidden: true,
            viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
            network: 'all requests intercepted; unmatched requests aborted',
            ownershipCases,
            spaNavigation: spaOutcome.code,
            responseCases,
            captureTimings: {
                stravaTotalMs: stravaCapture.totalMs,
                strava: stravaCapture.diagnostics,
                garmin: garminCapture.diagnostics,
            },
        }));
    } finally {
        await browser?.close();
    }
};

await verifyBrowser({ name: 'Chrome for Testing', engine: chromium, launch: { channel: 'chromium' } });
await verifyBrowser({ name: 'Firefox', engine: firefox, launch: {} });
