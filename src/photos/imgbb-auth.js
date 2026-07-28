// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — device-local ImgBB API-key storage.

import { imgbbClient as ImgbbClient } from './imgbb-client.js';

const STORAGE_KEY = 'bpbImgbbAuth';

const resolveLocalArea = () => {
    const api = typeof browser !== 'undefined' && browser.storage ? browser
        : typeof chrome !== 'undefined' && chrome.storage ? chrome
            : null;
    return api?.storage?.local || null;
};

const createKeyStore = (area = resolveLocalArea()) => {
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
    return {
        read,
        getKey: async () => (await read())?.key || null,
        setKey: async (key, savedAt = new Date().toISOString()) => {
            if (!area) throw new Error('ImgBB credential storage is unavailable.');
            const cleaned = ImgbbClient.cleanKey(key);
            if (!cleaned) throw new TypeError('ImgBB key is invalid.');
            await area.set({ [STORAGE_KEY]: { key: cleaned, savedAt } });
            return { configured: true, savedAt };
        },
        clear: async () => {
            if (!area) throw new Error('ImgBB credential storage is unavailable.');
            await area.remove(STORAGE_KEY);
        },
    };
};

const keyStore = createKeyStore();

export const imgbbAuth = {
    STORAGE_KEY,
    createKeyStore,
    keyStore,
};
