// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, chrome */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserFixtureServer, waitForCondition, webdriverScript } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { weatherFixture } from '../test/helpers/weather-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firefoxMode = process.argv.includes('--firefox');
const live = process.argv.includes('--live'); // one optional public-coordinate CORS proof
const resources = createResourceStack();
let primaryError = null, summary;
try {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-ascent-weather-verify-'));
    resources.defer('weather verification profile', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('weather HTTPS fixtures', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const evidence = [], networkErrors = [], held = [];
    resources.defer('weather held responses', () => held.splice(0).forEach(resolve => resolve()));
    let mode = 'complete', evaluate, navigate, click, screenshot, resize, setSettings, version;
    const replyFor = url => {
        const requested = new URL(url), fields = requested.searchParams.get('hourly').split(',');
        const body = weatherFixture({ startDate: requested.searchParams.get('start_date'), fields,
            latitude: Number(requested.searchParams.get('latitude')), longitude: Number(requested.searchParams.get('longitude')), elevation: Number(requested.searchParams.get('elevation')) });
        if (mode === 'partial' && body.hourly.precipitation) body.hourly.precipitation[40] = null;
        return { status: mode === 'error' ? 429 : 200, body: JSON.stringify(body) };
    };
    const checkRequest = (url, headers) => {
        assert.ok(!headers.some(header => ['cookie', 'referer', 'authorization'].includes(header.name.toLowerCase())), 'weather request leaked credentials/referrer');
        assert.ok(!/[?&](?:aid|cid|name|gpx)=/i.test(url));
        evidence.push({ host: new URL(url).host, model: new URL(url).searchParams.get('models'), origin: headers.find(header => header.name.toLowerCase() === 'origin')?.value });
    };
    if (firefoxMode) {
        const { Builder, By } = await import('selenium-webdriver');
        const firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot });
        resources.defer('weather Firefox source', () => prepared.cleanup());
        resources.defer('weather Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
        const profile = path.join(temporaryRoot, 'profile'); await mkdir(profile);
        const options = new firefox.Options().addArguments('-headless').enableBidi().setProfile(profile)
            .setPreference('network.dns.localDomains', 'www.peakbagger.com,peakbagger.com').setAcceptInsecureCerts(true);
        if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
        const service = new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
        resources.defer('weather Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
        version = (await driver.getCapabilities()).getBrowserVersion();
        const addon = await driver.installAddon(prepared.sourceDir, true);
        await driver.setContext(firefox.Context.CHROME);
        const extensionUrl = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);
        await driver.setContext(firefox.Context.CONTENT);
        const bidi = await driver.getBidi();
        const send = async request => { const result = await bidi.send(request); if (result.type === 'error') throw new Error(`${result.error}: ${result.message}`); return result; };
        if (!live) {
            await bidi.subscribe('network.beforeRequestSent');
            const listener = params => {
                if (!params.isBlocked) return;
                const url = params.request.url;
                if (!/^https:\/\/(archive-api|historical-forecast-api)\.open-meteo\.com\//.test(url)) return;
                void (async () => {
                    const headers = params.request.headers.map(header => ({ name: header.name, value: header.value.value }));
                    checkRequest(url, headers);
                    if (mode === 'loading') await new Promise(resolve => held.push(resolve));
                    const reply = replyFor(url);
                    await send({ method: 'network.provideResponse', params: { request: params.request.request, statusCode: reply.status,
                        headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }, { name: 'access-control-allow-origin', value: { type: 'string', value: '*' } }],
                        body: { type: 'string', value: reply.body } } });
                })().catch(error => networkErrors.push(error.message));
            };
            bidi.on('network.beforeRequestSent', listener);
            resources.defer('weather BiDi listener', () => bidi.off('network.beforeRequestSent', listener));
            await send({ method: 'network.addIntercept', params: { phases: ['beforeRequestSent'], urlPatterns: [
                { type: 'pattern', protocol: 'https', hostname: 'archive-api.open-meteo.com' },
                { type: 'pattern', protocol: 'https', hostname: 'historical-forecast-api.open-meteo.com' },
            ] } });
        }
        evaluate = fn => driver.executeScript(webdriverScript(fn));
        navigate = url => driver.get(url);
        click = selector => driver.findElement(By.css(selector)).click();
        resize = async (width, height) => send({ method: 'browsingContext.setViewport', params: { context: await driver.getWindowHandle(), viewport: { width, height } } });
        screenshot = async output => writeFile(output, await driver.findElement(By.id('bpb-ascent-weather')).takeScreenshot(true), 'base64');
        setSettings = async values => {
            await driver.get(extensionUrl);
            await driver.executeAsyncScript('const done=arguments[arguments.length-1]; chrome.storage.sync.set({bpbSettings:arguments[0]}).then(()=>done(true),error=>done(String(error)));', values);
        };
    } else {
        const { chromium } = await import('playwright');
        const dist = path.join(root, 'dist');
        assertChromeLaunchAllowed();
        const context = await chromium.launchPersistentContext(temporaryRoot, { channel: 'chromium', headless: true,
            ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
            ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], viewport: { width: 1440, height: 1100 },
            args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] });
        resources.defer('weather Chrome context', () => context.close());
        version = context.browser().version();
        const page = await context.newPage();
        if (!live) await context.route(/^https:\/\/(archive-api|historical-forecast-api)\.open-meteo\.com\//, async route => {
            checkRequest(route.request().url(), Object.entries(await route.request().allHeaders()).map(([name, value]) => ({ name, value })));
            if (mode === 'loading') await new Promise(resolve => held.push(resolve));
            const reply = replyFor(route.request().url());
            await route.fulfill({ status: reply.status, body: reply.body, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        });
        page.on('pageerror', error => networkErrors.push(error.message));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        evaluate = fn => page.evaluate(fn); navigate = url => page.goto(url, { waitUntil: 'load' });
        click = selector => page.locator(selector).click(); resize = (width, height) => page.setViewportSize({ width, height });
        screenshot = output => page.locator('#bpb-ascent-weather').screenshot({ path: output });
        setSettings = values => worker.evaluate(values => chrome.storage.sync.set({ bpbSettings: values }), values);
    }
    const wait = (fn, description) => waitForCondition(() => evaluate(fn), { description, timeoutMs: 20_000 });
    await setSettings({ theme: 'light', units: 'imperial' });
    await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
    await resize(1440, 1100);
    await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
    await wait(() => document.querySelector('#bpb-ascent-weather .bpb-weather-model-description')?.textContent.includes('Using HRRR'), 'weather result from the real isolated bundle');
    await wait(() => document.getElementById('bpb-ascent-weather')?.getAttribute('aria-busy') === 'false', 'settled weather card');
    if (live) {
        summary = { browser: firefoxMode ? 'firefox' : 'chromium', version, hidden: true, liveCors: 'passed', viewport: { width: 1440, height: 1100 }, profile: temporaryRoot };
    } else {
        const output = process.env.BPB_VERIFY_WEATHER_SCREENSHOT_DIR;
        if (output) await mkdir(output, { recursive: true });
        for (const theme of ['light', 'dark']) {
            await setSettings({ theme, units: theme === 'dark' ? 'metric' : 'imperial' });
            for (const kind of ['gpx', 'no-gpx', 'no-map']) {
                await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=${kind}`);
                await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
                await wait(() => document.querySelector('#bpb-ascent-weather .bpb-weather-model-description')?.textContent.includes('Using HRRR'), 'weather with and without GPX');
                if (kind === 'gpx') await wait(() => !!document.getElementById('bpb-route-explorer'), 'complete GPX route explorer before placement check');
                await click('.bpb-weather-disclosure');
                for (const width of [1440, 768, 375]) {
                    await resize(width, 1100);
                    await wait(() => {
                        const card = document.getElementById('bpb-ascent-weather'), svg = card.querySelector('svg');
                        return Math.abs(Number(svg.getAttribute('viewBox')?.split(' ')[2]) - svg.getBoundingClientRect().width) < 1;
                    }, 'responsive chart width');
                    const geometry = await evaluate(() => {
                        const card = document.getElementById('bpb-ascent-weather'), box = card.getBoundingClientRect(), explorer = document.getElementById('bpb-route-explorer');
                        const overflow = [...card.querySelectorAll('*')].filter(node => {
                            if (node.closest('details:not([open])') && !node.closest('summary')) return false;
                            const bounds = node.getBoundingClientRect(); return bounds.width > 0 && !node.closest('[hidden]') && (bounds.left < box.left - 1 || bounds.right > box.right + 1);
                        }).map(node => node.tagName + '.' + node.className);
                        return { width: box.width, overflow, belowExplorer: !explorer || box.top >= explorer.getBoundingClientRect().bottom, cardCount: document.querySelectorAll('#bpb-ascent-weather').length };
                    });
                    assert.deepEqual(geometry.overflow, [], JSON.stringify(geometry)); assert.equal(geometry.belowExplorer, true); assert.equal(geometry.cardCount, 1);
                    if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-${kind}-${width}.png`));
                }
            }
        }
        mode = 'loading'; await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-map`);
        await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
        await wait(() => document.querySelector('.bpb-weather-status').textContent.includes('Loading'), 'visible loading feedback');
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-loading.png`));
        mode = 'complete'; held.splice(0).forEach(resolve => resolve());
        await wait(() => document.querySelector('.bpb-weather-model-description').textContent.includes('Using HRRR'), 'loading settles');
        await evaluate(() => { const select = document.querySelector('.bpb-weather-model select'); select.value = 'ecmwf_ifs_analysis_long_window'; select.dispatchEvent(new Event('change')); });
        await wait(() => document.querySelector('.bpb-weather-model-description').textContent.includes('Using IFS Assimilation'), 'explicit model without precipitation');
        assert.equal(await evaluate(() => document.querySelector('[data-weather-value="precipitation"]').textContent), '—');
        await click('.bpb-weather-sources summary');
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-long-model.png`));
        mode = 'partial'; await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-map`);
        await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
        await wait(() => document.querySelector('.bpb-weather-status').textContent.includes('Partial data'), 'partial-data label');
        mode = 'error'; await evaluate(() => { const select = document.querySelector('.bpb-weather-model select'); select.value = 'gfs_global'; select.dispatchEvent(new Event('change')); });
        await wait(() => document.querySelector('.bpb-weather-status').textContent.includes('temporarily limited'), 'rate-limit recovery state');
        assert.ok(await evaluate(() => !document.querySelector('.bpb-weather-result').hidden));
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-error-partial.png`));
        const before = evidence.length;
        await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=invalid`);
        await wait(() => document.querySelector('.bpb-weather-status')?.textContent.includes('valid ascent date'), 'invalid date explanation');
        assert.equal(evidence.length, before);
        assert.deepEqual(networkErrors, []);
        summary = { browser: firefoxMode ? 'firefox' : 'chromium', version, hidden: true, viewports: [375, 768, 1440], themes: ['light', 'dark'], fixtures: ['gpx', 'no-gpx', 'no-map', 'loading', 'long-model', 'partial', 'rate-limit', 'invalid'], requests: evidence, profile: temporaryRoot };
    }
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({ ...summary, teardown: 'passed' }));
