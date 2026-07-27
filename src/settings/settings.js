// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared settings storage.
// Loaded into every isolated-world content script (theme, bridge, filter), the
// options page, and the background worker, where extension storage is
// available. It is NOT usable from the page MAIN world (the GPX analyzer),
// which reaches settings through the bridge (src/settings/bridge.js) instead.
//
// The schema itself — defaults, bounds, and validators — lives in the pure
// src/settings/settings-schema.js. ES-module imports carry it into this module and into
// the MAIN-world bundles that validate settings without storage access. This
// file adds only chrome.storage access on top of it.

import { settingsSchema as Schema } from './settings-schema.js';
import { themeResolve as ThemeResolve } from '../theme/theme-resolve.js';

export const STORAGE_KEY = 'bpbSettings';
const { DEFAULTS, clean } = Schema;

const resolveApi = () => {
    if (typeof browser !== 'undefined' && browser.storage) return browser;
    if (typeof chrome !== 'undefined' && chrome.storage) return chrome;
    return null;
};

const unavailable = () => new Error('Settings storage is unavailable.');

// The accessor is injectable so storage-failure and concurrency behavior can
// be exercised without a browser. get() remains fail-soft: passive rendering
// and feature gates whose defaults disable the action must survive a temporary
// sync-storage failure. Privacy gates and preservation actions use
// requireCurrent(), because defaults must never authorize capture or become a
// valid-looking backup. Mutations stay strict for the same preservation reason.
export const createSettingsStore = ({
    area = resolveApi()?.storage?.sync || null,
    onChanged = resolveApi()?.storage?.onChanged || null,
    sendMessage = resolveApi()?.runtime?.sendMessage
        ? message => resolveApi().runtime.sendMessage(message)
        : null,
} = {}) => {
    let mutationQueue = Promise.resolve();

    const read = async () => {
        if (!area) throw unavailable();
        const res = await area.get(STORAGE_KEY);
        return clean(res && res[STORAGE_KEY]);
    };

    const get = async () => {
        try {
            return await read();
        } catch {
            return { ...DEFAULTS };
        }
    };

    // Background-owned read-modify-write operation. The worker calls this for
    // SETTINGS_PATCH messages, serializing patches from every extension
    // context in one queue. Keeping this public also gives non-browser tests a
    // strict mutation path without pretending a worker exists.
    const applyPatch = patch => {
        const operation = mutationQueue.then(async () => {
            const current = await read();
            const next = clean({
                ...current,
                ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
            });
            await area.set({ [STORAGE_KEY]: next });
            return next;
        });
        mutationQueue = operation.catch(() => {});
        return operation;
    };

    const set = async patch => {
        if (typeof sendMessage !== 'function') {
            throw new Error('The settings worker route is unavailable.');
        }
        const response = await sendMessage({ type: 'SETTINGS_PATCH', patch });
        if (response?.ok && response.settings) return clean(response.settings);
        const message = response?.error?.message || 'The setting could not be saved.';
        throw new Error(message);
    };

    // Fires cb(settings) whenever the stored settings change (e.g. from the
    // options page or another tab). Returns an unsubscribe function.
    const subscribe = cb => {
        if (!onChanged) return () => {};
        const handler = (changes, areaName) => {
            if ((areaName === 'sync' || areaName === undefined) && changes[STORAGE_KEY]) {
                cb(clean(changes[STORAGE_KEY].newValue));
            }
        };
        onChanged.addListener(handler);
        return () => onChanged.removeListener(handler);
    };

    return {
        STORAGE_KEY,
        DEFAULTS,
        clean,
        get,
        requireCurrent: read,
        set,
        applyPatch,
        subscribe,
        resolveTheme: preference => ThemeResolve.resolve(preference),
    };
};

export const settings = createSettingsStore();
