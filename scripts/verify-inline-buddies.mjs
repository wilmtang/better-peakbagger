// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, chrome, innerWidth, innerHeight, getComputedStyle */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrowserFixtureServer, projectRoot, waitForCondition, webdriverScript } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';

// HTTPS contract fixture, actual unpacked extension and worker, native input.
const firefoxMode = process.argv.includes('--firefox');
if (!firefoxMode) assertChromeLaunchAllowed();
const resources = createResourceStack();
const profile = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-inline-buddies-'));
resources.defer('inline Buddy profile', () => rm(profile, { recursive: true, force: true }));
let failure;
try {
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile, inlineBuddies: true });
    resources.defer('inline Buddy fixture', () => fixture.close());
    const url = `https://www.peakbagger.com:${fixture.port}/climber/climber.aspx?cid=900002&hover=1`;
    const mutationUrl = new URL('/climber/climber.aspx?cid=900002', url).href;
    const networkErrors = [];
    let newPage, setSettings, readLocal, holdPost, version;
    if (firefoxMode) {
        const { Builder, By } = await import('selenium-webdriver');
        const firefox = (await import('selenium-webdriver/firefox.js')).default;
        resources.defer('inline Buddy Firefox processes', () => stopOwnedFirefoxProcesses(profile));
        const prepared = await prepareFirefoxSource({ temporaryRoot: profile });
        resources.defer('inline Buddy Firefox source', () => prepared.cleanup());
        const profileTemplate = path.join(profile, 'profile'); await mkdir(profileTemplate);
        const options = new firefox.Options().addArguments('-headless').enableBidi().setProfile(profileTemplate)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,peakbagger.com').setAcceptInsecureCerts(true);
        if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
        const service = new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${profile}`);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
        resources.defer('inline Buddy Firefox driver', () => quitFirefoxDriver(driver, profile));
        await driver.manage().setTimeouts({ pageLoad: 20_000, script: 15_000 });
        version = (await driver.getCapabilities()).getBrowserVersion();
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        let settingsUrl;
        try {
            settingsUrl = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        } finally { await driver.setContext(firefox.Context.CONTENT); }
        await driver.get(settingsUrl);
        const settingsWindow = await driver.getWindowHandle();
        const bidi = await driver.getBidi();
        const send = async request => {
            const result = await bidi.send(request);
            if (result.type === 'error') throw new Error(`${result.error}: ${result.message}`);
            return result;
        };
        newPage = async () => {
            await driver.switchTo().newWindow('tab');
            const handle = await driver.getWindowHandle();
            const select = () => driver.switchTo().window(handle);
            const evaluate = async (fn, ...args) => { await select(); return driver.executeScript(webdriverScript(fn, ...args)); };
            await driver.get(url);
            await send({ method: 'browsingContext.setViewport', params: { context: handle, viewport: { width: 1000, height: 760 } } });
            return {
                evaluate,
                click: async selector => { await select(); await driver.findElement(By.css(selector)).click(); },
                resize: (width, height) => send({ method: 'browsingContext.setViewport', params: { context: handle, viewport: { width, height } } }),
                screenshot: async output => { await select(); await writeFile(output, await driver.takeScreenshot(), 'base64'); },
            };
        };
        const inSettings = async (script, value) => {
            const previous = await driver.getWindowHandle();
            await driver.switchTo().window(settingsWindow);
            try {
                const result = await driver.executeAsyncScript(script, value);
                if (!result.ok) throw new Error(result.error);
                return result.value;
            } finally { await driver.switchTo().window(previous); }
        };
        setSettings = values => inSettings('const done=arguments[arguments.length-1]; chrome.storage.sync.set({bpbSettings:arguments[0]}).then(()=>done({ok:true}),error=>done({ok:false,error:String(error)}));', values);
        readLocal = keys => inSettings('const done=arguments[arguments.length-1]; chrome.storage.local.get(arguments[0]).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));', keys);
        holdPost = async gate => {
            let dispatched = false;
            await bidi.subscribe('network.beforeRequestSent');
            const listener = params => {
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
                await send({ method: 'network.removeIntercept', params: { intercept: result.result.intercept } });
                removed = true;
            };
            resources.defer('inline Buddy BiDi interception', remove);
            return { dispatched: () => dispatched, remove };
        };
    } else {
        const { chromium } = await import('playwright');
        const extension = path.join(projectRoot, 'dist');
        assertChromeLaunchAllowed();
        const context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
            ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
                '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
        });
        resources.defer('inline Buddy Chrome browser', () => context.close());
        version = context.browser().version();
        newPage = async () => {
            const tab = await context.newPage(); await tab.goto(url);
            return {
                evaluate: (fn, arg) => tab.evaluate(fn, arg), click: selector => tab.locator(selector).click(),
                resize: (width, height) => tab.setViewportSize({ width, height }),
                screenshot: output => tab.screenshot({ path: output }),
            };
        };
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        setSettings = values => worker.evaluate(async values => chrome.storage.sync.set({ bpbSettings: values }), values);
        readLocal = keys => worker.evaluate(async keys => chrome.storage.local.get(keys), keys);
        holdPost = async gate => {
            let dispatched = false;
            const intercept = async route => {
                if (route.request().method() === 'POST') { dispatched = true; await gate; }
                await route.continue();
            };
            await context.route(mutationUrl, intercept);
            return { dispatched: () => dispatched, remove: () => context.unroute(mutationUrl, intercept) };
        };
    }
    const wait = async (target, condition, description) => {
        try { return await waitForCondition(() => target.evaluate(condition), { description }); }
        catch (error) {
            const state = await target.evaluate(() => ({
                cardHidden: document.getElementById('bpb-climber-card')?.hidden,
                buddy: document.getElementById('bpb-climber-card-buddy')?.textContent,
                busy: document.getElementById('bpb-climber-card-buddy')?.disabled,
                favorite: document.getElementById('bpb-climber-card-favorite')?.textContent,
                ignoreDisabled: document.getElementById('bpb-climber-card-ignore')?.disabled,
                feedback: document.querySelector('.bpb-climber-card-feedback')?.textContent,
            })).catch(() => 'page unavailable');
            throw new Error(`${error.message}; live card state: ${JSON.stringify(state)}`, { cause: error });
        }
    };
    const ready = target => wait(target, () => !!document.querySelector('#hover-climber + button'), 'climber actions trigger');
    const page = await newPage(); await ready(page);
    const open = async target => {
        await target.evaluate(() => document.getElementById('hover-climber').scrollIntoView({ block: 'center' }));
        await target.click('#hover-climber + button');
        await wait(target, () => !document.getElementById('bpb-climber-card').hidden
            && !document.getElementById('bpb-climber-card-buddy').disabled, 'available Buddy action');
    };
    await open(page);
    assert.equal(fixture.requests.buddyMutations, 0);
    await page.click('#bpb-climber-card-buddy');
    await wait(page, () => document.getElementById('bpb-climber-card-buddy').textContent === 'Remove climbing buddy'
        && document.getElementById('bpb-climber-card-buddy').disabled === false, 'confirmed inline Buddy addition');
    await setSettings({ favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved: true });
    await wait(page, () => !document.getElementById('bpb-climber-card-favorite').hidden, 'custom favorite source');
    await page.click('#bpb-climber-card-buddy');
    await wait(page, () => document.getElementById('bpb-climber-card-buddy').textContent === 'Add climbing buddy'
        && document.getElementById('bpb-climber-card-buddy').disabled === false, 'confirmed inline Buddy removal');
    assert.equal(fixture.requests.buddyMutations, 2);

    // Hold a POST to verify another tab cannot overwrite or Ignore its target.
    const other = await newPage(); await ready(other);
    await open(other);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const interception = await holdPost(gate);
    resources.defer('held Buddy POST', () => release());
    await page.click('#bpb-climber-card-buddy');
    await wait(other, () => document.getElementById('bpb-climber-card-buddy').textContent === 'Check buddy status'
        && document.getElementById('bpb-climber-card-ignore').disabled, 'cross-tab Ignore protection');
    await waitForCondition(interception.dispatched, { description: 'held Buddy POST dispatch' });
    await other.click('#bpb-climber-card-buddy');
    await wait(other, () => document.querySelector('.bpb-climber-card-feedback').textContent.includes('another tab'), 'cross-tab Buddy protection');
    release();
    await wait(page, () => document.getElementById('bpb-climber-card-buddy').textContent === 'Remove climbing buddy'
        && document.getElementById('bpb-climber-card-favorite').textContent === 'Remove favorite climber'
        && document.getElementById('bpb-climber-card-buddy').disabled === false, 'confirmed Buddy and favorite reconciliation');
    await interception.remove();
    assert.equal(fixture.requests.buddyMutations, 3);

    const output = process.env.BPB_BUDDY_SCREENSHOTS;
    if (output) await mkdir(output, { recursive: true });
    for (const [width, theme] of [[1000, 'light'], [320, 'dark']]) {
        await page.resize(width, 760);
        assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, 760]);
        await page.evaluate(() => document.getElementById('hover-climber').scrollIntoView({ block: 'center' }));
        if (await page.evaluate(() => document.getElementById('bpb-climber-card').hidden)) await open(page);
        await page.evaluate(theme => { document.documentElement.dataset.bpbTheme = theme; }, theme);
        await wait(page, () => {
            const card = document.getElementById('bpb-climber-card'), rect = card.getBoundingClientRect();
            return !card.hidden && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
                && card.scrollWidth <= card.clientWidth + 1 && getComputedStyle(card).opacity === '1'
                && card.getAnimations().every(animation => animation.playState === 'finished');
        }, 'settled Buddy card within content viewport');
        if (output) await page.screenshot(path.join(output, `buddy-added-${width}-${theme}.png`));
    }
    await page.click('#bpb-climber-card-buddy');
    await wait(page, () => document.getElementById('bpb-climber-card-buddy').textContent === 'Add climbing buddy'
        && document.getElementById('bpb-climber-card-favorite').textContent === 'Add favorite climber'
        && document.getElementById('bpb-climber-card-buddy').disabled === false, 'confirmed Buddy and favorite removal');
    assert.equal(fixture.requests.buddyMutations, 4);
    const state = await readLocal(['bpbBuddyIntents', 'bpbBuddyCache']);
    assert.deepEqual(state.bpbBuddyIntents, []);
    assert.deepEqual(state.bpbBuddyCache.entries, []);
    await page.click('#AddBuddy');
    await wait(page, () => document.getElementById('RemoveBuddy')?.disabled === false, 'confirmed native Buddy addition');
    await page.click('#RemoveBuddy');
    await wait(page, () => document.getElementById('AddBuddy')?.disabled === false, 'confirmed native Buddy removal');
    assert.equal(fixture.requests.buddyMutations, 6);
    assert.deepEqual(networkErrors, []);
    console.log(JSON.stringify({ browser: firefoxMode ? 'Firefox' : 'Chrome for Testing', version, hidden: true,
        surface: 'native HTML/CSS; no WebGL', viewports: ['1000x760 light', '320x760 dark'],
        buddyPosts: fixture.requests.buddyMutations, checks: 'inline/native add/remove, shared worker, cross-tab race, favorites reconciliation' }));
} catch (error) { failure = error; }
finally { await resources.dispose(failure); }
assert.equal(existsSync(profile), false);
console.log(JSON.stringify({ cleanup: 'browser/server closed and profile/certificate removed', profile }));
