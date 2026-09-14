// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document, window */

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
import { chromium } from 'playwright';
import { createFixtureCertificate, waitForCondition } from './browser-verification-fixtures.mjs';
import { closeServer, createResourceStack, listenServer } from './resource-stack.mjs';
import { prepareGaiaImport } from '../src/gaia/gaia-import.js';

const root = path.resolve(import.meta.dirname, '..');
const evidenceDir = path.join(root, 'web-ext-artifacts', 'gaia-import-evidence');
const resources = createResourceStack();
const payload = {
    filename: 'peakbagger-7654321.gpx',
    gpx: '<?xml version="1.0"?><gpx version="1.1"><wpt lat="37" lon="-119"><name>Waypoint</name></wpt><trk><name>Saved ascent</name><trkseg><trkpt lat="37" lon="-119"><ele>100</ele></trkpt><trkpt lat="37.001" lon="-119.001"><ele>101</ele></trkpt></trkseg></trk></gpx>',
};

let failure;
try {
    await mkdir(evidenceDir, { recursive: true });
    const temporary = await mkdtemp(path.join(tmpdir(), 'bpb-gaia-import-'));
    resources.defer('disposable Gaia verifier', () => rm(temporary, { recursive: true, force: true }));
    const extensionDir = path.join(temporary, 'dist');
    await cp(path.join(root, 'dist'), extensionDir, { recursive: true });

    // The hidden fixture cannot approve native browser chrome. Grant only Gaia
    // in this disposable manifest; production still declares it optional.
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const gaiaOrigin = 'https://www.gaiagps.com/*';
    manifest.host_permissions.push(gaiaOrigin);
    manifest.optional_host_permissions = manifest.optional_host_permissions.filter(value => value !== gaiaOrigin);
    await writeFile(manifestPath, JSON.stringify(manifest));

    const ascentHtml = await readFile(path.join(root, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    let sourceReads = 0;
    let gaiaMode = 'ready';
    const gaiaFixture = () => `<!doctype html><html><meta charset="utf-8"><title>Gaia importer fixture</title><body>
        <button aria-label="Import Data" ${gaiaMode === 'signed-out' ? 'disabled' : ''}>Import</button>
        ${gaiaMode === 'signed-out' ? '<button>Log In</button>' : ''}<main id="preview"></main>
        <script>
        window.handoffs=0;window.saves=0;
        document.querySelector('button[aria-label="Import Data"]').onclick=()=>{
            const input=document.createElement('input');input.type='file';input.accept='.gpx';input.placeholder='Drag and drop to import files';
            input.oninput=async()=>{window.handoffs++;window.receivedName=input.files[0].name;window.received=await input.files[0].text();
                ${gaiaMode === 'stalled' ? '' : 'document.querySelector(\'main\').innerHTML=\'<p>Saved ascent</p><button>Save 1 item</button>\';document.querySelector(\'main button\').onclick=()=>window.saves++;'}
            };document.body.append(input);
        };
        </script></body></html>`;
    const certificate = await createFixtureCertificate({ label: 'gaia-import' });
    resources.defer('fixture certificate', () => certificate.remove());
    const server = createServer(certificate, (request, response) => {
        if (request.headers.host === 'www.gaiagps.com') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(gaiaFixture());
        } else if (request.url.startsWith('/climber/GPXFile.aspx')) {
            sourceReads++;
            response.setHeader('Content-Type', 'application/gpx+xml');
            response.end(payload.gpx);
        } else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(ascentHtml);
        }
    });
    await listenServer(server, 0, '127.0.0.1');
    resources.defer('Gaia HTTPS fixture', () => closeServer(server));
    const port = server.address().port;

    const context = await chromium.launchPersistentContext(path.join(temporary, 'browser'), {
        channel: 'chromium',
        headless: true,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        ignoreHTTPSErrors: true,
        viewport: { width: 1000, height: 760 },
        args: [
            `--disable-extensions-except=${extensionDir}`,
            `--load-extension=${extensionDir}`,
            `--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1, MAP www.gaiagps.com 127.0.0.1:${port}`,
        ],
    });
    resources.defer('hidden Chrome for Testing', () => context.close());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    const source = await context.newPage();
    await source.goto(`https://www.peakbagger.com:${port}/climber/ascent.aspx?aid=7654321`);
    const gaiaButton = source.locator('.bpb-gaia-button');
    await gaiaButton.waitFor();
    assert.equal((await gaiaButton.innerText()).trim(), 'Send to Gaia');
    const placement = await source.locator('.bpb-gaia-control').evaluate(control => ({
        parentId: control.parentElement?.id,
        previousTag: control.previousElementSibling?.tagName,
        previousHref: control.previousElementSibling?.getAttribute('href'),
    }));
    assert.deepEqual(placement, {
        parentId: 'gpxlinks',
        previousTag: 'A',
        previousHref: '/climber/GPXFile.aspx?aid=7654321&sep=1',
    });
    await source.locator('#gpxlinks').screenshot({ path: path.join(evidenceDir, 'ascent-button-light.png') });

    await gaiaButton.click();
    await waitForCondition(async () => {
        const text = await source.locator('.bpb-gaia-control').innerText();
        return /Ready in Gaia/.test(text) ? text : null;
    }, { description: 'the saved ascent to report Gaia ready', timeoutMs: 35_000 });
    const gaia = await waitForCondition(async () => context.pages().find(page => page.url().startsWith('https://www.gaiagps.com/')) || null, {
        description: 'the Gaia import tab',
    });
    const received = await gaia.evaluate(() => ({
        text: window.received,
        name: window.receivedName,
        handoffs: window.handoffs,
        saves: window.saves,
    }));
    assert.deepEqual(received, { text: payload.gpx, name: payload.filename, handoffs: 1, saves: 0 });
    assert.match(await source.locator('.bpb-gaia-status').innerText(), /Review the items and click Save/);
    assert.equal(await gaiaButton.isDisabled(), true);

    await source.evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; });
    await source.locator('#gpxlinks').screenshot({ path: path.join(evidenceDir, 'ascent-button-ready-dark.png') });
    const access = await context.newPage();
    await worker.evaluate(() => chrome.storage.sync.set({ bpbSettings: { theme: 'light' } }));
    await access.goto(`chrome-extension://${extensionId}/gaia/access.html`);
    await access.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'light');
    const lightAccessColors = await access.evaluate(() => ({
        page: window.getComputedStyle(document.body).backgroundColor,
        card: window.getComputedStyle(document.querySelector('.access-card')).backgroundColor,
    }));
    await access.screenshot({ path: path.join(evidenceDir, 'access-page-light.png') });
    await worker.evaluate(() => chrome.storage.sync.set({ bpbSettings: { theme: 'dark' } }));
    await access.reload();
    await access.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'dark');
    const darkAccessColors = await access.evaluate(() => ({
        page: window.getComputedStyle(document.body).backgroundColor,
        card: window.getComputedStyle(document.querySelector('.access-card')).backgroundColor,
    }));
    assert.notDeepEqual(darkAccessColors, lightAccessColors);
    await access.screenshot({ path: path.join(evidenceDir, 'access-page-dark.png') });

    const session = await worker.evaluate(() => chrome.storage.session.get(null));
    assert.ok(!JSON.stringify(session).includes('<gpx'), 'saved GPX must not enter extension storage');

    const adapterCheck = async (mode, timeoutMs = 500) => {
        gaiaMode = mode;
        const page = await context.newPage();
        await page.goto('https://www.gaiagps.com/map/');
        const outcome = await page.evaluate(prepareGaiaImport, { ...payload, timeoutMs });
        return {
            page,
            outcome,
            state: await page.evaluate(() => ({ handoffs: window.handoffs, saves: window.saves })),
        };
    };
    const signedOut = await adapterCheck('signed-out');
    assert.equal(signedOut.outcome.code, 'sign-in-required');
    assert.deepEqual(signedOut.state, { handoffs: 0, saves: 0 });
    const stalled = await adapterCheck('stalled');
    assert.equal(stalled.outcome.code, 'handoff-unconfirmed');
    assert.deepEqual(stalled.state, { handoffs: 1, saves: 0 });
    const duplicate = await stalled.page.evaluate(prepareGaiaImport, payload);
    assert.equal(duplicate.code, 'already-started');

    const report = {
        browser: context.browser().version(),
        viewport: { width: 1000, height: 760 },
        mode: 'hidden masked HTTPS fixtures',
        renderer: 'static HTML; no WebGL',
        sourceReads,
        nativePermissionPrompt: 'not inspected; Gaia was granted only in the disposable manifest',
        checks: [
            'real unpacked dist',
            'ascent-page placement',
            'trusted click and worker route',
            'exact saved GPX handoff',
            'manual Gaia Save preserved',
            'signed-out gate',
            'uncertain handoff suppresses retry',
            'no GPX in extension storage',
            'light and dark screenshots',
        ],
    };
    await writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} catch (error) {
    failure = error;
}
await resources.dispose(failure);
