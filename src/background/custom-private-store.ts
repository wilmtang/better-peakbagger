// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension-origin IndexedDB. Never storage.local/sync or page globals.
// Exact-Settings-page manual files may explicitly transfer source definitions.

export type CustomPrivateIndexedDbFactory = Pick<IDBFactory, 'open'>;

export function createCustomPrivateStore(indexedDB: CustomPrivateIndexedDbFactory = globalThis.indexedDB) {
    let opening: Promise<IDBDatabase> | null | undefined;
    const db = (): Promise<IDBDatabase> => (opening ||= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('bpb-private-map-sources-v1', 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('records'); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null; reject(new Error('Private layer storage is unavailable.')); };
    }));
    const transact = async <T = unknown, R = T | undefined>(
        key: string,
        mutate?: (current: T | undefined) => R,
    ): Promise<R> => {
        const database = await db();
        return new Promise<R>((resolve, reject) => {
            const tx = database.transaction('records', mutate ? 'readwrite' : 'readonly');
            const store = tx.objectStore('records');
            const request = store.get(key);
            let result!: R;
            request.onsuccess = () => {
                try {
                    const current = request.result as T | undefined;
                    result = mutate ? mutate(current) : (current as unknown as R);
                    if (mutate) {
                        if (result == null) store.delete(key);
                        else store.put(result, key);
                    }
                } catch {
                    tx.abort();
                }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(new Error('Private layer storage is unavailable.'));
        });
    };
    return {
        get: <T = unknown>(key: string): Promise<T | undefined> => transact<T, T | undefined>(key),
        put: <T>(key: string, value: T): Promise<T> => transact<T, T>(key, () => value),
        mutate: <T = unknown, R = T | undefined>(
            key: string,
            mutate: (current: T | undefined) => R,
        ): Promise<R> => transact<T, R>(key, mutate),
        async close(): Promise<void> {
            if (opening) (await opening).close();
            opening = null;
        },
    };
}

export type CustomPrivateStore = ReturnType<typeof createCustomPrivateStore>;
