// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension-origin IndexedDB; never exposed through storage.local or sync.
export const GARMIN_DB = 'bpb-garmin-v1';
const empty = () => ({ version: 1, epoch: 0, connection: null, items: {}, receipts: {}, scan: null,
    lastCheck: 0, lastFull: 0, retryAt: 0, error: null });
export function createGarminStore(indexedDB = globalThis.indexedDB) {
    let opening;
    const db = () => opening ||= new Promise((resolve, reject) => {
        const request = indexedDB.open(GARMIN_DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null; reject(new Error('Garmin storage is unavailable.')); };
    });
    const transaction = async (write, mutate) => {
        const database = await db();
        return new Promise((resolve, reject) => {
            const tx = database.transaction('state', write ? 'readwrite' : 'readonly');
            const store = tx.objectStore('state'); const request = store.get('current'); let result;
            request.onsuccess = () => {
                try { const state = request.result || empty(); result = mutate(state);
                    if (write) store.put(state, 'current'); }
                catch (error) { tx.abort(); reject(error); }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(new Error('Garmin storage could not be updated.'));
        });
    };
    return { read: () => transaction(false, state => state),
        mutate: mutate => transaction(true, mutate),
        async close() { if (opening) (await opening).close(); opening = null; } };
}
