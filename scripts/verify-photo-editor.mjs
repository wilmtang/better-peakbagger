// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden packaged-editor checks. Synthetic pixels stay on the extension page;
// no live site, user browser, API key, or upload is involved.
/* global document, DataTransfer, chrome, innerWidth, HTMLCanvasElement, FileReader */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    // Capture the real full-resolution encoding used by the upload estimate.
    // This exercises SVG decoding and canvas flattening without any upload.
    await page.evaluate(() => {
        const encode = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
            return encode.call(this, blob => {
                if (this.width === 1600 && this.height === 1200) globalThis.photoVerificationExport = blob;
                callback(blob);
            }, ...args);
        };
    });
    await page.locator('[data-tool="text"]').click();
    await page.locator('#add-at-center').click();
    const labelText = 'North ridge traverse\nKeep left above the gully';
    await page.locator('#object-text').fill(labelText);
    await page.locator('#object-color').selectOption('#ffffff');
    await page.locator('#label-background').check();
    await page.locator('#text-width').fill('300');
    await page.locator('#text-width').press('Tab');
    await page.locator('#annotation-list button').filter({ hasText: 'Text: North ridge' }).click();
    const spans = page.locator('#photo-overlay g.selected text tspan');
    assert.ok(await spans.count() >= 4);
    assert.equal(await page.locator('#object-text').inputValue(), labelText);
    await capture('text-wrapped');
    const labelBefore = await page.locator('#photo-overlay g.selected').getAttribute('transform');
    const fontBefore = await page.locator('#photo-overlay g.selected text').getAttribute('font-size');
    const handle = await page.locator('[data-text-resize="right"]').boundingBox();
    const center = [handle.x + handle.width / 2, handle.y + handle.height / 2];
    await stroke(center, [center[0] - 40, center[1]]);
    assert.ok(Number(await page.locator('#text-width').inputValue()) < 300);
    assert.equal(await page.locator('#photo-overlay g.selected text').getAttribute('font-size'), fontBefore);
    assert.equal(await page.locator('#photo-overlay g.selected').getAttribute('transform'), labelBefore);
    await capture('text-narrower');
    await page.locator('#undo').click();
    assert.equal(await page.locator('#text-width').inputValue(), '300');
    // Escape keeps selection, width, and the available redo gesture intact.
    await page.mouse.move(...center); await page.mouse.down();
    await page.mouse.move(center[0] + 30, center[1]);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await page.locator('#text-width').inputValue(), '300');
    assert.equal(await page.locator('#redo').isEnabled(), true);
    await page.locator('#text-width-auto').click();
    assert.equal(await spans.count(), 2, 'Auto still respects manual line breaks');
    await page.locator('#undo').click();
    assert.equal(await page.locator('#text-width').inputValue(), '300');
    await page.locator('#object-rotation').evaluate(input => {
        input.value = '35'; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const rotated = await page.locator('[data-text-resize="right"]').boundingBox();
    const rotatedCenter = [rotated.x + rotated.width / 2, rotated.y + rotated.height / 2];
    await stroke(rotatedCenter, [rotatedCenter[0] + 25 * Math.cos(35 * Math.PI / 180),
        rotatedCenter[1] + 25 * Math.sin(35 * Math.PI / 180)]);
    assert.ok(Number(await page.locator('#text-width').inputValue()) > 300);
    await capture('text-rotated');
    await page.locator('#undo').click();
    await page.locator('#undo').click();
    // Wait for the user-visible estimate after the final undo, not a stale blob.
    await page.waitForFunction(() => document.getElementById('upload-estimate').textContent.startsWith('Estimated upload')
        && globalThis.photoVerificationExport);
    if (screenshots) {
        const base64 = await page.evaluate(async () => {
            const reader = new FileReader();
            return new Promise(resolve => {
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(globalThis.photoVerificationExport);
            });
        });
        await writeFile(path.join(screenshots, 'text-export.png'), Buffer.from(base64, 'base64'));
    }
    for (const [width, height] of [[720, 900], [390, 844], [320, 800]]) {
        await page.setViewportSize({ width, height });
        await capture(`width-${width}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.locator('.view-controls').evaluate(el => el.scrollWidth > el.clientWidth), false);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => { document.documentElement.dataset.bpbTheme = 'dark'; });
    await capture('dark');
    // A real IndexedDB round trip also verifies original Blob retention, which
    // the jsdom/fake-indexeddb file-picking harness cannot faithfully clone.
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Saved on this device');
    const savedEditor = await context.newPage();
    await savedEditor.goto(`${url}?mode=library`);
    await savedEditor.getByRole('button', { name: 'Edit as new version', exact: true }).click();
    await savedEditor.locator('#editor-workspace').waitFor({ state: 'visible' });
    await savedEditor.locator('#annotation-list button').filter({ hasText: 'Text: North ridge' }).click();
    assert.equal(await savedEditor.locator('#text-width').inputValue(), '300');
    assert.equal(await savedEditor.locator('#object-text').inputValue(), labelText);
    assert.ok(await savedEditor.locator('#photo-overlay g.selected text tspan').count() >= 4);
    await savedEditor.close();
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
