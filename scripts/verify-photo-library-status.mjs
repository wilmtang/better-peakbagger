// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden shipped-library geometry checks with synthetic, device-local photos.
/* global document, chrome, indexedDB, getComputedStyle, innerWidth */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { photoLibrary as Library } from '../src/photos/photo-library.js';
import { photoProject as Project } from '../src/photos/photo-project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const screenshots = process.env.BPB_PHOTO_SCREENSHOTS;
const now = '2026-10-09T12:00:00.000Z';
const drafts = ['status-one', 'status-two'].map((localId, index) => Library.createDraft({
    localId, title: 'Alpine ridge', now,
    source: { fileName: 'ridge.png', mime: 'image/png', width: 1200, height: 900,
        bytes: 1000, sha256: (index ? 'b' : 'a').repeat(64) },
}));
const uploaded = drafts.map(photo => Library.completeUpload(photo, photo.source, {
    providerId: photo.localId, url: 'https://i.ibb.co/example/ridge.png',
    displayUrl: 'https://i.ibb.co/example/ridge.png', viewerUrl: 'https://ibb.co/example',
    thumbnailUrl: 'https://i.ibb.co/example/thumb.png', uploadedAt: now,
}, now));
const states = [
    { name: 'draft', base: drafts, remote: 'draft', backup: 'off', used: false, labels: ['Local draft'] },
    { name: 'uploading', base: drafts, remote: 'uploading', backup: 'pending', used: true,
        labels: ['Uploading', 'In report', 'Backup pending'] },
    { name: 'uncertain', base: drafts, remote: 'outcome-unknown', backup: 'failed', used: true,
        labels: ['Upload uncertain', 'In report', 'Backup failed'] },
    { name: 'uncertain-pending', base: drafts, remote: 'outcome-unknown', backup: 'pending', used: true,
        labels: ['Upload uncertain', 'In report', 'Backup pending'] },
    { name: 'draft-backed-up', base: drafts, remote: 'draft', backup: 'current', used: true,
        labels: ['Local draft', 'In report', 'Backed up'] },
    { name: 'uploaded', base: uploaded, remote: 'uploaded', backup: 'off', used: false,
        labels: ['Uploaded', 'Not inserted'] },
    { name: 'uploaded-pending', base: uploaded, remote: 'uploaded', backup: 'pending', used: false,
        labels: ['Uploaded', 'Not inserted', 'Backup pending'] },
    { name: 'uploaded-backed-up', base: uploaded, remote: 'uploaded', backup: 'current', used: true,
        labels: ['Uploaded', 'In report', 'Backed up'] },
    { name: 'unreachable', base: uploaded, remote: 'unreachable', backup: 'failed', used: true,
        labels: ['Image unreachable', 'In report', 'Backup failed'] },
];
const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-photo-status-'));
let context;
try {
    assertChromeLaunchAllowed();
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, viewport: { width: 1440, height: 1100 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    // No live provider or GitHub requests are part of this check.
    await context.route(/^https?:/, route => route.abort());
    await page.goto('chrome://extensions-internals/');
    const id = await page.waitForFunction(() => {
        try {
            return JSON.parse(document.body.innerText).find(record =>
                record.name === 'Better Peakbagger' && record.location === 'COMMAND_LINE')?.id;
        } catch { return false; }
    }).then(handle => handle.jsonValue());
    await page.goto(`chrome-extension://${id}/photos/photos.html?mode=library`);
    await page.locator('#library-empty').waitFor({ state: 'visible' });
    const projects = drafts.map(photo => Project.createProject({ localId: photo.localId,
        width: 1200, height: 900, sourceSha256: photo.source.sha256, updatedAt: now }));
    await page.evaluate(async ({ photos, projects }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1200; canvas.height = 900;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#819bb5'; ctx.fillRect(0, 0, 1200, 900);
        ctx.fillStyle = '#4c5555'; ctx.beginPath();
        ctx.moveTo(0, 850); ctx.lineTo(500, 100); ctx.lineTo(1200, 900); ctx.fill();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await new Promise((resolve, reject) => {
            const open = indexedDB.open('betterPeakbaggerPhotos');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const database = open.result;
                const tx = database.transaction(['photos', 'projects', 'originals', 'thumbnails'], 'readwrite');
                for (const [index, photo] of photos.entries()) {
                    tx.objectStore('photos').put(photo);
                    tx.objectStore('projects').put(projects[index]);
                    for (const name of ['originals', 'thumbnails']) tx.objectStore(name).put({ localId: photo.localId, blob });
                }
                tx.oncomplete = () => { database.close(); resolve(); };
                tx.onerror = () => { database.close(); reject(tx.error); };
            };
        });
    }, { photos: drafts, projects });
    const setState = async (state, serial) => {
        const changed = Library.cleanPhoto({ ...state.base[0], remote: { ...state.base[0].remote, state: state.remote },
            references: state.used ? [{ kind: 'ascent', cid: 1, aid: 2, pid: 3, insertedAt: now }] : [],
            backup: { state: state.backup, signature: null, backedUpAt: null, commitUrl: null } });
        assert.ok(changed);
        await page.evaluate(async ({ photos, serial }) => {
            await new Promise((resolve, reject) => {
                const open = indexedDB.open('betterPeakbaggerPhotos');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const database = open.result;
                    const tx = database.transaction('photos', 'readwrite');
                    for (const photo of photos) tx.objectStore('photos').put(photo);
                    tx.oncomplete = () => { database.close(); resolve(); };
                    tx.onerror = () => { database.close(); reject(tx.error); };
                };
            });
            // Exercise the completion notification used by automatic backup.
            await chrome.storage.local.set({ bpbPhotoLibraryBackupState: { verificationSerial: serial } });
        }, { photos: [changed, state.base[1]], serial });
        await page.waitForFunction(labels => {
            const card = document.querySelector('[data-local-id="status-one"]');
            return card && JSON.stringify([...card.querySelectorAll('.status-chip')].map(chip => chip.textContent)) === JSON.stringify(labels)
                && [...document.querySelectorAll('.photo-card img')].every(img => img.complete && img.naturalWidth > 0);
        }, state.labels);
    };
    const geometry = () => page.evaluate(() => [...document.querySelectorAll('.photo-card')].map(card => {
        const bounds = card.getBoundingClientRect();
        const chips = card.querySelector('.status-chips');
        const row = chips.getBoundingClientRect();
        return { id: card.dataset.localId, height: bounds.height, top: bounds.top,
            actions: card.querySelector('.card-actions').getBoundingClientRect().top - bounds.top,
            row: row.height, overflow: document.documentElement.scrollWidth > innerWidth,
            chips: [...chips.children].map(chip => {
                const rect = chip.getBoundingClientRect();
                return { text: chip.textContent, title: chip.title, singleLine: getComputedStyle(chip).whiteSpace === 'nowrap',
                    inside: rect.left >= row.left && rect.right <= row.right + 0.5,
                    height: rect.height, width: rect.width, scrollWidth: chip.scrollWidth, clientWidth: chip.clientWidth,
                    clipped: chip.scrollWidth > chip.clientWidth + 1 };
            }) };
    }));
    if (screenshots) await mkdir(screenshots, { recursive: true });
    let serial = 0;
    const widths = [1440, 650, 600, 520, 390, 320];
    for (const theme of ['light', 'dark']) {
        await page.locator('html').evaluate((html, theme) => { html.dataset.bpbTheme = theme; }, theme);
        for (const width of widths) {
            await page.setViewportSize({ width, height: 1100 });
            const baseline = new Map();
            for (const state of states) {
                await setState(state, ++serial);
                const cards = await geometry();
                const card = cards.find(item => item.id === 'status-one');
                const group = state.base === drafts ? 'draft' : 'uploaded';
                if (!baseline.has(group)) baseline.set(group, card);
                const before = baseline.get(group);
                assert.equal(card.row, before.row, `${theme}/${width}/${state.name}: status row stays fixed`);
                assert.equal(card.actions, baseline.get('draft').actions, `${theme}/${width}/${state.name}: actions stay aligned`);
                assert.equal(card.height, before.height, `${theme}/${width}/${state.name}: tags do not grow the card`);
                assert.equal(card.overflow, false, `${theme}/${width}/${state.name}: page fits the viewport`);
                for (const chip of card.chips) {
                    assert.equal(chip.singleLine && chip.inside, true, `${theme}/${width}/${state.name}: tags fit in one row`);
                    assert.equal(chip.title, chip.text, 'full status remains available when visually shortened');
                    assert.ok(chip.height <= card.row);
                    assert.equal(chip.clipped, false, `${theme}/${width}/${state.name}: status remains readable ${JSON.stringify(chip)}`);
                }
                if (cards[0].top === cards[1].top) assert.equal(cards[0].actions, cards[1].actions, 'adjacent cards keep action alignment');
                if (screenshots && ['uncertain', 'uploaded-backed-up'].includes(state.name)) {
                    await page.locator('#library-view').screenshot({ path: path.join(screenshots,
                        `status-${state.name}-${theme}-${width}.png`) });
                }
            }
        }
    }
    const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const extension = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
    });
    assert.doesNotMatch(renderer, /swiftshader|llvmpipe|software/i);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, browser: context.browser().version(), hidden: true, renderer,
        widths, height: 1100, states: states.length, themes: ['light', 'dark'], profile }));
} finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
}
