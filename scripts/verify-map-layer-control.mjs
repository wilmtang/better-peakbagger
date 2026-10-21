// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--firefox')) throw new Error('Usage: node scripts/verify-map-layer-control.mjs [--firefox]');
const firefoxMode = args.includes('--firefox');
const resources = createResourceStack(), screenshots = process.env.BPB_LAYER_SCREENSHOT_DIR;
let primaryError, summary;
try {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-layer-control-'));
    resources.defer('layer control temporary files', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('layer control HTTPS fixture', () => fixture.close());
    if (!firefoxMode) assertChromeLaunchAllowed();
    const context = await (firefoxMode ? firefox : chromium).launchPersistentContext(temporaryRoot, firefoxMode ? {
        headless: true, ignoreHTTPSErrors: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' },
    } : {
        channel: 'chromium', headless: true, args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('layer control browser', () => context.close());
    const bundle = await build({ stdin: { contents: `
        import {createMapLayerControl} from './src/maps/map-layer-control.js';
        import {settingsSchema as schema} from './src/settings/settings-schema.js';
        import {publicLandInfo} from './src/maps/map-overlay-providers.js';
        const state=schema.mapOverlayState({slope:{enabled:true,opacity:60}});
        const statuses={sentinel:{capture:'latest',message:'Coverage 100% · Clouds 3%',captures:[
            {id:'latest',label:'Latest · 10-07 18:27 · ☁ 3%',title:'Latest · 2026-10-07 18:27 PDT · Clouds 3%'},
            {id:'older',label:'2026-10-06 18:27 · ☁ 100%',title:'2026-10-06 18:27 PDT · Clouds 100%'},
            {id:'unknown',label:'2026-10-05 18:27 · ☁ ?',title:'2026-10-05 18:27 PDT · Clouds unknown'}]},
            land:publicLandInfo(null)};
        const control=createMapLayerControl({document,
            onToggle:(id,enabled)=>{state[id].enabled=enabled;paint()},
            onOpacity:(id,opacity)=>{state[id].opacity=opacity;paint()},
            onCapture:value=>{const status=statuses.sentinel;status.capture=value;status.message='Coverage 100% · Clouds '+status.captures.find(choice=>choice.id===value).title.split(' · Clouds ')[1];paint()},
            onRetry:id=>{statuses[id]={message:'Loaded'};paint()}});
        document.body.append(control.element);
        function paint(){control.render({state,statuses,theme:window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'});control.element.dataset.theme=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';control.position(document.querySelector('#map').getBoundingClientRect())}
        window.fixture={control,state,statuses,paint,landInfo:publicLandInfo};paint();`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
    const css = await readFile(path.join(root, 'src/maps/map-layers.css'), 'utf8');
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/layer-control.aspx', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:16px;font:14px system-ui}#map{height:240px;margin-top:36px;background:#c4cdc3}</style><div id="map"></div><h2>Following native content</h2>' }));
    const cases = [];
    for (const width of [736, 320]) for (const theme of ['light', 'dark']) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 800 }); await page.emulateMedia({ colorScheme: theme });
        await page.goto(`https://www.peakbagger.com:${fixture.port}/layer-control.aspx`);
        await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.locator('.bpb-map-layers').evaluate((element, scale) => { element.style.fontSize = `${12 * scale}px`; }, scale);
        const trigger = page.getByRole('button', { name: /^Layers/ });
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        const collapsedTrigger = await trigger.boundingBox();
        const caret = trigger.locator('.bpb-layers-caret');
        assert.equal(await caret.isVisible(), true);
        assert.equal(await caret.evaluate(element => getComputedStyle(element).transform), 'none');
        await trigger.click();
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(await caret.evaluate(element => getComputedStyle(element).transform), 'matrix(-1, 0, 0, -1, 0, 0)');
        assert.deepEqual(await trigger.boundingBox(), collapsedTrigger, 'caret rotation does not move or resize the trigger');
        const box = await page.locator('.bpb-layers-panel').boundingBox();
        assert.ok(box.width <= 233 && box.height <= (scale === 1 ? 135 : 285), `compact overview ${JSON.stringify(box)}`);
        const mapBox = await page.locator('#map').boundingBox(), triggerBox = await trigger.boundingBox();
        assert.ok(Math.abs(triggerBox.x - mapBox.x - 10) <= 1 && Math.abs(box.x - triggerBox.x) <= 1, 'trigger and menu share the map left inset');
        assert.equal(await page.locator('.bpb-layers-panel [aria-label="Base map"]').count(), 0);
        const geometry = () => page.evaluate(() => ['.bpb-layers-trigger', ...Array.from(document.querySelectorAll('.bpb-layers-row')).map(row => `[data-layer="${row.dataset.layer}"]`), '#map', 'h2'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
        const before = await geometry();
        const stable = async () => { const after = await geometry(); before.forEach((rect, i) => rect.forEach((value, j) => assert.ok(Math.abs(value - after[i][j]) <= 1, `stable control ${i}/${j}`))); };
        if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-overview.png`) }); }
        for (const id of ['sentinel', 'slope', 'land', 'snotel', 'slope']) {
            await page.locator(`[data-layer="${id}"] button`).click(); await stable();
            assert.equal(await page.locator('.bpb-layers-detail:not([hidden])').count(), 1);
            if (id === 'land') {
                const guidance = page.getByRole('link', { name: 'BLM camping rules', exact: true });
                assert.equal(await guidance.isVisible(), true);
                await guidance.focus(); assert.equal(await guidance.evaluate(element => document.activeElement === element), true);
                assert.equal(await guidance.getAttribute('href'), 'https://www.blm.gov/programs/recreation/camping');
                assert.deepEqual(await page.locator('.bpb-layers-detail:not([hidden]) .bpb-layers-legend-item').allTextContents(), ['BLM', 'USFS', 'Other federal', 'State', 'Local', 'Tribal']);
                const detailBox = await page.locator('.bpb-layers-detail:not([hidden])').boundingBox();
                assert.ok(detailBox.x >= box.x && detailBox.x + detailBox.width <= box.x + box.width, 'land detail stays within compact width');
                if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-land.png`) });
                await page.evaluate(() => {
                    window.fixture.state.land.enabled = true;
                    window.fixture.statuses.land = { ...window.fixture.landInfo([-125, 53, -124, 54]), permission: true, retry: true, message: 'Allow BC parcel maps.' };
                    window.fixture.paint();
                });
                const allow = page.getByRole('button', { name: 'Allow BC land maps', exact: true });
                await allow.scrollIntoViewIfNeeded(); const allowBox = await allow.boundingBox();
                const scroll = await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop);
                await allow.focus();
                for (const status of [{ pending: true, message: 'Allow BC parcel maps.' }, { pending: false, error: true, message: 'BC access not granted.' }]) {
                    await page.evaluate(status => { Object.assign(window.fixture.statuses.land, status); window.fixture.paint(); }, status);
                    assert.deepEqual(await allow.boundingBox(), allowBox, 'permission pending/denial keep the action anchored');
                    assert.equal(await page.locator('.bpb-layers-panel').evaluate(element => element.scrollTop), scroll, 'permission feedback preserves menu reading position');
                    assert.equal(await allow.evaluate(element => document.activeElement === element), true);
                }
                assert.equal(await page.getByRole('link', { name: 'BC Crown land rules', exact: true }).isVisible(), true);
                if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-canada.png`) });
                await page.evaluate(() => { window.fixture.state.land.enabled = false; window.fixture.statuses.land = window.fixture.landInfo(null); window.fixture.paint(); });
                await page.locator('.bpb-layers-panel').evaluate(element => { element.scrollTop = 0; });
            }
        }
        const slider = page.getByRole('slider', { name: 'Slope angle opacity' });
        await slider.focus(); await slider.press('Home'); assert.equal(await slider.inputValue(), '0');
        await slider.press('End'); assert.equal(await slider.inputValue(), '100');
        for (const status of [{ pending: true, message: 'Loading slope…', retry: true }, { error: true, message: 'Slope is unavailable. Try again.', retry: true }, { message: 'Loaded' }]) {
            await page.evaluate(status => { window.fixture.statuses.slope = status; window.fixture.paint(); }, status); await stable();
        }
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-detail.png`) });
        await slider.press('Escape'); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true);
        assert.equal(await slider.evaluate(element => document.activeElement === element), true, 'Escape keeps focus with the current control');
        assert.equal(await page.evaluate(() => window.fixture.state.slope.enabled), true);
        await page.mouse.click(width - 15, 320); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true);
        await page.locator('#map').click({ position: { x: mapBox.width - 10, y: 10 } });
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true); await stable();
        await trigger.click(); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        assert.equal(await caret.evaluate(element => getComputedStyle(element).transform), 'none');
        assert.deepEqual(await trigger.boundingBox(), collapsedTrigger, 'collapse leaves the trigger anchored');
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-collapsed.png`) });
        await trigger.press('Enter'); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true);
        assert.equal(await page.locator('.bpb-layers-details').isVisible(), false, 'reopen starts with the compact overview');
        await trigger.press('Space'); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        await trigger.click(); await page.locator('[data-layer="sentinel"] input').check();
        await page.locator('[data-layer="sentinel"] button').click();
        const capture = page.getByRole('combobox', { name: 'Sentinel-2 capture' });
        for (const id of ['latest', 'older', 'unknown']) {
            await capture.selectOption(id);
            const metadata = await capture.evaluate(element => ({ title: element.title, label: element.selectedOptions[0].textContent,
                accessible: element.selectedOptions[0].getAttribute('aria-label') }));
            assert.match(metadata.label, /☁ (?:3%|100%|\?)/); assert.match(metadata.title, /2026-10-0[567] 18:27 PDT · Clouds (?:3%|100%|unknown)$/);
            assert.equal(metadata.title, metadata.accessible); await stable();
        }
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scale}x-sentinel.png`) });
        cases.push({ width, theme, textScale: scale, overview: { width: box.width, height: box.height }, anchored: true });
    }
    const setupAssets = new Set(['bc-land/access.html', 'bc-land/access-head.js', 'bc-land/access.js', 'css/panel.css', 'css/gaia-access.css', 'css/bc-land-access.css', 'icons/icon-48.png']);
    await page.route(`https://www.peakbagger.com:${fixture.port}/dist/**`, async route => {
        const relative = new URL(route.request().url()).pathname.slice('/dist/'.length);
        assert.ok(setupAssets.has(relative), `unexpected setup asset ${relative}`);
        const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(relative)];
        return route.fulfill({ contentType, body: await readFile(path.join(root, 'dist', relative)) });
    });
    await page.addInitScript(() => {
        if (!window.location.pathname.endsWith('/bc-land/access.html')) return;
        window.__bcSetup = { requests: 0, notified: 0 };
        window.chrome = { runtime: {}, storage: { sync: { get: async () => ({ bpbSettings: { theme: 'system' } }) }, onChanged: { addListener() {}, removeListener() {} } },
            permissions: { request: () => { window.__bcSetup.requests++; return new Promise(resolve => { window.__bcSetup.finish = resolve; }); } },
            tabs: { sendMessage: async () => { window.__bcSetup.notified++; } } };
        window.close = () => { window.__bcSetup.closed = true; };
    });
    for (const entry of cases) {
        await page.setViewportSize({ width: entry.width, height: 800 }); await page.emulateMedia({ colorScheme: entry.theme });
        await page.goto(`https://www.peakbagger.com:${fixture.port}/dist/bc-land/access.html?tab=7`);
        const allow = page.getByRole('button', { name: 'Allow access', exact: true }); await allow.waitFor();
        await page.evaluate(scale => { document.querySelectorAll('h1,p,button').forEach(element => { element.style.fontSize = `${parseFloat(getComputedStyle(element).fontSize) * scale}px`; }); }, entry.textScale);
        const geometry = () => page.evaluate(() => ['h1', '.access-card', 'button'].map(selector => { const box = document.querySelector(selector).getBoundingClientRect(); return [box.x,box.y,box.width,box.height]; }));
        // Establish the user's focus/reading position before measuring async
        // feedback; keyboard focus can reveal a partly offscreen action.
        await allow.scrollIntoViewIfNeeded(); await allow.focus();
        const before = await geometry(), scroll = await page.evaluate(() => window.scrollY);
        const stable = async () => { assert.deepEqual(await geometry(), before, 'setup heading, card and action stay anchored through permission decisions'); assert.equal(await page.evaluate(() => window.scrollY), scroll); };
        await allow.press('Enter'); await page.waitForFunction(() => window.__bcSetup.requests === 1);
        await allow.press('Enter'); assert.equal(await page.evaluate(() => window.__bcSetup.requests), 1); await stable();
        assert.equal(await allow.evaluate(element => document.activeElement === element), true);
        await page.evaluate(() => window.__bcSetup.finish(false)); await page.getByText('Access not granted. Try again.', { exact: true }).waitFor(); await stable();
        await allow.press('Space'); await page.waitForFunction(() => window.__bcSetup.requests === 2);
        await page.evaluate(() => window.__bcSetup.finish(true));
        const back = page.getByRole('button', { name: 'Return to map', exact: true }); await back.waitFor(); await stable();
        assert.equal(await back.evaluate(element => document.activeElement === element), true);
        assert.equal(await page.evaluate(() => window.__bcSetup.notified), 1);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${entry.width}-${entry.theme}-${entry.textScale}x-bc-setup.png`), fullPage: true });
        await back.click(); assert.equal(await page.evaluate(() => window.__bcSetup.closed), true);
        entry.setupAnchored = true;
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(cases.length, 8, 'all component selections executed');
    summary = { check: 'map layer control', browser: firefoxMode ? 'firefox' : 'chromium', version: context.browser().version(), hidden: true, cases };
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({ ...summary, teardown: 'passed' }));
