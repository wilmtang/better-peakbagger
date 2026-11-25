// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — device-local ImgBB API-key storage.

import { imgbbClient as ImgbbClient } from './imgbb-client.ts';
import { storageValue as StorageValue } from '../storage/storage-value.ts';

export interface ImgbbStorageArea {
    get(keys: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string): Promise<void>;
}

export interface ImgbbAuthRecord {
    key: string;
    savedAt: string | null;
}

export interface ImgbbAuthReplaceResult {
    replaced: boolean;
    current: ImgbbAuthRecord | null;
}

export interface ImgbbKeyStatus {
    configured: boolean;
    savedAt: string;
}

export interface ImgbbKeyStore {
    read(): Promise<ImgbbAuthRecord | null>;
    getKey(): Promise<string | null>;
    setKey(key: unknown, savedAt?: string): Promise<ImgbbKeyStatus>;
    clear(): Promise<ImgbbAuthRecord | null>;
    replace(value: unknown): Promise<ImgbbAuthRecord | null>;
    replaceIfCurrent(expected: unknown, replacement: unknown): Promise<ImgbbAuthReplaceResult>;
}

interface StorageHost {
    storage?: {
        local?: ImgbbStorageArea;
    };
}

const STORAGE_KEY = 'bpbImgbbAuth';

const resolveLocalArea = (): ImgbbStorageArea | null => {
    const scope = globalThis as typeof globalThis & {
        browser?: StorageHost;
        chrome?: StorageHost;
    };
    const api = scope.browser?.storage ? scope.browser
        : scope.chrome?.storage ? scope.chrome
            : null;
    return api?.storage?.local || null;
};

const createKeyStore = (area: ImgbbStorageArea | null = resolveLocalArea()): ImgbbKeyStore => {
    let mutationQueue: Promise<unknown> = Promise.resolve();
    const read = async (): Promise<ImgbbAuthRecord | null> => {
        if (!area) throw new Error('ImgBB credential storage is unavailable.');
        const result = await area.get(STORAGE_KEY);
        const value = result?.[STORAGE_KEY];
        const record = value && typeof value === 'object' ? value as { key?: unknown; savedAt?: unknown } : null;
        const key = ImgbbClient.cleanKey(record?.key);
        return key ? {
            key,
            savedAt: typeof record?.savedAt === 'string' ? record.savedAt : null,
        } : null;
    };
    const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = mutationQueue.then(operation);
        mutationQueue = pending.catch(() => {});
        return pending;
    };
    const cleanRecord = (value: unknown): ImgbbAuthRecord | null => {
        if (value == null) return null;
        const record = typeof value === 'object' ? value as { key?: unknown; savedAt?: unknown } : null;
        const key = ImgbbClient.cleanKey(record?.key);
        if (!key) throw new TypeError('ImgBB key is invalid.');
        return {
            key,
            savedAt: typeof record?.savedAt === 'string' ? record.savedAt : null,
        };
    };
    const replace = (value: unknown): Promise<ImgbbAuthRecord | null> => {
        const next = cleanRecord(value);
        return mutate(async () => {
            if (!area) throw new Error('ImgBB credential storage is unavailable.');
            if (next == null) await area.remove(STORAGE_KEY);
            else await area.set({ [STORAGE_KEY]: next });
            return next;
        });
    };
    const replaceIfCurrent = (expected: unknown, replacement: unknown): Promise<ImgbbAuthReplaceResult> => {
        const expectedRecord = cleanRecord(expected);
        const next = cleanRecord(replacement);
        return mutate(async () => {
            const current = await read();
            if (!StorageValue.same(current, expectedRecord)) {
                return { replaced: false, current };
            }
            if (!area) throw new Error('ImgBB credential storage is unavailable.');
            if (next == null) await area.remove(STORAGE_KEY);
            else await area.set({ [STORAGE_KEY]: next });
            return { replaced: true, current: next };
        });
    };
    return {
        read,
        getKey: async () => (await read())?.key || null,
        setKey: async (key: unknown, savedAt = new Date().toISOString()) => {
            const cleaned = ImgbbClient.cleanKey(key);
            if (!cleaned) throw new TypeError('ImgBB key is invalid.');
            await replace({ key: cleaned, savedAt });
            return { configured: true, savedAt };
        },
        clear: () => replace(null),
        replace,
        replaceIfCurrent,
    };
};

const keyStore = createKeyStore();

export const imgbbAuth = {
    STORAGE_KEY,
    createKeyStore,
    keyStore,
};
