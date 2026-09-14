// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document, window */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
import { chromium } from 'playwright';
import { buildGaiaPrototype, prototypeDist } from './build.mjs';
import { prepareGaiaImport } from './adapter.mjs';
import { createFixtureCertificate } from '../../browser-verification-fixtures.mjs';
import { closeServer, createResourceStack, listenServer } from '../../resource-stack.mjs';

const live = process.argv.includes('--live');
const evidenceDir = path.resolve(prototypeDist, '../evidence');
const resources = createResourceStack();
let failure;
try {
    await mkdir(evidenceDir, { recursive: true });
    const profile = await mkdtemp(path.join(tmpdir(), 'bpb-gaia-prototype-'));
    console.log(`Disposable profile: ${profile}`);
    resources.defer('test profile', () => rm(profile, { recursive: true, force: true }));
    const dist = await buildGaiaPrototype(path.join(profile, 'dist'));
    // Fixture mode grants Gaia in the disposable manifest only. Native optional
    // permission prompts are deliberately outside this hidden check's evidence.
    const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
    manifest.host_permissions.push(...manifest.optional_host_permissions);
    manifest.optional_host_permissions = [];
    await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest));
    const payload = {
        filename: 'peakbagger-42.gpx',
        gpx: '<?xml version="1.0"?><gpx version="1.1"><wpt lat="37" lon="-119"><name>Waypoint</name></wpt><trk><name>Prototype track</name><trkseg><trkpt lat="37" lon="-119"><ele>100</ele></trkpt><trkpt lat="37.001" lon="-119.001"><ele>101</ele></trkpt></trkseg><trkseg><trkpt lat="37.002" lon="-119.002"><ele>102</ele></trkpt></trkseg></trk></gpx>',
    };
    let sourceReads = 0;
    let port;
    let mode = 'ready';
    const fixtureHtml = () => `<!doctype html><html><meta charset="utf-8"><title>Gaia importer contract fixture</title><body>
        <h1>Gaia importer contract fixture</h1><button aria-label="Import Data" ${mode === 'signed-out' ? 'disabled' : ''}>Import</button>${mode === 'signed-out' ? '<button>Log In</button>' : ''}<main id="preview"></main>
        <script>
        window.handoffs=0;window.saves=0;
        document.querySelector('button').onclick=()=>{
            const input=document.createElement('input');input.type='file';input.accept='.gpx';input.placeholder='Drag and drop to import files';
            input.oninput=async()=>{window.handoffs++;window.receivedName=input.files[0].name;window.received=await input.files[0].text();
                ${mode === 'stalled' ? '' : 'document.querySelector(\'main\').innerHTML=\'<p>Prototype track</p><button>Save 1 item</button>\';document.querySelector(\'main button\').onclick=()=>window.saves++;'}
            };document.body.append(input);
        };
        </script></body></html>`;
    if (!live) {
        const certificate = await createFixtureCertificate({ label: 'gaia-prototype' });
        resources.defer('fixture certificate', () => certificate.remove());
        const server = createServer(certificate, (request, response) => {
            if (request.headers.host === 'www.gaiagps.com') {
                response.setHeader('Content-Type', 'text/html');
                response.end(fixtureHtml());
            } else if (request.url.startsWith('/climber/GPXFile.aspx')) {
                sourceReads++;
                response.setHeader('Content-Type', 'application/gpx+xml');
                response.end(payload.gpx);
            } else {
                response.setHeader('Content-Type', 'text/html');
                response.end('<!doctype html><title>Ascent fixture</title><a href="/climber/GPXFile.aspx?aid=42&sep=1">Download this GPS track</a>');
            }
        });
        await listenServer(server, 0, '127.0.0.1');
        resources.defer('HTTPS fixture', () => closeServer(server));
        port = server.address().port;
    }
    const context = await chromium.launchPersistentContext(path.join(profile, 'browser'), {
        channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        ignoreHTTPSErrors: !live,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
            ...(live ? [] : [`--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1, MAP www.gaiagps.com 127.0.0.1:${port}`])],
    });
    resources.defer('test browser', () => context.close());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    if (live) {
        const page = await context.newPage();
        await page.goto('https://www.gaiagps.com/map/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('button[aria-label="Import Data"]')
            || /No Thanks|Oops!/.test(document.body.innerText));
        for (const label of ['No Thanks', 'Skip']) {
            const control = page.getByText(label, { exact: true });
            if (await control.isVisible()) await control.click();
        }
        await page.getByRole('button', { name: 'Import Data', exact: true }).waitFor().catch(async error => {
            await page.screenshot({ path: path.join(evidenceDir, 'live-unavailable.png') });
            throw new Error(`${error.message}; Gaia page: ${await page.locator('body').innerText()}`);
        });
        // Live probe checks the signed-out gate. No file reaches Gaia.
        assert.equal(await page.getByRole('button', { name: 'Import Data', exact: true }).isDisabled(), true);
        const renderer = await page.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl');
            const debug = gl?.getExtension('WEBGL_debug_renderer_info');
            return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
        });
        assert.ok(renderer && !/swiftshader|llvmpipe|software/i.test(renderer), `Hardware renderer required: ${renderer}`);
        const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.gaiagps.com/*' }))[0].id);
        const [result] = await worker.evaluate(`chrome.scripting.executeScript({
            target: {tabId: ${JSON.stringify(tabId)}},
            func: ${prepareGaiaImport.toString()},
            args: [${JSON.stringify(payload)}]
        })`);
        const outcome = result.result;
        assert.equal(outcome.code, 'sign-in-required');
        assert.equal(outcome.supplied, false);
        await page.screenshot({ path: path.join(evidenceDir, 'live-signed-out.png') });
        const report = { mode: 'live-signed-out', browser: context.browser().version(), viewport: { width: 1280, height: 900 }, renderer, outcome };
        await writeFile(path.join(evidenceDir, 'live.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    } else {
        const source = await context.newPage();
        await source.goto(`https://www.peakbagger.com:${port}/climber/ascent.aspx?aid=42`);
        const sourceTabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.peakbagger.com/*' }))[0].id);
        const popup = await context.newPage();
        await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), sourceTabId);
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        // The actual popup may be inspected in a background tab. Select the
        // source again and reload so its activeTab query has the same context.
        await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), sourceTabId);
        await popup.reload();
        await popup.waitForFunction(() => !document.getElementById('send').disabled);
        await popup.setViewportSize({ width: 344, height: 400 });
        await popup.screenshot({ path: path.join(evidenceDir, 'popup-idle.png') });
        await popup.getByRole('button', { name: 'Prepare in Gaia' }).click();
        await popup.waitForFunction(() => {
            const text = document.getElementById('status').textContent;
            return text && text !== 'Preparing GPX…';
        }, null, { timeout: 35000 }).catch(async error => {
            throw new Error(`${error.message}; popup: ${await popup.locator('body').innerText()}`);
        });
        const gaia = context.pages().find(page => page.url().startsWith('https://www.gaiagps.com/'));
        assert.match(await popup.locator('#status').innerText(), /GPX ready/,
            gaia ? await gaia.locator('body').innerText() : 'No Gaia page');
        assert.ok(gaia);
        const read = await gaia.evaluate(() => ({ text: window.received, name: window.receivedName, handoffs: window.handoffs, saves: window.saves }));
        assert.deepEqual(read, { text: payload.gpx, name: payload.filename, handoffs: 1, saves: 0 });
        assert.equal(sourceReads, 1);
        assert.equal(await popup.getByRole('button', { name: 'Prepare in Gaia' }).isDisabled(), true);
        await popup.screenshot({ path: path.join(evidenceDir, 'popup-ready.png') });
        await popup.emulateMedia({ colorScheme: 'dark' });
        await popup.screenshot({ path: path.join(evidenceDir, 'popup-ready-dark.png') });
        await popup.emulateMedia({ colorScheme: 'light' });
        const stored = await worker.evaluate(() => chrome.storage.session.get(null));
        assert.ok(!JSON.stringify(stored).includes('<gpx'));
        assert.equal(stored.gaiaPrototypeResult.code, 'prepared');
        // No page-world message route can trigger a second privileged upload.
        const denied = await gaia.evaluate(async extensionId => {
            try { return await chrome.runtime.sendMessage(extensionId, { type: 'GAIA_PREPARE', sourceTabId: 1 }); }
            catch { return 'denied'; }
        }, extensionId);
        assert.equal(denied, 'denied');
        const testAdapter = async (testMode, timeoutMs = 500) => {
            mode = testMode;
            const page = await context.newPage();
            await page.goto('https://www.gaiagps.com/map/');
            const outcome = await page.evaluate(prepareGaiaImport, { ...payload, timeoutMs });
            const state = await page.evaluate(() => ({ handoffs: window.handoffs, saves: window.saves }));
            return { page, outcome, state };
        };
        const signedOut = await testAdapter('signed-out');
        assert.equal(signedOut.outcome.code, 'sign-in-required');
        assert.deepEqual(signedOut.state, { handoffs: 0, saves: 0 });
        const stalled = await testAdapter('stalled');
        assert.equal(stalled.outcome.code, 'handoff-unconfirmed');
        assert.deepEqual(stalled.state, { handoffs: 1, saves: 0 });
        const duplicate = await stalled.page.evaluate(prepareGaiaImport, payload);
        assert.equal(duplicate.code, 'already-started');
        mode = 'ready';
        const wrongOrigin = await source.evaluate(prepareGaiaImport, payload);
        assert.equal(wrongOrigin.code, 'wrong-page');
        const report = { mode: 'masked-fixtures', browser: context.browser().version(), viewport: { width: 1280, height: 900 }, popupViewport: { width: 344, height: 400 }, renderer: 'Static HTML fixtures; no WebGL', sourceReads, checks: ['real packed extension', 'trusted popup click', 'exact original GPX', 'one input event', 'manual save preserved', 'signed-out gate', 'uncertain handoff', 'no blind retry', 'wrong origin', 'status-only session storage'] };
        await writeFile(path.join(evidenceDir, 'fixtures.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    }
} catch (error) { failure = error; }
await resources.dispose(failure);
