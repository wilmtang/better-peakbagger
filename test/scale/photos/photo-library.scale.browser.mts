// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://options.better-peakbagger.test
//
// The photo catalog is intentionally lifetime-sized, while the visible grid
// is not. This scale gate records the two-transaction render contract, bounded
// DOM, debounced filtering, and object-URL lifetime against a realistic local
// library rather than hiding those costs in ordinary unit fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byId } from '../../helpers/page-types.mts';
import type { StubMessage } from '../../helpers/page-types.mts';
import { FixtureDom, evalBundle } from '../../helpers/fixture-dom.mts';
import { makeChromeStub } from '../../helpers/chrome-stub.mts';
import { waitFor } from '../../helpers/fixture-page.mts';
import { photoLibrary as Library } from '../../../src/photos/photo-library.ts';
import { photoStore as Store } from '../../../src/photos/photo-store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const html = await readFile(path.join(root, 'photos', 'photos.html'), 'utf8');
const CATALOG_SIZE = 1200;
const PAGE_SIZE = 48;

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
});

const deleteDatabase = () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('betterPeakbaggerPhotos');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
});

const openDatabase = (indexedDB: IDBFactory) => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('betterPeakbaggerPhotos', Store.DATABASE_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

test('a 1,200-photo library renders and filters through bounded pages and transactions', async () => {
    // The page and this test share an origin, so they share its IndexedDB:
    // the test seeds the real database the page then reads.
    await deleteDatabase();
    const dom = await FixtureDom.open(html, {
        url: 'https://options.better-peakbagger.test/photos/photos.html?mode=library',
    });
    const win = dom.window;
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
        const draft = {
            localId,
            title,
            source: {
                fileName: `${localId}.jpg`,
                mime: 'image/jpeg',
                bytes: 12,
                width: 1600,
                height: 1200,
                sha256: index.toString(16).padStart(64, '0'),
            },
            now,
        };
        photos.put(Library.createDraft(draft));
        thumbnails.put({
            localId,
            blob: new Blob([`thumbnail-${index}`], { type: 'image/jpeg' }),
        });
    }
    await transactionDone(seed);
    database.close();

    const transactions: { names: string[]; mode: string }[] = [];
    // The page's own realm opens the database the page reads.
    const PageDatabase = (win as unknown as typeof globalThis).IDBDatabase;
    const originalTransaction = PageDatabase.prototype.transaction;
    PageDatabase.prototype.transaction = function instrumentedTransaction(this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
        const [storeNames, mode] = args;
        transactions.push({
            names: typeof storeNames === 'string' ? [storeNames] : [...storeNames],
            mode: mode || 'readonly',
        });
        return originalTransaction.apply(this, args);
    };

    const createdUrls: string[] = [];
    const revokedUrls: string[] = [];
    let nextUrl = 0;
    win.URL.createObjectURL = () => {
        const url = `blob:scale-${++nextUrl}`;
        createdUrls.push(url);
        return url;
    };
    win.URL.revokeObjectURL = (url: string) => { revokedUrls.push(url); };
    Object.defineProperty(win.navigator, 'storage', {
        value: { estimate: async () => ({ usage: 1_000_000 }) },
        configurable: true,
    });
    const chrome = makeChromeStub();
    chrome.runtime.sendMessage = async (message: StubMessage) => {
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
    Object.defineProperty(win, 'chrome', { value: chrome, configurable: true });

    const list = byId(win.document, 'library-list');
    let maximumCards = 0;
    const observer = new win.MutationObserver(() => {
        maximumCards = Math.max(maximumCards, list.querySelectorAll('.photo-card').length);
    });
    observer.observe(list, { childList: true });
    const renderTransactions = () => transactions.filter(call => {
        const names = [...call.names].sort().join(',');
        return names === 'metadata,photos' || names === 'thumbnails';
    });

    try {
        const openedAt = performance.now();
        await evalBundle(win, 'photos/photos.js');
        await waitFor(dom, () => list.querySelectorAll('.photo-card').length === PAGE_SIZE
            && /Page 1 of 25/.test(byId(win.document, 'library-page-status').textContent || ''),
        5000);
        const firstVisibleMs = performance.now() - openedAt;
        assert.ok(firstVisibleMs < 2500,
            `first visible page took ${firstVisibleMs.toFixed(1)} ms`);
        // Startup also reads the catalog for the editor's Continue draft action.
        // Keep that intentional read explicit without weakening the two-read
        // contract for subsequent filtering and paging below.
        assert.deepEqual(renderTransactions().map(call => [...call.names].sort().join(',')).sort(),
            ['metadata,photos', 'metadata,photos', 'thumbnails'],
            'startup reads the resume catalog, the visible catalog and one thumbnail page');
        assert.equal(createdUrls.length, PAGE_SIZE);

        const initialUrls = [...createdUrls];
        const search = byId<HTMLInputElement>(win.document, 'library-search');
        const beforeSearchTransactions = renderTransactions().length;
        const searchedAt = performance.now();
        search.value = 'alpine photo 1199';
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        assert.equal(renderTransactions().length, beforeSearchTransactions,
            'input itself is debounced instead of starting another full read');
        await waitFor(dom, () => list.querySelectorAll('.photo-card').length === 1
            && /Scale Alpine Photo 1199/.test(list.textContent || ''), 3000);
        const filteredMs = performance.now() - searchedAt;
        assert.ok(filteredMs < 1500,
            `filtered result took ${filteredMs.toFixed(1)} ms including debounce`);
        assert.equal(renderTransactions().length - beforeSearchTransactions, 2);
        assert.ok(initialUrls.every(url => revokedUrls.includes(url)),
            'a filtered page revokes every thumbnail URL from the previous page');

        search.value = '';
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        await waitFor(dom, () => list.querySelectorAll('.photo-card').length === PAGE_SIZE
            && /Page 1 of 25/.test(byId(win.document, 'library-page-status').textContent || ''),
        3000);
        const firstPageUrls = createdUrls.slice(-PAGE_SIZE);
        const beforePageTransactions = renderTransactions().length;
        byId(win.document, 'library-next').click();
        await waitFor(dom, () => /Page 2 of 25/.test(
            byId(win.document, 'library-page-status').textContent || '',
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
        PageDatabase.prototype.transaction = originalTransaction;
        await deleteDatabase();
    }
});
