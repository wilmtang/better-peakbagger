/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-page browser tests' loaders for the extension's options pages: the
// packaged HTML in a fixture frame at a stable test origin, with the stubbed
// extension API and the built head and page bundles, as the pages load them.
// Files using these declare `// @browser-origin https://options.better-peakbagger.test`.

import { afterEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout as nextTask } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChromeStub, type PageChrome, type Values } from './chrome-stub.mts';
import { FixtureDom, evalBundle } from './fixture-dom.mts';
import { accelerateTimeout, waitFor, type LoadedPage, type PageWindow } from './fixture-page.mts';

export { accelerateTimeout, evalBundle, makeChromeStub, waitFor };

export const OPTIONS_ORIGIN = 'https://options.better-peakbagger.test';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const optionsCss = await readFile(path.join(root, 'options', 'options.css'), 'utf8');
export const climberPageFixture = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-home.html'), 'utf8');
export const buddyPageFixture = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'report-buddy-list.html'), 'utf8');
export const favoriteKey = 'bpbFavoriteClimbers';
export const buddyCacheKey = 'bpbBuddyCache';

export interface OptionsPage extends LoadedPage {
    initialTheme?: string | null;
    githubPollDelays?: number[];
}

let currentFilePages: Set<OptionsPage> | null = null;

export const registerCleanup = () => {
    const filePages = new Set<OptionsPage>();
    afterEach(async () => {
        // Let callbacks a test left queued finish before its pages close.
        await nextTask(0);
        for (const dom of filePages) dom.window.close();
        filePages.clear();
    });
    currentFilePages = filePages;
    return filePages;
};

export const favoriteStore = (entries: unknown[] = []) => ({ schemaVersion: 1, entries });

// A real response, as the page's fetch would receive it.
export const pageResponse = (text: string, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(text, { status, headers });
export const peakbaggerFetch = ({ climberCid = 900002 } = {}) => async (rawUrl: RequestInfo | URL) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === '/report/report.aspx') return pageResponse(buddyPageFixture);
    if (/\/climber\/climber\.aspx$/i.test(url.pathname)) {
        return pageResponse(climberPageFixture.replaceAll('900001', String(climberCid)));
    }
    return pageResponse('', 404);
};

export const makeCacheStorage = (initial: Record<string, number | null> = {}) => {
    const entries = new Map(Object.entries(initial));
    const cache = {
        async keys() { return Array.from(entries.keys(), url => ({ url })); },
        async match(request: string | { url: string }) {
            const size = entries.get(typeof request === 'string' ? request : request.url);
            if (size === undefined) return undefined;
            return { headers: { get: (name: string) => name === 'x-bpb-size' && size !== null ? String(size) : null } };
        },
    };
    return {
        entries,
        keyCalls: 0,
        async keys() {
            this.keyCalls++;
            return entries.size ? ['bpb-mapterhorn-dem-v1'] : [];
        },
        async open() { return cache; },
    };
};

interface ExtensionPageOptions {
    local?: Values;
    prepareChrome?: ((chrome: PageChrome) => void) | null;
    prepareWindow?: ((window: PageWindow) => void) | null;
}

async function openExtensionPage(page: string, settings: Values, { local = {}, prepareChrome = null }: ExtensionPageOptions,
    hash = ''): Promise<OptionsPage> {
    const html = await readFile(path.join(root, 'options', page), 'utf8');
    const fixture = await FixtureDom.open(html, { url: `${OPTIONS_ORIGIN}/options/${page}${hash}` });
    const window = fixture.window as unknown as PageWindow;
    const chrome = makeChromeStub({ bpbSettings: settings }, local, {
        getSender: () => ({ url: chrome.runtime.getURL(`options/${page}`) }),
    });
    const dom: OptionsPage = { window, chrome, serialize: () => fixture.serialize() };
    currentFilePages?.add(dom);
    if (prepareChrome) prepareChrome(chrome);
    (window as { chrome?: unknown }).chrome = chrome;
    return dom;
}

export const loadOptions = async (settings: Values = {}, {
    cacheStorage = makeCacheStorage(),
    local = {},
    cachedTheme = null,
    hash = '',
    prepareChrome = null,
    prepareWindow = null,
    accelerateGithubPoll = false,
}: ExtensionPageOptions & {
    cacheStorage?: unknown;
    cachedTheme?: string | null;
    hash?: string;
    accelerateGithubPoll?: boolean;
} = {}): Promise<OptionsPage> => {
    const dom = await openExtensionPage('options.html', settings, { local, prepareChrome }, hash);
    // The page reads the terrain cache through CacheStorage; the stub replaces it.
    Object.defineProperty(dom.window, 'caches', { configurable: true, value: cacheStorage });
    if (accelerateGithubPoll) dom.githubPollDelays = accelerateTimeout(dom, 2000);
    if (prepareWindow) prepareWindow(dom.window);
    if (cachedTheme !== null) dom.window.localStorage.setItem('bpbThemePref', cachedTheme);
    // The options page loads the head bundle (settings + panel theme, pre-paint) then
    // the tail bundle (terrain-cache + the settings UI), as options.html does.
    await evalBundle(dom.window, 'options/options-head.js');
    dom.initialTheme = dom.window.document.documentElement.getAttribute('data-bpb-theme');
    await evalBundle(dom.window, 'options/options.js');
    await evalBundle(dom.window, 'options/garmin.js');
    await new Promise(resolve => dom.window.setTimeout(resolve, 20)); // S.get().then(populate)
    return dom;
};

export const el = (dom: LoadedPage, id: string) => dom.window.document.getElementById(id);
export const draftRow = (dom: LoadedPage, key: string) => Array.from(dom.window.document.querySelectorAll('.draft-item'))
    .find(row => row.dataset.draftKey === key);
export const favoriteRow = (dom: LoadedPage, cid: number | string) => Array.from(dom.window.document.querySelectorAll('.favorite-item'))
    .find(row => row.dataset.cid === String(cid));
export const readBlob = (dom: LoadedPage, blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new dom.window.FileReader();
    reader.addEventListener('load', () => resolve(reader.result as string));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
});

export const loadDraftsPage = async (settings: Values = {}, options: ExtensionPageOptions = {}) => {
    const dom = await openExtensionPage('drafts.html', settings, options);
    await evalBundle(dom.window, 'options/options-head.js');
    await evalBundle(dom.window, 'options/drafts-page.js');
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    return dom;
};

export const loadFavoritesPage = async (settings: Values = {}, options: ExtensionPageOptions = {}) => {
    const dom = await openExtensionPage('favorites.html', settings, options);
    if (options.prepareWindow) options.prepareWindow(dom.window);
    await evalBundle(dom.window, 'options/options-head.js');
    await evalBundle(dom.window, 'options/favorites-page.js');
    await new Promise(resolve => dom.window.setTimeout(resolve, 20)); // S.get().then(populate)
    return dom;
};

// A GitHub background without a network.
export const withGithubBackground = (status: unknown, { grant = true, ascentCount = 0 } = {}) => (chrome: PageChrome) => {
    chrome.permissions = { request: async () => grant, contains: async () => grant, remove: async () => true };
    chrome.runtime.sendMessage = (message, callback) => {
        let reply: unknown = {};
        if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
        if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') reply = { ok: true, count: ascentCount };
        if (typeof callback === 'function') void Promise.resolve().then(() => callback(reply));
        return Promise.resolve(reply);
    };
};

interface CreatedTab { url?: string; active?: boolean; [field: string]: unknown }
export const siteTabChrome = ({ onNavigate }: { onNavigate?: (navigation: { tabId: number; details: CreatedTab; chrome: PageChrome }) => void } = {}) =>
    (chrome: PageChrome) => {
        const created: CreatedTab[] = [];
        const removed: number[] = [];
        chrome.runtime.getURL = page => `chrome-extension://test-extension/${page}`;
        chrome.tabs = {
            create: (details: CreatedTab, callback: (tab: { id: number }) => void) => {
                created.push(details);
                callback({ id: 77 });
                onNavigate?.({ tabId: 77, details, chrome });
            },
            remove: (tabId: number, callback?: () => void) => { removed.push(tabId); callback?.(); },
            sendMessage: (_tabId: number, _message: unknown, callback: (value: unknown) => void) => callback({
                url: 'https://www.peakbagger.com/report/report.aspx?r=b',
                cache: chrome._localStore[buddyCacheKey],
            }),
        };
        chrome._siteTab = { created, removed };
    };

export const buddyCacheFrom = () => ({
    ownerCid: 900001,
    fetchedAt: Date.now(),
    entries: Array.from({ length: 6 }, (_, index) => ({
        cid: 910000 + index,
        name: `Fallback Buddy ${index}`,
    })),
});

// A cookie-blocked extension fetch can look signed out. Managed challenges
// also recover through a first-party helper tab.
export const signedOutFetch = () => async () => pageResponse('', 401);
