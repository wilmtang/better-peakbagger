// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The extension API stub page tests run with: in-memory chrome.storage with
// onChanged, and a runtime.sendMessage that routes settings, favorites,
// ignored-climber, buddy and report-draft writes through the production
// worker-side stores, delegating every other message to the test's handler.

import { createSettingsStore } from '../../src/settings/settings.ts';
import { createFavoritesStore, favoritesStore } from '../../src/background/favorites-store.ts';
import { createIgnoredStore } from '../../src/background/ignored-store.ts';
import { createBuddyStore } from '../../src/background/buddy-store.ts';
import { BUDDY_MESSAGE } from '../../src/favorites/buddy-state.ts';
import { BUDDY_CACHE_MESSAGE } from '../../src/favorites/buddy-cache.ts';
import { createBuddyCacheStore } from '../../src/background/buddy-cache-store.ts';
import { createReportDraftRoutes } from '../../src/background/report-draft-routes.ts';
import { isPeakbaggerSenderUrl } from '../../src/peakbagger/peakbagger-origin.ts';
import { settingsSchema } from '../../src/settings/settings-schema.ts';
import type { ChromeStub, StoredRecord, StubArea, StubMessage } from './page-types.mts';

export type Values = Record<string, unknown>;
type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type StorageListener = (changes: StorageChanges, area: string) => unknown;
interface Sender { url?: string; tab?: { id?: number } }
type Reply = (response: unknown) => void;
type SendMessage = (message: StubMessage, callback?: Reply) => unknown;

export interface PageChrome extends ChromeStub {
    _favoriteMutations: unknown[];
    storage: ChromeStub['storage'] & {
        onChanged: { addListener(listener: StorageListener): void; removeListener(listener: StorageListener): void };
    };
    runtime: ChromeStub['runtime'] & {
        id: string;
        getURL(file: string): string;
        getManifest(): { version: string };
        // Reads route settings, favorites and drafts to worker-like stores;
        // assigning replaces the handler for every other message.
        sendMessage: SendMessage;
    };
}

// Minimal in-memory chrome.storage.sync + onChanged, enough for settings.js.
export const makeChromeStub = (initial: Record<string, Values | undefined> = {}, localInitial: Values = {},
    { getSender = () => ({}) }: { getSender?: () => Sender } = {}): PageChrome => {
    const store: Values = { ...initial };
    const localStore: Values = { ...(settingsSchema.DEVICE_KEYS.some(key => Object.hasOwn(initial.bpbSettings || {}, key))
        ? { bpbDeviceSettings: { schemaVersion: 1, settings: Object.fromEntries(settingsSchema.DEVICE_KEYS.map(key => [key, (settingsSchema.clean(initial.bpbSettings) as Values)[key]])) } } : {}), ...localInitial };
    const listeners = new Set<StorageListener>();
    const makeStorageArea = (values: Values, area: string): StubArea => ({
        get: async (key?: string | string[] | Values | null) => {
            if (key === null) return { ...values };
            if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, values[item]]));
            if (key && typeof key === 'object') return Object.fromEntries(
                Object.entries(key).map(([item, fallback]) => [item, values[item] ?? fallback]));
            return { [key as string]: values[key as string] };
        },
        set: async (obj: Values) => {
            const changes: StorageChanges = {};
            for (const [key, value] of Object.entries(obj)) {
                changes[key] = { oldValue: values[key], newValue: value };
                values[key] = value;
            }
            await Promise.all([...listeners].map(fn => fn(changes, area)));
        },
        remove: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            const changes: StorageChanges = {};
            for (const item of keys) {
                if (!(item in values)) continue;
                changes[item] = { oldValue: values[item], newValue: undefined };
                delete values[item];
            }
            if (Object.keys(changes).length) for (const fn of listeners) fn(changes, area);
        }
    });
    const chrome = {
        _store: store as Record<string, StoredRecord>,
        _localStore: localStore as Record<string, StoredRecord>,
        _favoriteMutations: [] as unknown[],
        storage: {
            sync: makeStorageArea(store, 'sync'),
            local: makeStorageArea(localStore, 'local'),
            onChanged: {
                addListener: (fn: StorageListener) => { listeners.add(fn); },
                removeListener: (fn: StorageListener) => { listeners.delete(fn); }
            }
        },
        // A built content-script bundle carries every module the page injects,
        // so idle siblings (e.g. ascent-draft) touch chrome.runtime at load even
        // when the test only drives one feature. Mirror the page's full chrome.
        runtime: {
            id: 'test-extension',
            getURL: (file: string) => `chrome-extension://test-extension/${file}`,
            getManifest: () => ({ version: '0.0.0-test' }),
            onMessage: { addListener: () => {}, removeListener: () => {} }
        }
    };
    let delegatedSendMessage: SendMessage = async () => undefined;
    // The stub areas implement only the calls these stores make.
    type StoreOptions = NonNullable<Parameters<typeof createSettingsStore>[0]>;
    const settingsStore = createSettingsStore({ area: chrome.storage.sync as unknown as StoreOptions['area'],
        localArea: chrome.storage.local as unknown as StoreOptions['localArea'], sendMessage: null });
    let terrainActivationSequence = 0;
    // The JavaScript factory's parameter type is inferred from its `= {}` default.
    const favoriteMutations = (createFavoritesStore as unknown as (options: { storage: StubArea }) => ReturnType<typeof createFavoritesStore>)(
        { storage: chrome.storage.local });
    const ignoredMutations = createIgnoredStore({ storage: chrome.storage.local });
    const buddyMutations = createBuddyStore({ storage: chrome.storage.local,
        settings: async () => settingsSchema.clean(store.bpbSettings) });
    const buddyCache = createBuddyCacheStore({ storage: chrome.storage.local });
    // Exercise the production mutation queue and identity/tombstone rules.
    // Save-confirmation lifecycle messages remain explicitly delegated below.
    const draftRoutes = createReportDraftRoutes({
        ext: chrome,
        now: Date.now,
        isPeakbaggerSender: (sender: Sender) => !!sender?.tab && isPeakbaggerSenderUrl(sender.url),
        isExtensionPage: (sender: Sender) => !!sender?.url?.startsWith(chrome.runtime.getURL('')),
        mutateMap: () => { throw new Error('Save-confirmation routes must use the fixture delegate'); },
    });
    const draftHandlers = draftRoutes.handlers as Record<string, (message: StubMessage, sender: Sender) => Promise<unknown>>;
    const DRAFT_MUTATION_TYPES = new Set([
        'REPORT_DRAFT_WRITE', 'REPORT_DRAFT_REMOVE', 'REPORT_DRAFT_DELETE',
        'REPORT_DRAFT_RESTORE', 'REPORT_DRAFT_DELETE_MANY', 'REPORT_DRAFT_RESTORE_MANY',
        'REPORT_DRAFT_FINALIZE_DELETE', 'REPORT_DRAFT_FINALIZE_DELETE_MANY', 'REPORT_DRAFT_PRUNE',
    ]);
    const routedSendMessage: SendMessage = (message, callback) => {
        let operation: Promise<unknown>;
        if (message?.type === BUDDY_CACHE_MESSAGE) {
            operation = buddyCache.action(message);
        } else if (message?.type === BUDDY_MESSAGE) {
            operation = buddyMutations.action(message, { tab: { id: 1 } });
        } else if (message?.type === 'IGNORED_MUTATE') {
            operation = ignoredMutations.mutate(message.mutation);
        } else if (message?.type === 'PEAK_REPORT_PREFERENCE') {
            operation = ignoredMutations.preference(message.favoritesOnly);
        } else if (message?.type === favoritesStore.MESSAGE_TYPE) {
            chrome._favoriteMutations.push(structuredClone(message.mutation));
            operation = favoriteMutations.mutate(message.mutation);
        } else if (message?.type && DRAFT_MUTATION_TYPES.has(message.type)) {
            operation = draftHandlers[message.type]!(message, getSender());
        } else if (message?.type === 'SETTINGS_PATCH') {
            operation = settingsStore.applyPatch(message.patch, { onlyIfUnset: message.onlyIfUnset as boolean | undefined }).then(settings => ({ ok: true, settings }));
        } else if (message?.type === 'TERRAIN_ACTIVATION_ISSUE'
            && (message.action === 'init' || message.action === 'prefetch')) {
            terrainActivationSequence++;
            operation = Promise.resolve({
                ok: true,
                token: `test-terrain-activation-${terrainActivationSequence}`,
                expiresAt: Date.now() + 5000,
            });
        } else if (message?.type === 'GPX_PROCESS_INVALIDATE') {
            operation = Promise.resolve(delegatedSendMessage(message)).then(response => response ?? {
                ok: true,
                pageSessionId: message.pageSessionId,
                selectionGeneration: message.selectionGeneration,
                fileIdentity: structuredClone(message.fileIdentity),
            });
        } else {
            return delegatedSendMessage(message, callback);
        }
        if (typeof callback === 'function') void operation.then(callback);
        return operation;
    };
    // Tests may replace sendMessage to script feature-specific worker replies.
    // Keep settings and favorites writes owned by worker-like queues regardless,
    // then delegate every other message to the test's handler.
    Object.defineProperty(chrome.runtime, 'sendMessage', {
        configurable: true,
        get: () => routedSendMessage,
        set: (value: SendMessage) => { delegatedSendMessage = value; },
    });
    // defineProperty above supplies runtime.sendMessage, which completes PageChrome.
    return chrome as unknown as PageChrome;
};
