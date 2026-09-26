// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden packaged-editor checks. Synthetic pixels stay on the extension page;
// no live site, user browser, API key, or upload is involved.
/* global document, DataTransfer, chrome, innerWidth */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const screenshots = process.env.BPB_PHOTO_SCREENSHOTS;
const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-photo-verification-'));
let context;
try {
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true,
        viewport: { width: 1440, height: 1100 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const page = await context.newPage();
    const errors = [];
    context.on('page', opened => opened.on('pageerror', error => errors.push(String(error))));
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('chrome://extensions-internals/');
    const id = await page.waitForFunction(() => {
        try {
            return JSON.parse(document.body.innerText).find(record =>
                record.name === 'Better Peakbagger' && record.location === 'COMMAND_LINE')?.id;
        } catch { return false; }
    }).then(handle => handle.jsonValue());
    const url = `chrome-extension://${id}/photos/photos.html`;
    await page.goto(url);
    await page.waitForFunction(() => !document.getElementById('library-empty').hidden);
    await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1600; canvas.height = 1200;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 1200);
        gradient.addColorStop(0, '#819bb5'); gradient.addColorStop(1, '#263c32');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1600, 1200);
        ctx.fillStyle = '#4c5555'; ctx.beginPath();
        ctx.moveTo(0, 1100); ctx.lineTo(760, 150); ctx.lineTo(1600, 1000); ctx.fill();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], 'mountain.png', { type: 'image/png' }));
        const input = document.getElementById('photo-file');
        input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#editor-workspace').waitFor({ state: 'visible' });
    const capture = async name => {
        if (!screenshots) return;
        await mkdir(screenshots, { recursive: true });
        await page.locator('#editor-workspace').screenshot({ path: path.join(screenshots, `${name}.png`) });
    };
    const geometry = () => page.evaluate(() => Object.fromEntries([
        '.tool-rail', '.view-controls', '.editor-sidebar', '.editor-footer', '#photo-viewport',
    ].map(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    })));
    const stroke = async (start, end) => {
        await page.mouse.move(...start); await page.mouse.down();
        await page.mouse.move(...end, { steps: 20 }); await page.mouse.up();
    };
    await page.locator('[data-tool="route"]').click();
    await page.locator('#route-arrow').check(); await page.locator('#route-smooth').check();
    await page.locator('[data-tool="drawing"]').click();
    assert.equal(await page.locator('#route-arrow').isChecked(), false, 'Draw owns its own preferences');
    let overlay = await page.locator('#photo-overlay').boundingBox();
    await stroke([overlay.x + 120, overlay.y + 100], [overlay.x + 220, overlay.y + 240]);
    const strokes = page.locator('#annotation-list button').filter({ hasText: 'Freehand stroke' });
    assert.equal(await strokes.count(), 1);
    await page.locator('#undo').click(); assert.equal(await strokes.count(), 0);
    await page.locator('#redo').click(); assert.equal(await strokes.count(), 1);
    await capture('fit');
    const before = await geometry();
    await page.locator('#photo-zoom').selectOption('2');
    assert.deepEqual(await geometry(), before, 'zoom must not move any controls');
    assert.equal((await page.locator('#photo-stage').boundingBox()).width, 3200);
    await page.locator('#pan-photo').click();
    const viewport = await page.locator('#photo-viewport').boundingBox();
    const startX = (await page.locator('#photo-stage').boundingBox()).x;
    await stroke([viewport.x + 300, viewport.y + 250], [viewport.x + 380, viewport.y + 290]);
    assert.equal((await page.locator('#photo-stage').boundingBox()).x - startX, 80);
    assert.equal(await strokes.count(), 1, 'Hand cannot create annotations');
    await page.locator('[data-tool="drawing"]').click();
    overlay = await page.locator('#photo-overlay').boundingBox();
    const start = [viewport.x + 100, viewport.y + 100];
    await stroke(start, [start[0] + 100, start[1] + 80]);
    assert.equal(await strokes.count(), 2);
    const pathData = await page.locator('#photo-overlay g.selected path').first().getAttribute('d');
    const numbers = pathData.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.ok(Math.abs(numbers[0] - (start[0] - overlay.x) / 2) < 0.01);
    assert.ok(Math.abs(numbers[1] - (start[1] - overlay.y) / 2) < 0.01);
    await capture('zoom');
    await page.locator('.viewport-size-control summary').click();
    await page.locator('#viewport-height').fill('480'); await page.locator('#viewport-height').press('Tab');
    await page.locator('#viewport-width').fill('620'); await page.locator('#viewport-width').press('Tab');
    await page.waitForFunction(() => {
        const view = document.getElementById('photo-viewport');
        return view.clientHeight === 480 && view.clientWidth === 620;
    });
    await page.locator('.viewport-size-control summary').click();
    await page.locator('#fit-photo').click();
    await capture('resized');
    await page.locator('.viewport-size-control summary').click();
    await page.locator('#viewport-width').fill('280'); await page.locator('#viewport-width').press('Tab');
    await page.waitForFunction(() => document.getElementById('photo-viewport').clientWidth === 280);
    await capture('minimum-width');
    assert.equal(await page.locator('.editor-footer').evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.locator('.view-controls').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.locator('.viewport-size-control summary').click();
    // Confirm the accepted preference write before testing a separate page.
    await page.waitForFunction(async () => (await chrome.storage.local.get('bpbPhotoViewport'))
        .bpbPhotoViewport?.width === 280);
    const reopened = await context.newPage();
    await reopened.goto(url);
    await reopened.waitForFunction(() => document.getElementById('viewport-width').value === '280');
    const preferences = await reopened.evaluate(async () => chrome.storage.local.get('bpbPhotoTool:route'));
    assert.equal(preferences['bpbPhotoTool:route'].style.end, 'arrow');
    assert.equal(preferences['bpbPhotoTool:route'].style.smooth, true);
    await reopened.close();
    await page.locator('.viewport-size-control summary').click();
    await page.locator('#reset-viewport').click();
    await page.locator('.viewport-size-control summary').click();
    for (const [width, height] of [[720, 900], [390, 844], [320, 800]]) {
        await page.setViewportSize({ width, height });
        await capture(`width-${width}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.locator('.view-controls').evaluate(el => el.scrollWidth > el.clientWidth), false);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; });
    await capture('dark');
    const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const extension = gl?.getExtension('WEBGL_debug_renderer_info');
        return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable';
    });
    assert.notEqual(renderer, 'unavailable');
    assert.doesNotMatch(renderer, /swiftshader|llvmpipe|software/i);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: context.browser().version(), renderer, hidden: true,
        viewports: ['1440×1100', '720×900', '390×844', '320×800'], profile, passed: true }));
} finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
}
