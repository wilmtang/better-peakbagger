// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 2) throw new Error('Usage: node scripts/verify-map-layer-control.mjs');
const resources = createResourceStack(), screenshots = process.env.BPB_LAYER_SCREENSHOT_DIR;
let primaryError, summary;
try {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-layer-control-'));
    resources.defer('layer control temporary files', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('layer control HTTPS fixture', () => fixture.close());
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(temporaryRoot, {
        channel: 'chromium', headless: true, args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('layer control browser', () => context.close());
    const bundle = await build({ stdin: { contents: `
        import {createMapLayerControl} from './src/maps/map-layer-control.js';
        import {settingsSchema as schema} from './src/settings/settings-schema.js';
        const state=schema.mapOverlayState({slope:{enabled:true,opacity:60}});
        const statuses={};
        const control=createMapLayerControl({document,
            onToggle:(id,enabled)=>{state[id].enabled=enabled;paint()},
            onOpacity:(id,opacity)=>{state[id].opacity=opacity;paint()},
            onRetry:id=>{statuses[id]={message:'Loaded'};paint()}});
        document.body.append(control.element);
        function paint(){control.render({state,statuses,basemaps:[{id:'topo',label:'Topographic map'},{id:'imagery',label:'Satellite imagery'}],basemap:'topo',theme:window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'});control.element.dataset.theme=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';control.position(document.querySelector('#map').getBoundingClientRect())}
        window.fixture={control,state,statuses,paint};paint();`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
    const css = await readFile(path.join(root, 'src/maps/map-layers.css'), 'utf8');
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/layer-control.aspx', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:16px;font:14px system-ui}#map{height:240px;margin-top:36px;background:#c4cdc3}</style><div id="map"></div><h2>Following native content</h2>' }));
    const cases = [];
    for (const width of [736, 320]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 800 }); await page.emulateMedia({ colorScheme: theme });
        await page.goto(`https://www.peakbagger.com:${fixture.port}/layer-control.aspx`);
        await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const trigger = page.getByRole('button', { name: /^Layers/ });
        assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        await trigger.click();
        const box = await page.locator('.bpb-layers-panel').boundingBox();
        assert.ok(box.width <= 233 && box.height <= 190, `compact overview ${JSON.stringify(box)}`);
        const geometry = () => page.evaluate(() => ['.bpb-layers-trigger', ...Array.from(document.querySelectorAll('.bpb-layers-row')).map(row => `[data-layer="${row.dataset.layer}"]`), '#map', 'h2'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
        const before = await geometry();
        const stable = async () => { const after = await geometry(); before.forEach((rect, i) => rect.forEach((value, j) => assert.ok(Math.abs(value - after[i][j]) <= 1, `stable control ${i}/${j}`))); };
        if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-overview.png`) }); }
        for (const id of ['sentinel', 'slope', 'land', 'snotel', 'slope']) {
            await page.locator(`[data-layer="${id}"] button`).click(); await stable();
            assert.equal(await page.locator('.bpb-layers-detail:not([hidden])').count(), 1);
        }
        const slider = page.getByRole('slider', { name: 'Slope angle opacity' });
        await slider.focus(); await slider.press('Home'); assert.equal(await slider.inputValue(), '0');
        await slider.press('End'); assert.equal(await slider.inputValue(), '100');
        for (const status of [{ pending: true, message: 'Loading slope…', retry: true }, { error: true, message: 'Slope is unavailable. Try again.', retry: true }, { message: 'Loaded' }]) {
            await page.evaluate(status => { window.fixture.statuses.slope = status; window.fixture.paint(); }, status); await stable();
        }
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-detail.png`) });
        await slider.press('Escape'); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        assert.equal(await page.evaluate(() => document.activeElement === window.fixture.control.trigger), true);
        assert.equal(await page.evaluate(() => window.fixture.state.slope.enabled), true);
        await trigger.click(); assert.equal(await page.locator('.bpb-layers-details').isVisible(), false);
        await page.mouse.click(width - 15, 320); assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false);
        cases.push({ width, theme, overview: { width: box.width, height: box.height }, anchored: true });
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    summary = { check: 'map layer control', browser: context.browser().version(), hidden: true, cases };
} catch (error) { primaryError = error; }
await resources.dispose(primaryError);
console.log(JSON.stringify({ ...summary, teardown: 'passed' }));
