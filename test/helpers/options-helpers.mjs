// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared helpers for options pages tests

import { afterEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { accelerateTimeout, makeChromeStub, waitFor, evalBundle } from '../helpers/load-page.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const optionsCss = await readFile(path.join(root, 'options', 'options.css'), 'utf8');
export const climberPageFixture = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-home.html'), 'utf8');
export const buddyPageFixture = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'report-buddy-list.html'), 'utf8');
export const favoriteKey = 'bpbFavoriteClimbers';
export const buddyCacheKey = 'bpbBuddyCache';
let currentFilePages = null;

export const registerCleanup = () => {
    const filePages = new Set();
    afterEach(async () => {
        const livePages = Array.from(filePages).filter(dom => dom.window?.document);
        await Promise.all(livePages.map(dom =>
            new Promise(resolve => dom.window.setTimeout(resolve, 0))));
        for (const dom of livePages) dom.window.close();
        filePages.clear();
    });
    currentFilePages = filePages;
    return filePages;
};

const trackPage = dom => {
    if (currentFilePages) {
        currentFilePages.add(dom);
    }
    return dom;
};

export const favoriteStore = (entries = []) => ({ schemaVersion: 1, entries });
export const pageResponse = (text, status = 200, headers = {}) => ({
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null, ...headers },
    text: async () => text
});
export const peakbaggerFetch = ({ climberCid = 900002 } = {}) => async rawUrl => {
    const url = new URL(String(rawUrl));
    if (url.pathname === '/report/report.aspx') return pageResponse(buddyPageFixture);
    if (/\/climber\/climber\.aspx$/i.test(url.pathname)) {
        return pageResponse(climberPageFixture.replaceAll('900001', String(climberCid)));
    }
    return pageResponse('', 404);
};

export const makeCacheStorage = (initial = {}) => {
    const entries = new Map(Object.entries(initial));
    const cache = {
        async keys() { return Array.from(entries.keys(), url => ({ url })); },
        async match(request) {
            const size = entries.get(typeof request === 'string' ? request : request.url);
            if (size === undefined) return undefined;
            return { headers: { get: name => name === 'x-bpb-size' && size !== null ? String(size) : null } };
        }
    };
    return {
        entries,
        keyCalls: 0,
        async keys() {
            this.keyCalls++;
            return entries.size ? ['bpb-mapterhorn-dem-v1'] : [];
        },
        async open() { return cache; }
    };
};

export const loadOptions = async (settings = {}, {
    cacheStorage = makeCacheStorage(),
    local = {},
    cachedTheme = null,
    hash = '',
    prepareChrome = null,
    prepareWindow = null,
    accelerateGithubPoll = false
} = {}) => {
    const html = await readFile(path.join(root, 'options', 'options.html'), 'utf8');
    const dom = new JSDOM(html, {
        // jsdom treats extension URLs as opaque origins, unlike real browsers,
        // so use a stable test origin to exercise the synchronous theme mirror.
        // A hash lets a test load the page as a deep link (#section).
        url: `https://options.better-peakbagger.test/options/options.html${hash}`,
        runScripts: 'outside-only'
    });
    trackPage(dom);
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local);
    if (prepareChrome) prepareChrome(dom.chrome);
    dom.window.chrome = dom.chrome;
    dom.window.caches = cacheStorage;
    if (accelerateGithubPoll) dom.githubPollDelays = accelerateTimeout(dom, 2000);
    if (prepareWindow) prepareWindow(dom.window);
    if (cachedTheme !== null) dom.window.localStorage.setItem('bpbThemePref', cachedTheme);
    // The options page loads the head bundle (settings + panel theme, pre-paint) then
    // the tail bundle (terrain-cache + the settings UI), as options.html does.
    await evalBundle(dom.window, 'options/options-head.js');
    dom.initialTheme = dom.window.document.documentElement.getAttribute('data-bpb-theme');
    await evalBundle(dom.window, 'options/options.js');
    await new Promise(r => dom.window.setTimeout(r, 20)); // S.get().then(populate)
    return dom;
};

export const el = (dom, id) => dom.window.document.getElementById(id);
export const draftRow = (dom, key) => Array.from(dom.window.document.querySelectorAll('.draft-item'))
    .find(row => row.dataset.draftKey === key);
export const favoriteRow = (dom, cid) => Array.from(dom.window.document.querySelectorAll('.favorite-item'))
    .find(row => row.dataset.cid === String(cid));
export const readBlob = (dom, blob) => new Promise((resolve, reject) => {
    const reader = new dom.window.FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
});

export const loadDraftsPage = async (settings = {}, { local = {}, prepareChrome = null } = {}) => {
    const html = await readFile(path.join(root, 'options', 'drafts.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://options.better-peakbagger.test/options/drafts.html',
        runScripts: 'outside-only'
    });
    trackPage(dom);
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local);
    if (prepareChrome) prepareChrome(dom.chrome);
    dom.window.chrome = dom.chrome;
    await evalBundle(dom.window, 'options/options-head.js');
    await evalBundle(dom.window, 'options/drafts-page.js');
    await new Promise(r => dom.window.setTimeout(r, 20));
    return dom;
};

export const loadFavoritesPage = async (settings = {}, { local = {}, prepareChrome = null, prepareWindow = null } = {}) => {
    const html = await readFile(path.join(root, 'options', 'favorites.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://options.better-peakbagger.test/options/favorites.html',
        runScripts: 'outside-only'
    });
    trackPage(dom);
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local);
    if (prepareChrome) prepareChrome(dom.chrome);
    dom.window.chrome = dom.chrome;
    if (prepareWindow) prepareWindow(dom.window);
    await evalBundle(dom.window, 'options/options-head.js');
    await evalBundle(dom.window, 'options/favorites-page.js');
    await new Promise(r => dom.window.setTimeout(r, 20)); // S.get().then(populate)
    return dom;
};

// jsdom without a browser or network.
export const withGithubBackground = (status, { grant = true, ascentCount = 0 } = {}) => chrome => {
    chrome.permissions = { request: async () => grant, contains: async () => grant, remove: async () => true };
    chrome.runtime.sendMessage = (message, callback) => {
        let reply = {};
        if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
        if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') reply = { ok: true, count: ascentCount };
        if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
        return Promise.resolve(reply);
    };
};

export const siteTabChrome = ({ onNavigate } = {}) => chrome => {
    const created = [];
    const removed = [];
    chrome.runtime.getURL = page => `chrome-extension://test-extension/${page}`;
    chrome.tabs = {
        create: (details, callback) => {
            created.push(details);
            callback({ id: 77 });
        },
        update: (tabId, details, callback) => {
            callback?.();
            onNavigate?.({ tabId, details, chrome });
        },
        remove: (tabId, callback) => { removed.push(tabId); callback?.(); },
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

// A 401 is what a cookie-blocked extension fetch looks like, and it is the only
// failure that opens the helper tab.
export const signedOutFetch = () => async () => pageResponse('', 401);

export { waitFor, accelerateTimeout, makeChromeStub, evalBundle };
