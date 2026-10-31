// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, location */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { verifySettingsFragments, verifySettingsScrollTracking, readSettingsFragmentLanding, settingsFragmentLanded } from './settings-fragment-verification.mjs';
import { waitForCondition } from './browser-verification-fixtures.mjs';

const kind = process.argv[2] || 'chrome';
assert.ok(process.argv.length <= 3 && ['chrome', 'firefox'].includes(kind), 'Usage: node scripts/verify-settings-fragments.mjs [chrome|firefox]');
const resources = createResourceStack(); let failure, screenshot;
try {
    const root = await mkdtemp(path.join(tmpdir(), 'bpb-settings-fragments-'));
    resources.defer('settings fragment profile', () => rm(root, { recursive: true, force: true }));
    let evaluate, navigate, reload, back, forward, resize, keyboardLink, version, optionsUrl, delayedSettings;
    const images = process.env.BPB_SETTINGS_FRAGMENT_SCREENSHOTS;
    if (images) await mkdir(images, { recursive: true });
    if (kind === 'chrome') {
        assertChromeLaunchAllowed();
        const dist = path.resolve('dist');
        const context = await chromium.launchPersistentContext(root, { channel: 'chromium', headless: true,
            viewport: { width: 1000, height: 760 }, args: [`--load-extension=${dist}`, `--disable-extensions-except=${dist}`] });
        resources.defer('settings fragment Chrome', () => context.close());
        const page = await context.newPage(); await page.goto('chrome://extensions-internals/');
        const extension = await page.waitForFunction(() => {
            try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); } catch { return false; }
        }).then(handle => handle.jsonValue());
        optionsUrl = `chrome-extension://${extension.id}/options/options.html`;
        evaluate = (fn, arg) => page.evaluate(fn, arg);
        navigate = async hash => { await page.goto('about:blank'); await page.goto(optionsUrl + hash); };
        reload = () => page.reload(); back = () => page.goBack(); forward = () => page.goForward();
        resize = (width, height) => page.setViewportSize({ width, height });
        keyboardLink = async hash => { const link = page.locator(`.side-nav a[href="${hash}"]`); await link.focus(); await link.press('Enter'); };
        screenshot = async name => { if (images) await page.screenshot({ path: path.join(images, `chrome-${name}.png`) }); };
        version = context.browser().version();
        delayedSettings = async () => {
            await navigate('');
            await page.evaluate(() => globalThis.chrome.storage.sync.set({ bpbSettings: { theme: 'dark', enableReportEditor: false, enableGarminInbox: true } }));
            await context.addInitScript(() => {
                if (!location.search.includes('bpb-delay-settings')) return;
                const api = globalThis.chrome, get = api.storage.sync.get.bind(api.storage.sync);
                const gate = new Promise(resolve => { window.bpbReleaseInitialSettings = resolve; });
                api.storage.sync.get = (...args) => gate.then(() => get(...args));
            });
            await page.goto('about:blank'); await page.goto(`${optionsUrl}?bpb-delay-settings#map-chart-chart`);
            await page.waitForFunction(() => typeof window.bpbReleaseInitialSettings === 'function');
            const landed = () => waitForCondition(() => page.evaluate(readSettingsFragmentLanding), {
                description: 'delayed initial settings preserve the chart anchor',
                isReady: value => settingsFragmentLanded(value, '#map-chart-chart'),
            });
            await landed(); await page.evaluate(() => window.bpbReleaseInitialSettings());
            await page.waitForFunction(() => document.getElementById('enable-garmin-inbox').checked && !document.getElementById('capture-garmin').hidden
                && !document.getElementById('enable-report-editor').checked && document.querySelector('[data-report-editor-dependent]').hidden);
            await landed(); await screenshot('delayed-settings');
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
            .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${root}`)).build();
        resources.defer('settings fragment Firefox driver', () => quitFirefoxDriver(driver, root));
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        optionsUrl = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        await driver.setContext(firefox.Context.CONTENT);
        evaluate = (fn, arg) => driver.executeScript(`return (${fn})(arguments[0]);`, arg);
        navigate = async hash => { await driver.get('about:blank'); await driver.get(optionsUrl + hash); }; reload = () => driver.navigate().refresh();
        back = () => driver.navigate().back(); forward = () => driver.navigate().forward();
        resize = (width, height) => driver.manage().window().setRect({ width, height });
        keyboardLink = async hash => (await driver.findElement(By.css(`.side-nav a[href="${hash}"]`))).sendKeys(Key.ENTER);
        screenshot = async name => { if (images) await writeFile(path.join(images, `firefox-${name}.png`), await driver.takeScreenshot(), 'base64'); };
        version = (await driver.getCapabilities()).getBrowserVersion();
    }
    const configure = async prefs => {
        await navigate('');
        await evaluate(async prefs => {
            const api = globalThis.browser || globalThis.chrome;
            await api.storage.sync.set({ bpbSettings: prefs });
        }, prefs);
    };
    const scrollTracking = await verifySettingsScrollTracking({ evaluate, navigate, resize, configure, screenshot });
    const result = await verifySettingsFragments({ evaluate, navigate, reload, back, forward, resize, keyboardLink, configure, screenshot });
    if (delayedSettings) await delayedSettings();
    console.log(JSON.stringify({ verification: 'settings-fragments', browser: kind, version, hidden: true, ...result, scrollTracking,
        ...delayedSettings ? { cases: result.cases + 1, delayedInitialSettings: true } : {} }));
} catch (error) { failure = error; try { await screenshot?.('failure'); } catch { /* Keep the original assertion. */ } }
await resources.dispose(failure);
