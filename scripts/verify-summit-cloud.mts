// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createBrowserFixtureServer, waitForCondition as untypedWaitForCondition, webdriverScript } from './browser-verification-fixtures.mts';
import { createResourceStack } from './resource-stack.mts';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mts';
import { setFirefoxContentViewport } from './firefox-content-viewport.mts';
import { createVerificationRoot } from './verification-launch.mts';
import type { Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => Promise<T>, options: { description: string; timeoutMs: number; intervalMs: number }) => Promise<T>;
type PageFn = <T>(fn: (arg: never) => T, arg?: unknown) => Promise<Awaited<T>>;
type Field = HTMLSelectElement & HTMLDetailsElement;
interface CloudFixture { mode: string; requests: { url: string; options?: RequestInit }[]; held: (() => void)[]; settings: Record<string, unknown>;
    release(): void; patch(patch: object): void }
// Page-world fixture; callbacks cast in place so the shared program keeps Window unchanged.
interface CloudWindow { cloudFixture: CloudFixture; chrome: unknown; eval(source: string): unknown }
type Rect = { x: number; y: number; width: number; height: number };
interface CloudGeometry { rects: Rect[]; scroll: number[]; overflow: boolean; clipped: boolean; clockOverflow: boolean; focus: string | undefined;
    theme: string | undefined; viewport: number[]; timelineScroll: number }

const firefoxMode = process.argv.includes('--firefox');
if (process.argv.slice(2).some(arg => arg !== '--firefox') || process.argv.length > (firefoxMode ? 3 : 2)) throw new Error('Usage: node scripts/verify-summit-cloud.mts [--firefox]');
const resources = createResourceStack(), evidence: object[] = [], output = path.resolve('browser-evidence/summit-cloud');
let failure: unknown = null;
const boot = ({ scripts, css, saved = {}, now = Date.parse('2026-10-31T06:30Z') }: { scripts: string[]; css: string; saved?: object; now?: number }) => {
    window.Date.now = () => now;
    type Listener = (changes: object, area: string) => void;
    const listeners = new Set<Listener>();
    const page = window as unknown as CloudWindow;
    page.cloudFixture = { mode: 'complete', requests: [], held: [], settings: { showSummitCloud: true, bpbSummitCloudModel: 'gfs_global', ...saved },
        release() { this.held.splice(0).forEach(resolve => resolve()); },
        patch(patch: object) { const oldValue = this.settings; this.settings = { ...oldValue, ...patch }; listeners.forEach(fn => fn({ bpbSettings: { oldValue, newValue: this.settings } }, 'sync')); } };
    const fixture = page.cloudFixture;
    page.chrome = { storage: { sync: { get: async () => ({ bpbSettings: fixture.settings }) }, local: { get: async () => ({}) }, onChanged: {
        addListener: (fn: Listener) => listeners.add(fn), removeListener: (fn: Listener) => listeners.delete(fn),
    } }, runtime: { sendMessage: async (message: { patch: object }) => { fixture.patch(message.patch); return { ok: true, settings: fixture.settings }; } } };
    window.fetch = (async (url: string, options?: RequestInit) => {
        const query = new URL(url).searchParams;
        if (new URL(url).pathname.startsWith('/data/')) return new Response(JSON.stringify({ last_run_initialisation_time: Math.floor(Date.now() / 1000) - 3600,
            last_run_availability_time: Math.floor(Date.now() / 1000) - 600, update_interval_seconds: 21600 }), { headers: { 'content-type': 'application/json' } });
        fixture.requests.push({ url, options }); const mode = fixture.mode;
        if (mode === 'hold') await new Promise<void>(resolve => fixture.held.push(resolve));
        if (mode === 'error') return new Response('', { status: 503 });
        if (mode === 'limited') return new Response('', { status: 429, headers: { 'retry-after': '1' } });
        const start = Date.parse(`${query.get('start_hour')}Z`), end = Date.parse(`${query.get('end_hour')}Z`);
        const times = Array.from({ length: (end - start) / 3600000 + 1 }, (_item, index) => start / 1000 + index * 3600);
        const lons = query.get('longitude')!.split(',').map(Number);
        const result = query.get('latitude')!.split(',').map((lat, index) => {
            const hourly: Record<string, number[]> = { time: times }, hourly_units: Record<string, string> = { time: 'unixtime' };
            for (const name of query.get('hourly')!.split(',')) {
                const [, field, pressure] = name.match(/^(.*)_(\d+)hPa$/)!;
                const value = ({ temperature: 5, relative_humidity: mode === 'cloudy' ? 97 : 55,
                    cloud_cover: mode === 'cloudy' ? 95 : 5, geopotential_height: (1000 - Number(pressure)) * 8, wind_speed: 6, wind_direction: 270 } as Record<string, number>)[field];
                hourly_units[name] = ({ temperature: '°C', relative_humidity: '%', cloud_cover: '%', geopotential_height: 'm', wind_speed: 'm/s', wind_direction: '°' } as Record<string, string>)[field];
                hourly[name] = times.map(() => value);
            }
            return { latitude: Number(lat), longitude: lons[index], elevation: 700, utc_offset_seconds: 0, hourly, hourly_units };
        });
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }) as typeof window.fetch;
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    for (const script of scripts) page.eval(script);
};
const geometry = (): CloudGeometry => {
    const selectors = ['#bpb-summit-cloud', '#bpb-summit-cloud h2', '.bpb-cloud-refresh', '.bpb-cloud-navigation', '.bpb-cloud-hours', '#cloud-following'];
    const rect = (node: Element | null) => { const r = node!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const card = document.querySelector<Field>('#bpb-summit-cloud')!;
    return { rects: selectors.map(selector => rect(document.querySelector(selector))), scroll: [window.scrollX, window.scrollY],
        overflow: card.scrollWidth > card.clientWidth + 1,
        // Offscreen hour columns are deliberately inside a horizontal scroller.
        clipped: [...card.querySelectorAll('button, select')].some(node => !node.closest('.bpb-cloud-hours') && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().right > card.getBoundingClientRect().right + 1),
        clockOverflow: [...card.querySelectorAll('.bpb-cloud-clock > span:first-child')].some(node => node.scrollWidth > node.clientWidth + 1),
        focus: document.activeElement?.className, theme: document.documentElement.dataset.bpbTheme,
        viewport: [window.innerWidth, window.innerHeight], timelineScroll: card.querySelector('.bpb-cloud-hours')!.scrollLeft };
};
const stable = (before: CloudGeometry, after: CloudGeometry, label: string, { timeline = true } = {}) => {
    assert.equal(after.overflow, false, `${label}: card overflow`); assert.equal(after.clipped, false, `${label}: clipped control`);
    assert.equal(after.clockOverflow, false, `${label}: hour text overflows its cell`);
    before.rects.forEach((rect, index) => (Object.keys(rect) as (keyof Rect)[]).forEach(key => assert.ok(Math.abs(rect[key] - after.rects[index][key]) <= 1,
        `${label}: geometry ${index}.${key}: ${rect[key]} -> ${after.rects[index][key]}`)));
    assert.deepEqual(after.scroll, before.scroll, `${label}: scroll moved`);
    if (timeline) assert.ok(Math.abs(after.timelineScroll - before.timelineScroll) <= 1, `${label}: timeline scroll moved`);
};
try {
    await mkdir(output, { recursive: true });
    const temporaryRoot = await createVerificationRoot(resources, 'bpb-summit-cloud-verify-', 'cloud profile');
    // Preserve the required helper option despite its incomplete JS-inferred signature.
    const fixture = await createBrowserFixtureServer({ temporaryRoot } as never); resources.defer('cloud HTTPS fixture', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const scripts = await Promise.all(['summit-cloud', 'peak-cards'].map(name => readFile(name === 'summit-cloud' && process.env.BPB_SUMMIT_CLOUD_BUNDLE || `dist/content/${name}.js`, 'utf8')));
    const css = (await Promise.all(['column-resize', 'peak-card-layout', 'summit-cloud'].map(name => readFile(`dist/css/${name}.css`, 'utf8')))).join('\n');
    let evaluate: PageFn, resize: (width: number, height: number) => Promise<unknown>, navigate: (url: string) => Promise<unknown>,
        screenshot: (file: string) => Promise<unknown>, key: (selector: string, input: string) => Promise<unknown>, version: string;
    if (firefoxMode) {
        const { Builder, Key } = await import('selenium-webdriver');
        const firefox = (await import('selenium-webdriver/firefox.js')).default;
        const profile = path.join(temporaryRoot, 'profile'); await mkdir(profile);
        resources.defer('cloud Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
        const options = new firefox.Options().addArguments('-headless', '-no-remote').setProfile(profile)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,peakbagger.com');
        options.enableBidi(); options.setAcceptInsecureCerts(true);
        const service = new firefox.ServiceBuilder().addArguments(`--profile-root=${temporaryRoot}`);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build() as FirefoxDriver;
        resources.defer('cloud Firefox', () => quitFirefoxDriver(driver, temporaryRoot));
        evaluate = (fn, value) => driver.executeScript(webdriverScript(fn, value)) as Promise<never>;
        resize = (width, height) => setFirefoxContentViewport(driver, { width, height }); navigate = url => driver.get(url);
        screenshot = async file => writeFile(file, await driver.takeScreenshot(), 'base64');
        // Element.sendKeys scrolls before dispatching. Send real keys to the
        // already focused control so the check measures the feature's behavior.
        key = async (selector, input) => {
            await evaluate((value: string) => document.querySelector<HTMLElement>(value)!.focus({ preventScroll: true }), selector);
            await driver.actions().sendKeys((Key as unknown as Record<string, string>)[input]).perform();
        };
        version = (await driver.getCapabilities()).getBrowserVersion() as string;
    } else {
        // Loaded here so the Firefox path does not need Playwright installed.
        const { launchVerificationChrome, PEAKBAGGER_HOST_RULE } = await import('./verification-launch.mts');
        const context = await launchVerificationChrome(resources, 'cloud Chrome', path.join(temporaryRoot, 'profile'), {
            ignoreHTTPSErrors: true, hosts: [PEAKBAGGER_HOST_RULE, 'peakbagger.com 127.0.0.1'] });
        const page = await context.newPage();
        await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        evaluate = (fn, value) => page.evaluate(fn as (arg: unknown) => never, value); resize = (width, height) => page.setViewportSize({ width, height }); navigate = url => page.goto(url);
        screenshot = file => page.screenshot({ path: file }); key = (selector, input) => page.locator(selector).press(({ ENTER: 'Enter', HOME: 'Home', END: 'End', ARROW_LEFT: 'ArrowLeft', ARROW_RIGHT: 'ArrowRight' } as Record<string, string>)[input] || input);
        version = context.browser()!.version();
    }
    const wait = (fn: () => unknown, description: string) => waitForCondition(() => evaluate(fn), { description, timeoutMs: 10000, intervalMs: 50 });
    const click = (selector: string) => evaluate((value: string) => document.querySelector<HTMLElement>(value)!.click(), selector);
    await resize(1440, 1000); await navigate(`${origin}/Peak.aspx?pid=2296&weather=1`); await evaluate(boot, { scripts, css });
    await evaluate(() => document.querySelector<Field>('#bpb-summit-cloud')!.scrollIntoView({ block: 'center' }));
    await wait(() => document.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.', 'initial cloud result');
    assert.match(await evaluate(() => document.querySelector<Field>('.bpb-cloud-selected-clock')!.textContent), /Today.*Fri, Oct 30.*11:00 PM PDT.*Current hour/,
        'the selected forecast must visibly name its summit-local day, date and relation to now');
    await evaluate(() => { const row = document.querySelector<Field>('#bpb-summit-cloud-row')!; const next = document.createElement('tr'); next.id = 'cloud-following'; next.innerHTML = '<td colspan="2">Following native content</td>'; row.after(next); });
    for (const [width, theme, zoom] of [[1440, 'light', 1], [820, 'dark', 1], [390, 'light', 1], [320, 'dark', 1], [820, 'light', 1.5]] as const) {
        await resize(width, 1000); await evaluate(({ theme: pageTheme, zoom: pageZoom }: { theme: string; zoom: number }) => { document.documentElement.dataset.bpbTheme = pageTheme; document.body.style.zoom = String(pageZoom); }, { theme, zoom });
        await evaluate(() => document.querySelector<Field>('#bpb-summit-cloud')!.scrollIntoView({ block: 'center' }));
        await wait(() => document.querySelector<Field>('#bpb-summit-cloud')!.getBoundingClientRect().width > 0, 'visible cloud card');
        await wait(() => {
            const viewport = document.querySelector<Field>('.bpb-cloud-hours')!.getBoundingClientRect();
            const selected = document.querySelector<Field>('.bpb-cloud-hour[aria-pressed="true"]')!.getBoundingClientRect();
            return selected.left >= viewport.left - 1 && selected.right <= viewport.right + 1;
        }, 'the selected hour remains visible after resize and zoom');
        await evaluate(() => document.querySelector<Field>('.bpb-cloud-refresh')!.focus({ preventScroll: true }));
        const before = await evaluate(geometry);
        assert.equal(before.viewport[0], width, 'the browser must use the requested content viewport');
        assert.equal(await evaluate(() => {
            const card = document.querySelector<Field>('#bpb-summit-cloud')!, probe = document.createElement('span');
            // The shared peak-card owner intentionally gives headers their own text token.
            probe.style.color = getComputedStyle(card).getPropertyValue('--peak-card-text'); card.append(probe);
            const matches = getComputedStyle(card.querySelector('h2')!).color === getComputedStyle(probe).color; probe.remove(); return matches;
        }), true, 'the heading must use the shared peak-card text token');
        await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.mode = 'hold'; }); await key('.bpb-cloud-refresh', 'ENTER');
        await wait(() => document.querySelector<Field>('#bpb-summit-cloud')!.getAttribute('aria-busy') === 'true', 'pending refresh');
        stable(before, await evaluate(geometry), `${width}/${theme}/${zoom} pending`);
        await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.release(); (window as unknown as CloudWindow).cloudFixture.mode = 'complete'; });
        await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'refresh completion');
        stable(before, await evaluate(geometry), `${width}/${theme}/${zoom} success`);
        await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.mode = 'error'; }); await key('.bpb-cloud-refresh', 'ENTER');
        await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent.includes('Refresh failed'), 'retained error');
        stable(before, await evaluate(geometry), `${width}/${theme}/${zoom} error`);
        await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.mode = 'complete'; }); await key('.bpb-cloud-refresh', 'ENTER');
        await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'retry completion');
        stable(before, await evaluate(geometry), `${width}/${theme}/${zoom} retry`);
        assert.match((await evaluate(geometry)).focus || '', /bpb-cloud-refresh/);
        const file = path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${width}-${theme}-${zoom}.png`); await screenshot(file);
        evidence.push({ width, theme, zoom, geometry: await evaluate(geometry), screenshot: file });
    }
    const requestsBeforeNavigation = await evaluate(() => (window as unknown as CloudWindow).cloudFixture.requests.length);
    const navigationGeometry = await evaluate(geometry);
    await key('.bpb-cloud-hour[aria-pressed="true"]', 'HOME');
    assert.match(await evaluate(() => document.querySelector<Field>('.bpb-cloud-selected-clock')!.textContent), /Today.*12:00 AM PDT.*Past forecast/);
    assert.equal(await evaluate(() => document.querySelector<Field>('.bpb-cloud-hours')!.scrollLeft), 0);
    stable(navigationGeometry, await evaluate(geometry), 'keyboard first hour', { timeline: false });
    await key('.bpb-cloud-hour[aria-pressed="true"]', 'ARROW_RIGHT');
    assert.equal(await evaluate(() => (document.activeElement as HTMLElement).dataset.index), '1');
    await key('.bpb-cloud-hour[aria-pressed="true"]', 'END');
    assert.match(await evaluate(() => document.querySelector<Field>('.bpb-cloud-selected-clock')!.textContent), /11:00 PM PDT.*Current hour/);
    assert.ok(await evaluate(() => document.querySelector<Field>('.bpb-cloud-hours')!.scrollLeft > 0));
    stable(navigationGeometry, await evaluate(geometry), 'keyboard last hour', { timeline: false });
    assert.equal(await evaluate(() => (window as unknown as CloudWindow).cloudFixture.requests.length), requestsBeforeNavigation);
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-cloud-hour[data-temporal="now"]').length), 1);
    const dateChange = (index: number) => evaluate((value: number) => { const select = document.querySelector<Field>('#bpb-summit-cloud-date')!; select.value = select.options[value].value; select.dispatchEvent(new Event('change')); }, index);
    await dateChange(1);
    await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'tomorrow forecast');
    assert.match(await evaluate(() => document.querySelector<Field>('.bpb-cloud-day')!.textContent), /Tomorrow.*Sat, Oct 31/);
    assert.match(await evaluate(() => document.querySelector<Field>('.bpb-cloud-selected-clock')!.textContent), /Tomorrow.*Sat, Oct 31.*Future forecast/);
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-cloud-hour[data-temporal="now"]').length), 0);
    await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-tomorrow.png`));
    await dateChange(3);
    await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'future forecast');
    assert.match(await evaluate(() => document.querySelector<Field>('.bpb-cloud-selected-clock')!.textContent), /Mon, Nov 2.*Future forecast/);
    const retainedDay = await evaluate(() => document.querySelector<Field>('.bpb-cloud-day')!.textContent);
    // Use an uncached date so the failure stub is actually exercised.
    await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.mode = 'error'; }); await dateChange(4);
    await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent.includes('Refresh failed'), 'retained dated result');
    assert.equal(await evaluate(() => document.querySelector<Field>('.bpb-cloud-day')!.textContent), retainedDay);
    await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.mode = 'complete'; }); await dateChange(0);
    await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'restored today');
    await evaluate(() => { document.body.style.zoom = '1'; }); await resize(390, 1000);
    await click('.bpb-cloud-details summary'); await evaluate(() => document.querySelector<Field>('#bpb-summit-cloud')!.scrollIntoView({ block: 'center' }));
    const expanded = await evaluate(geometry); await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.mode = 'hold'; }); await click('.bpb-cloud-refresh');
    await wait(() => document.querySelector<Field>('#bpb-summit-cloud')!.getAttribute('aria-busy') === 'true', 'expanded pending'); stable(expanded, await evaluate(geometry), 'expanded pending');
    await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.release(); (window as unknown as CloudWindow).cloudFixture.mode = 'complete'; });
    await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'expanded complete'); stable(expanded, await evaluate(geometry), 'expanded complete');
    await evaluate(() => { (window as unknown as CloudWindow).cloudFixture.mode = 'cloudy'; }); await click('.bpb-cloud-refresh');
    await wait(() => document.querySelector<Field>('.bpb-cloud-prediction')!.textContent.includes('inside cloud'), 'changed cloud result');
    stable(expanded, await evaluate(geometry), 'expanded changed forecast');
    await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-explanation.png`));
    const total = await evaluate(() => { const seen = new Set(); const previous = document.querySelector<Field>('[aria-label="Show earlier hours"]')!, next = document.querySelector<Field>('[aria-label="Show later hours"]')!;
        for (let i = 0; i < 4 && previous.getAttribute('aria-disabled') !== 'true'; i++) previous.click();
        for (let i = 0; i < 4; i++) { document.querySelectorAll<HTMLElement>('.bpb-cloud-hour').forEach(node => seen.add(node.dataset.index)); if (next.getAttribute('aria-disabled') === 'true') break; next.click(); } return seen.size; });
    assert.ok(total >= 23 && total <= 25);
    await evaluate(() => { const select = document.querySelector<Field>('#bpb-summit-cloud-model')!; select.value = 'ukmo_global_deterministic_10km'; select.dispatchEvent(new Event('change')); });
    await wait(() => (window as unknown as CloudWindow).cloudFixture.settings.bpbSummitCloudModel === 'ukmo_global_deterministic_10km' && document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'persisted long model selection');
    const saved = await evaluate(() => (window as unknown as CloudWindow).cloudFixture.settings);
    await navigate(`${origin}/Peak.aspx?pid=2296&weather=1`); await evaluate(boot, { scripts, css, saved });
    await evaluate(() => document.querySelector<Field>('#bpb-summit-cloud')!.scrollIntoView({ block: 'center' }));
    await wait(() => document.querySelector<Field>('.bpb-cloud-status')!.textContent === 'Cloud profiles updated.', 'restored model result');
    assert.equal(await evaluate(() => document.querySelector<Field>('#bpb-summit-cloud-model')!.value), 'ukmo_global_deterministic_10km');
    await click('#bpb-summit-cloud .bpb-peak-card-toggle');
    await wait(() => document.querySelector<Field>('#bpb-summit-cloud .bpb-peak-card-body')!.hidden, 'collapsed cloud card');
    assert.equal(await evaluate(() => [...document.querySelectorAll('#bpb-summit-cloud .bpb-peak-card-body button')].some(node => node.getClientRects().length)), false);
    for (const [now, count] of [[Date.parse('2026-03-08T15:00Z'), 23], [Date.parse('2026-11-01T09:30Z'), 25]]) {
        await resize(820, 1000); await navigate(`${origin}/Peak.aspx?pid=2296&weather=1`); await evaluate(boot, { scripts, css, now });
        await evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; document.querySelector<Field>('#bpb-summit-cloud')!.scrollIntoView({ block: 'center' }); });
        await wait(() => document.querySelector('.bpb-cloud-status')?.textContent === 'Cloud profiles updated.', 'DST cloud timeline');
        assert.equal(await evaluate(() => document.querySelectorAll('.bpb-cloud-hour').length), count);
        assert.equal(await evaluate(() => new Set([...document.querySelectorAll<HTMLElement>('.bpb-cloud-hour')].map(node => node.dataset.time)).size), count);
        if (count === 25) {
            assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.bpb-cloud-hour')]
                .filter(node => node.querySelector('.bpb-cloud-clock')!.textContent === '1 AM')
                .map(node => node.querySelector('.bpb-cloud-hour-zone')!.textContent)), ['PDT', 'PST']);
            assert.match(await evaluate(() => document.querySelector<Field>('.bpb-cloud-selected-clock')!.textContent), /Today.*Sun, Nov 1.*1:00 AM PST.*Current hour/);
            await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-dst-repeat.png`));
        }
    }
    const result = { browser: firefoxMode ? 'Firefox' : 'Chrome for Testing', version, hidden: true, temporaryRoot, totalHours: total, cases: evidence,
        dstHours: [23, 25],
        limitation: 'Provider responses and settings bridge stubbed. CSS zoom checked; native browser chrome, screen-reader speech and real forecast skill not established.' };
    await writeFile(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ browser: result.browser, version, cases: evidence.length, totalHours: total, output, temporaryRoot }));
} catch (error) { failure = error; }
await resources.dispose(failure as null);
