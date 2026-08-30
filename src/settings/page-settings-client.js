// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Optimistic MAIN-world settings client for the isolated settings bridge.
// Pending writes remain ordered by request id, and every write has a bounded
// acknowledgement lifetime so a lost bridge reply cannot pin stale UI state.

import { settingsSchema as Schema } from './settings-schema.js';

const DEFAULT_READY_TIMEOUT_MS = 800;
const DEFAULT_WRITE_ACK_TIMEOUT_MS = 5000;
const WRITE_FAILED_FALLBACK = 'That setting couldn’t be saved.';

export const createPageSettingsClient = ({
    fallback = {},
    ownerWindow = globalThis.window,
    ownerLocation = globalThis.location,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    writeAckTimeoutMs = DEFAULT_WRITE_ACK_TIMEOUT_MS,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
} = {}) => {
    const safeFallback = Schema.clean(fallback);
    let settings = null;
    let confirmed = null;
    let confirmedRevision = -1;
    let applied = null;
    let nextRequestId = 1;
    let readyTimer = null;
    let disposed = false;
    const pending = new Map();
    const subscribers = new Set();
    const writeFailureSubscribers = new Set();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });

    const failureMessage = value => (typeof value === 'string' && value.trim() && value.length <= 200
        ? value.trim()
        : WRITE_FAILED_FALLBACK);
    const sameSettings = (left, right) => {
        if (!left || !right) return left === right;
        const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
        return Array.from(keys).every(key => left[key] === right[key]);
    };
    const markApplied = () => { applied = { ...(settings || safeFallback) }; };
    const recompute = () => {
        const previous = settings;
        const optimistic = { ...(confirmed || safeFallback) };
        for (const { patch } of pending.values()) Object.assign(optimistic, patch);
        settings = Schema.clean(optimistic);
        if (sameSettings(previous, settings)) return;
        const before = applied || previous || safeFallback;
        const changed = keys => keys.some(key => before[key] !== settings[key]);
        markApplied();
        subscribers.forEach(subscriber => {
            try { subscriber(settings, changed); } catch (error) { /* A subscriber cannot break the bridge. */ }
        });
    };
    const settle = requestId => {
        const entry = pending.get(requestId);
        if (!entry) return false;
        clearTimer(entry.timer);
        pending.delete(requestId);
        return true;
    };
    const settleThrough = requestId => {
        if (!Number.isSafeInteger(requestId) || requestId < 0) return;
        for (const pendingId of [...pending.keys()]) {
            if (pendingId <= requestId) settle(pendingId);
        }
    };
    const acceptSnapshot = data => {
        if (!data.settings
            || !Number.isSafeInteger(data.snapshotRevision)
            || data.snapshotRevision <= confirmedRevision
            || !Number.isSafeInteger(data.throughRequestId)
            || data.throughRequestId < 0) return false;
        confirmed = Schema.clean(data.settings);
        confirmedRevision = data.snapshotRevision;
        settleThrough(data.throughRequestId);
        return true;
    };
    const fail = (requestId, message) => {
        if (!settle(requestId)) return;
        recompute();
        const publicMessage = failureMessage(message);
        writeFailureSubscribers.forEach(subscriber => {
            try { subscriber(publicMessage); } catch (error) { /* A subscriber cannot break the bridge. */ }
        });
    };

    const receive = event => {
        if (disposed || event.source !== ownerWindow || event.origin !== ownerLocation.origin) return;
        const data = event.data;
        if (!data || data.__bpb !== true || data.dir !== 'toPage') return;
        if (data.kind === 'setResult') {
            if (data.ok === true && data.settings) {
                const wasPending = pending.has(data.requestId);
                const accepted = acceptSnapshot(data);
                // A later successful snapshot is authoritative through that
                // request. Clear older requests too so a lost older reply
                // cannot later roll the confirmed value backward or emit a
                // false timeout.
                if (wasPending) settleThrough(data.requestId);
                if (accepted || wasPending) recompute();
                if (accepted) resolveReady(settings);
                return;
            }
            fail(data.requestId, data.message);
            return;
        }
        if (!acceptSnapshot(data)) return;
        recompute();
        resolveReady(settings);
    };
    ownerWindow.addEventListener('message', receive);

    return {
        init: async () => {
            ownerWindow.postMessage({ __bpb: true, dir: 'toCS', kind: 'get' }, ownerLocation.origin);
            if (!settings) {
                readyTimer = setTimer(() => {
                    readyTimer = null;
                    resolveReady(null);
                }, readyTimeoutMs);
                await ready;
                if (readyTimer !== null) {
                    clearTimer(readyTimer);
                    readyTimer = null;
                }
            }
            if (!settings) settings = { ...safeFallback };
            markApplied();
            return settings;
        },
        get: () => settings || safeFallback,
        refresh: () => {
            if (disposed) return false;
            ownerWindow.postMessage({ __bpb: true, dir: 'toCS', kind: 'get' }, ownerLocation.origin);
            return true;
        },
        set: patch => {
            if (disposed) return null;
            const requestId = nextRequestId++;
            const timer = setTimer(() => fail(requestId), writeAckTimeoutMs);
            pending.set(requestId, { patch, timer });
            settings = Schema.clean({ ...(settings || safeFallback), ...patch });
            // The caller applies this patch itself; subscribers should only
            // receive later reconciliation or external changes.
            markApplied();
            ownerWindow.postMessage({
                __bpb: true,
                dir: 'toCS',
                kind: 'set',
                requestId,
                patch
            }, ownerLocation.origin);
            return requestId;
        },
        subscribe: subscriber => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
        onWriteFailed: subscriber => {
            writeFailureSubscribers.add(subscriber);
            return () => writeFailureSubscribers.delete(subscriber);
        },
        dispose: () => {
            disposed = true;
            ownerWindow.removeEventListener('message', receive);
            if (readyTimer !== null) clearTimer(readyTimer);
            for (const entry of pending.values()) clearTimer(entry.timer);
            pending.clear();
            subscribers.clear();
            writeFailureSubscribers.clear();
        }
    };
};

export const pageSettingsClient = { create: createPageSettingsClient };
