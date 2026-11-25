// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exercise the real capture worker and Peakbagger helper with an interactive
// document whose image never finishes. Only the provider adapter is a fixture;
// its temporary host permission and no-GPS response never enter shipped dist/.
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from 'selenium-webdriver';
import firefox, { type Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';
import { createFixtureCertificate, verificationViewport } from './browser-verification-fixtures.mts';
import { createResourceStack, closeServer, listenServer } from './resource-stack.mts';
import { prepareFirefoxSource } from './run-firefox.mts';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mts';
import { createVerificationRoot, launchVerificationChrome } from './verification-launch.mts';

type Resources = ReturnType<typeof createResourceStack>;
type Fixture = Awaited<ReturnType<typeof fixtureServer>>;
interface Tabs { peakbaggerId: number; providerId: number }
interface CaptureReply { phase?: string; error?: { code?: string } }
// Runs one extension-page function in either browser and returns its result.
type Evaluate = <T, A>(fn: (arg: A) => T, arg?: A) => Promise<Awaited<T>>;
type ExtensionGlobal = typeof globalThis & { browser?: typeof chrome; bpbFixtureExports?: number };

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountLinks = '<div>Logged in: Test Climber | <a href="/climber/climber.aspx?cid=77">My Home Page</a>'
    + '<a href="/climber/climberedit.aspx?cid=77">Edit Account</a></div>';

async function fixtureServer(resources: Resources, temporaryRoot: string) {
    const certificate = await createFixtureCertificate({ directory: temporaryRoot as never });
    assert.ok(certificate);
    resources.defer('capture fixture certificate', () => certificate.remove());
    const state = { signedIn: true, loginRequests: 0, holdHelper: false };
    const heldHelpers: (() => void)[] = [];
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
    const sockets = new Set<net.Socket>();
    const proxy = http.createServer();
    proxy.on('connect', (request, socket, head) => {
        if (!['www.peakbagger.com:443', 'connect.garmin.com:443'].includes(request.url!)) {
            socket.destroy();
            return;
        }
        const upstream = net.connect((server.address() as AddressInfo).port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        for (const connection of [socket as net.Socket, upstream]) {
            sockets.add(connection);
            connection.on('error', () => { socket.destroy(); upstream.destroy(); });
            connection.on('close', () => sockets.delete(connection));
        }
    });
    resources.defer('capture fixture proxy', () => closeServer(proxy));
    resources.defer('capture fixture sockets', () => { for (const socket of sockets) socket.destroy(); });
    await listenServer(proxy, 0, '127.0.0.1');
    return { state, port: (proxy.address() as AddressInfo).port, chromeTrustArgs: certificate.chromeTrustArgs };
}

async function prepareFixtureExtension(temporaryRoot: string) {
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
async function prepareTabs(): Promise<Tabs> {
    const api = (globalThis as ExtensionGlobal).browser || globalThis.chrome;
    const wait = async <T,>(read: () => Promise<T>, ready: (value: T) => unknown) => {
        const expiresAt = Date.now() + 10_000;
        let last: T;
        do {
            last = await read();
            if (ready(last)) return last;
            await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < expiresAt);
        throw new Error(`Capture fixture did not become ready: ${JSON.stringify(last)}`);
    };
    const peakbagger = await api.tabs.create({ active: false, url: 'https://www.peakbagger.com/Default.aspx?pending' });
    const provider = await api.tabs.create({ active: false, url: 'https://connect.garmin.com/app/activity/123' });
    await wait(() => api.tabs.get(provider.id!),
        tab => tab.url?.includes('/app/activity/123') && tab.status === 'complete');
    await wait(async () => {
        const tab = await api.tabs.get(peakbagger.id!);
        if (!tab.url?.includes('/Default.aspx?pending')) return { url: tab.url, status: tab.status };
        const results = await api.scripting.executeScript({
            target: { tabId: peakbagger.id! }, world: 'MAIN', injectImmediately: true,
            func: () => document.readyState,
        });
        return { url: tab.url, status: tab.status, readyState: results[0]?.result as string | undefined };
    }, state => (state as { readyState?: string }).readyState === 'interactive' && state.status === 'loading');
    return { peakbaggerId: peakbagger.id!, providerId: provider.id! };
}

async function capture(tabs: Tabs) {
    const api = (globalThis as ExtensionGlobal).browser || globalThis.chrome;
    const job: CaptureReply | undefined = await api.runtime.sendMessage({ type: 'CAPTURE_START', tabId: tabs.providerId, force: true });
    const peakbagger = await api.tabs.get(tabs.peakbaggerId);
    const results = await api.scripting.executeScript({
        target: { tabId: tabs.providerId }, world: 'MAIN',
        func: () => (globalThis as ExtensionGlobal).bpbFixtureExports || 0,
    });
    return { phase: job?.phase, error: job?.error, status: peakbagger.status, exports: results[0]?.result };
}

// Hold the helper's first response until the observer has seen its tab. This
// covers the real pre-commit tab state without depending on network timing.
async function captureWithNewHelper(tabs: Tabs) {
    const api = (globalThis as ExtensionGlobal).browser || globalThis.chrome;
    const existing = await api.tabs.query({ url: 'https://www.peakbagger.com/*' });
    for (const tab of existing) await api.tabs.remove(tab.id!);
    const before = new Set((await api.tabs.query({})).map(tab => tab.id));
    const capturePromise: Promise<CaptureReply | undefined> = api.runtime.sendMessage({ type: 'CAPTURE_START', tabId: tabs.providerId, force: true });
    let helper: chrome.tabs.Tab | undefined;
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
        func: () => (globalThis as ExtensionGlobal).bpbFixtureExports || 0,
    });
    return {
        phase: job?.phase, error: job?.error, exports: results[0]?.result,
        helperRemains: (await api.tabs.query({})).some(tab => tab.id === helper!.id),
        initialUrl: helper!.url || null,
    };
}

async function verify(evaluate: Evaluate, fixture: Fixture, label: string) {
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

async function run(browserName: string) {
    const resources = createResourceStack();
    let failure: unknown = null;
    try {
        const temporaryRoot = await createVerificationRoot(resources, `bpb-capture-readiness-${browserName}-`, 'capture verification root');
        const fixture = await fixtureServer(resources, temporaryRoot);
        const source = await prepareFixtureExtension(temporaryRoot);
        if (browserName === 'chrome') {
            const context = await launchVerificationChrome(resources, 'capture Chrome context', path.join(temporaryRoot, 'profile'), {
                chromeBinary: process.env.CHROME_BIN,
                viewport: verificationViewport,
                ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
                proxy: { server: `http://127.0.0.1:${fixture.port}` },
                // Extension-created tabs may navigate before Playwright can
                // attach its per-page certificate policy. Trust this run's key
                // at launch so initial navigation cannot hit a TLS error page.
                trustArgs: fixture.chromeTrustArgs, extension: source,
            });
            const networkFailures: { url: string; error: string | undefined }[] = [];
            context.on('requestfailed', request => {
                if (networkFailures.length < 10) networkFailures.push({
                    url: request.url(), error: request.failure()?.errorText,
                });
            });
            const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
            const page = await context.newPage();
            await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
            try {
                await verify(((fn: (arg: unknown) => unknown, arg?: unknown) => page.evaluate(fn, arg)) as Evaluate, fixture, `Chrome ${context.browser()!.version()}`);
            } catch (error) {
                console.error('Capture readiness failure:', {
                    pages: context.pages().map(open => open.url()), networkFailures,
                });
                throw error;
            }
        } else {
            resources.defer('owned Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
            const prepared = await prepareFirefoxSource({ distDir: source, temporaryRoot });
            resources.defer('capture Firefox source', prepared.cleanup);
            const profile = path.join(temporaryRoot, 'profile');
            await mkdir(profile);
            const options = new firefox.Options().addArguments('-headless', '-no-remote').setProfile(profile)
                .windowSize(verificationViewport)
                .setPreference('network.proxy.type', 1)
                .setPreference('network.proxy.ssl', '127.0.0.1')
                .setPreference('network.proxy.ssl_port', fixture.port)
                .setPreference('network.proxy.no_proxies_on', '');
            options.setAcceptInsecureCerts(true);
            if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
            const service = new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`);
            const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build() as FirefoxDriver;
            resources.defer('capture Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
            await driver.manage().setTimeouts({ script: 30_000, pageLoad: 20_000 });
            const addonId = await driver.installAddon(prepared.sourceDir, true);
            await driver.setContext(firefox.Context.CHROME);
            const baseUrl = await driver.executeScript<string>('return WebExtensionPolicy.getByID(arguments[0]).getURL("")', addonId);
            await driver.setContext(firefox.Context.CONTENT);
            await driver.get(`${baseUrl}popup/popup.html`);
            const evaluate = async (fn: (arg: never) => unknown, arg?: unknown) => {
                const result = await driver.executeAsyncScript<{ value?: unknown; error?: string }>(`
                    const done = arguments[arguments.length - 1];
                    Promise.resolve((${fn.toString()})(arguments[0]))
                        .then(value => done({ value }), error => done({ error: String(error) }));
                `, arg ?? null);
                if (result.error) throw new Error(result.error);
                return result.value;
            };
            await verify(evaluate as Evaluate, fixture, `Firefox ${(await driver.getCapabilities()).get('browserVersion')}`);
        }
    } catch (error) {
        failure = error;
    } finally {
        await resources.dispose(failure as null);
    }
}

const requestedBrowser = process.argv[2];
assert.ok(!requestedBrowser || ['chrome', 'firefox'].includes(requestedBrowser),
    'Usage: node scripts/verify-capture-readiness.mts [chrome|firefox]');
for (const name of requestedBrowser ? [requestedBrowser] : ['chrome', 'firefox']) await run(name);
