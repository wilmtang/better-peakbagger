// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, chrome, getComputedStyle, Chart */

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
import { PEAK_WEATHER_MODELS } from '../src/weather/peak-weather-models.js';
import { weatherFixture, weatherModelFixture } from '../test/helpers/weather-fixture.mjs';
import { verifyPeakWeatherCases } from './verify-peak-weather-cases.mjs';
import { verifyWeatherTabStyles } from './verify-weather-tab-styles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firefoxMode = process.argv.includes('--firefox');
const live = process.argv.includes('--live'); // one optional public-coordinate CORS proof
const peakMode = process.argv.includes('--peak');
const cardId = peakMode ? 'bpb-peak-weather' : 'bpb-ascent-weather';
const resources = createResourceStack();
let primaryError = null, summary;
try {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-ascent-weather-verify-'));
    resources.defer('weather verification profile', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('weather HTTPS fixtures', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    const evidence = [], metadataEvidence = [], networkErrors = [], held = [];
    resources.defer('weather held responses', () => held.splice(0).forEach(resolve => resolve()));
    let mode = 'complete', evaluate, navigate, click, press, movePointer, clickPoint, screenshot, screenshotPage, resize, setSettings, version;
    const replyFor = url => {
        const requested = new URL(url);
        if (requested.pathname.startsWith('/data/')) return { status: 200, headers: {}, body: JSON.stringify({
            last_run_initialisation_time: Math.floor(Date.now() / 1000) - 3600,
            last_run_availability_time: Math.floor(Date.now() / 1000) - 600, update_interval_seconds: 21600,
        }) };
        const fields = requested.searchParams.get('hourly').split(',');
        const body = weatherFixture({ startDate: requested.searchParams.get('start_date'), fields,
            hours: (Date.parse(requested.searchParams.get('end_date')) - Date.parse(requested.searchParams.get('start_date'))) / 3600_000 + 24,
            latitude: Number(requested.searchParams.get('latitude')), longitude: Number(requested.searchParams.get('longitude')), elevation: Number(requested.searchParams.get('elevation')) });
        if (peakMode) body.hourly.time.forEach((_, index) => {
            const day = Math.floor(index / 24), codes = [0, 2, 3, 61, 71, 2, 0, 45, 3], code = codes[day % codes.length];
            body.hourly.weather_code[index] = code;
            body.hourly.temperature_2m[index] += day - 4;
            body.hourly.precipitation[index] = [61, 71].includes(code) && index % 24 >= 15 && index % 24 <= 18 ? .3 : 0;
            body.hourly.wind_speed_10m[index] = 12 + day * 3;
            body.hourly.wind_gusts_10m[index] = 20 + day * 3;
        });
        if (mode === 'cold-temperature') body.hourly.temperature_2m = body.hourly.temperature_2m.map((_, index) => index % 2 ? -29 : -35);
        if (mode === 'partial' && body.hourly.precipitation) {
            if (peakMode) body.hourly.precipitation.fill(null);
            else body.hourly.precipitation[40] = null;
        }
        if (mode === 'empty') Object.entries(body.hourly).forEach(([key, values]) => { if (key !== 'time') values.fill(null); });
        const replyBody = peakMode ? weatherModelFixture(body, requested.searchParams.get('models').split(','), Object.fromEntries(PEAK_WEATHER_MODELS.map(model => [model.id,
            Date.parse(new Date().toISOString().slice(0, 10)) / 1000 + model.forecastDays * 86400]))) : body;
        if (mode === 'negative-precipitation') for (const [key, values] of Object.entries(replyBody.hourly)) {
            if (key === 'precipitation' || key === 'precipitation_meteofrance_arpege_world') values[45] = -0.1;
        }
        return { status: mode === 'error' ? 429 : mode === 'service-error' ? 503 : 200, body: JSON.stringify(replyBody), headers: mode === 'error' ? { 'retry-after': '120' } : {} };
    };
    const checkRequest = (url, headers) => {
        assert.ok(!headers.some(header => ['cookie', 'referer', 'authorization'].includes(header.name.toLowerCase())), 'weather request leaked credentials/referrer');
        assert.ok(!/[?&](?:aid|cid|name|gpx)=/i.test(url));
        if (new URL(url).pathname.startsWith('/data/')) { metadataEvidence.push({ host: new URL(url).host, path: new URL(url).pathname, query: new URL(url).search }); return; }
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
                if (!/^https:\/\/(api|archive-api|historical-forecast-api)\.open-meteo\.com\//.test(url)) return;
                void (async () => {
                    const headers = params.request.headers.map(header => ({ name: header.name, value: header.value.value }));
                    checkRequest(url, headers);
                    if (mode === 'loading') await new Promise(resolve => held.push(resolve));
                    const reply = replyFor(url);
                    await send({ method: 'network.provideResponse', params: { request: params.request.request, statusCode: reply.status,
                        headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }, { name: 'access-control-allow-origin', value: { type: 'string', value: '*' } }, { name: 'access-control-expose-headers', value: { type: 'string', value: 'retry-after' } }, ...Object.entries(reply.headers).map(([name, value]) => ({ name, value: { type: 'string', value } }))],
                        body: { type: 'string', value: reply.body } } });
                })().catch(error => networkErrors.push(error.message));
            };
            bidi.on('network.beforeRequestSent', listener);
            resources.defer('weather BiDi listener', () => bidi.off('network.beforeRequestSent', listener));
            await send({ method: 'network.addIntercept', params: { phases: ['beforeRequestSent'], urlPatterns: [
                { type: 'pattern', protocol: 'https', hostname: 'archive-api.open-meteo.com' },
                { type: 'pattern', protocol: 'https', hostname: 'historical-forecast-api.open-meteo.com' },
                { type: 'pattern', protocol: 'https', hostname: 'api.open-meteo.com' },
            ] } });
        } else {
            await bidi.subscribe('network.beforeRequestSent');
            const listener = params => {
                if (/^https:\/\/(api|archive-api|historical-forecast-api)\.open-meteo\.com\//.test(params.request.url) && params.request.method === 'GET') {
                    checkRequest(params.request.url, params.request.headers.map(header => ({ name: header.name, value: header.value.value })));
                }
            };
            bidi.on('network.beforeRequestSent', listener);
            resources.defer('weather live BiDi listener', () => bidi.off('network.beforeRequestSent', listener));
        }
        evaluate = (fn, ...args) => driver.executeScript(webdriverScript(fn, ...args));
        navigate = url => driver.get(url);
        click = async selector => {
            const target = await driver.findElement(By.css(selector));
            // Element screenshots and responsive reflows can leave a tab on
            // the viewport edge. Gate the physical click on its exposed centre
            // instead of relying on Marionette's minimum scrolling heuristic.
            await driver.executeScript('const e=arguments[0], r=e.getBoundingClientRect(); if(r.top+r.height/2<0 || r.top+r.height/2>=innerHeight) e.scrollIntoView({block:"center",inline:"nearest"});', target);
            let last;
            try {
                await waitForCondition(async () => {
                    last = await driver.executeScript(`const e=arguments[0], r=e.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
                        const hit=document.elementFromPoint(x,y); return {x,y,width:r.width,height:r.height,viewport:innerHeight,
                            hit:hit?.tagName,exposed:r.width>0&&r.height>0&&y>=0&&y<innerHeight&&(hit===e||e.contains(hit))};`, target);
                    return last.exposed;
                }, { description: `exposed weather control ${selector}`, timeoutMs: 5000 });
            } catch (error) { throw new Error(`${error.message}; live geometry: ${JSON.stringify(last)}`); }
            await target.click();
        };
        press = key => driver.actions({ async: true }).sendKeys(key).perform();
        movePointer = (x, y) => driver.actions({ async: true }).move({ origin: 'viewport', x: Math.round(x), y: Math.round(y) }).perform();
        clickPoint = (x, y, button = 'left') => driver.actions({ async: true }).move({ origin: 'viewport', x: Math.round(x), y: Math.round(y) }).press(button === 'right' ? 2 : 0).release(button === 'right' ? 2 : 0).perform();
        resize = async (width, height) => send({ method: 'browsingContext.setViewport', params: { context: await driver.getWindowHandle(), viewport: { width, height } } });
        screenshot = async output => writeFile(output, await driver.findElement(By.id(cardId)).takeScreenshot(true), 'base64');
        screenshotPage = async output => writeFile(output, await driver.takeScreenshot(), 'base64');
        const weatherWindow = await driver.getWindowHandle();
        await driver.switchTo().newWindow('tab');
        const settingsWindow = await driver.getWindowHandle();
        await driver.get(extensionUrl);
        await driver.switchTo().window(weatherWindow);
        setSettings = async values => {
            await driver.switchTo().window(settingsWindow);
            try {
                await driver.executeAsyncScript('const done=arguments[arguments.length-1]; chrome.storage.sync.set({bpbSettings:arguments[0]}).then(()=>done(true),error=>done(String(error)));', values);
            } finally { await driver.switchTo().window(weatherWindow); }
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
        if (!live) await context.route(/^https:\/\/(api|archive-api|historical-forecast-api)\.open-meteo\.com\//, async route => {
            checkRequest(route.request().url(), Object.entries(await route.request().allHeaders()).map(([name, value]) => ({ name, value })));
            if (mode === 'loading') await new Promise(resolve => held.push(resolve));
            const reply = replyFor(route.request().url());
            await route.fulfill({ status: reply.status, body: reply.body, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'retry-after', ...reply.headers } });
        });
        else page.on('request', request => {
            if (/^https:\/\/(api|archive-api|historical-forecast-api)\.open-meteo\.com\//.test(request.url()) && request.method() === 'GET') {
                void request.allHeaders().then(headers => checkRequest(request.url(), Object.entries(headers).map(([name, value]) => ({ name, value }))))
                    .catch(error => networkErrors.push(error.message));
            }
        });
        page.on('pageerror', error => networkErrors.push(error.message));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        evaluate = (fn, arg) => page.evaluate(fn, arg); navigate = url => page.goto(url, { waitUntil: 'load' });
        click = selector => page.locator(selector).click(); resize = (width, height) => page.setViewportSize({ width, height });
        press = key => page.keyboard.press(key);
        movePointer = (x, y) => page.mouse.move(x, y); clickPoint = (x, y, button = 'left') => page.mouse.click(x, y, { button });
        screenshot = output => page.locator(`#${cardId}`).screenshot({ path: output });
        screenshotPage = output => page.screenshot({ path: output });
        setSettings = values => worker.evaluate(values => chrome.storage.sync.set({ bpbSettings: values }), values);
    }
    const wait = (fn, description) => waitForCondition(() => evaluate(fn), { description, timeoutMs: 20_000 });
    const checkGpxCursor = async () => {
        const before = evidence.length;
        await resize(1440, 1100);
        await wait(() => {
            const canvas = document.querySelector('#bpb-gpx-analysis canvas');
            return canvas && Chart.getChart(canvas)?.getSortedVisibleDatasetMetas()[0]?.data.length > 2;
        }, 'real MAIN-world Chart.js data');
        const targets = await evaluate(() => {
            const canvas = document.querySelector('#bpb-gpx-analysis canvas');
            canvas.scrollIntoView({ block: 'center' });
            const chart = Chart.getChart(canvas), meta = chart.getSortedVisibleDatasetMetas()[0], rect = canvas.getBoundingClientRect();
            return [.2, .8].map(fraction => {
                const index = Math.floor(meta.data.length * fraction), pixel = meta.data[index].getCenterPoint();
                return { x: rect.left + pixel.x, y: rect.top + pixel.y, time: chart.data.datasets[meta.index].data[index]._raw.ms };
            });
        });
        await movePointer(targets[0].x, targets[0].y);
        await wait(() => document.querySelector('.bpb-weather-cursor-label')?.textContent.startsWith('Hover'), 'GPX hover crosses into the isolated weather card');
        assert.equal(await evaluate(() => document.querySelector('.bpb-weather-disclosure').getAttribute('aria-expanded')), 'false', 'hover must not expand hourly weather');
        await movePointer(1, 1);
        await wait(() => document.querySelector('.bpb-weather-cursor-label').textContent === '', 'hover clears without a selection');
        await clickPoint(targets[0].x, targets[0].y);
        await movePointer(1, 1);
        await wait(() => document.querySelector('.bpb-weather-cursor-label').textContent.startsWith('Selected'), 'clicked GPX time survives pointer exit');
        await click('.bpb-weather-disclosure');
        assert.equal(await evaluate(() => document.querySelector('[role="tab"]').getAttribute('aria-selected')), 'true');
        assert.equal(await evaluate(() => document.querySelector('[role="tab"]').dataset.metric), 'conditions');
        await click('[data-metric="temperature"]');
        assert.equal(Number(await evaluate(() => document.querySelector('.bpb-weather-cursor').dataset.time)), targets[0].time);
        // The weather disclosure may scroll in WebDriver. Re-read chart geometry
        // before the next physical pointer gesture.
        const next = await evaluate(() => {
            const canvas = document.querySelector('#bpb-gpx-analysis canvas'); canvas.scrollIntoView({ block: 'center' });
            const chart = Chart.getChart(canvas), meta = chart.getSortedVisibleDatasetMetas()[0], index = Math.floor(meta.data.length * .8);
            const pixel = meta.data[index].getCenterPoint(), rect = canvas.getBoundingClientRect();
            return { x: rect.left + pixel.x, y: rect.top + pixel.y, time: chart.data.datasets[meta.index].data[index]._raw.ms };
        });
        await movePointer(next.x, next.y);
        await wait(() => document.querySelector('.bpb-weather-cursor')?.dataset.mode === 'hover', 'transient weather line');
        assert.equal(Number(await evaluate(() => document.querySelector('.bpb-weather-cursor').dataset.time)), next.time);
        await movePointer(1, 1);
        await wait(() => document.querySelector('.bpb-weather-cursor')?.dataset.mode === 'selected', 'weather restores clicked point');
        assert.equal(Number(await evaluate(() => document.querySelector('.bpb-weather-cursor').dataset.time)), targets[0].time);
        const bounds = await evaluate(() => {
            const line = document.querySelector('.bpb-weather-cursor'), svg = line.closest('svg');
            return { x: Number(line.getAttribute('x1')), width: Number(svg.getAttribute('viewBox').split(' ')[2]), time: Number(line.dataset.time) };
        });
        const dayStart = Date.parse('2024-07-12T07:00:00Z');
        assert.ok(Math.abs(bounds.x - (42 + (bounds.width - 58) * (bounds.time - dayStart) / 86400_000)) < .01, 'weather cursor uses the summit local day');
        assert.equal(evidence.length, before, 'GPX interaction makes no additional weather request');
    };
    const explorerGeometry = () => {
        const explorer = document.getElementById('bpb-route-explorer');
        const mapColumn = explorer.querySelector('.bpb-route-explorer__map-column');
        const map = document.getElementById('bpb-map-viewport');
        const frame = map.querySelector('iframe');
        const analysis = document.getElementById('bpb-gpx-analysis');
        const mapRect = map.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
        const columnRect = mapColumn.getBoundingClientRect(), analysisRect = analysis.getBoundingClientRect();
        return { layout: explorer.dataset.layout, position: getComputedStyle(mapColumn).position,
            width: mapRect.width, frameContained: frameRect.bottom <= mapRect.bottom + 1,
            beside: columnRect.right <= analysisRect.left + 1,
            below: analysisRect.top >= Math.max(columnRect.bottom, frameRect.bottom) - 1 };
    };
    const checkExplorerReflow = async output => {
        await resize(1440, 1100);
        await wait(() => document.getElementById('bpb-route-explorer')?.dataset.layout === 'side', 'side layout before container resize');
        const before = await evaluate(explorerGeometry);
        assert.ok(before.beside && before.frameContained, JSON.stringify(before));
        const original = await evaluate(() => {
            const host = document.getElementById('bpb-route-explorer').parentElement;
            return { style: host.getAttribute('style'), x: window.scrollX, y: window.scrollY };
        });
        try {
            // Change only the containing column. The map and browser keep their
            // dimensions, so neither existing map/window resize handler fires.
            await evaluate(() => {
                const explorer = document.getElementById('bpb-route-explorer');
                explorer.parentElement.style.width = `${document.getElementById('bpb-map-viewport').getBoundingClientRect().width + 350}px`;
            });
            await wait(() => document.getElementById('bpb-route-explorer')?.dataset.layout === 'stacked', 'container resize clears sticky map layout');
            await evaluate(() => window.scrollBy(0, document.getElementById('bpb-map-viewport').getBoundingClientRect().top + 200));
            const stacked = await evaluate(explorerGeometry);
            assert.ok(stacked.below && stacked.frameContained && stacked.position === 'static', JSON.stringify(stacked));
            assert.equal(stacked.width, before.width, 'container reflow does not resize the map');
            if (output) {
                await evaluate(() => document.getElementById('bpb-route-explorer').scrollIntoView({ block: 'start' }));
                await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-gpx-stacked.png`));
            }
        } finally {
            await evaluate(original => {
                const host = document.getElementById('bpb-route-explorer').parentElement;
                if (original.style === null) host.removeAttribute('style');
                else host.setAttribute('style', original.style);
                window.scrollTo(original.x, original.y);
            }, original);
        }
        await wait(() => document.getElementById('bpb-route-explorer')?.dataset.layout === 'side', 'widening the container restores sticky side layout');
        const restored = await evaluate(explorerGeometry);
        assert.ok(restored.beside && restored.frameContained && restored.position === 'sticky', JSON.stringify(restored));
        assert.equal(restored.width, before.width);
    };
    const geometryForCard = () => {
        const card = document.getElementById('bpb-ascent-weather'), box = card.getBoundingClientRect();
        const header = card.querySelector('header'), headingBox = header.querySelector('h2').getBoundingClientRect();
        const dateBox = header.querySelector('.bpb-weather-date-navigation').getBoundingClientRect();
        const dateStart = dateBox.top >= headingBox.bottom - 1 ? headingBox.left : headingBox.right + parseFloat(getComputedStyle(header).columnGap);
        const column = document.getElementById('bpb-ascent-summary-column'), columnBox = column.getBoundingClientRect();
        const summaryBox = column.querySelector('.bpb-ascent-table-split__summary').getBoundingClientRect();
        const reportBox = document.querySelector('.bpb-ascent-table-split__report').getBoundingClientRect();
        const stacked = getComputedStyle(document.getElementById('bpb-ascent-table-split')).display !== 'grid';
        const overflow = [...card.querySelectorAll('*')].filter(node => {
            if (node.closest('details:not([open])') && !node.closest('summary')) return false;
            // Hour columns deliberately extend inside their clipped scroll
            // region. Check the region itself against the card, not its cells.
            if (node.parentElement?.closest('.bpb-weather-hourly-scroll')) return false;
            const bounds = node.getBoundingClientRect(); return bounds.width > 0 && !node.closest('[hidden]') && (bounds.left < box.left - 1 || bounds.right > box.right + 1);
        }).map(node => node.tagName + '.' + node.className);
        const gps = document.getElementById('bpb-ascent-gpx-details'), gpsBox = gps?.getBoundingClientRect();
        const gpsOverflow = gps ? [...gps.querySelectorAll('*')].filter(node => {
            const bounds = node.getBoundingClientRect(); return bounds.width > 0 && !node.closest('[hidden]')
                && (bounds.left < columnBox.left - 1 || bounds.right > columnBox.right + 1);
        }).map(node => node.tagName + '.' + node.className) : [];
        return { width: box.width, overflow, gpsOverflow, cardCount: document.querySelectorAll('#bpb-ascent-weather').length,
            summaryHeight: card.querySelector('.bpb-weather-hourly').getBoundingClientRect().top - box.top,
            metricColumns: getComputedStyle(card.querySelector('.bpb-weather-metrics')).gridTemplateColumns.split(' ').length,
            dateWithHeading: Math.abs(dateBox.left - dateStart) <= 1,
            inSummaryColumn: card.parentElement === column, belowSummary: box.top >= summaryBox.bottom,
            gpsBeforeWeather: !gps || (gps.parentElement === column && gps.nextElementSibling === card && gpsBox.bottom <= box.top),
            withinColumn: box.left >= columnBox.left - 1 && box.right <= columnBox.right + 1,
            besideReport: stacked || box.left >= reportBox.right - 1,
            reportRight: reportBox.right, cardLeft: box.left,
            beforeReportEnd: stacked || box.top < reportBox.bottom };
    };
    const assertPlacement = geometry => {
        assert.deepEqual(geometry.overflow, [], JSON.stringify(geometry));
        assert.deepEqual(geometry.gpsOverflow, [], JSON.stringify(geometry));
        // Extreme divider positions must let text wrap, even into a taller card.
        if (geometry.width >= 300) assert.ok(geometry.summaryHeight <= ({ 1: 700, 2: 500, 4: 310 }[geometry.metricColumns]), `archive summary is too tall: ${JSON.stringify(geometry)}`);
        for (const key of ['dateWithHeading', 'inSummaryColumn', 'belowSummary', 'gpsBeforeWeather', 'withinColumn', 'besideReport']) assert.equal(geometry[key], true, JSON.stringify(geometry));
        assert.equal(geometry.cardCount, 1);
    };
    if (peakMode) {
        summary = { browser: firefoxMode ? 'firefox' : 'chromium', version, hidden: true, profile: temporaryRoot,
            ...await verifyPeakWeatherCases({ origin, evaluate, navigate, click, press, clickPoint, resize, screenshot, screenshotPage, setSettings, wait,
                setMode: next => { mode = next; }, release: () => held.splice(0).forEach(resolve => resolve()), evidence, metadataEvidence, networkErrors, live, firefoxMode }) };
    } else {
        await setSettings({ theme: 'light', units: 'imperial' });
        await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
        await resize(1440, 1100);
        await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
        await wait(() => document.querySelector('#bpb-ascent-weather .bpb-weather-model-description')?.textContent.includes('Using Best Match'), 'weather result from the real isolated bundle');
        await wait(() => document.getElementById('bpb-ascent-weather')?.getAttribute('aria-busy') === 'false', 'settled weather card');
        assert.equal(await evaluate(() => document.querySelector('.bpb-weather-model select').options[0].value), 'best_match');
        if (live) {
            summary = { browser: firefoxMode ? 'firefox' : 'chromium', version, hidden: true, liveCors: 'passed', viewport: { width: 1440, height: 1100 }, profile: temporaryRoot };
        } else {
            const output = process.env.BPB_VERIFY_WEATHER_SCREENSHOT_DIR;
            if (output) await mkdir(output, { recursive: true });
            const mixedUnits = { theme: 'light', units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'metric', windUnits: 'imperial' };
            const beforeUnitChange = evidence.length;
            await setSettings(mixedUnits);
            await wait(() => document.querySelector('[data-weather-value="temperature"]')?.textContent.includes('°C')
                && document.querySelector('[data-weather-value="precipitation"]')?.textContent.includes('mm')
                && document.querySelector('[data-weather-value="gust"]')?.textContent.includes('mph'), 'mixed weather units');
            await click('.bpb-weather-disclosure');
            await click('[data-metric="temperature"]');
            await wait(() => document.querySelector('.bpb-weather-chart')?.getAttribute('aria-label')?.includes('°C'), 'Celsius chart axis');
            await click('[data-metric="conditions"]');
            await wait(() => document.querySelector('[data-weather-row="temperature"] td')?.textContent.includes('°C')
                && document.querySelector('[data-weather-row="precipitation"] td')?.textContent.includes('mm'), 'mixed hourly weather units');
            const unitOutput = process.env.BPB_VERIFY_UNIT_SCREENSHOTS_DIR;
            if (unitOutput) {
                await mkdir(unitOutput, { recursive: true });
                await screenshot(path.join(unitOutput, `${firefoxMode ? 'firefox' : 'chrome'}-mixed-weather-units.png`));
            }
            await setSettings({ ...mixedUnits, temperatureUnits: 'imperial', windUnits: 'metric' });
            await wait(() => document.querySelector('[data-weather-value="temperature"]')?.textContent.includes('°F')
                && document.querySelector('[data-weather-value="gust"]')?.textContent.includes('km/h')
                && document.querySelector('[data-weather-row="precipitation"] td')?.textContent.includes('mm'), 'independent live weather unit changes');
            assert.equal(evidence.length, beforeUnitChange, 'display preferences must not refetch weather');
            for (const theme of ['light', 'dark']) {
                await setSettings({ theme, units: theme === 'dark' ? 'metric' : 'imperial' });
                for (const kind of ['gpx', 'no-gpx', 'no-map', 'long-report']) {
                    await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=${kind}`);
                    await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
                    await wait(() => document.querySelector('#bpb-ascent-weather .bpb-weather-model-description')?.textContent.includes('Using Best Match'), 'weather with and without GPX');
                    if (kind === 'gpx') {
                        await wait(() => !!document.getElementById('bpb-route-explorer'), 'complete GPX route explorer before placement check');
                        await wait(() => document.querySelectorAll('#bpb-ascent-gpx-details .bpb-map-handoff-button').length === 4, 'original provider controls above weather');
                        assert.equal(await evaluate(() => document.getElementById('gps-track-note').parentElement.id), 'bpb-ascent-gpx-details');
                    }
                    assert.equal(await evaluate(() => document.querySelector('#bpb-ascent-weather h2').textContent), 'Weather archive');
                    assert.equal(await evaluate(() => document.querySelector('.bpb-weather-attribution').textContent), 'Powered by Open-Meteo');
                    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.bpb-weather-day-button')].map(button => ({
                        name: button.getAttribute('aria-label'), visible: !button.hidden, enabled: button.getAttribute('aria-disabled') === 'false',
                        target: button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44,
                    }))), [{ name: 'Previous day', visible: true, enabled: true, target: true }, { name: 'Next day', visible: true, enabled: true, target: true }]);
                    assert.deepEqual(await evaluate(() => {
                        const button = document.querySelector('.bpb-weather-disclosure'), style = getComputedStyle(button);
                        return { label: button.firstElementChild.textContent, expanded: button.getAttribute('aria-expanded'),
                            bordered: parseFloat(style.borderTopWidth) >= 1, height: button.getBoundingClientRect().height >= 44 };
                    }), { label: 'Show hourly weather', expanded: 'false', bordered: true, height: true });
                    if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-${kind}-disclosure.png`));
                    if (kind === 'gpx') {
                        await checkGpxCursor();
                        await checkExplorerReflow(output);
                    }
                    else {
                        await click('.bpb-weather-disclosure');
                        assert.equal(await evaluate(() => document.querySelector('[role="tab"]').dataset.metric), 'conditions');
                        assert.equal(await evaluate(() => document.querySelector('[role="tab"]').getAttribute('aria-selected')), 'true');
                        await click('[data-metric="temperature"]');
                    }
                    assert.equal(await evaluate(() => document.querySelector('.bpb-weather-disclosure').firstElementChild.textContent), 'Hide hourly weather');
                    for (const width of [1440, 768, 375]) {
                        await resize(width, 1100);
                        await wait(() => {
                            const card = document.getElementById('bpb-ascent-weather'), svg = card.querySelector('.bpb-weather-chart');
                            return Math.abs(Number(svg.getAttribute('viewBox')?.split(' ')[2]) - svg.getBoundingClientRect().width) < 1;
                        }, 'responsive chart width');
                        const geometry = await evaluate(geometryForCard);
                        assertPlacement(geometry);
                        if (kind === 'gpx') assert.equal(await evaluate(() => document.querySelector('.bpb-weather-cursor').dataset.mode), 'selected', 'resize retains selection');
                        if (kind === 'long-report') assert.equal(geometry.beforeReportEnd, true, JSON.stringify(geometry));
                        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-${kind}-${width}.png`));
                        if (kind === 'gpx' && output) {
                            await evaluate(() => document.getElementById('bpb-ascent-gpx-details').scrollIntoView());
                            await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-gps-weather-${width}.png`));
                        }
                        const requestsBeforeConditions = evidence.length;
                        await click('[data-metric="conditions"]');
                        await verifyWeatherTabStyles(evaluate, '.bpb-weather-tabs button');
                        await wait(() => !document.querySelector('.bpb-weather-conditions').hidden
                        && document.querySelectorAll('.bpb-weather-conditions thead th[data-weather-time]').length === 24, 'horizontal hourly conditions');
                        assert.equal(await evaluate(() => document.querySelector('#bpb-ascent-weather .bpb-weather-chart').hasAttribute('hidden')), true);
                        assert.ok(await evaluate(() => !!document.querySelector('.bpb-weather-conditions [aria-label="Light snow"]')));
                        assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.bpb-weather-hourly-table tbody th')].map(cell => cell.textContent)), ['Conditions', 'Temperature', 'Rain/snow', 'Wind', 'Gusts']);
                        assert.ok(await evaluate(() => {
                            const grid = document.querySelector('.bpb-weather-conditions');
                            return grid.scrollWidth > grid.clientWidth && grid.scrollHeight <= grid.clientHeight + 1;
                        }), 'all metric rows fit without vertical scrolling');
                        if (kind === 'gpx') {
                            const selection = await evaluate(() => {
                                const row = document.querySelector('.bpb-weather-conditions [aria-current="time"]');
                                const cursor = document.querySelector('.bpb-weather-cursor');
                                return { mode: row?.dataset.mode, hour: Number(row?.dataset.weatherTime), time: Number(cursor.dataset.time) };
                            });
                            assert.equal(selection.mode, 'selected');
                            assert.equal(selection.hour, Math.floor(selection.time / 3600_000) * 3600_000);
                        }
                        assertPlacement(await evaluate(geometryForCard));
                        if (kind !== 'gpx') await evaluate(() => { document.querySelector('.bpb-weather-conditions').scrollLeft = 0; });
                        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-${kind}-conditions-${width}.png`));
                        assert.equal(evidence.length, requestsBeforeConditions, 'the condition tab uses the same response');
                        await evaluate(() => { document.querySelector('.bpb-weather-conditions').scrollLeft = 320; });
                        assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.bpb-weather-hourly-table tbody th')).position), 'sticky');
                        await click('[data-metric="temperature"]');
                        await wait(() => !document.querySelector('#bpb-ascent-weather .bpb-weather-chart').hasAttribute('hidden'), 'return to the numeric graph');
                    }
                    if (kind === 'long-report') {
                        await resize(1440, 1100);
                        await evaluate(() => document.getElementById('bpb-ascent-table-split').scrollIntoView());
                        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-right-column.png`));
                    }
                    if (kind === 'no-gpx') {
                        for (const width of [1440, 375]) {
                            await resize(width, 1100);
                            await evaluate(() => document.querySelector('#bpb-ascent-weather header').scrollIntoView({ block: 'start' }));
                            await click('[data-metric="conditions"]');
                            const before = await evaluate(() => ({ date: document.querySelector('.bpb-weather-date').textContent,
                                scroll: window.scrollY, cardTop: document.getElementById('bpb-ascent-weather').getBoundingClientRect().top }));
                            await click('[aria-label="Previous day"]');
                            await wait(() => document.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false'
                                && document.querySelector('.bpb-weather-date').textContent.includes('July 11, 2024'), 'previous archive day and readings committed');
                            assertPlacement(await evaluate(geometryForCard));
                            assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Previous day', 'archive navigation retains the button focus');
                            assert.equal(await evaluate(() => document.querySelector('.bpb-weather-disclosure').getAttribute('aria-expanded')), 'true');
                            assert.equal(await evaluate(() => document.querySelector('[data-metric="conditions"]').getAttribute('aria-selected')), 'true');
                            assert.equal(await evaluate(() => document.querySelector('input[type="date"]')), null);
                            const after = await evaluate(() => ({ scroll: window.scrollY, cardTop: document.getElementById('bpb-ascent-weather').getBoundingClientRect().top }));
                            assert.ok(Math.abs(after.scroll - before.scroll) <= 1 && Math.abs(after.cardTop - before.cardTop) <= 1,
                                `archive navigation moved the viewport: ${JSON.stringify({ before, after })}`);
                            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-archive-previous-${width}.png`));
                            await evaluate(() => document.querySelector('[aria-label="Next day"]').focus({ preventScroll: true }));
                            await press(firefoxMode ? '\uE007' : 'Enter');
                            await wait(() => document.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false'
                                && document.querySelector('.bpb-weather-date').textContent.includes('July 12, 2024'), 'next day returns to saved ascent date');
                            assert.equal(await evaluate(() => document.querySelector('.bpb-weather-date').textContent), before.date);
                        }
                    }
                    if (kind === 'gpx' || kind === 'long-report') {
                    // Both column extremes must fit; also exercise the narrowest
                    // desktop width immediately before the stacked layout.
                        for (const width of [1440, 681]) {
                            await resize(width, 1100);
                            await evaluate(() => document.getElementById('bpb-ascent-table-resize-handle').dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'End' })));
                            await wait(() => {
                                const svg = document.querySelector('#bpb-ascent-weather .bpb-weather-chart');
                                return Math.abs(Number(svg.getAttribute('viewBox')?.split(' ')[2]) - svg.getBoundingClientRect().width) < 1;
                            }, 'weather chart after divider resize');
                            assertPlacement(await evaluate(geometryForCard));
                            await click('[data-metric="conditions"]');
                            assertPlacement(await evaluate(geometryForCard));
                            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-${kind}-conditions-narrow-${width}.png`));
                            await click('[data-metric="temperature"]');
                        }
                        await resize(1440, 1100);
                        await evaluate(() => document.getElementById('bpb-ascent-table-resize-handle').dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Home' })));
                        await wait(() => {
                            const svg = document.querySelector('#bpb-ascent-weather .bpb-weather-chart');
                            return Math.abs(Number(svg.getAttribute('viewBox')?.split(' ')[2]) - svg.getBoundingClientRect().width) < 1;
                        }, 'weather chart after widening the summary column');
                        assertPlacement(await evaluate(geometryForCard));
                        assert.equal(await evaluate(() => {
                            const label = document.querySelector('.bpb-weather-model label').getBoundingClientRect();
                            const select = document.querySelector('.bpb-weather-model select').getBoundingClientRect();
                            return label.right <= select.left && Math.abs((label.top + label.bottom - select.top - select.bottom) / 2) <= 1;
                        }), true, 'wide archive model label and picker share a row');
                        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-${kind}-wide-summary.png`));
                        await evaluate(() => document.getElementById('bpb-ascent-table-resize-handle').dispatchEvent(new document.defaultView.MouseEvent('dblclick')));
                    }
                }
            }
            mode = 'cold-temperature'; await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-map`);
            await wait(() => document.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'), 'cold temperature fixture');
            const coldRequests = evidence.length;
            for (const theme of ['light', 'dark']) {
                for (const [system, expected] of [['metric', '−35° / −29°C'], ['imperial', '−31° / −20°F']]) {
                    await setSettings({ theme, units: system });
                    await waitForCondition(async () => {
                        const state = await evaluate(() => ({ theme: document.documentElement.dataset.bpbTheme,
                            text: document.querySelector('[data-weather-value="temperature"]').textContent }));
                        return state.theme === theme && state.text === expected;
                    }, { description: 'cold temperature unit and theme update', timeoutMs: 20_000 });
                    assert.equal(await evaluate(() => document.querySelector('[data-weather-value="temperature"]').textContent), expected);
                    for (const width of [1440, 768, 375]) {
                        await resize(width, 1100); assertPlacement(await evaluate(geometryForCard));
                        assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.bpb-weather-low, .bpb-weather-high')].map(node => {
                            const bounds = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
                            return { wrapped: range.getClientRects().length > 1, contained: range.getBoundingClientRect().width <= bounds.width + 1 };
                        })), [{ wrapped: false, contained: true }, { wrapped: false, contained: true }]);
                        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-cold-temperature-${system}-${width}.png`));
                    }
                }
            }
            assert.equal(evidence.length, coldRequests, 'formatting and unit changes reuse the loaded cold weather');
            mode = 'loading'; await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-map`);
            await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
            await wait(() => document.querySelector('.bpb-weather-status').textContent.includes('Loading'), 'visible loading feedback');
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-loading.png`));
            mode = 'complete'; held.splice(0).forEach(resolve => resolve());
            await wait(() => document.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'), 'loading settles');
            await evaluate(() => { const select = document.querySelector('.bpb-weather-model select'); select.value = 'ecmwf_ifs_analysis_long_window'; select.dispatchEvent(new Event('change')); });
            await wait(() => document.querySelector('.bpb-weather-model-description').textContent.includes('Using IFS Assimilation'), 'explicit model without precipitation');
            assert.equal(await evaluate(() => document.querySelector('[data-weather-value="precipitation"]').textContent), '—');
            await click('.bpb-weather-disclosure');
            await click('[data-metric="conditions"]');
            await wait(() => document.querySelector('[role="tabpanel"]').textContent.includes('This model does not provide hourly conditions')
                && !!document.querySelector('.bpb-weather-conditions [data-weather-row="temperature"]'), 'model condition field limitation retains other readings');
            await click('.bpb-weather-sources summary');
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-long-model.png`));
            mode = 'complete'; await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
            await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
            await wait(() => document.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'), 'numeric keyboard fixture loaded');
            await click('.bpb-weather-disclosure'); await click('[data-metric="wind"]');
            await evaluate(() => document.querySelector('[data-metric="wind"]').focus());
            await press(firefoxMode ? '\uE004' : 'Tab');
            assert.equal(await evaluate(() => document.activeElement.matches('.bpb-weather-chart-frame')), true);
            await press(firefoxMode ? '\uE011' : 'Home');
            await wait(() => document.querySelector('.bpb-weather-readout').textContent.includes('12:00 AM PDT'), 'first wind reading by keyboard');
            await press(firefoxMode ? '\uE010' : 'End');
            await wait(() => document.querySelector('.bpb-weather-readout').textContent.includes('11:00 PM PDT'), 'last wind reading by keyboard');
            await press(firefoxMode ? '\uE00C' : 'Escape');
            await wait(() => !document.querySelector('.bpb-weather-reading-cursor'), 'Escape clears weather reading');
            await press(firefoxMode ? '\uE004' : 'Tab');
            assert.equal(await evaluate(() => document.activeElement.matches('.bpb-weather-sources summary')), true, 'numeric graph never traps Tab');
            await setSettings({ showWeather: false, units: 'metric' });
            const beforeOptOut = evidence.length;
            await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=gpx`);
            await wait(() => document.querySelector('#bpb-ascent-weather')?.hidden, 'weather initially disabled');
            assert.equal(await evaluate(() => !!document.querySelector('#bpb-ascent-gpx-details')), false);
            assert.equal(evidence.length, beforeOptOut);
            await evaluate(() => {
                const node = document.querySelector('#gpxlinks');
                window.__bpbGpsOrigin = { node, parent: node.parentNode, next: node.nextSibling };
            });
            await setSettings({ showWeather: true, units: 'metric' });
            await wait(() => document.querySelector('#bpb-ascent-gpx-details #gpxlinks'), 'enabled weather places native GPS blocks');
            await setSettings({ showWeather: false, units: 'metric' });
            await wait(() => !document.querySelector('#bpb-ascent-gpx-details'), 'disabled weather restores native GPS blocks');
            assert.equal(await evaluate(() => {
                const original = window.__bpbGpsOrigin;
                return original.node.isConnected && original.node.parentNode === original.parent && original.node.nextSibling === original.next;
            }), true);
            await evaluate(() => { delete window.__bpbGpsOrigin; });
            await setSettings({ showWeather: true, units: 'metric' });
            mode = 'partial'; await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-map`);
            await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
            await wait(() => document.querySelector('.bpb-weather-status').textContent.includes('Partial data'), 'partial-data label');
            mode = 'error'; await evaluate(() => { const select = document.querySelector('.bpb-weather-model select'); select.value = 'gfs_global'; select.dispatchEvent(new Event('change')); });
            await wait(() => document.querySelector('.bpb-weather-status').textContent.includes('Open-Meteo request limit reached'), 'rate-limit recovery state');
            assert.ok(await evaluate(() => !document.querySelector('.bpb-weather-result').hidden));
            assert.equal(await evaluate(() => document.querySelector('.bpb-weather-retry').disabled), true);
            assert.equal(await evaluate(() => [...document.querySelectorAll('.bpb-weather-day-button')].every(button => button.getAttribute('aria-disabled') === 'true')), true);
            assert.equal(await evaluate(() => document.querySelector('.bpb-weather-status').dataset.kind), 'rate-limit');
            for (const width of [1440, 375]) {
                await resize(width, 1100);
                await evaluate(() => document.querySelector('.bpb-weather-status').scrollIntoView({ block: 'center' }));
                if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-rate-limit-${width}.png`));
            }
            const before = evidence.length;
            await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=invalid`);
            await wait(() => document.querySelector('.bpb-weather-status')?.textContent.includes('valid ascent date'), 'invalid date explanation');
            assert.equal(evidence.length, before);
            await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=challenge`);
            await wait(() => document.readyState === 'complete' && document.querySelector('#challenge-form'), 'loaded verification document');
            assert.equal(await evaluate(() => !!document.getElementById('bpb-ascent-weather')), false, 'verification must not mount weather');
            assert.equal(evidence.length, before, 'verification must not request weather');
            for (const width of [1440, 375]) {
                await resize(width, 1100);
                if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-challenge-${width}.png`));
            }
            mode = 'complete';
            await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
            await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView());
            await wait(() => document.querySelector('.bpb-weather-model-description')?.textContent.includes('Using Best Match'), 'weather after verification navigation');
            assert.deepEqual(networkErrors, []);
            summary = { browser: firefoxMode ? 'firefox' : 'chromium', version, hidden: true, viewports: [375, 681, 768, 1440], themes: ['light', 'dark'], fixtures: ['negative-temperature', 'archive-day-navigation', 'gpx-container-reflow', 'hourly-conditions', 'conditions-without-model-field', 'gpx-hover-selection-cursor', 'no-gpx', 'no-map', 'long-report', 'divider-resize', 'loading', 'long-model', 'partial', 'rate-limit', 'invalid', 'challenge-navigation'], requests: evidence, profile: temporaryRoot };
        }
    }
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({ ...summary, teardown: 'passed' }));
