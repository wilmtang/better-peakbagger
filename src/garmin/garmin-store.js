// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension-origin IndexedDB; never exposed through storage.local or sync.
export const GARMIN_DB = 'bpb-garmin-v1';
const empty = () => ({ version: 1, epoch: 0, connection: null, items: {}, receipts: {}, scan: null,
    lastCheck: 0, lastFull: 0, retryAt: 0, error: null });
export const garminPublicSummary = state => ({ revision: state.revision || 0, configured: !!state.connection?.key,
    enabled: !!state.connection?.key, cid: state.connection?.cid || null,
    connectedDate: state.connection?.connectedDate || null,
    queued: Object.values(state.items).filter(item => !item.analysis && ['waiting', 'error'].includes(item.phase)).length,
    peakbaggerBlocked: state.peakbaggerBlocked || null,
    pending: Object.values(state.items).filter(item => item.phase !== 'dismissed').length,
    lastCheck: state.lastCheck, lastFull: state.lastFull, retryAt: state.retryAt, error: state.error, historyIncomplete: !!state.scan,
    undoDue: Math.min(...Object.values(state.items).filter(item => item.phase === 'dismissed').map(item => item.undoUntil), Infinity) });
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
                    if (write) { state.revision = (state.revision || 0) + 1; store.put(state, 'current');
                        store.put(garminPublicSummary(state), 'summary'); } }
                catch (error) { tx.abort(); reject(error); }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(new Error('Garmin storage could not be updated.'));
        });
    };
    const read = () => transaction(false, state => state);
    const summary = async () => {
        const database = await db();
        const result = await new Promise((resolve, reject) => {
            const tx = database.transaction('state', 'readonly'); const request = tx.objectStore('state').get('summary');
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Garmin inbox summary is unavailable.'));
        });
        // Older cached summaries may still contain the separate opt-in flag.
        return Number.isInteger(result?.queued) ? { ...result, enabled: result.configured === true } : garminPublicSummary(await read());
    };
    return { read, summary,
        mutate: mutate => transaction(true, mutate),
        async close() { if (opening) (await opening).close(); opening = null; } };
}
