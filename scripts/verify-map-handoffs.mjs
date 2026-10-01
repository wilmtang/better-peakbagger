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
import { prepareOnxImport } from '../src/onx/onx-import.js';
import { prepareCaltopoImport } from '../src/caltopo/caltopo-import.js';
import { prepareAlltrailsImport } from '../src/alltrails/alltrails-import.js';

const root = path.resolve(import.meta.dirname, '..');
const evidenceDir = path.join(root, 'web-ext-artifacts', 'map-handoff-evidence');
const resources = createResourceStack();
const payload = {
    filename: 'peakbagger-7654321.gpx',
    gpx: '<?xml version="1.0"?><gpx version="1.1"><wpt lat="37" lon="-119"><name>Waypoint</name></wpt><trk><name>Saved ascent</name><trkseg><trkpt lat="37" lon="-119"><ele>100</ele></trkpt><trkpt lat="37.001" lon="-119.001"><ele>101</ele></trkpt></trkseg></trk></gpx>',
};

let failure;
try {
    await mkdir(evidenceDir, { recursive: true });
    const temporary = await mkdtemp(path.join(tmpdir(), 'bpb-map-handoff-'));
    resources.defer('disposable map handoff verifier', () => rm(temporary, { recursive: true, force: true }));
    const extensionDir = path.join(temporary, 'dist');
    await cp(path.join(root, 'dist'), extensionDir, { recursive: true });

    // The hidden fixture cannot approve native browser chrome. Grant only the
    // tested map origins here; production still declares them optional.
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const gaiaOrigin = 'https://www.gaiagps.com/*';
    const onxOrigin = 'https://backcountry.onxmaps.com/*';
    const caltopoOrigin = 'https://caltopo.com/*';
    const alltrailsOrigin = 'https://www.alltrails.com/*';
    manifest.host_permissions.push(gaiaOrigin, onxOrigin, alltrailsOrigin, caltopoOrigin);
    manifest.optional_host_permissions = manifest.optional_host_permissions.filter(
        value => value !== gaiaOrigin && value !== onxOrigin && value !== alltrailsOrigin && value !== caltopoOrigin,
    );
    await writeFile(manifestPath, JSON.stringify(manifest));

    const ascentHtml = await readFile(path.join(root, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    const betaHtml = await readFile(path.join(root, 'test/fixtures/peakascents/1039-default-full-columns.html'), 'utf8');
    let sourceReads = 0;
    let gaiaMode = 'ready';
    let onxMode = 'ready';
    let alltrailsMode = 'ready';
    let caltopoMode = 'ready';
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
    const onxFixture = () => `<!doctype html><html><meta charset="utf-8"><title>onX importer fixture</title><body>
        ${onxMode === 'membership' ? '<button data-test="upgrade-now-button">Upgrade now</button>' : `
        <input id="add-files-input" type="file" accept=".gpx,.kml">
        <main id="preview"></main><button data-test="import-card-import-button" disabled>Import</button>`}
        <script>
        window.handoffs=0;window.imports=0;
        const input=document.querySelector('#add-files-input');
        if(input)input.onchange=async()=>{window.handoffs++;window.receivedName=input.files[0].name;window.received=await input.files[0].text();
            ${onxMode === 'stalled' ? '' : 'const item=document.createElement(\'p\');item.dataset.test=\'file-item\';item.textContent=\'Saved ascent\';document.querySelector(\'main\').append(item);document.querySelector(\'[data-test="import-card-import-button"]\').disabled=false;'}
        };
        const confirm=document.querySelector('[data-test="import-card-import-button"]');
        if(confirm)confirm.onclick=()=>window.imports++;
        </script></body></html>`;
    const alltrailsFixture = () => `<!doctype html><html><meta charset="utf-8"><title>AllTrails uploader fixture</title><body>
        <button id="open">Upload a route</button>
        <script>
        window.handoffs=0;window.uploads=0;
        document.querySelector('#open').onclick=()=>{
            const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
            dialog.innerHTML='<h2>Upload a route</h2>';
            const input=document.createElement('input');input.type='file';input.accept='.gpx,.fit';
            input.onchange=async()=>{window.handoffs++;window.receivedName=input.files[0].name;window.received=await input.files[0].text();
                ${alltrailsMode === 'stalled' ? '' : 'const label=document.createElement(\'div\');label.title=input.files[0].name;label.textContent=input.files[0].name;dialog.append(label);const upload=document.createElement(\'button\');upload.textContent=\'Upload\';upload.onclick=()=>window.uploads++;dialog.append(upload);'}
            };document.body.append(dialog);
            // Live AllTrails uses a Dropzone input portaled under body.
            input.className='dz-hidden-input';
            setTimeout(()=>document.body.append(input),0);
        };
        </script></body></html>`;
    const caltopoFixture = () => `<!doctype html><html><meta charset="utf-8"><title>CalTopo importer fixture</title><body>
        <div id="page_left"><div class="action-button-js"><img src="/static/images/import.svg">Import</div></div>
        <script>
        window.handoffs=0;window.imports=0;
        document.querySelector('.action-button-js').onclick=()=>{
            const dialog=document.createElement('div');dialog.className='yui-panel';
            dialog.innerHTML='<div class="hd">Importer</div><input id="file" type="file"><button>Import</button>';
            const input=dialog.querySelector('input');
            input.onchange=async()=>{window.handoffs++;window.receivedName=input.files[0].name;window.received=await input.files[0].text();
                if('${caltopoMode}'==='stalled')return;
                dialog.style.display='none';
                const review=document.createElement('div');review.className='yui-panel';
                review.innerHTML='<div class="hd">Import Data</div><table><tbody><tr><td><input type="checkbox" checked><input type="text" value="Saved ascent"></td></tr></tbody></table><button>Import</button>';
                review.querySelector('button').onclick=()=>window.imports++;document.body.append(review);
            };document.body.append(dialog);
        };
        </script></body></html>`;
    const certificate = await createFixtureCertificate({ label: 'map-handoff' });
    resources.defer('fixture certificate', () => certificate.remove());
    const server = createServer(certificate, (request, response) => {
        if (request.headers.host === 'caltopo.com') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(caltopoFixture());
        } else if (request.headers.host === 'www.gaiagps.com') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(gaiaFixture());
        } else if (request.headers.host === 'backcountry.onxmaps.com') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(onxFixture());
        } else if (request.headers.host === 'www.alltrails.com') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(alltrailsFixture());
        } else if (request.url.startsWith('/climber/PeakAscents.aspx')) {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(betaHtml);
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
    resources.defer('map handoff HTTPS fixture', () => closeServer(server));
    const port = server.address().port;

    const context = await chromium.launchPersistentContext(path.join(temporary, 'browser'), {
        channel: 'chromium',
        headless: true,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        viewport: { width: 1000, height: 760 },
        args: [
            ...certificate.chromeTrustArgs,
            `--disable-extensions-except=${extensionDir}`,
            `--load-extension=${extensionDir}`,
            `--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1, MAP www.gaiagps.com 127.0.0.1:${port}, MAP backcountry.onxmaps.com 127.0.0.1:${port}, MAP www.alltrails.com 127.0.0.1:${port}, MAP caltopo.com 127.0.0.1:${port}`,
        ],
    });
    resources.defer('hidden Chrome for Testing', () => context.close());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    // Capture injection failures in this disposable worker, without recording GPX.
    await worker.evaluate(() => {
        globalThis.handoffInjectionErrors = [];
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.scripting.executeScript = async details => {
            try { return await execute(details); }
            catch (error) {
                globalThis.handoffInjectionErrors.push({ tabId: details.target?.tabId, message: error.message });
                throw error;
            }
        };
    });

    const source = await context.newPage();
    await source.goto(`https://www.peakbagger.com:${port}/climber/ascent.aspx?aid=7654321`);
    const gaiaButton = source.locator('[data-provider=\"gaia\"]');
    const onxButton = source.locator('[data-provider=\"onx\"]');
    const alltrailsButton = source.locator('[data-provider=\"alltrails\"]');
    const caltopoButton = source.locator('[data-provider="caltopo"]');
    await gaiaButton.waitFor();
    assert.equal((await caltopoButton.innerText()).trim(), 'Send to CalTopo');
    assert.equal((await gaiaButton.innerText()).trim(), 'Send to Gaia');
    assert.equal((await onxButton.innerText()).trim(), 'Send to onX');
    assert.equal((await alltrailsButton.innerText()).trim(), 'Send to AllTrails');
    const placement = await source.locator('.bpb-map-handoff-control').evaluate(control => ({
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
    const linkBox = await source.locator('#gpxlinks > a').first().boundingBox();
    const controlsBox = await source.locator('.bpb-map-handoff-control').boundingBox();
    assert.ok(controlsBox.x >= linkBox.x + linkBox.width, 'send controls sit beside the download');
    assert.ok(controlsBox.y < linkBox.y + linkBox.height && controlsBox.y + controlsBox.height > linkBox.y, 'send controls share the download line');

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html#map-handoffs`);
    const providerList = options.locator('#map-provider-order');
    await providerList.locator('input:checked').first().waitFor();
    assert.equal(await providerList.locator('input:checked').count(), 4);
    // Measure real layout: jsdom cannot expose description caps or centering.
    for (const width of [1000, 760, 430]) {
        await options.setViewportSize({ width, height: 760 });
        for (const theme of ['light', 'dark']) {
            await options.locator('#theme').selectOption(theme);
            await options.waitForFunction(value => document.documentElement.dataset.bpbTheme === value, theme);
            await options.waitForFunction(() => !document.querySelector('#status').classList.contains('show'));
            const layout = await options.evaluate(() => {
                const orders = [...document.querySelectorAll('.order-setting-row')].map(row => {
                    const label = row.querySelector('.label').getBoundingClientRect();
                    const desc = row.querySelector('.desc').getBoundingClientRect();
                    const list = row.querySelector('ol').getBoundingClientRect();
                    return { labelWidth: label.width, descWidth: desc.width, descBottom: desc.bottom, listTop: list.top };
                });
                const row = document.querySelector('.viewport-setting-row');
                const label = row.querySelector('.label').getBoundingClientRect();
                const controls = row.querySelector('.control').getBoundingClientRect();
                return { orders, labelTop: label.top, labelBottom: label.bottom, controlsTop: controls.top,
                    viewportFits: row.scrollWidth <= row.clientWidth,
                    stacked: window.getComputedStyle(row).flexDirection === 'column' };
            });
            for (const order of layout.orders) {
                assert.ok(Math.abs(order.labelWidth - order.descWidth) < 1, `order description uses available width at ${width}px`);
                assert.ok(order.listTop >= order.descBottom, `order description clears the list at ${width}px`);
            }
            assert.ok(layout.viewportFits, `viewport setting fits at ${width}px`);
            assert.ok(layout.stacked ? layout.controlsTop >= layout.labelBottom : Math.abs(layout.controlsTop - layout.labelTop) < 1,
                `viewport label aligns with the control group or stacks above it at ${width}px`);
            await options.locator('#map-handoffs').screenshot({ path: path.join(evidenceDir, `provider-layout-${theme}-${width}.png`) });
            await options.locator('.order-setting-row').filter({ has: options.locator('#beta-peak-order') }).screenshot({ path: path.join(evidenceDir, `filter-layout-${theme}-${width}.png`) });
            await options.locator('.viewport-setting-row').screenshot({ path: path.join(evidenceDir, `viewport-layout-${theme}-${width}.png`) });
        }
    }
    await options.setViewportSize({ width: 1000, height: 760 });
    await options.locator('#theme').selectOption('light');

    await providerList.getByRole('button', { name: 'Reorder onX Backcountry', exact: true }).press('ArrowUp');
    await waitForCondition(async () => options.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Reorder onX Backcountry' && !document.activeElement.disabled), { description: 'keyboard focus preserved at the first position' });
    await providerList.getByRole('button', { name: 'Reorder onX Backcountry', exact: true }).press('ArrowDown');
    await waitForCondition(async () => (await source.locator('.bpb-map-handoff-button').evaluateAll(items => items.map(item => item.dataset.provider))).join() === 'gaia,onx,alltrails,caltopo', { description: 'provider order restored before the transfer check' });

    const caltopoGrip = providerList.getByRole('button', { name: 'Reorder CalTopo', exact: true });
    await caltopoGrip.scrollIntoViewIfNeeded();
    const gripBox = await caltopoGrip.boundingBox();
    const targetBox = await providerList.locator('[data-order-item="alltrails"]').boundingBox();
    await options.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await options.mouse.down();
    await options.mouse.move(gripBox.x + gripBox.width / 2, targetBox.y + targetBox.height / 2 - 8, { steps: 8 });
    assert.equal(await providerList.getAttribute('data-reordering'), '');
    await providerList.screenshot({ path: path.join(evidenceDir, 'provider-settings-dragging.png') });
    await options.mouse.up();
    await waitForCondition(async () => (await source.locator('.bpb-map-handoff-button').evaluateAll(items => items.map(item => item.dataset.provider))).join() === 'gaia,onx,caltopo,alltrails', { description: 'provider order applied to the open ascent' });
    await providerList.getByLabel('Gaia GPS', { exact: true }).uncheck();
    await gaiaButton.waitFor({ state: 'hidden' });
    await options.locator('#map-handoffs').screenshot({ path: path.join(evidenceDir, 'provider-settings-light.png') });

    const beta = await context.newPage();
    await beta.goto(`https://www.peakbagger.com:${port}/climber/PeakAscents.aspx?pid=1039`);
    await beta.locator('#pbaf-bar').waitFor();
    const betaKeys = () => beta.locator('.pbaf-filter-item').evaluateAll(items => items.map(item => item.dataset.filterKey));
    await options.locator('#beta-peak-order').getByRole('button', { name: 'Reorder Has beta', exact: true }).press('ArrowUp');
    await waitForCondition(async () => (await betaKeys()).join() === 'fav,gps,tr,beta,link', { description: 'settings filter order applied to the open list' });
    await beta.locator('[data-filter-key="beta"] .pbaf-chip').press('Alt+ArrowLeft');
    await waitForCondition(async () => (await options.locator('#beta-peak-order > li').evaluateAll(items => items.map(item => item.dataset.orderItem))).join() === 'fav,gps,beta,tr,link', { description: 'page keyboard order reflected in Settings' });
    await options.locator('#beta-peak-order').screenshot({ path: path.join(evidenceDir, 'beta-order-settings-light.png') });

    const downloadEvent = options.waitForEvent('download');
    await options.locator('#settings-backup-export').click();
    const settingsDownload = await downloadEvent;
    const exportedPath = path.join(temporary, 'settings.json');
    await settingsDownload.saveAs(exportedPath);
    const exported = JSON.parse(await readFile(exportedPath, 'utf8'));
    assert.deepEqual(exported.settings.mapProviderOrder, ['gaia', 'onx', 'caltopo', 'alltrails']);
    assert.deepEqual(exported.settings.mapProvidersEnabled, ['onx', 'alltrails', 'caltopo']);
    assert.deepEqual(exported.settings.betaPeakFilterOrder, ['fav', 'gps', 'beta', 'tr', 'link']);
    await worker.evaluate(() => chrome.storage.sync.set({ bpbSettings: { mapProvidersEnabled: [], theme: 'dark' } }));
    await source.locator('.bpb-map-handoff-control').waitFor({ state: 'hidden' });
    await options.locator('#settings-backup-file').setInputFiles(exportedPath);
    await options.locator('#settings-backup-confirm').click();
    await waitForCondition(async () => (await source.locator('.bpb-map-handoff-button:visible').evaluateAll(items => items.map(item => item.dataset.provider))).join() === 'onx,caltopo,alltrails', { description: 'imported settings restore provider visibility and order' });
    await waitForCondition(async () => (await betaKeys()).join() === 'fav,gps,beta,tr,link', { description: 'imported settings restore filter order' });
    await worker.evaluate(() => chrome.storage.sync.set({ bpbSettings: { theme: 'dark' } }));
    await options.setViewportSize({ width: 430, height: 760 });
    await options.locator('#map-handoffs').screenshot({ path: path.join(evidenceDir, 'provider-settings-dark-narrow.png') });
    await options.locator('#beta-peak-order').screenshot({ path: path.join(evidenceDir, 'beta-order-settings-dark-narrow.png') });
    const fits = await options.locator('#map-provider-order').evaluate(list => {
        const bounds = list.getBoundingClientRect();
        return [...list.querySelectorAll('li, button')].every(item => {
            const rect = item.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right + 1;
        });
    });
    assert.ok(fits, 'provider settings fit at 430px');
    // Touch uses the same grip, with reduced motion and no checkbox side effect.
    await options.emulateMedia({ reducedMotion: 'reduce' });
    await providerList.scrollIntoViewIfNeeded();
    const touchGrip = await providerList.getByRole('button', { name: 'Reorder CalTopo', exact: true }).boundingBox();
    const firstRow = await providerList.locator('[data-order-item="gaia"]').boundingBox();
    const touchSession = await context.newCDPSession(options);
    try {
        await touchSession.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        const touchX = touchGrip.x + touchGrip.width / 2;
        await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchGrip.y + touchGrip.height / 2 }] });
        await touchSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX, y: firstRow.y + firstRow.height / 2 - 8 }] });
        assert.equal(await providerList.getAttribute('data-reordering'), '');
        assert.equal(await providerList.evaluate(list => list.getAnimations({ subtree: true }).length), 0, 'reduced motion disables reorder animations');
        await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitForCondition(async () => (await source.locator('.bpb-map-handoff-button').evaluateAll(items => items.map(item => item.dataset.provider))).join() === 'caltopo,gaia,onx,alltrails', { description: 'touch grip reorder persisted to the open ascent' });
        assert.equal(await providerList.locator('input:checked').count(), 4, 'touch reordering never toggles a provider');
    } finally {
        await touchSession.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await touchSession.detach();
    }

    await worker.evaluate(() => chrome.storage.sync.set({ bpbSettings: {} }));
    await gaiaButton.waitFor();
    await options.close();
    await beta.close();


    await gaiaButton.click();
    await waitForCondition(async () => {
        const text = await source.locator('.bpb-map-handoff-control').innerText();
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
    assert.match(await source.locator('.bpb-map-handoff-status').innerText(), /Review the items and click Save/);
    assert.equal(await gaiaButton.isDisabled(), false);
    assert.equal((await gaiaButton.innerText()).trim(), 'Send to Gaia again');
    assert.equal(await onxButton.isDisabled(), false);

    await onxButton.click();
    await waitForCondition(async () => {
        const text = await source.locator('.bpb-map-handoff-control').innerText();
        return /Ready in onX/.test(text) ? text : null;
    }, { description: 'the saved ascent to report onX ready', timeoutMs: 35_000 }).catch(async error => {
        error.message += `\nSource: ${await source.locator('.bpb-map-handoff-control').innerText()}`;
        error.message += `\nTabs and injections: ${JSON.stringify(await worker.evaluate(async () => ({ tabs: await chrome.tabs.query({}), errors: globalThis.handoffInjectionErrors })))}`;
        for (const page of context.pages()) {
            if (page.url().startsWith('https://backcountry.onxmaps.com/')) {
                error.message += `\nonX: ${page.url()} ${await page.locator('body').innerText()}`;
            }
        }
        throw error;
    });
    const onx = await waitForCondition(async () => context.pages().find(
        page => page.url().startsWith('https://backcountry.onxmaps.com/'),
    ) || null, { description: 'the onX import tab' });
    const onxReceived = await onx.evaluate(() => ({
        text: window.received,
        name: window.receivedName,
        handoffs: window.handoffs,
        imports: window.imports,
    }));
    assert.deepEqual(onxReceived, { text: payload.gpx, name: payload.filename, handoffs: 1, imports: 0 });
    assert.match(await source.locator('.bpb-map-handoff-status').innerText(), /Review the file and click Import/);
    assert.equal(await onxButton.isDisabled(), false);
    assert.equal((await onxButton.innerText()).trim(), 'Send to onX again');

    const onxTabsBeforeRepeat = context.pages().filter(
        page => page.url().startsWith('https://backcountry.onxmaps.com/'),
    );
    await onxButton.click();
    const repeatedOnx = await waitForCondition(async () => {
        const tabs = context.pages().filter(page => page.url().startsWith('https://backcountry.onxmaps.com/'));
        const fresh = tabs.find(page => !onxTabsBeforeRepeat.includes(page));
        if (!fresh) return null;
        return await fresh.evaluate(() => window.handoffs === 1 ? true : null) ? fresh : null;
    }, { description: 'a fresh onX tab for explicit retry', timeoutMs: 35_000 });
    const repeatedOnxReceived = await repeatedOnx.evaluate(() => ({
        text: window.received,
        name: window.receivedName,
        imports: window.imports,
    }));
    assert.deepEqual(repeatedOnxReceived, { text: payload.gpx, name: payload.filename, imports: 0 });
    assert.equal(await onx.evaluate(() => window.imports), 0);
    // File receipt precedes the worker's tab focus and source-page response.
    // Do not begin another trusted click while that workflow is still ending.
    await waitForCondition(async () => await onxButton.isEnabled()
        && /Ready in onX/.test(await source.locator('.bpb-map-handoff-status').innerText()), {
        description: 'the repeated onX handoff to finish on the source page', timeoutMs: 35_000,
    });

    await alltrailsButton.click();
    await waitForCondition(async () => {
        const text = await source.locator('.bpb-map-handoff-control').innerText();
        return /Ready in AllTrails/.test(text) ? text : null;
    }, { description: 'the saved ascent to report AllTrails ready', timeoutMs: 35_000 }).catch(async error => {
        error.message += `\nSource: ${await source.locator('.bpb-map-handoff-control').innerText()}`;
        for (const page of context.pages()) {
            if (page.url().startsWith('https://www.alltrails.com/')) {
                error.message += `\nAllTrails: ${await page.locator('body').innerText()}`;
            }
        }
        throw error;
    });
    const alltrails = await waitForCondition(async () => context.pages().find(
        page => page.url().startsWith('https://www.alltrails.com/'),
    ) || null, { description: 'the AllTrails upload tab' });
    const alltrailsReceived = await alltrails.evaluate(() => ({
        text: window.received,
        name: window.receivedName,
        handoffs: window.handoffs,
        uploads: window.uploads,
    }));
    assert.deepEqual(alltrailsReceived, {
        text: payload.gpx, name: payload.filename, handoffs: 1, uploads: 0,
    });
    assert.match(await source.locator('.bpb-map-handoff-status').innerText(), /Review the route and click Upload/);
    assert.equal(await alltrailsButton.isDisabled(), false);
    assert.equal((await alltrailsButton.innerText()).trim(), 'Send to AllTrails again');
    assert.equal(await alltrails.evaluate(() => window.uploads), 0);

    await caltopoButton.click();
    await waitForCondition(async () => /Ready in CalTopo/.test(
        await source.locator('.bpb-map-handoff-status').innerText()) && await caltopoButton.isEnabled(), {
        description: 'the saved ascent to report CalTopo ready', timeoutMs: 35_000,
    });
    const caltopo = context.pages().find(page => page.url().startsWith('https://caltopo.com/map.html'));
    assert.ok(caltopo);
    assert.deepEqual(await caltopo.evaluate(() => ({
        text: window.received, name: window.receivedName, handoffs: window.handoffs, imports: window.imports,
    })), { text: payload.gpx, name: payload.filename, handoffs: 1, imports: 0 });
    await caltopo.locator('.yui-panel').filter({ hasText: 'Import Data' }).screenshot({
        path: path.join(evidenceDir, 'caltopo-review.png'),
    });
    await source.evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; });
    await source.locator('#gpxlinks').screenshot({ path: path.join(evidenceDir, 'ascent-buttons-ready-dark.png') });
    await source.setViewportSize({ width: 430, height: 760 });
    await source.locator('#gpxlinks').screenshot({ path: path.join(evidenceDir, 'ascent-buttons-ready-dark-narrow.png') });
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
    const onxAccess = await context.newPage();
    await onxAccess.goto(`chrome-extension://${extensionId}/onx/access.html`);
    await onxAccess.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'dark');
    await onxAccess.screenshot({ path: path.join(evidenceDir, 'onx-access-page-dark.png') });
    const alltrailsAccess = await context.newPage();
    await alltrailsAccess.goto(`chrome-extension://${extensionId}/alltrails/access.html`);
    await alltrailsAccess.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'dark');
    await alltrailsAccess.screenshot({ path: path.join(evidenceDir, 'alltrails-access-page-dark.png') });

    const caltopoAccess = await context.newPage();
    await caltopoAccess.goto(`chrome-extension://${extensionId}/caltopo/access.html`);
    await caltopoAccess.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'dark');
    await caltopoAccess.screenshot({ path: path.join(evidenceDir, 'caltopo-access-page-dark.png') });
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
    const onxAdapterCheck = async (mode, timeoutMs = 500) => {
        onxMode = mode;
        const page = await context.newPage();
        await page.goto('https://backcountry.onxmaps.com/backcountry/map/content/import');
        const outcome = await page.evaluate(prepareOnxImport, { ...payload, timeoutMs });
        return {
            page,
            outcome,
            state: await page.evaluate(() => ({ handoffs: window.handoffs, imports: window.imports })),
        };
    };
    const membership = await onxAdapterCheck('membership');
    assert.equal(membership.outcome.code, 'membership-required');
    assert.deepEqual(membership.state, { handoffs: 0, imports: 0 });
    const onxStalled = await onxAdapterCheck('stalled');
    assert.equal(onxStalled.outcome.code, 'handoff-unconfirmed');
    assert.deepEqual(onxStalled.state, { handoffs: 1, imports: 0 });
    const onxDuplicate = await onxStalled.page.evaluate(prepareOnxImport, payload);
    assert.equal(onxDuplicate.code, 'already-started');
    alltrailsMode = 'stalled';
    const stalledAlltrailsPage = await context.newPage();
    await stalledAlltrailsPage.goto('https://www.alltrails.com/explore/custom-routes/new');
    const stalledAlltrails = await stalledAlltrailsPage.evaluate(prepareAlltrailsImport,
        { ...payload, timeoutMs: 500 });
    assert.equal(stalledAlltrails.code, 'handoff-unconfirmed');
    assert.deepEqual(await stalledAlltrailsPage.evaluate(() => ({
        handoffs: window.handoffs, uploads: window.uploads,
    })), { handoffs: 1, uploads: 0 });
    const alltrailsDuplicate = await stalledAlltrailsPage.evaluate(prepareAlltrailsImport, payload);
    assert.equal(alltrailsDuplicate.code, 'existing-preview');

    caltopoMode = 'stalled';
    const stalledCaltopoPage = await context.newPage();
    await stalledCaltopoPage.goto('https://caltopo.com/map.html');
    const stalledCaltopo = await stalledCaltopoPage.evaluate(prepareCaltopoImport, { ...payload, timeoutMs: 500 });
    assert.equal(stalledCaltopo.code, 'handoff-unconfirmed');
    assert.deepEqual(await stalledCaltopoPage.evaluate(() => ({ handoffs: window.handoffs, imports: window.imports })),
        { handoffs: 1, imports: 0 });
    const report = {
        browser: context.browser().version(),
        viewport: { width: 1000, height: 760 },
        narrowViewport: { width: 430, height: 760 },
        mode: 'hidden masked HTTPS fixtures',
        renderer: 'static HTML; no WebGL',
        sourceReads,
        nativePermissionPrompt: 'not inspected; Gaia, onX, AllTrails, and CalTopo were granted only in the disposable manifest',
        checks: [
            'real unpacked dist',
            'ascent-page placement beside GPX download',
            'settings description width and viewport alignment at 1000, 760, and 430px in light and dark themes',
            'provider and beta grip controls: mouse drag, touch drag, keyboard, and reduced motion',
            'provider and beta order controls, live sync, all-off, settings file export/import',
            'trusted click and worker route',
            'exact saved GPX handoff',
            'manual Gaia Save preserved',
            'exact saved GPX handoff to onX',
            'manual onX Import preserved',
            'exact saved GPX handoff to AllTrails',
            'manual AllTrails Upload preserved',
            'exact saved GPX handoff to CalTopo',
            'manual CalTopo Import preserved',
            'onX membership gate',
            'signed-out gate',
            'explicit retry opens a fresh onX importer tab',
            'uncertain handoff requires an explicit retry',
            'no GPX in extension storage',
            'light and dark screenshots at standard and narrow widths',
        ],
    };
    await writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} catch (error) {
    failure = error;
}
await resources.dispose(failure);
