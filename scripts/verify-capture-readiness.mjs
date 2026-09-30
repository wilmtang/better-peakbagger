// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exercise the real capture worker and Peakbagger helper with an interactive
// document whose image never finishes. Only the provider adapter is a fixture;
// its temporary host permission and no-GPS response never enter shipped dist/.
/* global document */
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { createFixtureCertificate, verificationViewport } from './browser-verification-fixtures.mjs';
import { createResourceStack, closeServer, listenServer } from './resource-stack.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountLinks = '<a href="/climber/climber.aspx?cid=77">My Home Page</a>'
    + '<a href="/climber/climberedit.aspx?cid=77">Edit Account</a>';

async function fixtureServer(resources, temporaryRoot) {
    const certificate = await createFixtureCertificate({ directory: temporaryRoot });
    resources.defer('capture fixture certificate', () => certificate.remove());
    const state = { signedIn: true, loginRequests: 0, holdHelper: false };
    const heldHelpers = [];
    const server = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
        if (request.url === '/release-helper') {
            state.holdHelper = false;
            for (const release of heldHelpers.splice(0)) release();
            response.end('released');
            return;
        }
        if (request.url === '/pending.svg') return; // Intentionally hold window.load.
        response.setHeader('content-type', 'text/html');
        const isLogin = request.headers.host === 'www.peakbagger.com' && request.url === '/Default.aspx';
        if (isLogin) state.loginRequests++;
        const body = isLogin && !state.signedIn ? '<p>Sign in</p>' : accountLinks;
        const finish = () => response.end(`<!doctype html><title>Capture readiness fixture</title>${body}`
            + (request.url === '/Default.aspx?pending' ? '<img src="/pending.svg" alt="">' : ''));
        if (isLogin && state.holdHelper) heldHelpers.push(finish);
        else finish();
    });
    resources.defer('capture fixture HTTPS server', () => closeServer(server));
    await listenServer(server, 0, '127.0.0.1');

    // A local CONNECT proxy preserves the production canonical origin on port
    // 443 without privileged binds, DNS changes, or any live site requests.
    const sockets = new Set();
    const proxy = http.createServer();
    proxy.on('connect', (request, socket, head) => {
        if (!['www.peakbagger.com:443', 'connect.garmin.com:443'].includes(request.url)) {
            socket.destroy();
            return;
        }
        const upstream = net.connect(server.address().port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        for (const connection of [socket, upstream]) {
            sockets.add(connection);
            connection.on('error', () => { socket.destroy(); upstream.destroy(); });
            connection.on('close', () => sockets.delete(connection));
        }
    });
    resources.defer('capture fixture proxy', () => closeServer(proxy));
    resources.defer('capture fixture sockets', () => { for (const socket of sockets) socket.destroy(); });
    await listenServer(proxy, 0, '127.0.0.1');
    const certificateSpki = createHash('sha256').update(new X509Certificate(certificate.cert)
        .publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    return { state, port: proxy.address().port, certificateSpki };
}

async function prepareFixtureExtension(temporaryRoot) {
    const source = path.join(temporaryRoot, 'extension');
    await cp(path.join(projectRoot, 'dist'), source, { recursive: true });
    const manifestPath = path.join(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions.push('https://connect.garmin.com/*');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(path.join(source, 'provider-page.js'), `
        globalThis.BPBProviderPage = {
            waitForOwnership: async expected => ({ ok: true, ...expected }),
            capture: async (options, generation, timeout, expected) => {
                globalThis.bpbFixtureExports = (globalThis.bpbFixtureExports || 0) + 1;
                return { ok: false, code: 'no-gps-data', ...expected };
            },
            cancelCapture: () => true,
        };
        void 0;
    `);
    return source;
}

// These functions execute in an extension page in both browsers. The worker,
// tab selection, readiness probe, MAIN-world helper, and account check are real.
async function prepareTabs() {
    const api = globalThis.browser || globalThis.chrome;
    const wait = async (read, ready) => {
        const expiresAt = Date.now() + 10_000;
        let last;
        do {
            last = await read();
            if (ready(last)) return last;
            await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < expiresAt);
        throw new Error(`Capture fixture did not become ready: ${JSON.stringify(last)}`);
    };
    const peakbagger = await api.tabs.create({ active: false, url: 'https://www.peakbagger.com/Default.aspx?pending' });
    const provider = await api.tabs.create({ active: false, url: 'https://connect.garmin.com/app/activity/123' });
    await wait(() => api.tabs.get(provider.id),
        tab => tab.url?.includes('/app/activity/123') && tab.status === 'complete');
    await wait(async () => {
        const tab = await api.tabs.get(peakbagger.id);
        if (!tab.url?.includes('/Default.aspx?pending')) return { url: tab.url, status: tab.status };
        const results = await api.scripting.executeScript({
            target: { tabId: peakbagger.id }, world: 'MAIN', injectImmediately: true,
            func: () => document.readyState,
        });
        return { url: tab.url, status: tab.status, readyState: results[0]?.result };
    }, state => state.readyState === 'interactive' && state.status === 'loading');
    return { peakbaggerId: peakbagger.id, providerId: provider.id };
}

async function capture(tabs) {
    const api = globalThis.browser || globalThis.chrome;
    const job = await api.runtime.sendMessage({ type: 'CAPTURE_START', tabId: tabs.providerId, force: true });
    const peakbagger = await api.tabs.get(tabs.peakbaggerId);
    const results = await api.scripting.executeScript({
        target: { tabId: tabs.providerId }, world: 'MAIN',
        func: () => globalThis.bpbFixtureExports || 0,
    });
    return { phase: job?.phase, error: job?.error, status: peakbagger.status, exports: results[0]?.result };
}

// Hold the helper's first response until the observer has seen its tab. This
// covers the real pre-commit tab state without depending on network timing.
async function captureWithNewHelper(tabs) {
    const api = globalThis.browser || globalThis.chrome;
    const existing = await api.tabs.query({ url: 'https://www.peakbagger.com/*' });
    for (const tab of existing) await api.tabs.remove(tab.id);
    const before = new Set((await api.tabs.query({})).map(tab => tab.id));
    const capturePromise = api.runtime.sendMessage({ type: 'CAPTURE_START', tabId: tabs.providerId, force: true });
    let helper;
    try {
        const expiresAt = Date.now() + 10_000;
        do {
            helper = (await api.tabs.query({})).find(tab => !before.has(tab.id));
            if (helper) break;
            await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < expiresAt);
        if (!helper) throw new Error('Capture did not create its helper tab');
    } finally {
        await fetch('https://www.peakbagger.com/release-helper');
    }
    const job = await capturePromise;
    const results = await api.scripting.executeScript({
        target: { tabId: tabs.providerId }, world: 'MAIN',
        func: () => globalThis.bpbFixtureExports || 0,
    });
    return {
        phase: job?.phase, error: job?.error, exports: results[0]?.result,
        helperRemains: (await api.tabs.query({})).some(tab => tab.id === helper.id),
        initialUrl: helper.url || null,
    };
}

async function verify(evaluate, fixture, label) {
    const viewport = await evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
    fixture.state.signedIn = true;
    const tabs = await evaluate(prepareTabs);
    const requestsBefore = fixture.state.loginRequests;
    const signedIn = await evaluate(capture, tabs);
    assert.equal(signedIn.phase, 'no-gps', `${label} must progress past checking-peakbagger: ${JSON.stringify(signedIn)}`);
    assert.equal(signedIn.status, 'loading', 'the image must still be pending when capture completes');
    assert.equal(signedIn.exports, 1);
    assert.equal(fixture.state.loginRequests, requestsBefore + 1, 'an interactive tab still needs a live login check');

    fixture.state.signedIn = false;
    const signedOut = await evaluate(capture, tabs);
    assert.equal(signedOut.error?.code, 'peakbagger-signed-out', `${label}: ${JSON.stringify(signedOut)}`);
    assert.equal(signedOut.exports, 1, 'stale signed-in DOM links must not permit another GPS export');
    fixture.state.signedIn = true;
    fixture.state.holdHelper = true;
    const freshHelper = await evaluate(captureWithNewHelper, tabs);
    assert.equal(freshHelper.phase, 'no-gps', `${label} new helper: ${JSON.stringify(freshHelper)}`);
    assert.equal(freshHelper.exports, 2);
    assert.equal(freshHelper.helperRemains, false, 'the completed helper must be cleaned up');

    fixture.state.signedIn = false;
    fixture.state.holdHelper = true;
    const signedOutHelper = await evaluate(captureWithNewHelper, tabs);
    assert.equal(signedOutHelper.error?.code, 'peakbagger-signed-out', `${label}: ${JSON.stringify(signedOutHelper)}`);
    assert.equal(signedOutHelper.exports, 2, 'a new signed-out helper must also block GPS export');
    console.log(`${label}: pending-image capture, new-helper startup, and signed-out privacy gates passed`
        + ` (hidden, ${viewport.width}x${viewport.height} viewport; no WebGL).`);
}

async function run(browserName) {
    const resources = createResourceStack();
    let failure;
    try {
        const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `bpb-capture-readiness-${browserName}-`));
        resources.defer('capture verification root', () => rm(temporaryRoot, { recursive: true, force: true }));
        const fixture = await fixtureServer(resources, temporaryRoot);
        const source = await prepareFixtureExtension(temporaryRoot);
        if (browserName === 'chrome') {
            const context = await chromium.launchPersistentContext(path.join(temporaryRoot, 'profile'), {
                ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chromium' }),
                headless: true,
                viewport: verificationViewport,
                ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
                proxy: { server: `http://127.0.0.1:${fixture.port}` },
                // Extension-created tabs may navigate before Playwright can
                // attach its per-page certificate policy. Trust this run's key
                // at launch so initial navigation cannot hit a TLS error page.
                args: [`--ignore-certificate-errors-spki-list=${fixture.certificateSpki}`,
                    `--disable-extensions-except=${source}`, `--load-extension=${source}`],
            });
            resources.defer('capture Chrome context', () => context.close());
            const networkFailures = [];
            context.on('requestfailed', request => {
                if (networkFailures.length < 10) networkFailures.push({
                    url: request.url(), error: request.failure()?.errorText,
                });
            });
            const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
            const page = await context.newPage();
            await page.goto(`chrome-extension://${new URL(worker.url()).host}/options/options.html`);
            try {
                await verify((fn, arg) => page.evaluate(fn, arg), fixture, `Chrome ${context.browser().version()}`);
            } catch (error) {
                console.error('Capture readiness failure:', {
                    pages: context.pages().map(page => page.url()), networkFailures,
                });
                throw error;
            }
        } else {
            resources.defer('owned Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
            const prepared = await prepareFirefoxSource({ distDir: source, temporaryRoot });
            resources.defer('capture Firefox source', prepared.cleanup);
            const profile = path.join(temporaryRoot, 'profile');
            await mkdir(profile);
            const options = new firefox.Options().addArguments('-headless').setProfile(profile)
                .windowSize(verificationViewport).setAcceptInsecureCerts(true)
                .setPreference('network.proxy.type', 1)
                .setPreference('network.proxy.ssl', '127.0.0.1')
                .setPreference('network.proxy.ssl_port', fixture.port)
                .setPreference('network.proxy.no_proxies_on', '');
            if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
            const service = new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`);
            const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
            resources.defer('capture Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
            await driver.manage().setTimeouts({ script: 30_000, pageLoad: 20_000 });
            const addonId = await driver.installAddon(prepared.sourceDir, true);
            await driver.setContext(firefox.Context.CHROME);
            const baseUrl = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("")', addonId);
            await driver.setContext(firefox.Context.CONTENT);
            await driver.get(`${baseUrl}options/options.html`);
            const evaluate = async (fn, arg) => {
                const result = await driver.executeAsyncScript(`
                    const done = arguments[arguments.length - 1];
                    Promise.resolve((${fn.toString()})(arguments[0]))
                        .then(value => done({ value }), error => done({ error: String(error) }));
                `, arg ?? null);
                if (result.error) throw new Error(result.error);
                return result.value;
            };
            await verify(evaluate, fixture, `Firefox ${(await driver.getCapabilities()).get('browserVersion')}`);
        }
    } catch (error) {
        failure = error;
    } finally {
        await resources.dispose(failure);
    }
}

const requestedBrowser = process.argv[2];
assert.ok(!requestedBrowser || ['chrome', 'firefox'].includes(requestedBrowser),
    'Usage: node scripts/verify-capture-readiness.mjs [chrome|firefox]');
for (const name of requestedBrowser ? [requestedBrowser] : ['chrome', 'firefox']) await run(name);
