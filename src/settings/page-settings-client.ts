// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Optimistic MAIN-world settings client for the isolated settings bridge.
// Pending writes remain ordered by request id, and every write has a bounded
// acknowledgement lifetime so a lost bridge reply cannot pin stale UI state.

import { storageValue as StorageValue } from '../storage/storage-value.ts';
import { settingsSchema as Schema } from './settings-schema.ts';

const DEFAULT_READY_TIMEOUT_MS = 800;
const DEFAULT_WRITE_ACK_TIMEOUT_MS = 5000;
const WRITE_FAILED_FALLBACK = 'That setting couldn’t be saved.';

export type PageSettingsValues = typeof Schema.DEFAULTS;
export type PageSettingsChangedMatcher = (keys: readonly string[]) => boolean;
export type PageSettingsSubscriber = (settings: PageSettingsValues, changed: PageSettingsChangedMatcher) => void;
export type PageSettingsWriteFailureSubscriber = (message: string) => void;

export interface PageSettingsWindowLike {
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    postMessage(message: unknown, targetOrigin: string): void;
}

export interface PageSettingsLocationLike {
    origin: string;
}

export interface PageSettingsClientOptions<TimerId = ReturnType<typeof globalThis.setTimeout> | number> {
    fallback?: unknown;
    ownerWindow?: PageSettingsWindowLike;
    ownerLocation?: PageSettingsLocationLike;
    readyTimeoutMs?: number;
    writeAckTimeoutMs?: number;
    setTimer?: (callback: () => void, delayMs: number) => TimerId;
    clearTimer?: (handle: TimerId) => void;
}

type BridgeIncomingData = {
    __bpb?: unknown;
    dir?: unknown;
    kind?: unknown;
    ok?: unknown;
    requestId?: unknown;
    message?: unknown;
    settings?: unknown;
    snapshotRevision?: unknown;
    throughRequestId?: unknown;
};

export const createPageSettingsClient = <TimerId = ReturnType<typeof globalThis.setTimeout> | number>({
    fallback = {},
    ownerWindow = globalThis.window,
    ownerLocation = globalThis.location,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    writeAckTimeoutMs = DEFAULT_WRITE_ACK_TIMEOUT_MS,
    setTimer = globalThis.setTimeout as unknown as (callback: () => void, delayMs: number) => TimerId,
    clearTimer = globalThis.clearTimeout as unknown as (handle: TimerId) => void,
}: PageSettingsClientOptions<TimerId> = {}) => {
    const safeFallback = Schema.clean(fallback);
    let settings: PageSettingsValues | null = null;
    let confirmed: PageSettingsValues | null = null;
    let confirmedRevision = -1;
    let applied: PageSettingsValues | null = null;
    let nextRequestId = 1;
    let readyTimer: TimerId | null = null;
    let disposed = false;
    const pending = new Map<number, { patch: Partial<PageSettingsValues> | Record<string, unknown>; timer: TimerId }>();
    const subscribers = new Set<PageSettingsSubscriber>();
    const writeFailureSubscribers = new Set<PageSettingsWriteFailureSubscriber>();
    let resolveReady!: (value: PageSettingsValues | null) => void;
    const ready = new Promise<PageSettingsValues | null>(resolve => { resolveReady = resolve; });

    const failureMessage = (value: unknown): string => (typeof value === 'string' && value.trim() && value.length <= 200
        ? value.trim()
        : WRITE_FAILED_FALLBACK);
    const sameValue = StorageValue.same;
    const sameSettings = (left: PageSettingsValues | null, right: PageSettingsValues | null): boolean => {
        if (!left || !right) return left === right;
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
        return Array.from(keys).every(key => sameValue(leftRecord[key], rightRecord[key]));
    };
    const markApplied = () => { applied = { ...(settings || safeFallback) }; };
    const recompute = () => {
        const previous = settings;
        const optimistic: Record<string, unknown> = { ...(confirmed || safeFallback) };
        for (const { patch } of pending.values()) Object.assign(optimistic, patch);
        settings = Schema.clean(optimistic);
        if (sameSettings(previous, settings)) return;
        const before = (applied || previous || safeFallback) as Record<string, unknown>;
        const changed: PageSettingsChangedMatcher = keys => keys.some(
            key => !sameValue(before[key], (settings as Record<string, unknown>)[key]),
        );
        markApplied();
        subscribers.forEach(subscriber => {
            try { subscriber(settings || safeFallback, changed); } catch (error) { /* A subscriber cannot break the bridge. */ }
        });
    };
    const settle = (requestId: unknown): boolean => {
        if (typeof requestId !== 'number') return false;
        const entry = pending.get(requestId);
        if (!entry) return false;
        clearTimer(entry.timer);
        pending.delete(requestId);
        return true;
    };
    const settleThrough = (requestId: unknown) => {
        if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 0) return;
        for (const pendingId of [...pending.keys()]) {
            if (pendingId <= requestId) settle(pendingId);
        }
    };
    const acceptSnapshot = (data: BridgeIncomingData): boolean => {
        if (!data.settings
            || typeof data.snapshotRevision !== 'number'
            || !Number.isSafeInteger(data.snapshotRevision)
            || data.snapshotRevision <= confirmedRevision
            || typeof data.throughRequestId !== 'number'
            || !Number.isSafeInteger(data.throughRequestId)
            || data.throughRequestId < 0) return false;
        confirmed = Schema.clean(data.settings);
        confirmedRevision = data.snapshotRevision;
        settleThrough(data.throughRequestId);
        return true;
    };
    const fail = (requestId: unknown, message?: unknown) => {
        if (!settle(requestId)) return;
        recompute();
        const publicMessage = failureMessage(message);
        writeFailureSubscribers.forEach(subscriber => {
            try { subscriber(publicMessage); } catch (error) { /* A subscriber cannot break the bridge. */ }
        });
    };

    const receive = (event: MessageEvent) => {
        if (disposed || event.source !== ownerWindow || event.origin !== ownerLocation.origin) return;
        const data = event.data as BridgeIncomingData | null | undefined;
        if (!data || data.__bpb !== true || data.dir !== 'toPage') return;
        if (data.kind === 'setResult') {
            if (data.ok === true && data.settings) {
                const wasPending = typeof data.requestId === 'number' && pending.has(data.requestId);
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

    const set = (
        patch: Partial<PageSettingsValues> | Record<string, unknown>,
        wirePatch: Partial<PageSettingsValues> | Record<string, unknown> = patch,
    ): number | null => {
        if (disposed) return null;
        const requestId = nextRequestId++;
        const timer = setTimer(() => fail(requestId), writeAckTimeoutMs);
        pending.set(requestId, { patch, timer });
        settings = Schema.clean({ ...(settings || safeFallback), ...patch });
        markApplied();
        ownerWindow.postMessage({
            __bpb: true, dir: 'toCS', kind: 'set', requestId, patch: wirePatch
        }, ownerLocation.origin);
        return requestId;
    };

    return {
        init: async (): Promise<PageSettingsValues> => {
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
        get: (): PageSettingsValues => settings || safeFallback,
        refresh: (): boolean => {
            if (disposed) return false;
            ownerWindow.postMessage({ __bpb: true, dir: 'toCS', kind: 'get' }, ownerLocation.origin);
            return true;
        },
        set,
        setTrackUnits: (value: unknown): number | null => {
            const patch = Schema.trackUnitsPatch(value);
            return Object.keys(patch).length ? set(patch, { units: value }) : null;
        },
        subscribe: (subscriber: PageSettingsSubscriber): (() => boolean) => {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
        onWriteFailed: (subscriber: PageSettingsWriteFailureSubscriber): (() => boolean) => {
            writeFailureSubscribers.add(subscriber);
            return () => writeFailureSubscribers.delete(subscriber);
        },
        dispose: (): void => {
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

export type PageSettingsClient = ReturnType<typeof createPageSettingsClient>;

export const pageSettingsClient = { create: createPageSettingsClient };
