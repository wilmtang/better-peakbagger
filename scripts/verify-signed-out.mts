// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Render shipped filters on native HTTPS fixtures with explicit storage/network
// stubs. Real manifest/worker coverage belongs to verify -- browsers.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/* global document, scrollY, requestAnimationFrame, Response, localStorage */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, type BrowserType, type Page } from 'playwright';
import { createBrowserFixtureServer, projectRoot } from './browser-verification-fixtures.mts';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';
import { createResourceStack } from './resource-stack.mts';
import { darkCss } from '../src/theme/site-dark-css.ts';

type Box = { x: number; y: number; width: number; height: number };

interface GeometrySnapshot {
    button: Box | undefined;
    toolbar: Box | undefined;
    heading: Box | undefined;
    documentHeight: number;
    scroll: number;
    focused: boolean;
    busy: string | null | undefined;
    hidden: HTMLElement['hidden'] | undefined;
    text: string | undefined;
}

interface SignedOutState {
    requests: number;
    pending: ((response: Response) => void)[];
    complete: (success: boolean) => void;
}

interface SignedOutGlobals {
    __signedOut: SignedOutState;
    chrome: unknown;
}

interface StubRuntimeMessage {
    type: string;
    favoritesOnly?: boolean;
    phase?: string;
    observedAt?: unknown;
    cache?: unknown;
}

type StorageChangeListener = (changes: Record<string, { newValue: unknown }>, area: string) => void;

const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every(value => /^--browser=(chrome|firefox)$/.test(value)),
    `Unknown signed-out verification arguments: ${args.join(' ')}`);
const selectedBrowser = args[0]?.split('=')[1];
const browsers: [string, BrowserType][] = ([['chrome', chromium], ['firefox', firefox]] as [string, BrowserType][])
    .filter(([name]) => !selectedBrowser || name === selectedBrowser);
const resources = createResourceStack();
const profile = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-signed-out-'));
resources.defer('signed-out fixture directory', () => rm(profile, { recursive: true, force: true }));
let failure: unknown, cases = 0;
function install({ theme, scale }: { theme: string; scale: number }) {
    const listeners: StorageChangeListener[] = [];
    const data: Record<string, unknown> = {
        bpbIgnoredClimbers: { schemaVersion: 1, revision: 0, entries: [] },
        bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
        bpbPeakReportFilter: { schemaVersion: 1, favoritesOnly: true },
    };
    const publish = (values: Record<string, unknown>) => {
        Object.assign(data, values);
        for (const listener of listeners) listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local');
    };
    const state: SignedOutState = { requests: 0, pending: [], complete: success => {
        const body = success ? '<div>Logged in: Test | <a href="/climber/climber.aspx?cid=900001">My Home Page</a></div><h1>Buddy List</h1><table id="RGridView"><tr><th>Climber</th></tr></table>' : 'Service unavailable';
        for (const done of state.pending.splice(0)) done(new Response(body, { status: success ? 200 : 503 }));
    } };
    (globalThis as unknown as SignedOutGlobals).__signedOut = state;
    const fetchPage = globalThis.fetch;
    globalThis.fetch = (url, init) => String(url).includes('/report/report.aspx')
        ? ++state.requests === 1 ? Promise.resolve(new Response('Service unavailable', { status: 503 }))
            : new Promise<Response>(resolve => state.pending.push(resolve)) : fetchPage(url, init);
    (globalThis as unknown as SignedOutGlobals).chrome = { storage: { local: { get: async () => data, set: async (values: Record<string, unknown>) => publish(values) },
        sync: { get: async () => ({ bpbSettings: { favoritesSource: 'buddies', theme } }) },
        onChanged: { addListener: (listener: StorageChangeListener) => listeners.push(listener), removeListener() {} } },
    runtime: { id: 'signed-out-fixture', getURL: (file: string) => `https://extension.invalid/${file}`,
        onMessage: { addListener() {} }, sendMessage: async (message: StubRuntimeMessage) => {
            if (message.type === 'PEAK_REPORT_PREFERENCE') { publish({ bpbPeakReportFilter: { schemaVersion: 1, favoritesOnly: message.favoritesOnly } }); return { ok: true }; }
            if (message.type === 'BUDDY_CACHE_UPDATE') {
                if (message.phase === 'begin') return { ok: true, snapshot: { version: null, observedAt: message.observedAt } };
                publish({ bpbBuddyCache: message.cache }); return { ok: true, written: true };
            }
            return { ok: true };
        } } };
    localStorage.setItem('pbAscentBetaFilter.v1', JSON.stringify({ beta: false, tr: false, gps: false, link: false, fav: true }));
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; document.documentElement.style.zoom = String(scale); });
}
async function geometry(page: Page, selector: string): Promise<GeometrySnapshot> {
    return page.evaluate(async targetSelector => {
        await new Promise<number>(requestAnimationFrame);
        const button = [...document.querySelectorAll('button')].find(el => el.textContent === 'Retry');
        const box = (element: Element | null | undefined): Box | undefined => element?.getBoundingClientRect().toJSON() as Box | undefined;
        return { button: box(button), toolbar: box(document.querySelector(targetSelector)), heading: box(document.querySelector('h1')),
            documentHeight: document.documentElement.scrollHeight, scroll: scrollY, focused: document.activeElement === button,
            busy: button?.getAttribute('aria-busy'), hidden: button?.hidden, text: document.querySelector<HTMLElement>(targetSelector)?.innerText };
    }, selector);
}
function stable(before: GeometrySnapshot, after: GeometrySnapshot, label: string) {
    for (const region of ['button', 'toolbar', 'heading'] as const) for (const key of ['x', 'y', 'width', 'height'] as const) {
        assert.ok(Math.abs(after[region]![key] - before[region]![key]) <= 1, `${label}: ${region}.${key}: ${JSON.stringify({ before, after })}`);
    }
    assert.equal(after.scroll, before.scroll, label);
    assert.equal(after.documentHeight, before.documentHeight, label);
    assert.equal(after.focused, true, `${label}: Retry lost focus: ${JSON.stringify(after)}`);
}
try {
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('signed-out HTTPS fixture', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const peak = await readFile(path.join(projectRoot, 'test/fixtures/pages/peak-rainier.html'), 'utf8');
    const ascents = await readFile(path.join(projectRoot, 'test/fixtures/peakascents/2296-rainier-y9999-sort-ascentdate.html'), 'utf8');
    const output = process.env.BPB_SIGNED_OUT_SCREENSHOTS;
    if (output) await mkdir(output, { recursive: true });
    for (const [name, type] of browsers) {
        if (name === 'chrome') assertChromeLaunchAllowed();
        const browser = await type.launch({ headless: true, ...(name === 'chrome'
            ? { channel: 'chromium', args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
            : { firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }) });
        try {
            for (const theme of ['light', 'dark'] as const) for (const width of [1000, 375]) for (const scale of [1, 2]) {
                const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, colorScheme: theme });
                try {
                    await context.addInitScript(install, { theme, scale });
                    for (const surface of ['peak', 'ascents'] as const) for (const signedIn of [false, true]) {
                        const page = await context.newPage(); page.setDefaultTimeout(10000);
                        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
                        const html = signedIn ? surface === 'peak' ? peak : ascents
                            : (surface === 'peak' ? peak : ascents).replace(/<div\b[^>]*>\s*(?:&nbsp;|\s)*Logged in:[\s\S]*?<\/div>/i, '');
                        await page.route('**/*', route => {
                            const url = new URL(route.request().url());
                            if (url.origin !== origin) return route.abort();
                            if (/\/(?:peak|peakascents)\.aspx$/i.test(url.pathname)) return route.fulfill({ contentType: 'text/html', body: html });
                            return route.continue();
                        });
                        const url = `${origin}/${surface === 'peak' ? 'Peak.aspx' : 'climber/PeakAscents.aspx'}?pid=2296&y=9999`;
                        await page.goto(url); await page.addStyleTag({ content: darkCss });
                        await page.addScriptTag({ path: path.join(projectRoot, 'dist/content', surface === 'peak' ? 'peak-report-filter.js' : 'ascent-filter.js') });
                        const selector = surface === 'peak' ? '#bpb-peak-report-tools' : '#pbaf-bar';
                        await page.waitForFunction(targetSelector => document.querySelector<HTMLElement>(targetSelector)?.innerText.includes('Peakbagger'), selector).catch(async error => {
                            throw new Error(JSON.stringify({ name, theme, width, scale, surface, signedIn, errors, state: await page.evaluate(targetSelector => ({ title: document.title, tools: document.querySelector<HTMLElement>(targetSelector)?.innerText, requests: (globalThis as unknown as SignedOutGlobals).__signedOut?.requests }), selector) }), { cause: error });
                        });
                        if (!signedIn) {
                            assert.equal(await page.locator(`${selector} a`).filter({ hasText: 'Sign in to Peakbagger' }).count(), 1);
                            assert.equal(await page.locator(`${selector} a`).filter({ hasText: 'Use custom favorites…' }).count(), 1);
                            assert.equal(await page.evaluate(() => (globalThis as unknown as SignedOutGlobals).__signedOut.requests), 0);
                            assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).isVisible(), false);
                            if (output && scale === 1) await page.locator(selector).screenshot({ path: path.join(output, `${name}-${surface}-${theme}-${width}.png`) });
                        } else {
                            const retry = page.getByRole('button', { name: 'Retry', exact: true });
                            await retry.scrollIntoViewIfNeeded(); await retry.focus();
                            const before = await geometry(page, selector);
                            await retry.press('Enter'); await page.waitForFunction(() => (globalThis as unknown as SignedOutGlobals).__signedOut.pending.length === 1);
                            stable(before, await geometry(page, selector), 'pending');
                            await retry.press('Space'); assert.equal(await page.evaluate(() => (globalThis as unknown as SignedOutGlobals).__signedOut.requests), 2, 'duplicate retry');
                            await page.evaluate(() => (globalThis as unknown as SignedOutGlobals).__signedOut.complete(false));
                            await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry')?.getAttribute('aria-busy') === 'false');
                            stable(before, await geometry(page, selector), 'repeated error');
                            await retry.press('Enter'); await page.waitForFunction(() => (globalThis as unknown as SignedOutGlobals).__signedOut.pending.length === 1);
                            await page.evaluate(() => (globalThis as unknown as SignedOutGlobals).__signedOut.complete(true));
                            await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry')?.getAttribute('aria-busy') === 'false');
                            const success = await geometry(page, selector);
                            assert.equal(success.focused, true, JSON.stringify(success));
                            for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(success.button![key] - before.button![key]) <= 1, `success action ${key}: ${JSON.stringify({ before, success })}`);
                        }
                        cases++; await page.close();
                    }
                } finally { await context.close(); }
            }
            console.log(JSON.stringify({ browser: name, version: browser.version(), hidden: true, widths: [1000, 375], height: 900, cssZoom: [1, 2], themes: ['light', 'dark'], cases }));
        } finally { await browser.close(); }
    }
    assert.equal(cases, browsers.length * 32, 'every selected signed-out and retry variant must execute');
} catch (error) { failure = error; }
await resources.dispose(failure);
