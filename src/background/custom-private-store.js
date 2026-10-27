// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension-origin IndexedDB. Never storage.local/sync or page globals.
// Exact-Settings-page manual files may explicitly transfer source definitions.
export function createCustomPrivateStore(indexedDB = globalThis.indexedDB) {
    let opening;
    const db = () => opening ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('bpb-private-map-sources-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null;reject(new Error('Private layer storage is unavailable.')); };
    });
    const transact = async (key, mutate) => {
        const database = await db();
        return new Promise((resolve, reject) => {
            const tx = database.transaction('records', mutate ? 'readwrite' : 'readonly'), store = tx.objectStore('records'), request = store.get(key);let result;
            request.onsuccess = () => { try { result = mutate ? mutate(request.result) : request.result;if (mutate) { if (result == null) store.delete(key);else store.put(result, key); } } catch { tx.abort(); } };
            tx.oncomplete = () => resolve(result);tx.onerror = tx.onabort = () => reject(new Error('Private layer storage is unavailable.'));
        });
    };
    return { get: key => transact(key), put: (key, value) => transact(key, () => value), mutate: transact,
        async close() { if (opening) (await opening).close();opening = null; } };
}
