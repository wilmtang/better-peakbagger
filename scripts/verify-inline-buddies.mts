// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBrowserFixtureServer, projectRoot, waitForCondition as untypedWaitForCondition, webdriverScript } from './browser-verification-fixtures.mts';
import { createResourceStack } from './resource-stack.mts';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';
import { prepareFirefoxSource } from './run-firefox.mts';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mts';
import { createVerificationRoot } from './verification-launch.mts';
import type { Route } from 'playwright';
import type { Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => T | Promise<T>, options: { description: string }) => Promise<T>;
type Field = HTMLButtonElement;
// One tab in either browser: Playwright pages in Chrome, WebDriver windows in Firefox.
interface Target {
    evaluate<T>(fn: (arg: never) => T, arg?: unknown): Promise<Awaited<T>>;
    click(selector: string): Promise<unknown>;
    resize(width: number, height: number): Promise<unknown>;
    screenshot(output: string): Promise<unknown>;
}
interface HeldPost { dispatched(): boolean; remove(): Promise<unknown> }

// HTTPS contract fixture, actual unpacked extension and worker, native input.
const firefoxMode = process.argv.includes('--firefox');
if (!firefoxMode) assertChromeLaunchAllowed();
const resources = createResourceStack();
const profile = await createVerificationRoot(resources, 'better-peakbagger-inline-buddies-', 'inline Buddy profile');
let failure: unknown = null;
try {
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile, inlineBuddies: true } as never);
    resources.defer('inline Buddy fixture', () => fixture.close());
    const url = `https://www.peakbagger.com:${fixture.port}/climber/climber.aspx?cid=900002&hover=1`;
    const mutationUrl = new URL('/climber/climber.aspx?cid=900002', url).href;
    const networkErrors: string[] = [];
    let newPage: () => Promise<Target>, setSettings: (values: object) => Promise<unknown>, readLocal: (keys: string[]) => Promise<Record<string, unknown>>,
        holdPost: (gate: Promise<unknown>) => Promise<HeldPost>, version: string;
    if (firefoxMode) {
        const { Builder, By } = await import('selenium-webdriver');
        const firefox = (await import('selenium-webdriver/firefox.js')).default;
        resources.defer('inline Buddy Firefox processes', () => stopOwnedFirefoxProcesses(profile));
        const prepared = await prepareFirefoxSource({ temporaryRoot: profile });
        resources.defer('inline Buddy Firefox source', () => prepared.cleanup());
        const profileTemplate = path.join(profile, 'profile'); await mkdir(profileTemplate);
        const options = new firefox.Options().addArguments('-headless', '-no-remote').setProfile(profileTemplate)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,peakbagger.com');
        options.enableBidi(); options.setAcceptInsecureCerts(true);
        if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
        const service = new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${profile}`);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build() as FirefoxDriver;
        resources.defer('inline Buddy Firefox driver', () => quitFirefoxDriver(driver, profile));
        await driver.manage().setTimeouts({ pageLoad: 20_000, script: 15_000 });
        version = (await driver.getCapabilities()).getBrowserVersion() as string;
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        let settingsUrl: string;
        try {
            settingsUrl = await driver.executeScript<string>('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        } finally { await driver.setContext(firefox.Context.CONTENT); }
        await driver.get(settingsUrl);
        const settingsWindow = await driver.getWindowHandle();
        const bidi = await driver.getBidi();
        type BidiReply = { type: string; error?: string; message?: string; result?: unknown };
        const send = async (request: { method: string; params: object }) => {
            const result = await bidi.send(request) as BidiReply;
            if (result.type === 'error') throw new Error(`${result.error}: ${result.message}`);
            return result;
        };
        newPage = async () => {
            await driver.switchTo().newWindow('tab');
            const handle = await driver.getWindowHandle();
            const select = () => driver.switchTo().window(handle);
            const evaluate = async (fn: (arg: never) => unknown, ...args: unknown[]) => { await select(); return driver.executeScript(webdriverScript(fn, ...args)); };
            await driver.get(url);
            await send({ method: 'browsingContext.setViewport', params: { context: handle, viewport: { width: 1000, height: 760 } } });
            return {
                evaluate: evaluate as Target['evaluate'],
                click: async (selector: string) => { await select(); await driver.findElement(By.css(selector)).click(); },
                resize: (width: number, height: number) => send({ method: 'browsingContext.setViewport', params: { context: handle, viewport: { width, height } } }),
                screenshot: async (output: string) => { await select(); await writeFile(output, await driver.takeScreenshot(), 'base64'); },
            };
        };
        const inSettings = async (script: string, value: unknown) => {
            const previous = await driver.getWindowHandle();
            await driver.switchTo().window(settingsWindow);
            try {
                const result = await driver.executeAsyncScript<{ ok: boolean; error?: string; value?: Record<string, unknown> }>(script, value);
                if (!result.ok) throw new Error(result.error);
                return result.value as Record<string, unknown>;
            } finally { await driver.switchTo().window(previous); }
        };
        setSettings = values => inSettings('const done=arguments[arguments.length-1]; chrome.storage.sync.set({bpbSettings:arguments[0]}).then(()=>done({ok:true}),error=>done({ok:false,error:String(error)}));', values);
        readLocal = keys => inSettings('const done=arguments[arguments.length-1]; chrome.storage.local.get(arguments[0]).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));', keys);
        holdPost = async gate => {
            let dispatched = false;
            await bidi.subscribe('network.beforeRequestSent');
            const listener = (params: { isBlocked: boolean; request: { url: string; method: string; request: string } }) => {
                if (!params.isBlocked) return;
                void (async () => {
                    if (params.request.url === mutationUrl && params.request.method === 'POST') {
                        dispatched = true; await gate;
                    }
                    await send({ method: 'network.continueRequest', params: { request: params.request.request } });
                })().catch(error => networkErrors.push(error.message));
            };
            bidi.on('network.beforeRequestSent', listener);
            resources.defer('inline Buddy BiDi listener', () => bidi.off('network.beforeRequestSent', listener));
            const result = await send({ method: 'network.addIntercept', params: { phases: ['beforeRequestSent'],
                urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'www.peakbagger.com', pathname: '/climber/climber.aspx' }] } });
            let removed = false;
            const remove = async () => {
                if (removed) return;
                await send({ method: 'network.removeIntercept', params: { intercept: (result.result as { intercept: string }).intercept } });
                removed = true;
            };
            resources.defer('inline Buddy BiDi interception', remove);
            return { dispatched: () => dispatched, remove };
        };
    } else {
        // Loaded here so the Firefox path does not need Playwright installed.
        const { launchVerificationChrome, PEAKBAGGER_HOST_RULE } = await import('./verification-launch.mts');
        const extension = path.join(projectRoot, 'dist');
        const context = await launchVerificationChrome(resources, 'inline Buddy Chrome browser', profile, {
            viewport: { width: 1000, height: 760 }, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            trustArgs: fixture.chromeTrustArgs, extension, hosts: [PEAKBAGGER_HOST_RULE],
        });
        version = context.browser()!.version();
        newPage = async () => {
            const tab = await context.newPage(); await tab.goto(url);
            return {
                evaluate: ((fn: (arg: unknown) => unknown, arg?: unknown) => tab.evaluate(fn, arg)) as Target['evaluate'], click: (selector: string) => tab.locator(selector).click(),
                resize: (width: number, height: number) => tab.setViewportSize({ width, height }),
                screenshot: (output: string) => tab.screenshot({ path: output }),
            };
        };
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        setSettings = values => worker.evaluate(async bpbSettings => chrome.storage.sync.set({ bpbSettings }), values);
        readLocal = keys => worker.evaluate(async storageKeys => chrome.storage.local.get(storageKeys), keys);
        holdPost = async gate => {
            let dispatched = false;
            const intercept = async (route: Route) => {
                if (route.request().method() === 'POST') { dispatched = true; await gate; }
                await route.continue();
            };
            await context.route(mutationUrl, intercept);
            return { dispatched: () => dispatched, remove: () => context.unroute(mutationUrl, intercept) };
        };
    }
    const wait = async (target: Target, condition: () => unknown, description: string) => {
        try { return await waitForCondition(() => target.evaluate(condition), { description }); }
        catch (error) {
            const state = await target.evaluate(() => ({
                cardHidden: (document.getElementById('bpb-climber-card') as Field | null)?.hidden,
                buddy: (document.getElementById('bpb-climber-card-buddy') as Field | null)?.textContent,
                busy: (document.getElementById('bpb-climber-card-buddy') as Field | null)?.disabled,
                favorite: (document.getElementById('bpb-climber-card-favorite') as Field | null)?.textContent,
                ignoreDisabled: (document.getElementById('bpb-climber-card-ignore') as Field | null)?.disabled,
                feedback: document.querySelector('.bpb-climber-card-feedback')?.textContent,
            })).catch(() => 'page unavailable');
            throw new Error(`${(error as Error).message}; live card state: ${JSON.stringify(state)}`, { cause: error });
        }
    };
    const ready = (target: Target) => wait(target, () => !!document.querySelector('#hover-climber + button'), 'climber actions trigger');
    const page = await newPage(); await ready(page);
    const open = async (target: Target) => {
        await target.evaluate(() => (document.getElementById('hover-climber') as Field).scrollIntoView({ block: 'center' }));
        await target.click('#hover-climber + button');
        await wait(target, () => !(document.getElementById('bpb-climber-card') as Field).hidden
            && !(document.getElementById('bpb-climber-card-buddy') as Field).disabled, 'available Buddy action');
    };
    await open(page);
    assert.equal(fixture.requests.buddyMutations, 0);
    await page.click('#bpb-climber-card-buddy');
    await wait(page, () => (document.getElementById('bpb-climber-card-buddy') as Field).textContent === 'Remove climbing buddy'
        && (document.getElementById('bpb-climber-card-buddy') as Field).disabled === false, 'confirmed inline Buddy addition');
    await setSettings({ favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved: true });
    await wait(page, () => !(document.getElementById('bpb-climber-card-favorite') as Field).hidden, 'custom favorite source');
    await page.click('#bpb-climber-card-buddy');
    await wait(page, () => (document.getElementById('bpb-climber-card-buddy') as Field).textContent === 'Add climbing buddy'
        && (document.getElementById('bpb-climber-card-buddy') as Field).disabled === false, 'confirmed inline Buddy removal');
    assert.equal(fixture.requests.buddyMutations, 2);

    // Hold a POST to verify another tab cannot overwrite or Ignore its target.
    const other = await newPage(); await ready(other);
    await open(other);
    let release!: (value?: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const interception = await holdPost(gate);
    resources.defer('held Buddy POST', () => release());
    await page.click('#bpb-climber-card-buddy');
    await wait(other, () => (document.getElementById('bpb-climber-card-buddy') as Field).textContent === 'Check buddy status'
        && (document.getElementById('bpb-climber-card-ignore') as Field).disabled, 'cross-tab Ignore protection');
    await waitForCondition(interception.dispatched, { description: 'held Buddy POST dispatch' });
    await other.click('#bpb-climber-card-buddy');
    await wait(other, () => document.querySelector('.bpb-climber-card-feedback')!.textContent.includes('another tab'), 'cross-tab Buddy protection');
    release();
    await wait(page, () => (document.getElementById('bpb-climber-card-buddy') as Field).textContent === 'Remove climbing buddy'
        && (document.getElementById('bpb-climber-card-favorite') as Field).textContent === 'Remove favorite climber'
        && (document.getElementById('bpb-climber-card-buddy') as Field).disabled === false, 'confirmed Buddy and favorite reconciliation');
    await interception.remove();
    assert.equal(fixture.requests.buddyMutations, 3);

    const output = process.env.BPB_BUDDY_SCREENSHOTS;
    if (output) await mkdir(output, { recursive: true });
    for (const [width, theme] of [[1000, 'light'], [320, 'dark']] as const) {
        await page.resize(width, 760);
        assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, 760]);
        await page.evaluate(() => (document.getElementById('hover-climber') as Field).scrollIntoView({ block: 'center' }));
        if (await page.evaluate(() => (document.getElementById('bpb-climber-card') as Field).hidden)) await open(page);
        await page.evaluate((next: string) => { document.documentElement.dataset.bpbTheme = next; }, theme);
        await wait(page, () => {
            const card = document.getElementById('bpb-climber-card')!, rect = card.getBoundingClientRect();
            return !card.hidden && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
                && card.scrollWidth <= card.clientWidth + 1 && getComputedStyle(card).opacity === '1'
                && card.getAnimations().every(animation => animation.playState === 'finished');
        }, 'settled Buddy card within content viewport');
        if (output) await page.screenshot(path.join(output, `buddy-added-${width}-${theme}.png`));
    }
    await page.click('#bpb-climber-card-buddy');
    await wait(page, () => (document.getElementById('bpb-climber-card-buddy') as Field).textContent === 'Add climbing buddy'
        && (document.getElementById('bpb-climber-card-favorite') as Field).textContent === 'Add favorite climber'
        && (document.getElementById('bpb-climber-card-buddy') as Field).disabled === false, 'confirmed Buddy and favorite removal');
    assert.equal(fixture.requests.buddyMutations, 4);
    const state = await readLocal(['bpbBuddyIntents', 'bpbBuddyCache']);
    assert.deepEqual(state.bpbBuddyIntents, []);
    assert.deepEqual((state.bpbBuddyCache as { entries: unknown[] }).entries, []);
    await page.click('#AddBuddy');
    await wait(page, () => (document.getElementById('RemoveBuddy') as Field | null)?.disabled === false, 'confirmed native Buddy addition');
    await page.click('#RemoveBuddy');
    await wait(page, () => (document.getElementById('AddBuddy') as Field | null)?.disabled === false, 'confirmed native Buddy removal');
    assert.equal(fixture.requests.buddyMutations, 6);
    assert.deepEqual(networkErrors, []);
    console.log(JSON.stringify({ browser: firefoxMode ? 'Firefox' : 'Chrome for Testing', version, hidden: true,
        surface: 'native HTML/CSS; no WebGL', viewports: ['1000x760 light', '320x760 dark'],
        buddyPosts: fixture.requests.buddyMutations, checks: 'inline/native add/remove, shared worker, cross-tab race, favorites reconciliation' }));
} catch (error) { failure = error; }
finally { await resources.dispose(failure as null); }
assert.equal(existsSync(profile), false);
console.log(JSON.stringify({ cleanup: 'browser/server closed and profile/certificate removed', profile }));
