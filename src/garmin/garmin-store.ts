// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension-origin IndexedDB; never exposed through storage.local or sync.
export const GARMIN_DB = 'bpb-garmin-v1';

export type GarminConnection = {
    key?: string | null;
    cid?: string | null;
    connectedDate?: string | null;
};

export type GarminInboxItem = {
    analysis?: unknown;
    phase: string;
    undoUntil?: number;
};

export type GarminState = {
    version?: number;
    epoch: number;
    revision?: number;
    connection: GarminConnection | null;
    items: Record<string, GarminInboxItem>;
    receipts: Record<string, unknown>;
    scan: unknown;
    lastCheck: number;
    lastFull: number;
    retryAt: number;
    error: unknown;
    peakbaggerBlocked?: unknown;
};

export type GarminPublicSummary = {
    revision: number;
    configured: boolean;
    enabled: boolean;
    cid: string | null;
    connectedDate: string | null;
    queued: number;
    peakbaggerBlocked: unknown;
    pending: number;
    lastCheck: number;
    lastFull: number;
    retryAt: number;
    error: unknown;
    historyIncomplete: boolean;
    undoDue: number;
};

type GarminStoreRequestLike = {
    readonly result: unknown;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
};

type GarminObjectStoreLike = {
    get(key: string): GarminStoreRequestLike;
    put(value: unknown, key: string): unknown;
};

type GarminTransactionLike = {
    objectStore(name: string): GarminObjectStoreLike;
    abort(): void;
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
};

type GarminDatabaseLike = {
    createObjectStore(name: string): unknown;
    transaction(storeNames: string, mode: 'readonly' | 'readwrite'): GarminTransactionLike;
    close(): void;
};

type GarminOpenRequestLike = {
    readonly result: GarminDatabaseLike;
    onupgradeneeded: (() => void) | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
};

export type GarminIndexedDbFactory = Pick<IDBFactory, 'open'> | {
    open(name: string, version?: number): GarminOpenRequestLike;
};

const empty = (): GarminState => ({ version: 1, epoch: 0, connection: null, items: {}, receipts: {}, scan: null,
    lastCheck: 0, lastFull: 0, retryAt: 0, error: null });

export const garminPublicSummary = (state: GarminState): GarminPublicSummary => ({ revision: state.revision || 0, configured: !!state.connection?.key,
    enabled: !!state.connection?.key, cid: state.connection?.cid || null,
    connectedDate: state.connection?.connectedDate || null,
    queued: Object.values(state.items).filter(item => !item.analysis && ['waiting', 'error'].includes(item.phase)).length,
    peakbaggerBlocked: state.peakbaggerBlocked || null,
    pending: Object.values(state.items).filter(item => item.phase !== 'dismissed').length,
    lastCheck: state.lastCheck, lastFull: state.lastFull, retryAt: state.retryAt, error: state.error, historyIncomplete: !!state.scan,
    undoDue: Math.min(...Object.values(state.items).filter(item => item.phase === 'dismissed').map(item => item.undoUntil as number), Infinity) });

export function createGarminStore(indexedDB: GarminIndexedDbFactory = globalThis.indexedDB) {
    let opening: Promise<IDBDatabase | GarminDatabaseLike> | null | undefined;
    const db = (): Promise<IDBDatabase | GarminDatabaseLike> => (opening ||= new Promise<IDBDatabase | GarminDatabaseLike>((resolve, reject) => {
        const request = indexedDB.open(GARMIN_DB, 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('state'); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null; reject(new Error('Garmin storage is unavailable.')); };
    }));
    const transaction = async <T>(write: boolean, mutate: (state: GarminState) => T): Promise<T> => {
        const database = await db();
        return new Promise<T>((resolve, reject) => {
            const tx = database.transaction('state', write ? 'readwrite' : 'readonly');
            const store = tx.objectStore('state');
            const request = store.get('current');
            let result!: T;
            request.onsuccess = () => {
                try {
                    const state = (request.result as GarminState | undefined) || empty();
                    result = mutate(state);
                    if (write) {
                        state.revision = (state.revision || 0) + 1;
                        store.put(state, 'current');
                        store.put(garminPublicSummary(state), 'summary');
                    }
                } catch (error) {
                    tx.abort();
                    reject(error);
                }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(new Error('Garmin storage could not be updated.'));
        });
    };
    const read = (): Promise<GarminState> => transaction(false, state => state);
    const summary = async (): Promise<GarminPublicSummary> => {
        const database = await db();
        const result = await new Promise<Partial<GarminPublicSummary> | undefined>((resolve, reject) => {
            const tx = database.transaction('state', 'readonly');
            const request = tx.objectStore('state').get('summary');
            request.onsuccess = () => resolve(request.result as Partial<GarminPublicSummary> | undefined);
            request.onerror = () => reject(new Error('Garmin inbox summary is unavailable.'));
        });
        // Older cached summaries may still contain the separate opt-in flag.
        return result && Number.isInteger(result.queued)
            ? { ...(result as GarminPublicSummary), enabled: result.configured === true }
            : garminPublicSummary(await read());
    };
    return {
        read,
        summary,
        mutate: <T>(mutate: (state: GarminState) => T): Promise<T> => transaction(true, mutate),
        async close(): Promise<void> { if (opening) (await opening).close(); opening = null; }
    };
}

export type GarminStore = ReturnType<typeof createGarminStore>;
