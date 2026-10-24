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
import { storageValue as StorageValue } from '../storage/storage-value.js';

export const STORAGE_KEY = 'bpbSettings';
export const DEVICE_STORAGE_KEY = 'bpbDeviceSettings';
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
    localArea = resolveApi()?.storage?.local || null,
    onChanged = resolveApi()?.storage?.onChanged || null,
    sendMessage = resolveApi()?.runtime?.sendMessage
        ? message => resolveApi().runtime.sendMessage(message)
        : null,
} = {}) => {
    let mutationQueue = Promise.resolve();
    let firstRead;

    const readSnapshot = async (syncedOverride, migratePersonal = false) => {
        if (!area || !localArea) throw unavailable();
        const [synced, local] = await Promise.all([
            syncedOverride || area.get(STORAGE_KEY), localArea.get([DEVICE_STORAGE_KEY, 'bpbGithubAuth', ...(migratePersonal ? Schema.PERSONAL_KEYS : [])]),
        ]);
        const raw = synced?.[STORAGE_KEY] || {};
        const installed = local?.[DEVICE_STORAGE_KEY];
        if (installed !== undefined && (installed?.schemaVersion !== 1 || !installed.settings
            || typeof installed.settings !== 'object' || Array.isArray(installed.settings))) throw unavailable();
        const device = installed?.schemaVersion === 1 ? installed.settings : null;
        // An existing local connection preserves the old installation's choices.
        // A fresh device cannot inherit automatic-transfer consent from sync.
        const connected = !!(local?.bpbGithubAuth?.token && local.bpbGithubAuth.repo);
        const merged = { ...raw };
        for (const key of Schema.DEVICE_KEYS) merged[key] = device
            ? device[key]
            : Schema.TRANSFER_KEYS.includes(key) && !connected ? DEFAULTS[key]
                : raw[key] ?? (connected && key.startsWith('auto') && key !== 'autoGithubBackup' ? true : DEFAULTS[key]);
        for (const key of Schema.PERSONAL_KEYS) {
            if (!Object.hasOwn(raw, key) && local?.[key] !== undefined) merged[key] = local[key];
        }
        return { current: clean(merged), raw, installed };
    };
    const read = async ({ includeLegacy = false } = {}) => {
        const { current } = await readSnapshot(undefined, includeLegacy);
        firstRead ??= current;
        return current;
    };
    const write = async (next, snapshot, migration = false) => {
        const device = { schemaVersion: 1, settings: Object.fromEntries(Schema.DEVICE_KEYS.map(key => [key, next[key]])) };
        // Installation must not publish a new default-filled sync item before
        // the browser has downloaded this account's existing preferences.
        const synced = Object.fromEntries(Object.entries(next).filter(([key, value]) => !Schema.DEVICE_KEYS.includes(key)
            && (!migration || Object.hasOwn(snapshot.raw, key) || (Schema.PERSONAL_KEYS.includes(key) && value != null))));
        const deviceChanged = !StorageValue.same(device, snapshot.installed);
        if (deviceChanged) await localArea.set({ [DEVICE_STORAGE_KEY]: device });
        try {
            if (!StorageValue.same(synced, snapshot.raw)) await area.set({ [STORAGE_KEY]: synced });
        } catch (error) {
            // The worker queue owns local settings, so no newer local patch can
            // be lost while reverting a failed two-area write.
            if (deviceChanged) {
                if (snapshot.installed === undefined) await localArea.remove(DEVICE_STORAGE_KEY);
                else await localArea.set({ [DEVICE_STORAGE_KEY]: snapshot.installed });
            }
            throw error;
        }
        return next;
    };

    // Legacy UI preferences are read separately: a slow preference read must
    // never delay an authoritative feature/privacy gate.
    const preferences = async keys => {
        const requested = Array.isArray(keys) ? keys : [keys];
        if (requested.some(key => !Schema.PERSONAL_KEYS.includes(key))) throw unavailable();
        const synced = await area.get(STORAGE_KEY);
        const raw = synced?.[STORAGE_KEY] || {};
        const missing = requested.filter(key => !Object.hasOwn(raw, key));
        const legacy = missing.length ? await localArea.get(Array.isArray(keys) ? missing : missing[0]) : {};
        const merged = { ...legacy, ...raw };
        return clean(merged);
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
    const applyPatch = (patch, { onlyIfUnset = false, migration = false } = {}) => {
        const operation = mutationQueue.then(async () => {
            const snapshot = await readSnapshot(undefined, true);
            const { current } = snapshot;
            const proposed = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
            const updates = Object.fromEntries(Object.entries(proposed).filter(([key]) => !onlyIfUnset || current[key] == null));
            if (onlyIfUnset && !Object.keys(updates).length) return current;
            const next = clean({ ...current, ...updates });
            await write(next, snapshot, migration);
            return next;
        });
        mutationQueue = operation.catch(() => {});
        return operation;
    };

    // Compare and replace inside the same queue as ordinary SETTINGS_PATCH
    // writes. Manual file import uses this to restore its snapshot only while
    // no newer settings mutation has won.
    const replaceIfCurrent = (expected, replacement) => {
        const operation = mutationQueue.then(async () => {
            const snapshot = await readSnapshot(undefined, true);
            const { current } = snapshot;
            if (!StorageValue.same(current, clean(expected))) {
                return { replaced: false, current };
            }
            const next = clean(replacement);
            await write(next, snapshot);
            return { replaced: true, current: next };
        });
        mutationQueue = operation.catch(() => {});
        return operation;
    };

    const set = async (patch, { onlyIfUnset = false } = {}) => {
        if (typeof sendMessage !== 'function') {
            throw new Error('The settings worker route is unavailable.');
        }
        const response = await sendMessage({ type: 'SETTINGS_PATCH', patch, ...(onlyIfUnset ? { onlyIfUnset: true } : {}) });
        if (response?.ok && response.settings) return clean(response.settings);
        const message = response?.error?.message || 'The setting could not be saved.';
        throw new Error(message);
    };

    // Fires cb(settings) whenever the stored settings change (e.g. from the
    // options page or another tab). Returns an unsubscribe function.
    const subscribe = cb => {
        if (!onChanged) return () => {};
        let generation = 0, published;
        const handler = (changes, areaName) => {
            if (((areaName === 'sync' || areaName === undefined) && changes[STORAGE_KEY])
                || (areaName === 'local' && changes[DEVICE_STORAGE_KEY])) {
                const revision = ++generation;
                const synced = areaName !== 'local' ? { [STORAGE_KEY]: changes[STORAGE_KEY].newValue } : undefined;
                return readSnapshot(synced).then(({ current }) => {
                    if (revision !== generation) return;
                    // Moving unchanged defaults to the local record is not a
                    // newer user choice. In particular, it must not suppress
                    // the error/rollback of a simultaneous portable write.
                    const previous = published ?? firstRead;
                    published = current;
                    if (areaName !== 'local' || !StorageValue.same(current, previous)) cb(current);
                }, () => {});
            }
        };
        onChanged.addListener(handler);
        return () => onChanged.removeListener(handler);
    };

    return {
        STORAGE_KEY, DEVICE_STORAGE_KEY,
        migrate: () => applyPatch({}, { migration: true }),
        DEFAULTS,
        clean,
        get,
        requireCurrent: read, preferences,
        set,
        applyPatch,
        replaceIfCurrent,
        subscribe,
        resolveTheme: preference => ThemeResolve.resolve(preference),
    };
};

export const settings = createSettingsStore();
