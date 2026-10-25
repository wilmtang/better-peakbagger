// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, location, indexedDB */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Real shipped editor, native decoding/canvas/IndexedDB; external APIs are inert.
export async function verifyPhotoReportEdit(page, origin, variant, { capture }) {
    await page.addInitScript(({ theme }) => {
        const values = { bpbSettings: { theme } }, listeners = [];
        const area = { get: async () => values, set: async patch => {
            Object.assign(values, patch);
            listeners.forEach(fn => fn(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), 'local'));
        }, remove: async () => {} };
        window.chrome = { storage: { sync: area, local: area, onChanged: { addListener: fn => listeners.push(fn), removeListener() {} } },
            runtime: { getURL: file => new URL(`/dist/${file}`, location.origin).href,
                sendMessage: async () => ({ ok: true, configured: false, connected: false, permissionGranted: false }) },
            permissions: { contains: async () => false } };
    }, variant);
    const catalog = () => page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('betterPeakbaggerPhotos');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result, transaction = db.transaction('photos'), read = transaction.objectStore('photos').getAll();
            read.onsuccess = () => resolve(read.result);
            transaction.oncomplete = () => db.close();
        };
    }));
    const url = `${origin}/dist/photos/photos.html`;
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('library-empty').hidden === false
        || document.getElementById('library-list').children.length > 0);
    for (const size of [128, 48]) {
        if (size === 48) await page.goto(url);
        await page.locator('#photo-file').setInputFiles({ name: `photo-${size}.png`, mimeType: 'image/png',
            buffer: await readFile(new URL(`../icons/icon-${size}.png`, import.meta.url)) });
        await page.locator('#editor-workspace').waitFor();
        if (size === 128) {
            await page.locator('#photo-caption').fill('Existing caption');
            await page.locator('[data-tool=text]').click(); await page.locator('#add-at-center').click();
            await page.locator('#object-text').fill('North ridge');
            await page.locator('#object-text').fill(''); await page.locator('#object-text').press('Tab');
            assert.equal(await page.locator('#annotation-list button[data-object-id]').count(), 0);
            await page.locator('#undo').click();
            assert.equal(await page.locator('#photo-overlay text').textContent(), 'North ridge');
        }
        await page.locator('#save-status').filter({ hasText: 'Saved on this device' }).waitFor();
    }
    const photos = await catalog(); assert.equal(photos.length, 2);
    const original = photos.find(photo => photo.caption === 'Existing caption'), other = photos.find(photo => photo !== original);
    assert(original && other);
    await page.goto(`${url}?returnToken=fixture&localPhotoId=${original.localId}&imageCaption=Existing%20caption`);
    await page.locator('#editor-status').filter({ hasText: 'Edits stay on this device' }).waitFor();
    await page.locator('#editor-workspace').waitFor();
    assert.equal(await page.locator('#save-status').textContent(), 'Saved on this device');
    assert(await page.locator('#photo-file').isDisabled());
    await page.locator('#show-library').click();
    const card = page.locator(`[data-local-id="${other.localId}"]`);
    await card.waitFor();
    assert.equal(await card.locator('[data-action=edit], [data-action=insert]').count(), 0);
    await capture(page, `${variant.name}-report-photo-library`);
    await page.locator(`[data-local-id="${original.localId}"] [data-action=edit]`).click();
    await page.locator('#editor-workspace').waitFor();
    await page.locator('#upload-insert').filter({ hasText: 'Save and return' }).waitFor();
    await capture(page, `${variant.name}-report-photo-edit`);
}
