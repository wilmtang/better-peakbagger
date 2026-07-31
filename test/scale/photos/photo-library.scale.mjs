// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The photo catalog is intentionally lifetime-sized, while the visible grid
// is not. This scale gate records the two-transaction render contract, bounded
// DOM, debounced filtering, and object-URL lifetime against a realistic local
// library rather than hiding those costs in ordinary unit fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
    IDBDatabase,
    IDBFactory,
    IDBKeyRange,
} from 'fake-indexeddb';
import { evalBundle, makeChromeStub, waitFor } from '../../helpers/load-page.mjs';
import { photoLibrary as Library } from '../../../src/photos/photo-library.js';
import { photoStore as Store } from '../../../src/photos/photo-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const html = await readFile(path.join(root, 'photos', 'photos.html'), 'utf8');
const CATALOG_SIZE = 1200;
const PAGE_SIZE = 48;
const HASH = 'a'.repeat(64);

const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
});

const openDatabase = indexedDB => new Promise((resolve, reject) => {
    const request = indexedDB.open('betterPeakbaggerPhotos', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

test('a 1,200-photo library renders and filters through bounded pages and transactions', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://scale/photos/photos.html?mode=library',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window: win } = dom;
    // fake-indexeddb keeps Node's Blob instances. Use that same constructor in
    // the page realm so the store's trust-boundary check exercises real blobs
    // instead of rejecting a cross-realm jsdom stand-in.
    win.Blob = Blob;
    const indexedDB = new IDBFactory();
    const schema = await Store.createPhotoStore({ indexedDB });
    schema.close();
    const database = await openDatabase(indexedDB);
    const seed = database.transaction(['photos', 'thumbnails'], 'readwrite');
    const photos = seed.objectStore('photos');
    const thumbnails = seed.objectStore('thumbnails');
    for (let index = 0; index < CATALOG_SIZE; index += 1) {
        const localId = `scale-photo-${String(index).padStart(4, '0')}`;
        const title = index === CATALOG_SIZE - 1
            ? 'Scale Alpine Photo 1199'
            : `Scale Photo ${String(index).padStart(4, '0')}`;
        const now = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
        photos.put(Library.createDraft({
            localId,
            title,
            source: {
                fileName: `${localId}.jpg`,
                mime: 'image/jpeg',
                bytes: 12,
                width: 1600,
                height: 1200,
                sha256: HASH,
            },
            now,
        }));
        thumbnails.put({
            localId,
            blob: new Blob([`thumbnail-${index}`], { type: 'image/jpeg' }),
        });
    }
    await transactionDone(seed);
    database.close();

    const transactions = [];
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function instrumentedTransaction(storeNames, mode) {
        transactions.push({
            names: typeof storeNames === 'string' ? [storeNames] : [...storeNames],
            mode: mode || 'readonly',
        });
        return originalTransaction.call(this, storeNames, mode);
    };

    const createdUrls = [];
    const revokedUrls = [];
    let nextUrl = 0;
    win.URL.createObjectURL = () => {
        const url = `blob:scale-${++nextUrl}`;
        createdUrls.push(url);
        return url;
    };
    win.URL.revokeObjectURL = url => revokedUrls.push(url);
    win.indexedDB = indexedDB;
    win.IDBKeyRange = IDBKeyRange;
    win.structuredClone = globalThis.structuredClone;
    Object.defineProperty(win.crypto, 'subtle', {
        value: globalThis.crypto.subtle,
        configurable: true,
    });
    Object.defineProperty(win.navigator, 'storage', {
        value: { estimate: async () => ({ usage: 1_000_000 }) },
        configurable: true,
    });
    const chrome = makeChromeStub();
    chrome.runtime.sendMessage = async message => {
        if (message?.type === 'PHOTO_IMGBB_STATUS') {
            return { ok: true, configured: false, permissionGranted: false };
        }
        if (message?.type === 'GITHUB_PHOTOS_STATUS') {
            return { ok: true, connected: false };
        }
        return { ok: true };
    };
    chrome.permissions = { contains: async () => false, request: async () => false };
    chrome.tabs = { create() {} };
    win.chrome = chrome;

    const list = win.document.getElementById('library-list');
    let maximumCards = 0;
    const observer = new win.MutationObserver(() => {
        maximumCards = Math.max(maximumCards, list.querySelectorAll('.photo-card').length);
    });
    observer.observe(list, { childList: true });
    const renderTransactions = () => transactions.filter(call =>
        call.names.length === 1 && ['photos', 'thumbnails'].includes(call.names[0]));

    try {
        const openedAt = performance.now();
        await evalBundle(win, 'photos/photos.js');
        await waitFor(dom, () => list.querySelectorAll('.photo-card').length === PAGE_SIZE
            && /Page 1 of 25/.test(win.document.getElementById('library-page-status').textContent),
        5000);
        const firstVisibleMs = performance.now() - openedAt;
        assert.ok(firstVisibleMs < 2500,
            `first visible page took ${firstVisibleMs.toFixed(1)} ms`);
        assert.equal(renderTransactions().length, 2,
            'initial render is one catalog transaction plus one thumbnail transaction');
        assert.equal(createdUrls.length, PAGE_SIZE);

        const initialUrls = [...createdUrls];
        const search = win.document.getElementById('library-search');
        const beforeSearchTransactions = renderTransactions().length;
        const searchedAt = performance.now();
        search.value = 'alpine photo 1199';
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        assert.equal(renderTransactions().length, beforeSearchTransactions,
            'input itself is debounced instead of starting another full read');
        await waitFor(dom, () => list.querySelectorAll('.photo-card').length === 1
            && /Scale Alpine Photo 1199/.test(list.textContent), 3000);
        const filteredMs = performance.now() - searchedAt;
        assert.ok(filteredMs < 1500,
            `filtered result took ${filteredMs.toFixed(1)} ms including debounce`);
        assert.equal(renderTransactions().length - beforeSearchTransactions, 2);
        assert.ok(initialUrls.every(url => revokedUrls.includes(url)),
            'a filtered page revokes every thumbnail URL from the previous page');

        search.value = '';
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        await waitFor(dom, () => list.querySelectorAll('.photo-card').length === PAGE_SIZE
            && /Page 1 of 25/.test(win.document.getElementById('library-page-status').textContent),
        3000);
        const firstPageUrls = createdUrls.slice(-PAGE_SIZE);
        const beforePageTransactions = renderTransactions().length;
        win.document.getElementById('library-next').click();
        await waitFor(dom, () => /Page 2 of 25/.test(
            win.document.getElementById('library-page-status').textContent,
        ), 3000);
        assert.equal(renderTransactions().length - beforePageTransactions, 2);
        assert.ok(firstPageUrls.every(url => revokedUrls.includes(url)),
            'paging revokes every thumbnail URL from the preceding page');
        assert.equal(list.querySelectorAll('.photo-card').length, PAGE_SIZE);
        assert.ok(maximumCards <= PAGE_SIZE,
            `the grid rendered ${maximumCards} cards despite a ${PAGE_SIZE}-card page`);
    } finally {
        observer.disconnect();
        win.dispatchEvent(new win.Event('beforeunload'));
        dom.window.close();
        IDBDatabase.prototype.transaction = originalTransaction;
    }
});
