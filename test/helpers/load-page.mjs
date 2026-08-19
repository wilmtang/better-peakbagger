// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: load a Peakbagger fixture into jsdom, stub chrome.storage, and
// run the extension against it by evaluating the *built* content-script bundles
// (dist/…) — the same self-contained IIFE files the browser loads. Evaluating
// the shipped bundle keeps the harness faithful across the ES-module migration:
// bundle output is an IIFE whether the source modules are IIFEs or ES modules,
// so a test names the page's bundles rather than a hand-kept list of src files.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createFavoritesStore, favoritesStore } from '../../src/background/favorites-store.js';
import { settingsSchema } from '../../src/settings/settings-schema.js';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(root, 'test', 'fixtures', 'peakascents');
export const PAGE_FIXTURES = path.join(root, 'test', 'fixtures', 'pages');
export const DIST = path.join(root, 'dist');

// Evaluate one or more built bundles (dist-relative paths) into a window or
// vm-style context, in order. `npm test` runs `npm run build` first,
// so dist/ is always current.
export const evalBundle = async (target, ...bundles) => {
    for (const rel of bundles) {
        target.eval(await readFile(path.join(DIST, rel), 'utf8'));
    }
};

// Minimal in-memory chrome.storage.sync + onChanged, enough for settings.js.
export const makeChromeStub = (initial = {}, localInitial = {}) => {
    const store = { ...initial };
    const localStore = { ...localInitial };
    const listeners = new Set();
    const makeStorageArea = (values, area) => ({
        get: async key => {
            if (key === null) return { ...values };
            if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, values[item]]));
            if (key && typeof key === 'object') return Object.fromEntries(
                Object.entries(key).map(([item, fallback]) => [item, values[item] ?? fallback]));
            return { [key]: values[key] };
        },
        set: async obj => {
            const changes = {};
            for (const [key, value] of Object.entries(obj)) {
                changes[key] = { oldValue: values[key], newValue: value };
                values[key] = value;
            }
            for (const fn of listeners) fn(changes, area);
        },
        remove: async key => {
            const keys = Array.isArray(key) ? key : [key];
            const changes = {};
            for (const item of keys) {
                if (!(item in values)) continue;
                changes[item] = { oldValue: values[item], newValue: undefined };
                delete values[item];
            }
            if (Object.keys(changes).length) for (const fn of listeners) fn(changes, area);
        }
    });
    const chrome = {
        _store: store,
        _localStore: localStore,
        _favoriteMutations: [],
        storage: {
            sync: makeStorageArea(store, 'sync'),
            local: makeStorageArea(localStore, 'local'),
            onChanged: {
                addListener: fn => listeners.add(fn),
                removeListener: fn => listeners.delete(fn)
            }
        },
        // A built content-script bundle carries every module the page injects,
        // so idle siblings (e.g. ascent-draft) touch chrome.runtime at load even
        // when the test only drives one feature. Mirror the page's full chrome.
        runtime: {
            id: 'test-extension',
            getURL: path => `chrome-extension://test-extension/${path}`,
            getManifest: () => ({ version: '0.0.0-test' }),
            onMessage: { addListener: () => {}, removeListener: () => {} }
        }
    };
    let delegatedSendMessage = async () => undefined;
    let settingsPatchQueue = Promise.resolve();
    let draftMutationQueue = Promise.resolve();
    let draftGeneration = 0;
    let terrainActivationSequence = 0;
    const favoriteMutations = createFavoritesStore({ storage: chrome.storage.local });
    const nextDraftGeneration = () => `${Date.now()}:${++draftGeneration}:test-generation`;
    const draftMutation = message => {
        const operation = draftMutationQueue.then(async () => {
            const key = message.draftKey;
            switch (message.type) {
            case 'REPORT_DRAFT_WRITE': {
                const current = (await chrome.storage.local.get(key))[key];
                if ((typeof current?.text === 'string' && current.savedAt > message.record.savedAt)
                    || (current?.deletedGeneration && current.deletedAt >= message.record.savedAt)) {
                    return { ok: true, draftKey: key, written: false, reason: 'superseded' };
                }
                const record = structuredClone(message.record);
                record.storageGeneration = nextDraftGeneration();
                await chrome.storage.local.set({ [key]: record });
                return { ok: true, draftKey: key, written: true, record };
            }
            case 'REPORT_DRAFT_REMOVE':
                await chrome.storage.local.remove(key);
                return { ok: true, draftKey: key };
            case 'REPORT_DRAFT_DELETE': {
                const current = (await chrome.storage.local.get(key))[key];
                const currentGeneration = current?.storageGeneration || null;
                if (!current || typeof current.text !== 'string'
                    || current.savedAt !== message.expectedSavedAt
                    || currentGeneration !== message.expectedGeneration) {
                    return { ok: true, draftKey: key, deleted: false, reason: 'changed' };
                }
                const generation = nextDraftGeneration();
                await chrome.storage.local.set({
                    [key]: { deletedGeneration: generation, deletedAt: Date.now() },
                });
                return { ok: true, draftKey: key, deleted: true, generation, record: current };
            }
            case 'REPORT_DRAFT_RESTORE': {
                const current = (await chrome.storage.local.get(key))[key];
                if (current?.deletedGeneration !== message.generation) {
                    return { ok: true, draftKey: key, restored: false, reason: 'changed' };
                }
                const record = structuredClone(message.record);
                record.storageGeneration = nextDraftGeneration();
                await chrome.storage.local.set({ [key]: record });
                return { ok: true, draftKey: key, restored: true, record };
            }
            case 'REPORT_DRAFT_DELETE_MANY': {
                const results = [];
                for (const entry of message.entries) {
                    const current = (await chrome.storage.local.get(entry.draftKey))[entry.draftKey];
                    const currentGeneration = current?.storageGeneration || null;
                    if (!current || typeof current.text !== 'string'
                        || current.savedAt !== entry.expectedSavedAt
                        || currentGeneration !== entry.expectedGeneration) {
                        results.push({ ok: true, draftKey: entry.draftKey, deleted: false, reason: 'changed' });
                        continue;
                    }
                    const generation = nextDraftGeneration();
                    await chrome.storage.local.set({
                        [entry.draftKey]: { deletedGeneration: generation, deletedAt: Date.now() },
                    });
                    results.push({
                        ok: true,
                        draftKey: entry.draftKey,
                        deleted: true,
                        generation,
                        record: current,
                    });
                }
                return { ok: true, results };
            }
            case 'REPORT_DRAFT_RESTORE_MANY': {
                const results = [];
                for (const entry of message.entries) {
                    const current = (await chrome.storage.local.get(entry.draftKey))[entry.draftKey];
                    if (current?.deletedGeneration !== entry.generation) {
                        results.push({ ok: true, draftKey: entry.draftKey, restored: false, reason: 'changed' });
                        continue;
                    }
                    const record = structuredClone(entry.record);
                    record.storageGeneration = nextDraftGeneration();
                    await chrome.storage.local.set({ [entry.draftKey]: record });
                    results.push({ ok: true, draftKey: entry.draftKey, restored: true, record });
                }
                return { ok: true, results };
            }
            case 'REPORT_DRAFT_FINALIZE_DELETE': {
                const current = (await chrome.storage.local.get(key))[key];
                if (current?.deletedGeneration !== message.generation) return { ok: true, finalized: false };
                await chrome.storage.local.remove(key);
                return { ok: true, finalized: true };
            }
            case 'REPORT_DRAFT_FINALIZE_DELETE_MANY': {
                for (const entry of message.entries) {
                    const current = (await chrome.storage.local.get(entry.draftKey))[entry.draftKey];
                    if (current?.deletedGeneration === entry.generation) {
                        await chrome.storage.local.remove(entry.draftKey);
                    }
                }
                return { ok: true };
            }
            case 'REPORT_DRAFT_PRUNE': {
                const now = Date.now();
                const drafts = Object.entries(localStore)
                    .filter(([, value]) => value && typeof value.savedAt === 'number');
                const expired = drafts.filter(([, value]) => now - value.savedAt > 14 * 24 * 60 * 60 * 1000);
                const fresh = drafts.filter(([, value]) => now - value.savedAt <= 14 * 24 * 60 * 60 * 1000)
                    .sort((a, b) => b[1].savedAt - a[1].savedAt);
                const doomed = [...expired, ...fresh.slice(30)].map(([item]) => item)
                    .filter(item => item !== message.keepKey);
                await chrome.storage.local.remove(doomed);
                return { ok: true, removed: doomed };
            }
            default: return null;
            }
        });
        draftMutationQueue = operation.catch(() => {});
        return operation;
    };
    const DRAFT_MUTATION_TYPES = new Set([
        'REPORT_DRAFT_WRITE', 'REPORT_DRAFT_REMOVE', 'REPORT_DRAFT_DELETE',
        'REPORT_DRAFT_RESTORE', 'REPORT_DRAFT_DELETE_MANY', 'REPORT_DRAFT_RESTORE_MANY',
        'REPORT_DRAFT_FINALIZE_DELETE', 'REPORT_DRAFT_FINALIZE_DELETE_MANY', 'REPORT_DRAFT_PRUNE',
    ]);
    const routedSendMessage = (message, callback) => {
        let operation;
        if (message?.type === favoritesStore.MESSAGE_TYPE) {
            chrome._favoriteMutations.push(structuredClone(message.mutation));
            operation = favoriteMutations.mutate(message.mutation);
        } else if (DRAFT_MUTATION_TYPES.has(message?.type)) {
            operation = draftMutation(message);
        } else if (message?.type === 'SETTINGS_PATCH') {
            operation = settingsPatchQueue.then(async () => {
                const current = settingsSchema.clean(store.bpbSettings);
                const next = settingsSchema.clean({ ...current, ...(message.patch || {}) });
                await chrome.storage.sync.set({ bpbSettings: next });
                return { ok: true, settings: next };
            });
            settingsPatchQueue = operation.catch(() => {});
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
        if (typeof callback === 'function') operation.then(callback);
        return operation;
    };
    // Tests may replace sendMessage to script feature-specific worker replies.
    // Keep settings and favorites writes owned by worker-like queues regardless,
    // then delegate every other message to the test's handler.
    Object.defineProperty(chrome.runtime, 'sendMessage', {
        configurable: true,
        get: () => routedSendMessage,
        set: value => { delegatedSendMessage = value; },
    });
    return chrome;
};

// jsdom's public dispatchEvent can only mint untrusted events, but the upload
// flow's swap guard keys on event.isTrusted (a user-initiated file pick). Fire
// a trusted event through jsdom's internal dispatch helper; the paths are
// internals pinned by the jsdom version in package-lock, so a jsdom upgrade
// that moves them fails here loudly rather than silently skipping the guard.
export const fireTrustedEvent = (element, type, attributes = { bubbles: true }) => {
    const { fireAnEvent } = require(path.join(root, 'node_modules/jsdom/lib/jsdom/living/helpers/events.js'));
    const { implForWrapper } = require(path.join(root, 'node_modules/jsdom/lib/generated/idl/utils.js'));
    fireAnEvent(type, implForWrapper(element), undefined, attributes);
};

export const waitFor = async (dom, predicate, ms = 5000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > ms) throw new Error('waitFor timed out');
        await new Promise(resolve => dom.window.setTimeout(resolve, 5));
    }
};

// Keep timer-driven behavior under test without paying production wall-clock
// delays. The caller still asserts the requested delay, so changing the runtime
// contract fails instead of silently making the test fast for the wrong timer.
export const accelerateTimeout = (dom, expectedDelay) => {
    const requested = [];
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay = 0, ...args) => {
        if (delay === expectedDelay) {
            requested.push(delay);
            return nativeSetTimeout(callback, 0, ...args);
        }
        return nativeSetTimeout(callback, delay, ...args);
    };
    return requested;
};

export const loadPage = async (fixture, {
    url,
    settings = {},
    local = {},
    bundles = ['content/ascent-filter.js'],
    fixtures = FIXTURES,
    prepare = null
} = {}) => {
    const html = await readFile(path.join(fixtures, fixture), 'utf8');
    // pretendToBeVisual provides requestAnimationFrame, which the bundled
    // editor libraries (ProseMirror, CodeMirror) schedule their work through.
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    // The same libraries measure the DOM through layout APIs jsdom does not
    // implement; zero-size answers are fine because no test asserts geometry.
    const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    dom.window.Range.prototype.getClientRects = () => [];
    dom.window.Range.prototype.getBoundingClientRect = zeroRect;
    if (!dom.window.document.elementFromPoint) {
        dom.window.document.elementFromPoint = () => null;
    }
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local);
    dom.window.chrome = dom.chrome;
    if (prepare) prepare(dom);
    await evalBundle(dom.window, ...bundles);
    return dom;
};

// Shorthand: load and wait for the filter bar to be injected.
export const loadPageWithBar = async (fixture, opts) => {
    const dom = await loadPage(fixture, opts);
    await waitFor(dom, () => dom.window.document.getElementById('pbaf-bar'));
    return dom;
};
