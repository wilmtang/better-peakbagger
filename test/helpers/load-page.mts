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
import { createSettingsStore } from '../../src/settings/settings.js';
import { createFavoritesStore, favoritesStore } from '../../src/background/favorites-store.js';
import { createIgnoredStore } from '../../src/background/ignored-store.js';
import { createBuddyStore } from '../../src/background/buddy-store.js';
import { BUDDY_MESSAGE } from '../../src/favorites/buddy-state.js';
import { BUDDY_CACHE_MESSAGE } from '../../src/favorites/buddy-cache.js';
import { createBuddyCacheStore } from '../../src/background/buddy-cache-store.js';
import { createReportDraftRoutes } from '../../src/background/report-draft-routes.js';
import { isPeakbaggerSenderUrl } from '../../src/peakbagger/peakbagger-origin.js';
import { settingsSchema } from '../../src/settings/settings-schema.ts';
import type { ChromeStub, PageDocument, StoredRecord, StubArea, StubMessage, TestWindow } from './page-types.mts';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(root, 'test', 'fixtures', 'peakascents');
export const PAGE_FIXTURES = path.join(root, 'test', 'fixtures', 'pages');
export const DIST = path.join(root, 'dist');

type Values = Record<string, unknown>;
type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type StorageListener = (changes: StorageChanges, area: string) => unknown;
interface Sender { url?: string; tab?: { id: number } }
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

// A jsdom page whose document lookups are typed as this repository's known
// fixture markup (see page-types.mts), plus the extension stub it runs with.
export type PageWindow = Omit<TestWindow, 'document' | 'chrome'> & { document: PageDocument; chrome: PageChrome };
export interface LoadedPage extends Omit<JSDOM, 'window'> {
    readonly window: PageWindow;
    chrome: PageChrome;
}

// Anything with an `eval`, such as a jsdom window or a vm-style context.
interface EvalTarget { eval(source: string): unknown }

// Evaluate one or more built bundles (dist-relative paths) into a window or
// vm-style context, in order. `npm test` runs `npm run build` first,
// so dist/ is always current.
export const evalBundle = async (target: EvalTarget, ...bundles: string[]): Promise<void> => {
    for (const rel of bundles) {
        target.eval(await readFile(path.join(DIST, rel), 'utf8'));
    }
};

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

// jsdom's public dispatchEvent can only mint untrusted events, but the upload
// flow's swap guard keys on event.isTrusted (a user-initiated file pick). Fire
// a trusted event through jsdom's internal dispatch helper. These internals
// have no published types; this is the one local declaration of the parts used,
// pinned to the jsdom major in package-lock, so an upgrade that moves them
// fails here loudly rather than silently skipping the guard.
const JSDOM_INTERNALS_MAJOR = 30;
interface JsdomEventInternals {
    fireAnEvent(type: string, target: object, eventInterface: object | undefined, attributes: Record<string, unknown>): boolean;
}
interface JsdomWrapperInternals { implForWrapper(wrapper: object): object }
const jsdomInternal = <T, >(file: string): T => {
    const { version } = require(path.join(root, 'node_modules/jsdom/package.json')) as { version: string };
    if (Number.parseInt(version, 10) !== JSDOM_INTERNALS_MAJOR) {
        throw new Error(`fireTrustedEvent is declared against jsdom ${JSDOM_INTERNALS_MAJOR}, found ${version}.`);
    }
    return require(path.join(root, 'node_modules/jsdom/lib', file)) as T;
};

export const fireTrustedEvent = (element: EventTarget, type: string, attributes: Record<string, unknown> = { bubbles: true }): void => {
    const { fireAnEvent } = jsdomInternal<JsdomEventInternals>('jsdom/living/helpers/events.js');
    const { implForWrapper } = jsdomInternal<JsdomWrapperInternals>('generated/idl/utils.js');
    const eventInterface = /^(?:auxclick|click|dblclick|mousedown|mouseup|mousemove)$/.test(type)
        ? jsdomInternal<object>('generated/idl/MouseEvent.js')
        : /^(?:keydown|keyup)$/.test(type)
            ? jsdomInternal<object>('generated/idl/KeyboardEvent.js')
            : undefined;
    fireAnEvent(type, implForWrapper(element), eventInterface, attributes);
};

interface TimerWindow { setTimeout: (handler: (...args: never[]) => void, delay?: number, ...args: unknown[]) => unknown }

export const waitFor = async (dom: { window: TimerWindow }, predicate: () => unknown, ms = 5000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > ms) throw new Error('waitFor timed out');
        await new Promise<void>(resolve => { dom.window.setTimeout(resolve, 5); });
    }
};

// Keep timer-driven behavior under test without paying production wall-clock
// delays. The caller still asserts the requested delay, so changing the runtime
// contract fails instead of silently making the test fast for the wrong timer.
export const accelerateTimeout = (dom: { window: Pick<TestWindow, 'setTimeout'> }, expectedDelay: number): number[] => {
    const requested: number[] = [];
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = ((callback: TimerHandler, delay = 0, ...args: unknown[]) => {
        if (delay === expectedDelay) {
            requested.push(delay);
            return nativeSetTimeout(callback, 0, ...args);
        }
        return nativeSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    return requested;
};

export interface LoadPageOptions {
    url?: string;
    settings?: Values;
    local?: Values;
    bundles?: string[];
    fixtures?: string;
    prepare?: ((dom: LoadedPage) => void) | null;
}

export const loadPage = async (fixture: string, {
    url,
    settings = {},
    local = {},
    bundles = ['content/ascent-filter.js'],
    fixtures = FIXTURES,
    prepare = null
}: LoadPageOptions = {}): Promise<LoadedPage> => {
    const html = await readFile(path.join(fixtures, fixture), 'utf8');
    // pretendToBeVisual provides requestAnimationFrame, which the bundled
    // editor libraries (ProseMirror, CodeMirror) schedule their work through.
    const jsdom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const dom = jsdom as unknown as LoadedPage;
    // The same libraries measure the DOM through layout APIs jsdom does not
    // implement; zero-size answers are fine because no test asserts geometry.
    const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
    jsdom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    jsdom.window.Range.prototype.getBoundingClientRect = zeroRect;
    if (!jsdom.window.document.elementFromPoint) {
        jsdom.window.document.elementFromPoint = () => null;
    }
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local, {
        getSender: () => ({ url: jsdom.window.location.href, tab: { id: 1 } }),
    });
    (jsdom.window as { chrome?: unknown }).chrome = dom.chrome;
    if (prepare) prepare(dom);
    await evalBundle(jsdom.window, ...bundles);
    return dom;
};

// Shorthand: load and wait for the filter bar to be injected.
export const loadPageWithBar = async (fixture: string, opts?: LoadPageOptions): Promise<LoadedPage> => {
    const dom = await loadPage(fixture, opts);
    await waitFor(dom, () => dom.window.document.getElementById('pbaf-bar'));
    return dom;
};
