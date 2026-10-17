// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden packaged-editor checks. Synthetic pixels stay on the extension page;
// no live site, user browser, API key, or upload is involved.
/* global document, DataTransfer, chrome, innerWidth, innerHeight, scrollX, scrollY, getComputedStyle, HTMLCanvasElement, FileReader, navigator, indexedDB */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const screenshots = process.env.BPB_PHOTO_SCREENSHOTS;
const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-photo-verification-'));
let context;
try {
    assertChromeLaunchAllowed();
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
    assert.equal(await page.locator('#text-width').inputValue(), '', 'new labels start at Auto width');
    assert.equal(await page.locator('#object-text').evaluate(input => document.activeElement === input), true);
    await page.locator('#undo').click();
    overlay = await page.locator('#photo-overlay').boundingBox();
    await page.mouse.click(overlay.x + 100, overlay.y + 100);
    assert.equal(await page.locator('#object-text').evaluate(input => document.activeElement === input
        && input.selectionStart === 0 && input.selectionEnd === input.value.length), true,
    'pointer placement keeps the placeholder selected in the text field');
    const labelText = 'North ridge traverse\nKeep left above the gully';
    await page.keyboard.type('North ridge traverse');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Keep left above the gully');
    assert.equal(await page.locator('#object-text').inputValue(), labelText);
    assert.equal(await page.locator('[data-tool][aria-pressed="true"]').getAttribute('data-tool'), 'text');
    await capture('text-auto-focused');
    // Exercise actual browser copy/paste commands. Preserve the clipboard's
    // supported formats for the duration of this synthetic-data check.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async () => { globalThis.photoClipboardBackup = await navigator.clipboard.read(); });
    await context.clearPermissions();
    try {
        await page.locator('[data-tool="select"]').click();
        await page.locator('#photo-overlay g.selected [data-bpb-hit-target]').click();
        const countBeforePaste = await page.locator('#annotation-list button').count();
        const clipboardModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${clipboardModifier}+c`);
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.waitForFunction(async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (JSON.parse(text).kind !== 'better-peakbagger-annotation') return false;
                globalThis.photoClipboardWritten = text;
                return true;
            }
            catch { return false; }
        });
        await context.clearPermissions();
        await page.keyboard.press(`${clipboardModifier}+v`);
        await page.waitForFunction(count => document.querySelectorAll('#annotation-list button').length === count + 1,
            countBeforePaste);
        assert.equal(await page.locator('#object-text').inputValue(), labelText);
        assert.equal(await page.locator('#text-width').inputValue(), '');
        assert.equal(await page.locator('#photo-viewport').evaluate(view => document.activeElement === view), true);
        await capture('text-pasted');
        await page.locator('#undo').click();
        assert.equal(await page.locator('#annotation-list button').count(), countBeforePaste);
        await page.locator('#redo').click();
        assert.equal(await page.locator('#annotation-list button').count(), countBeforePaste + 1);
        await page.locator('#undo').click();
        await page.locator('#annotation-list button').filter({ hasText: 'Text: North ridge' }).click();
    } finally {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.evaluate(async () => {
            // Do not overwrite a clipboard change from the user's own work.
            if (globalThis.photoClipboardWritten === await navigator.clipboard.readText()) {
                if (globalThis.photoClipboardBackup.length) await navigator.clipboard.write(globalThis.photoClipboardBackup);
                else await navigator.clipboard.writeText('');
            }
            delete globalThis.photoClipboardBackup;
            delete globalThis.photoClipboardWritten;
        });
        await context.clearPermissions();
    }
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
    // Native typing, rather than fill(), must keep the label and its field
    // visible together above the sticky header. Crossing 900px also exercises
    // moving the focused field out of the contextual dock.
    for (const theme of ['light', 'dark']) {
        await page.evaluate(async value => {
            const { bpbSettings } = await chrome.storage.sync.get('bpbSettings');
            await chrome.storage.sync.set({ bpbSettings: { ...bpbSettings, theme: value } });
        }, theme);
        await page.waitForFunction(value => document.documentElement.dataset.bpbTheme === value, theme);
        for (const [width, height] of [[390, 760], [520, 800], [1000, 760]]) {
            await page.setViewportSize({ width, height });
            await page.locator('[data-tool="text"]').focus();
            await page.keyboard.press('Enter');
            await page.locator('#add-at-center').focus();
            await page.keyboard.press('Enter');
            // Select Auto on the first new label, preserving the earlier
            // wrapped label and its saved width for the round-trip check.
            if (theme === 'light' && width === 390) {
                await page.locator('#text-width-auto').click();
                await page.locator('#object-text').focus();
                await page.locator('#photo-text-editor').evaluate(dock => dock.scrollIntoView({ block: 'end' }));
            }
            await page.keyboard.type(`Ridge ${theme} ${width}`);
            await page.keyboard.press('Enter');
            await page.keyboard.type('Upper gully');
            const state = await page.waitForFunction(() => {
                const header = document.querySelector('.app-header').getBoundingClientRect();
                const input = document.getElementById('object-text');
                const label = document.querySelector('#photo-overlay .selected text');
                const dock = document.getElementById('photo-text-editor');
                if (!label?.textContent.includes('Upper gully')) return false;
                const visible = element => {
                    const rect = element.getBoundingClientRect();
                    // scrollTop rounds to CSS pixels at viewport and ancestor edges.
                    if (!(rect.width > 0 && rect.height > 0 && rect.top >= header.bottom
                        && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth)) return false;
                    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                        const style = getComputedStyle(parent);
                        const bounds = parent.getBoundingClientRect();
                        if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)
                            && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) return false;
                    }
                    return true;
                };
                if (!visible(input) || !visible(label)) return false;
                return {
                    focused: document.activeElement === input,
                    docked: !dock.hidden,
                    dockHidden: !dock.hidden || getComputedStyle(dock).display === 'none',
                    value: input.value,
                    width: document.getElementById('text-width').value,
                    tool: document.querySelector('[data-tool][aria-pressed="true"]').dataset.tool,
                };
            }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(async error => {
                console.error(JSON.stringify(await page.evaluate(() => ({
                    width: innerWidth, scrollY,
                    nodes: [document.getElementById('object-text'), document.querySelector('#photo-overlay .selected text')].map(element => {
                        const clips = [];
                        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                            if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowY)) {
                                clips.push({ name: parent.id || parent.className,
                                    rect: parent.getBoundingClientRect().toJSON(), scroll: parent.scrollTop });
                            }
                        }
                        return { rect: element.getBoundingClientRect().toJSON(), clips };
                    }),
                })), null, 2));
                throw error;
            });
            assert.deepEqual(state, { focused: true, docked: width <= 900, dockHidden: true,
                value: `Ridge ${theme} ${width}\nUpper gully`, width: '', tool: 'text' });
            if (screenshots) await page.screenshot({ path: path.join(screenshots, `label-${theme}-${width}.png`) });
        }
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    // A real IndexedDB round trip also verifies original Blob retention, which
    // the jsdom/fake-indexeddb file-picking harness cannot faithfully clone.
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Saved on this device');
    const savedEditor = await context.newPage();
    await savedEditor.goto(`${url}?mode=library`);
    await savedEditor.getByRole('button', { name: 'Edit', exact: true }).click();
    await savedEditor.locator('#editor-workspace').waitFor({ state: 'visible' });
    await savedEditor.locator('#show-library').click();
    await savedEditor.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1);
    if (screenshots) {
        for (const theme of ['light', 'dark']) {
            await savedEditor.locator('html').evaluate((html, value) => { html.dataset.bpbTheme = value; }, theme);
            for (const width of [1440, 520]) {
                await savedEditor.setViewportSize({ width, height: 900 });
                await savedEditor.locator('#library-view').screenshot({
                    path: path.join(screenshots, `latest-library-${theme}-${width}.png`),
                });
            }
        }
        await savedEditor.setViewportSize({ width: 1440, height: 1100 });
    }
    await savedEditor.getByRole('button', { name: 'Edit', exact: true }).click();
    await savedEditor.locator('#editor-workspace').waitFor({ state: 'visible' });
    assert.equal(await savedEditor.locator('#photo-title').inputValue(), 'mountain');
    const savedCount = await savedEditor.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('betterPeakbaggerPhotos');
        open.onsuccess = () => {
            const database = open.result;
            const count = database.transaction('photos').objectStore('photos').count();
            count.onsuccess = () => { database.close(); resolve(count.result); };
            count.onerror = () => { database.close(); reject(count.error); };
        };
        open.onerror = () => reject(open.error);
    }));
    assert.equal(savedCount, 1, 'reopening a draft retains one saved version');
    await savedEditor.locator('#annotation-list button').filter({ hasText: 'Text: North ridge' }).click();
    assert.equal(await savedEditor.locator('#text-width').inputValue(), '300');
    assert.equal(await savedEditor.locator('#object-text').inputValue(), labelText);
    assert.ok(await savedEditor.locator('#photo-overlay g.selected text tspan').count() >= 4);
    await savedEditor.locator('#text-width').fill('275');
    await savedEditor.locator('#text-width').press('Tab');
    await savedEditor.locator('#object-color').selectOption('#1e88e5');
    await savedEditor.locator('#object-opacity').fill('45');
    await savedEditor.locator('[data-tool="route"]').click();
    assert.equal(await savedEditor.locator('#object-color').inputValue(), '#1e88e5');
    assert.equal(await savedEditor.locator('#object-opacity').inputValue(), '45');
    await savedEditor.locator('[data-tool="text"]').click();
    await savedEditor.locator('#add-at-center').click();
    assert.equal(await savedEditor.locator('#text-width').inputValue(), '275');
    await savedEditor.locator('#text-width-auto').click();
    await savedEditor.locator('#add-at-center').click();
    assert.equal(await savedEditor.locator('#text-width').inputValue(), '');
    await savedEditor.locator('[data-tool="route"]').click();
    const routeBox = await savedEditor.locator('#photo-overlay').boundingBox();
    const markCount = await savedEditor.locator('#annotation-list button').count();
    for (const offset of [100, 180, 260]) {
        await savedEditor.mouse.click(routeBox.x + offset, routeBox.y + offset);
    }
    const routePath = () => savedEditor.locator('#photo-overlay g.selected path').first().getAttribute('d');
    const fullRoute = await routePath();
    await savedEditor.keyboard.press('Control+z');
    assert.notEqual(await routePath(), fullRoute);
    assert.equal(await savedEditor.locator('#annotation-list button').count(), markCount + 1);
    await savedEditor.keyboard.press('Meta+z');
    assert.equal(await savedEditor.locator('#annotation-list button').count(), markCount);
    assert.equal(await savedEditor.locator('.route-preview-dot').count(), 1);
    await savedEditor.keyboard.press('Control+Shift+z');
    await savedEditor.keyboard.press('Meta+Shift+z');
    assert.equal(await routePath(), fullRoute);
    if (screenshots) await savedEditor.locator('#editor-workspace').screenshot({
        path: path.join(screenshots, 'route-point-redo.png'),
    });
    await savedEditor.keyboard.press('Enter');
    await savedEditor.keyboard.press('Control+z');
    assert.equal(await savedEditor.locator('#annotation-list button').count(), markCount);
    await savedEditor.close();
    // Circular symbols have no orientation, including when an existing mark
    // is selected while a different tool is armed. Check actual CSS hiding,
    // keyboard access, and stable geometry through repeated style changes.
    for (const theme of ['light', 'dark']) {
        await page.evaluate(async value => {
            const { bpbSettings } = await chrome.storage.sync.get('bpbSettings');
            await chrome.storage.sync.set({ bpbSettings: { ...bpbSettings, theme: value } });
        }, theme);
        await page.waitForFunction(value => document.documentElement.dataset.bpbTheme === value, theme);
        for (const [width, height, zoom] of [[1440, 1100, 1], [720, 900, 1.25]]) {
            await page.setViewportSize({ width, height });
            await page.locator('body').evaluate((body, value) => { body.style.zoom = value; }, String(zoom));
            for (const type of ['anchor', 'belay', 'bolt', 'piton', 'rappel', 'pitch', 'text']) {
                const hidden = type === 'anchor' || type === 'belay';
                const tool = page.locator(`[data-tool="${type}"]`);
                await tool.focus(); await tool.press('Enter');
                assert.equal(await page.locator('#object-rotation').isHidden(), hidden, `${type} preset`);
                await page.locator('#add-at-center').click();
                const id = await page.locator('#annotation-list button').last().getAttribute('data-object-id');
                await page.locator(`[data-tool="${hidden ? 'piton' : 'belay'}"]`).click();
                await page.locator(`#annotation-list [data-object-id="${id}"]`).click();
                assert.equal(await page.locator('#object-rotation').isHidden(), hidden, `${type} selection`);
                assert.equal(await page.locator('#object-scale').isVisible(), true);
                if (hidden) {
                    assert.equal(await page.getByRole('slider', { name: /Rotation/ }).count(), 0);
                    assert.equal(await page.locator('#object-rotation').evaluate(input => {
                        input.focus(); return document.activeElement === input;
                    }), false, 'hidden rotation cannot receive focus');
                    const opacity = page.locator('#object-opacity');
                    await opacity.focus();
                    const stableGeometry = async () => ({ ...await geometry(),
                        actions: await page.locator('#object-actions').boundingBox(),
                        heading: await page.locator('#inspector-heading').boundingBox(),
                        scroll: await page.evaluate(() => ({ x: scrollX, y: scrollY,
                            sidebar: document.querySelector('.editor-sidebar').scrollTop })),
                    });
                    const beforeStyle = await stableGeometry();
                    for (let tick = 0; tick < 3; tick++) await opacity.press('ArrowLeft');
                    assert.deepEqual(await stableGeometry(), beforeStyle, `${type} restyling stays anchored`);
                    await capture(`rotation-${type}-${theme}-${width}`);
                }
                await page.locator('#delete-object').click();
            }
        }
    }
    await page.locator('body').evaluate(body => { body.style.zoom = ''; });
    await page.setViewportSize({ width: 1440, height: 1100 });
    const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const extension = gl?.getExtension('WEBGL_debug_renderer_info');
        return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable';
    });
    assert.notEqual(renderer, 'unavailable');
    assert.doesNotMatch(renderer, /swiftshader|llvmpipe|software/i);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: context.browser().version(), renderer, hidden: true,
        viewports: ['1440×1100', '720×900', '390×844', '320×800', '390×760', '520×800', '1000×760'], profile, passed: true }));
} finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
}
