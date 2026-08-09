// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — device-local ImgBB API-key storage.

import { imgbbClient as ImgbbClient } from './imgbb-client.js';
import { storageValue as StorageValue } from '../storage/storage-value.js';

const STORAGE_KEY = 'bpbImgbbAuth';

const resolveLocalArea = () => {
    const api = typeof browser !== 'undefined' && browser.storage ? browser
        : typeof chrome !== 'undefined' && chrome.storage ? chrome
            : null;
    return api?.storage?.local || null;
};

const createKeyStore = (area = resolveLocalArea()) => {
    let mutationQueue = Promise.resolve();
    const read = async () => {
        if (!area) throw new Error('ImgBB credential storage is unavailable.');
        const result = await area.get(STORAGE_KEY);
        const value = result?.[STORAGE_KEY];
        const key = ImgbbClient.cleanKey(value?.key);
        return key ? {
            key,
            savedAt: typeof value.savedAt === 'string' ? value.savedAt : null,
        } : null;
    };
    const mutate = operation => {
        const pending = mutationQueue.then(operation);
        mutationQueue = pending.catch(() => {});
        return pending;
    };
    const cleanRecord = value => {
        if (value == null) return null;
        const key = ImgbbClient.cleanKey(value?.key);
        if (!key) throw new TypeError('ImgBB key is invalid.');
        return {
            key,
            savedAt: typeof value.savedAt === 'string' ? value.savedAt : null,
        };
    };
    const replace = value => {
        const next = cleanRecord(value);
        return mutate(async () => {
            if (!area) throw new Error('ImgBB credential storage is unavailable.');
            if (next == null) await area.remove(STORAGE_KEY);
            else await area.set({ [STORAGE_KEY]: next });
            return next;
        });
    };
    const replaceIfCurrent = (expected, replacement) => {
        const expectedRecord = cleanRecord(expected);
        const next = cleanRecord(replacement);
        return mutate(async () => {
            const current = await read();
            if (!StorageValue.same(current, expectedRecord)) {
                return { replaced: false, current };
            }
            if (next == null) await area.remove(STORAGE_KEY);
            else await area.set({ [STORAGE_KEY]: next });
            return { replaced: true, current: next };
        });
    };
    return {
        read,
        getKey: async () => (await read())?.key || null,
        setKey: async (key, savedAt = new Date().toISOString()) => {
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
