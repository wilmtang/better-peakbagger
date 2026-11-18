// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createResourceStack } from './resource-stack.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { verifySettingsFragments, verifySettingsScrollTracking, readSettingsFragmentLanding, settingsFragmentLanded } from './settings-fragment-verification.mjs';
import { waitForCondition as untypedWaitForCondition } from './browser-verification-fixtures.mjs';
import { createVerificationRoot, launchVerificationChrome } from './verification-launch.mts';
import type { Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => Promise<T>, options: { description: string; isReady: (value: T) => boolean }) => Promise<T>;
type Evaluate = (fn: (arg: never) => unknown, arg?: unknown) => Promise<unknown>;
declare global { interface Window { bpbReleaseInitialSettings: (value?: unknown) => void } }

const kind = process.argv[2] || 'chrome';
assert.ok(process.argv.length <= 3 && ['chrome', 'firefox'].includes(kind), 'Usage: node scripts/verify-settings-fragments.mts [chrome|firefox]');
const resources = createResourceStack(); let failure: unknown = null, screenshot: ((name: string) => Promise<void>) | undefined;
try {
    const root = await createVerificationRoot(resources, 'bpb-settings-fragments-', 'settings fragment profile');
    let evaluate: Evaluate, navigate: (hash: string) => Promise<void>, reload: () => Promise<unknown>, back: () => Promise<unknown>, forward: () => Promise<unknown>,
        resize: (width: number, height: number) => Promise<unknown>, keyboardLink: (hash: string) => Promise<unknown>, version: string, optionsUrl: string,
        delayedSettings: (() => Promise<void>) | undefined;
    const images = process.env.BPB_SETTINGS_FRAGMENT_SCREENSHOTS;
    if (images) await mkdir(images, { recursive: true });
    if (kind === 'chrome') {
        const dist = path.resolve('dist');
        const context = await launchVerificationChrome(resources, 'settings fragment Chrome', root, { viewport: { width: 1000, height: 760 }, extension: dist });
        const page = await context.newPage(); await page.goto('chrome://extensions-internals/');
        const extension = await page.waitForFunction(() => {
            try { return JSON.parse(document.body.innerText).find((item: { name: string; id: string }) => item.name === 'Better Peakbagger'); } catch { return false; }
        }).then(handle => handle.jsonValue());
        optionsUrl = `chrome-extension://${extension.id}/options/options.html`;
        evaluate = (fn, arg) => page.evaluate(fn as (value: unknown) => unknown, arg);
        navigate = async hash => { await page.goto('about:blank'); await page.goto(optionsUrl + hash); };
        reload = () => page.reload(); back = () => page.goBack(); forward = () => page.goForward();
        resize = (width, height) => page.setViewportSize({ width, height });
        keyboardLink = async hash => { const link = page.locator(`.side-nav a[href="${hash}"]`); await link.focus(); await link.press('Enter'); };
        screenshot = async name => { if (images) await page.screenshot({ path: path.join(images, `chrome-${name}.png`) }); };
        version = context.browser()!.version();
        delayedSettings = async () => {
            await navigate('');
            await page.evaluate(() => globalThis.chrome.storage.sync.set({ bpbSettings: { theme: 'dark', enableReportEditor: false, enableGarminInbox: true } }));
            await context.addInitScript(() => {
                if (!location.search.includes('bpb-delay-settings')) return;
                const api = globalThis.chrome, get = api.storage.sync.get.bind(api.storage.sync);
                const gate = new Promise(resolve => { window.bpbReleaseInitialSettings = resolve; });
                api.storage.sync.get = ((...args: Parameters<typeof get>) => gate.then(() => get(...args))) as typeof api.storage.sync.get;
            });
            await page.goto('about:blank'); await page.goto(`${optionsUrl}?bpb-delay-settings#map-chart-chart`);
            await page.waitForFunction(() => typeof window.bpbReleaseInitialSettings === 'function');
            const landed = () => waitForCondition(() => page.evaluate(readSettingsFragmentLanding), {
                description: 'delayed initial settings preserve the chart anchor',
                isReady: value => settingsFragmentLanded(value, '#map-chart-chart'),
            });
            await landed(); await page.evaluate(() => window.bpbReleaseInitialSettings());
            await page.waitForFunction(() => (document.getElementById('enable-garmin-inbox') as HTMLInputElement).checked && !document.getElementById('capture-garmin')!.hidden
                && !(document.getElementById('enable-report-editor') as HTMLInputElement).checked && document.querySelector<HTMLElement>('[data-report-editor-dependent]')!.hidden);
            await landed(); await screenshot!('delayed-settings');
        };
    } else {
        const { Builder, By, Key } = await import('selenium-webdriver');
        const firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot: root }); resources.defer('settings fragment Firefox source', () => prepared.cleanup());
        resources.defer('settings fragment Firefox processes', () => stopOwnedFirefoxProcesses(root));
        const profile = path.join(root, 'profile'); await mkdir(profile);
        const options = new firefox.Options().addArguments('-headless').setProfile(profile);
        if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
            .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${root}`)).build() as FirefoxDriver;
        resources.defer('settings fragment Firefox driver', () => quitFirefoxDriver(driver, root));
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        optionsUrl = await driver.executeScript<string>('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        await driver.setContext(firefox.Context.CONTENT);
        evaluate = (fn, arg) => driver.executeScript(`return (${fn})(arguments[0]);`, arg);
        navigate = async hash => { await driver.get('about:blank'); await driver.get(optionsUrl + hash); }; reload = () => driver.navigate().refresh();
        back = () => driver.navigate().back(); forward = () => driver.navigate().forward();
        resize = (width, height) => driver.manage().window().setRect({ width, height });
        keyboardLink = async hash => (await driver.findElement(By.css(`.side-nav a[href="${hash}"]`))).sendKeys(Key.ENTER);
        screenshot = async name => { if (images) await writeFile(path.join(images, `firefox-${name}.png`), await driver.takeScreenshot(), 'base64'); };
        version = (await driver.getCapabilities()).getBrowserVersion() as string;
    }
    const configure = async (prefs: object) => {
        await navigate('');
        await evaluate((async (bpbSettings: object) => {
            const api = (globalThis as { browser?: typeof chrome }).browser || globalThis.chrome;
            await api.storage.sync.set({ bpbSettings });
        }) as (arg: never) => unknown, prefs);
    };
    const scrollTracking = await verifySettingsScrollTracking({ evaluate, navigate, resize, configure, screenshot });
    const result = await verifySettingsFragments({ evaluate, navigate, reload, back, forward, resize, keyboardLink, configure, screenshot });
    if (delayedSettings) await delayedSettings();
    console.log(JSON.stringify({ verification: 'settings-fragments', browser: kind, version, hidden: true, ...result, scrollTracking,
        ...delayedSettings ? { cases: result.cases + 1, delayedInitialSettings: true } : {} }));
} catch (error) { failure = error; try { await screenshot?.('failure'); } catch { /* Keep the original assertion. */ } }
await resources.dispose(failure as null);
