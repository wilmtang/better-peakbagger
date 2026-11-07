// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hidden packaged check that Photo Topos gets a topo out with no ImgBB key and
// no network: Copy writes the flattened PNG to the clipboard, Export downloads
// it, Upload asks for a key in a modal the editor cannot hear, and the finish
// actions stay put and in view. Synthetic pixels only; no live site or upload.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/* eslint-disable @typescript-eslint/no-shadow -- page-world callbacks take the outer value as their argument. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

// Report service-worker traffic too, so "no network" covers the worker.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const screenshots = process.env.BPB_PHOTO_OUTPUT_SCREENSHOTS;
const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-photo-output-'));
const downloads = await mkdtemp(path.join(os.tmpdir(), 'bpb-photo-output-downloads-'));

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, selector: string): Promise<Box> => {
    const value = await page.locator(selector).boundingBox();
    assert.ok(value, `${selector} has no box`);
    return value;
};
const same = (a: Box, b: Box, label: string) => {
    for (const key of ['x', 'y', 'width', 'height'] as const) {
        assert.ok(Math.abs(a[key] - b[key]) <= 0.5, `${label} moved: ${key} ${a[key]} → ${b[key]}`);
    }
};

// PNG: IHDR dimensions, and no eXIf/tEXt/iTXt chunk that could carry metadata.
const pngInfo = (bytes: Buffer) => {
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
    const chunks: string[] = [];
    for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        chunks.push(bytes.subarray(offset + 4, offset + 8).toString('latin1'));
        offset += 12 + length;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), chunks };
};
// JPEG: no APP1 (Exif/XMP) segment.
const jpegHasApp1 = (bytes: Buffer) => {
    assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8', 'not a JPEG');
    for (let offset = 2; offset + 4 <= bytes.length;) {
        if (bytes[offset] !== 0xff) return false;
        const marker = bytes[offset + 1];
        if (marker === 0xda) return false;
        if (marker === 0xe1) return true;
        offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return false;
};

let context: BrowserContext | undefined;
const external: string[] = [];
try {
    assertChromeLaunchAllowed();
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: downloads,
        viewport: { width: 1440, height: 790 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    // Origin-scoped grants are refused for extension origins; the context-wide
    // grant is what reaches the packaged page.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    context.on('request', request => {
        const url = request.url();
        if (!/^(chrome-extension|chrome|data|blob|about):/.test(url)) external.push(url);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('chrome://extensions-internals/');
    const id = await page.waitForFunction(() => {
        try {
            return JSON.parse(document.body.innerText).find((record: { name: string; location: string; id: string }) =>
                record.name === 'Better Peakbagger' && record.location === 'COMMAND_LINE')?.id;
        } catch { return false; }
    }).then(handle => handle.jsonValue());
    const url = `chrome-extension://${id}/photos/photos.html`;
    const capture = async (name: string) => {
        if (!screenshots) return;
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `${name}.png`) });
    };

    // Everything from here runs offline.
    await context.setOffline(true);
    await page.goto(url);
    await page.locator('#editor-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#resume-draft').isHidden(), true, 'a fresh profile has no draft to continue');
    assert.equal(await page.locator('#credential-card').count(), 0, 'no key form sits in the page');
    await capture('empty');

    await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1600; canvas.height = 1200;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#3a6b8a'; ctx.fillRect(0, 0, 1600, 1200);
        const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], 'Mount Hood.png', { type: 'image/png' }));
        const input = document.getElementById('photo-file') as HTMLInputElement;
        input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#editor-workspace').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /Saved on this device/.test(document.getElementById('save-status')!.textContent || ''));
    // One freehand stroke across the photo's centre.
    await page.locator('[data-tool="drawing"]').click();
    const overlay = await box(page, '#photo-overlay');
    const mid = { x: overlay.x + overlay.width / 2, y: overlay.y + overlay.height / 2 };
    await page.mouse.move(mid.x - 60, mid.y); await page.mouse.down();
    await page.mouse.move(mid.x + 60, mid.y, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(() => /^PNG · /.test(document.getElementById('output-summary')!.textContent || ''));

    // The finish actions and the status row are in view on common laptop windows.
    for (const viewport of [{ width: 1440, height: 790 }, { width: 1280, height: 680 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => scrollTo(0, 0));
        for (const selector of ['#copy-image', '#export-image', '#upload-insert', '.viewport-actions']) {
            const rect = await box(page, selector);
            assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height + 0.5,
                `${selector} out of view at ${viewport.width}×${viewport.height}: ${JSON.stringify(rect)}`);
        }
        await capture(`editor-${viewport.width}x${viewport.height}`);
    }
    // Narrow windows and 200% zoom: no sideways scroll, and a long note wraps
    // inside the status row instead of being clipped to a sliver.
    await page.evaluate(() => {
        document.getElementById('finish-note')!.hidden = false;
        document.getElementById('finish-note-text')!.textContent
            = 'Reports need a hosted image. Connect ImgBB to insert it, or export it and host it anywhere.';
    });
    for (const [width, zoom] of [[900, 1], [600, 1], [360, 1], [1440, 2]] as const) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
        const fit = await page.evaluate(() => {
            const row = document.querySelector<HTMLElement>('.viewport-actions')!;
            const note = document.getElementById('finish-note')!.getBoundingClientRect();
            return {
                overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                rowClipped: row.scrollHeight > row.clientHeight + 1,
                noteWidth: note.width,
                actions: ['copy-image', 'export-image', 'upload-insert'].map(id => document.getElementById(id)!.getBoundingClientRect().width),
            };
        });
        assert.equal(fit.overflow, false, `sideways scroll at ${width}px ×${zoom}`);
        assert.equal(fit.rowClipped, false, `status row clips its note at ${width}px ×${zoom}`);
        assert.ok(fit.noteWidth >= 150, `the note is squeezed to ${fit.noteWidth}px at ${width}px ×${zoom}`);
        assert.ok(fit.actions.every(value => value > 40), `a finish action collapsed at ${width}px ×${zoom}`);
        await capture(`narrow-${width}-zoom${zoom}`);
    }
    await page.evaluate(() => {
        document.body.style.zoom = '';
        document.getElementById('finish-note')!.hidden = true;
    });
    await page.setViewportSize({ width: 1440, height: 790 });
    // The top bar stays under the page header while the page scrolls.
    await page.setViewportSize({ width: 1440, height: 790 });
    await page.evaluate(() => scrollTo(0, 500));
    await page.waitForFunction(() => scrollY > 0);
    const header = await box(page, '.app-header');
    const topbar = await box(page, '.editor-topbar');
    assert.ok(Math.abs(topbar.y - (header.y + header.height)) <= 1, `top bar did not stick: ${JSON.stringify({ header, topbar })}`);
    await page.evaluate(() => scrollTo(0, 0));

    // Standalone order and emphasis: publish first, Export last and primary.
    assert.deepEqual(await page.locator('#finish-actions button:not([hidden])').evaluateAll(buttons =>
        buttons.map(button => [button.id, button.classList.contains('primary')])),
    [['upload-insert', false], ['copy-image', false], ['export-image', true]]);
    const finishBefore = {
        copy: await box(page, '#copy-image'), exportButton: await box(page, '#export-image'),
        upload: await box(page, '#upload-insert'),
    };

    // Offline: Upload refuses before asking for a key or touching the journal.
    await page.locator('#upload-insert').click();
    await page.waitForFunction(() => /offline/i.test(document.getElementById('toast-message')!.textContent || ''));
    assert.equal(await page.locator('#imgbb-dialog').evaluate(dialog => (dialog as HTMLDialogElement).open), false);

    // Copy: a real clipboard round trip of the flattened PNG.
    await page.locator('#copy-image').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('copy-image')!.textContent!.trim() === 'Copied');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'copy-image', 'focus stays on Copy');
    same(finishBefore.copy, await box(page, '#copy-image'), 'Copy image through Copied');
    const pasted = await page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        const blob = await item.getType('image/png');
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const centre = [...ctx.getImageData(800, 600, 1, 1).data];
        const corner = [...ctx.getImageData(40, 40, 1, 1).data];
        return { types: item.types, width: bitmap.width, height: bitmap.height, centre, corner };
    });
    assert.deepEqual(pasted.types, ['image/png']);
    assert.deepEqual([pasted.width, pasted.height], [1600, 1200], 'the clipboard holds full resolution');
    assert.deepEqual(pasted.corner.slice(0, 3), [0x3a, 0x6b, 0x8a], 'the photo itself is unchanged');
    assert.notDeepEqual(pasted.centre.slice(0, 3), [0x3a, 0x6b, 0x8a], 'the stroke is flattened in');
    await page.waitForFunction(() => document.getElementById('copy-image')!.textContent!.trim() === 'Copy image');
    same(finishBefore.copy, await box(page, '#copy-image'), 'Copy image after it resets');

    // Export: PNG named from the title, full resolution, no metadata chunks.
    const pngDownload = page.waitForEvent('download');
    await page.locator('#export-image').click();
    const png = await pngDownload;
    assert.equal(png.suggestedFilename(), 'Mount-Hood-topo.png');
    const pngBytes = await readFile((await png.path())!);
    const info = pngInfo(pngBytes);
    assert.deepEqual([info.width, info.height], [1600, 1200]);
    assert.deepEqual(info.chunks.filter(chunk => /^(eXIf|tEXt|iTXt|zTXt)$/.test(chunk)), []);
    await page.waitForFunction(() => /Downloading Mount-Hood-topo\.png/.test(document.getElementById('editor-status')!.textContent || ''));
    same(finishBefore.exportButton, await box(page, '#export-image'), 'Export image after exporting');

    // JPEG follows the chosen format and carries no Exif.
    await page.locator('#upload-format').selectOption('jpeg');
    await page.waitForFunction(() => /^JPEG · /.test(document.getElementById('output-summary')!.textContent || ''));
    same(finishBefore.exportButton, await box(page, '#export-image'), 'Export image across a format change');
    const jpegDownload = page.waitForEvent('download');
    await page.locator('#export-image').click();
    const jpeg = await jpegDownload;
    assert.equal(jpeg.suggestedFilename(), 'Mount-Hood-topo.jpg');
    assert.equal(jpegHasApp1(await readFile((await jpeg.path())!)), false, 'no Exif in the export');

    assert.deepEqual(external, [], 'nothing reached the network while offline');

    // Online, Upload with no key opens the dialog, which the editor cannot hear.
    await context.setOffline(false);
    await page.locator('#upload-insert').click();
    await page.waitForFunction(() => (document.getElementById('imgbb-dialog') as HTMLDialogElement).open);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'imgbb-key');
    await page.keyboard.press('b');
    assert.notEqual(await page.locator('[data-tool="bolt"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#imgbb-key').fill('');
    await page.locator('#save-key').click();
    await page.waitForFunction(() => /no spaces/.test(document.getElementById('imgbb-error')!.textContent || ''));
    await capture('dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !(document.getElementById('imgbb-dialog') as HTMLDialogElement).open);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'upload-insert');
    same(finishBefore.upload, await box(page, '#upload-insert'), 'Upload slot after the dialog');

    // New photo opens the picker from the click.
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.locator('#new-photo').click();
    await chooser;

    // With a saved draft, a fresh tab offers to continue it, and the line is in
    // place from the first paint: Choose photo does not move once the library
    // has finished loading.
    const resumed = await context.newPage();
    resumed.on('pageerror', error => errors.push(String(error)));
    await resumed.goto(url);
    await resumed.locator('#editor-empty').waitFor({ state: 'visible' });
    assert.equal(await resumed.locator('#resume-draft').isVisible(), true, 'the saved draft is offered');
    assert.match(await resumed.locator('#resume-draft-open').textContent() || '', /^Continue Mount Hood$/);
    const chooseFirstPaint = await box(resumed, '#editor-empty .file-button');
    await resumed.waitForFunction(() => document.getElementById('library-list')!.children.length > 0);
    same(chooseFirstPaint, await box(resumed, '#editor-empty .file-button'), 'Choose photo after the drafts read');
    await resumed.locator('#resume-draft-open').click();
    await resumed.locator('#editor-workspace').waitFor({ state: 'visible' });
    assert.equal(await resumed.locator('#photo-title').inputValue(), 'Mount Hood', 'Continue reopens the draft in place');
    await resumed.close();

    // Dark theme renders the same layout.
    await page.evaluate(async () => {
        const { bpbSettings = {} } = await chrome.storage.sync.get('bpbSettings');
        await chrome.storage.sync.set({ bpbSettings: { ...(bpbSettings as object), theme: 'dark' } });
    });
    await page.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'dark');
    same(finishBefore.exportButton, await box(page, '#export-image'), 'Export image in dark theme');
    await capture('editor-dark');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
        browser: context.browser()?.version(), hidden: true, viewports: ['1440×790', '1280×680'],
        offline: true, clipboard: 'round trip in headless Chrome; the OS pasteboard is not exercised', passed: true,
    }));
} finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
}
