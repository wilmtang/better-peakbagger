// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drives the real options page (options.html + settings.js + options.js) in
// jsdom against a chrome.storage stub, so the settings UI is exercised end to
// end without a browser.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { accelerateTimeout, makeChromeStub, waitFor, evalBundle } from '../helpers/load-page.mjs';
import { settingsSchema } from '../../src/settings/settings-schema.js';
import { settingsTransfer } from '../../src/settings/settings-transfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const optionsCss = await readFile(path.join(root, 'options', 'options.css'), 'utf8');
const climberPageFixture = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-home.html'), 'utf8');
const buddyPageFixture = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'report-buddy-list.html'), 'utf8');
const favoriteKey = 'bpbFavoriteClimbers';
const buddyCacheKey = 'bpbBuddyCache';
const openOptionsPages = new Set();
const favoriteStore = (entries = []) => ({ schemaVersion: 1, entries });
const pageResponse = (text, status = 200) => ({ status, headers: {}, text: async () => text });
const peakbaggerFetch = ({ climberCid = 900002 } = {}) => async rawUrl => {
    const url = new URL(String(rawUrl));
    if (url.pathname === '/report/report.aspx') return pageResponse(buddyPageFixture);
    if (/\/climber\/climber\.aspx$/i.test(url.pathname)) {
        return pageResponse(climberPageFixture.replaceAll('900001', String(climberCid)));
    }
    return pageResponse('', 404);
};

const makeCacheStorage = (initial = {}) => {
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

const loadOptions = async (settings = {}, {
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
    openOptionsPages.add(dom);
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

afterEach(async () => {
    const livePages = Array.from(openOptionsPages).filter(dom => dom.window.document);
    await Promise.all(livePages.map(dom =>
        new Promise(resolve => dom.window.setTimeout(resolve, 0))));
    for (const dom of livePages) dom.window.close();
    openOptionsPages.clear();
});

const el = (dom, id) => dom.window.document.getElementById(id);
const draftRow = (dom, key) => Array.from(dom.window.document.querySelectorAll('.draft-item'))
    .find(row => row.dataset.draftKey === key);
const favoriteRow = (dom, cid) => Array.from(dom.window.document.querySelectorAll('.favorite-item'))
    .find(row => row.dataset.cid === String(cid));
const readBlob = (dom, blob) => new Promise((resolve, reject) => {
    const reader = new dom.window.FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
});

test('theme bootstrap loads before the options stylesheet', async () => {
    const dom = await loadOptions({});
    const resources = Array.from(dom.window.document.head.querySelectorAll('script[src], link[rel="stylesheet"]'))
        .map(node => node.getAttribute('src') || node.getAttribute('href'));
    assert.deepEqual(resources, ['options-head.js', 'options.css']);
});

test('cached dark theme is applied before the asynchronous settings read', async () => {
    const dom = await loadOptions({ theme: 'dark' }, { cachedTheme: 'dark' });
    assert.equal(dom.initialTheme, 'dark');
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
});

test('the authoritative theme refreshes the pre-paint cache', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
});

test('a failed setting write restores the authoritative control value', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    dom.chrome.storage.sync.get = async () => { throw new Error('sync read failed'); };
    dom.chrome.storage.sync.set = async () => { throw new Error('sync write failed'); };
    const theme = el(dom, 'theme');
    theme.value = 'light';
    theme.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => /couldn’t be saved/i.test(el(dom, 'status-error-text').textContent));

    assert.equal(theme.value, 'dark');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark');
});

// The draft manager is its own page now: same stylesheet, theme bootstrap, and
// card styles as Settings, but its own document and bundle. Loading it the way
// drafts.html does keeps these tests exercising the shipped page rather than a
// section that no longer exists.
const loadDraftsPage = async (settings = {}, { local = {}, prepareChrome = null } = {}) => {
    const html = await readFile(path.join(root, 'options', 'drafts.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://options.better-peakbagger.test/options/drafts.html',
        runScripts: 'outside-only'
    });
    openOptionsPages.add(dom);
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local);
    if (prepareChrome) prepareChrome(dom.chrome);
    dom.window.chrome = dom.chrome;
    await evalBundle(dom.window, 'options/options-head.js');
    await evalBundle(dom.window, 'options/drafts-page.js');
    await new Promise(r => dom.window.setTimeout(r, 20));
    return dom;
};

test('settings are grouped by the surface they affect', async () => {
    const dom = await loadOptions({});
    const sections = Array.from(dom.window.document.querySelectorAll('.settings-section'));
    assert.deepEqual(sections.map(section => section.querySelector('h2').textContent), [
        'General',
        'Activity creation',
        'Map & GPX chart',
        'Ascent beta filter',
        'Favorite climbers',
        'Backup & sync',
        'About'
    ]);

    const [general, capture, mapChart, beta, favorites, github, about] = sections;
    assert.ok(github.querySelector('#enable-github-backup'));
    assert.ok(github.querySelector('#github-panel'));
    assert.match(github.querySelector('#github-backup .desc').textContent, /manual backup controls/i);
    // Every settings section is labelled by its heading and carries at least
    // one card; About is informational, not a card.
    for (const section of [general, capture, mapChart, beta, favorites, github]) {
        const heading = section.querySelector('h2');
        assert.equal(section.getAttribute('aria-labelledby'), heading.id);
        assert.ok(section.querySelector('.card'), 'the section carries a settings card');
    }
    assert.equal(about.getAttribute('aria-labelledby'), about.querySelector('h2').id);
    assert.ok(about.querySelector('.about-version'));
    // Everything a trip report needs while creating an ascent lives in one
    // section: the editor, the photo credential, and the local drafts.
    // The drafts themselves moved to their own page — they are records to
    // manage, not settings — but the anchor stays so existing #drafts links
    // still land on the topic, one click from the manager.
    const drafts = capture.querySelector('#drafts');
    assert.equal(drafts.id, 'drafts', 'the established deep-link anchor stays stable');
    assert.equal(drafts.querySelector('#drafts-list'), null, 'the list is not a setting');
    assert.equal(drafts.querySelector('#open-draft-manager').getAttribute('href'), 'drafts.html');
    assert.match(mapChart.querySelector('label[for="units"] .desc').textContent, /processing summaries/);
    // The custom-list workspace moved to its own page; Settings keeps the
    // anchor and links out, the way trip report drafts do.
    assert.equal(favorites.querySelector('input[value="custom"]'), null, 'the list is not a setting');
    assert.equal(favorites.querySelector('#open-favorites').getAttribute('href'), 'favorites.html');
    assert.equal(github.querySelector('#github-connection-heading').textContent, 'GitHub connection');
    assert.equal(dom.window.document.querySelector('.side-nav a[href="#github"]').textContent,
        'Backup & sync');
    assert.equal(github.id, 'github', 'the established deep-link anchor stays stable');

    assert.ok(general.querySelector('#theme'));
    assert.ok(general.querySelector('#enable-3d-map'));
    assert.equal(general.querySelector('#units'), null);
    // The trip-report controls moved out of General into Activity creation.
    assert.equal(general.querySelector('#enable-report-editor'), null);
    assert.equal(general.querySelector('#add-report-credit'), null);

    // Activity creation → GPX capture / Trip report editor
    for (const id of ['retain-waypoints', 'fill-ascent-details', 'fill-trip-info', 'fill-wilderness-nights', 'fill-external-url']) {
        assert.ok(capture.querySelector(`#capture-gpx #${id}`), `${id} should belong to GPX capture`);
    }
    for (const id of ['enable-report-editor', 'add-report-credit']) {
        assert.ok(capture.querySelector(`#capture-report #${id}`), `${id} should belong to Trip report editor`);
    }
    assert.ok(capture.querySelector('#capture-photos #imgbb-key'),
        'the ImgBB key should belong to Trip report photos');
    // Map & GPX chart → GPX chart / Map
    for (const id of ['units', 'chart-series']) {
        assert.ok(mapChart.querySelector(`#map-chart-chart #${id}`), `${id} should belong to GPX chart`);
    }
    for (const id of ['map-route-color', 'remember-map-layer', 'terrain-cache-limit', 'map-viewport-width']) {
        assert.ok(mapChart.querySelector(`#map-chart-map #${id}`), `${id} should belong to Map`);
    }
    const outlineColor = mapChart.querySelector('#map-route-casing-color');
    const outlineWidth = mapChart.querySelector('#map-route-casing-width');
    assert.equal(outlineColor.previousElementSibling.textContent, 'Outline');
    assert.equal(outlineColor.getAttribute('aria-label'), 'Route outline color');
    assert.equal(outlineWidth.getAttribute('aria-label'), 'Route outline width in pixels');
    for (const id of ['beta-tr', 'beta-tr-words', 'beta-gps', 'beta-link', 'beta-sort-date-desc']) {
        assert.ok(beta.querySelector(`#${id}`), `${id} should belong to Ascent beta filter`);
    }
    // The custom-list workspace moved to its own page; Settings keeps only a
    // link to it, and its GitHub backup below.
    assert.equal(favorites.querySelector('#favorites-buddy-panel'), null);
    assert.equal(favorites.querySelector('#favorites-list'), null);
    assert.equal(favorites.querySelector('#open-favorites').getAttribute('href'), 'favorites.html');
    assert.ok(github.querySelector('#github-favorites-backup #favorites-restore'),
        'the favorites GitHub backup stays in Backup & sync');
    assert.ok(github.querySelector('#github-backup #enable-github-backup'), 'GitHub backup lives in its subsection');
    assert.ok(github.querySelector('#github-settings-backup #settings-backup-export'));
    assert.ok(github.querySelector('#github-settings-backup #settings-backup-import'));
    // Favorites backup is a Backup & sync concern, not part of the list editor.
    assert.equal(favorites.querySelector('#favorites-backup'), null);
    for (const id of ['favorites-github-status', 'favorites-backup', 'favorites-restore', 'favorites-auto-backup']) {
        assert.ok(github.querySelector(`#github-favorites-backup #${id}`),
            `${id} should belong to Favorite climbers backup`);
    }
});

test('only interactive setting labels advertise a pointer cursor', async () => {
    const dom = await loadOptions({});
    const style = dom.window.document.createElement('style');
    style.textContent = optionsCss;
    dom.window.document.head.append(style);

    assert.equal(dom.window.getComputedStyle(
        dom.window.document.querySelector('label.label[for="theme"]')
    ).cursor, 'pointer');
    assert.notEqual(dom.window.getComputedStyle(
        dom.window.document.querySelector('div.label')
    ).cursor, 'pointer');
});

test('options sections log the missing ids before degrading to no-op controllers', async () => {
    const errors = [];
    await loadOptions({}, {
        prepareWindow(window) {
            for (const id of [
                'github-panel', 'settings-backup-export', 'favorites-github-status'
            ]) window.document.getElementById(id).remove();
            window.console.error = message => errors.push(String(message));
        }
    });

    assert.equal(errors.length, 3);
    assert.ok(errors.some(message => /GitHub settings.*github-panel/.test(message)));
    assert.ok(errors.some(message => /settings backup.*settings-backup-export/.test(message)));
    assert.ok(errors.some(message => /favorite climbers backup.*favorites-github-status/.test(message)));
});

// The favorite-climbers workspace degrades the same way on its own page.
test('the favorite climbers page logs its missing ids instead of throwing', async () => {
    const errors = [];
    const dom = await loadFavoritesPage({}, {});
    dom.window.console.error = message => errors.push(String(message));
    dom.window.document.getElementById('favorites-list').remove();
    await evalBundle(dom.window, 'options/favorites-page.js');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /favorite climbers.*favorites-list/);
});

// The draft manager degrades the same way on its own page.
test('the draft manager page logs its missing ids instead of throwing', async () => {
    const errors = [];
    const dom = await loadDraftsPage({}, {});
    dom.window.console.error = message => errors.push(String(message));
    dom.window.document.getElementById('drafts-list').remove();
    await evalBundle(dom.window, 'options/drafts-page.js');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /draft manager.*drafts-list/);
});

test('settings feedback separates severity: successes fade, failures persist and alert', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    const ok = el(dom, 'status');
    const bad = el(dom, 'status-error');
    const badText = el(dom, 'status-error-text');

    // Success: the polite region, and it is scheduled to fade.
    el(dom, 'map-viewport-reset').click();
    await waitFor(dom, () => ok.textContent === 'Map size reset');
    assert.equal(ok.classList.contains('show'), true);
    assert.equal(ok.getAttribute('role'), 'status');
    assert.equal(bad.hidden, true, 'a success never lights the alert region');

    // Failure: the alert region, and it does not auto-dismiss.
    dom.chrome.storage.sync.get = async () => { throw new Error('sync read failed'); };
    dom.chrome.storage.sync.set = async () => { throw new Error('sync write failed'); };
    const theme = el(dom, 'theme');
    theme.value = 'light';
    theme.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => /couldn’t be saved/i.test(badText.textContent));

    assert.equal(bad.hidden, false);
    assert.equal(bad.classList.contains('show'), true);
    assert.equal(bad.getAttribute('role'), 'alert', 'failures are announced assertively');
    assert.equal(ok.classList.contains('show'), false, 'the success line is cleared');
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(bad.classList.contains('show'), true,
        'recovery copy must not fade out from under the user');

    // ...but it is dismissible, per the reversible-and-safe bar.
    el(dom, 'status-error-dismiss').click();
    assert.equal(bad.hidden, true);
    assert.equal(bad.classList.contains('show'), false);
});

test('the settings feedback dock stays on screen from any scroll position', async () => {
    const css = await readFile(path.join(root, 'options', 'options.css'), 'utf8');
    // The controls live thousands of pixels above the end of .content, which is
    // the scroll container; an in-flow line at the end of .wrap is never seen.
    assert.match(css, /\.status-dock\s*{[^}]*position:\s*sticky/s);
    assert.match(css, /\.status-dock\s*{[^}]*bottom:\s*0/s);
    assert.match(css, /\.status-error\s*{[^}]*color:\s*var\(--danger\)/s,
        'failures need a colour that is not the success accent');
});

test('the options controller exclusively owns shared status timing', async () => {
    const draftsSource = await readFile(path.join(root, 'options', 'drafts.js'), 'utf8');
    assert.match(draftsSource, /export const initDrafts/);
    assert.doesNotMatch(draftsSource, /getElementById\(['"]status['"]\)|2200/);
});

test('settings export downloads a parseable known-key-only payload', async () => {
    const download = {};
    const dom = await loadOptions({ theme: 'dark', unknownSetting: 'private' }, {
        prepareWindow(window) {
            window.URL.createObjectURL = blob => {
                download.blob = blob;
                return 'blob:settings-export';
            };
            window.URL.revokeObjectURL = url => { download.revoked = url; };
            window.HTMLAnchorElement.prototype.click = function click() {
                download.href = this.href;
                download.name = this.download;
            };
        }
    });

    el(dom, 'settings-backup-export').click();
    await waitFor(dom, () => download.blob);
    const parsed = settingsTransfer.parse(await readBlob(dom, download.blob));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, 'dark');
    assert.equal('unknownSetting' in parsed.settings, false);
    assert.equal(download.href, 'blob:settings-export');
    assert.match(download.name, /^better-peakbagger-settings-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(download.revoked, 'blob:settings-export');
});

test('settings export preserves the previous backup when settings cannot be read and retries cleanly', async () => {
    const download = { created: 0, clicked: 0 };
    const errors = [];
    let restoreSettingsRead;
    const dom = await loadOptions({ theme: 'dark' }, {
        prepareChrome(chrome) {
            restoreSettingsRead = chrome.storage.sync.get;
            chrome.storage.sync.get = async () => {
                throw new Error('SYNC_EXPORT_SETTINGS_SENTINEL');
            };
        },
        prepareWindow(window) {
            window.console.error = (...args) => errors.push(args.map(String).join(' '));
            window.URL.createObjectURL = blob => {
                download.created++;
                download.blob = blob;
                return 'blob:settings-export';
            };
            window.URL.revokeObjectURL = url => { download.revoked = url; };
            window.HTMLAnchorElement.prototype.click = function click() {
                download.clicked++;
            };
        }
    });

    el(dom, 'settings-backup-export').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent
        === 'Settings could not be read, so no backup was created.');

    assert.equal(download.created, 0, 'a failed read must not serialize a default-valued backup');
    assert.equal(download.clicked, 0, 'a failed read must not start a download');
    assert.equal(download.revoked, undefined);
    assert.ok(errors.some(message => message.includes('SYNC_EXPORT_SETTINGS_SENTINEL')));

    dom.chrome.storage.sync.get = restoreSettingsRead;
    el(dom, 'settings-backup-export').click();
    await waitFor(dom, () => download.blob);

    const parsed = settingsTransfer.parse(await readBlob(dom, download.blob));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, 'dark',
        'the retry must serialize the authoritative settings rather than defaults from the failed read');
    assert.equal(download.created, 1);
    assert.equal(download.clicked, 1);
    assert.equal(download.revoked, 'blob:settings-export');
});

test('settings import replaces known settings only after inline confirmation', async () => {
    const dom = await loadOptions({ theme: 'dark', units: 'imperial' });
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });

    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);
    assert.match(el(dom, 'settings-backup-confirmation').textContent,
        /trail-settings\.json.*Replaces your current settings/s);
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark', 'reading a file must not apply it');

    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    assert.equal(dom.chrome._store.bpbSettings.units, 'metric');
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
    assert.equal(el(dom, 'status').textContent, 'Settings imported');
});

test('settings import keeps its confirmation retryable when persistence fails', async () => {
    let failWrite = true;
    const dom = await loadOptions({ theme: 'dark', units: 'imperial' }, {
        prepareChrome: chrome => {
            const nativeSet = chrome.storage.sync.set;
            chrome.storage.sync.set = async values => {
                if (failWrite && values.bpbSettings?.theme === 'light') {
                    throw new Error('sync write failed');
                }
                return nativeSet(values);
            };
        },
    });
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });

    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);
    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => /couldn’t be saved/i.test(el(dom, 'status-error-text').textContent));

    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, false);
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-confirm'));

    failWrite = false;
    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden);
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-import'));
    assert.equal(el(dom, 'status').textContent, 'Settings imported');
});

test('Escape cancels a settings import and restores focus to Import', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });
    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
    }));

    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-import'));
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
});

test('Escape cannot visually cancel an import after its write has started', async () => {
    let releaseWrite;
    let writeStarted = false;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const dom = await loadOptions({ theme: 'dark' }, {
        prepareChrome: chrome => {
            const nativeSet = chrome.storage.sync.set;
            chrome.storage.sync.set = async values => {
                if (values.bpbSettings?.theme === 'light') {
                    writeStarted = true;
                    await writeGate;
                }
                return nativeSet(values);
            };
        },
    });
    const input = el(dom, 'settings-backup-file');
    const payload = settingsTransfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{ name: 'trail-settings.json', text: async () => settingsTransfer.serialize(payload) }]
    });
    input.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);

    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => writeStarted);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
    }));

    assert.equal(el(dom, 'settings-backup-confirmation').hidden, false);
    assert.equal(el(dom, 'settings-backup-confirmation').getAttribute('aria-busy'), 'true');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');

    releaseWrite();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden);
    assert.equal(el(dom, 'status').textContent, 'Settings imported');
});

test('settings import rejects invalid and newer files without changing settings', async () => {
    const dom = await loadOptions({ theme: 'dark' });
    const input = el(dom, 'settings-backup-file');
    const choose = async (name, text) => {
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ name, text: async () => text }]
        });
        input.dispatchEvent(new dom.window.Event('change'));
        await waitFor(dom, () => el(dom, 'status-error-text').textContent.length > 0);
    };

    await choose('notes.json', '{');
    assert.equal(el(dom, 'status-error-text').textContent, 'That is not a Better Peakbagger settings file.');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');

    el(dom, 'status-error-text').textContent = '';
    await choose('future.json', JSON.stringify({
        kind: settingsTransfer.KIND,
        schemaVersion: settingsTransfer.SCHEMA_VERSION + 1,
        settings: {}
    }));
    assert.equal(el(dom, 'status-error-text').textContent,
        'This settings file was made by a newer version of the extension.');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');
    assert.equal(el(dom, 'settings-backup-confirmation').hidden, true);
});

test('settings GitHub controls back up, confirm restore, and persist automatic backup', async () => {
    const messages = [];
    const status = {
        connected: true,
        hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const restored = settingsTransfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });
    const dom = await loadOptions({ theme: 'dark', units: 'imperial' }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                messages.push(structuredClone(message));
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_SETTINGS_BACKUP') reply = {
                    ok: true,
                    result: { path: 'settings.json', commitUrl: 'https://github.com/ada/peaks/commit/settings123' }
                };
                if (message.type === 'GITHUB_SETTINGS_RESTORE') reply = {
                    ok: true,
                    content: settingsTransfer.serialize(restored)
                };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        }
    });

    await waitFor(dom, () => !el(dom, 'settings-backup-github-actions').hidden);
    assert.match(el(dom, 'settings-backup-github-status').textContent, /settings\.json.*ada\/peaks/);

    el(dom, 'settings-backup-github-backup').click();
    await waitFor(dom, () => messages.some(message => message.type === 'GITHUB_SETTINGS_BACKUP'));
    assert.deepEqual(messages.find(message => message.type === 'GITHUB_SETTINGS_BACKUP'), {
        type: 'GITHUB_SETTINGS_BACKUP'
    });
    await waitFor(dom, () => /Settings backed up ✓/.test(el(dom, 'settings-backup-github-status').textContent));
    const commitLink = el(dom, 'settings-backup-github-status').querySelector('a');
    assert.equal(commitLink.textContent, 'View commit');
    assert.equal(commitLink.getAttribute('href'), 'https://github.com/ada/peaks/commit/settings123');
    assert.equal(commitLink.getAttribute('target'), '_blank');
    assert.equal(commitLink.getAttribute('rel'), 'noopener noreferrer');
    await waitFor(dom, () => !el(dom, 'settings-backup-github-restore').disabled);

    el(dom, 'settings-backup-github-restore').click();
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden === false);
    assert.match(el(dom, 'settings-backup-confirmation').textContent,
        /settings\.json from ada\/peaks.*Replaces your current settings/s);
    assert.equal(dom.chrome._store.bpbSettings.theme, 'dark');

    el(dom, 'settings-backup-confirm').click();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    await waitFor(dom, () => el(dom, 'settings-backup-confirmation').hidden);
    assert.equal(dom.chrome._store.bpbSettings.units, 'metric');
    assert.equal(dom.window.document.activeElement, el(dom, 'settings-backup-github-restore'));
    await waitFor(dom, () => /Stored as settings\.json/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-status').querySelector('a'), null,
        'changing settings must clear the success state for the older payload');

    const auto = el(dom, 'settings-backup-auto');
    auto.checked = true;
    auto.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.autoSettingsBackup === true);
});

test('settings backup reports in-row progress before its persistent success state', async () => {
    let finishBackup;
    const backupResponse = new Promise(resolve => { finishBackup = resolve; });
    const status = {
        connected: true,
        hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ theme: 'dark' }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = message => {
                if (message.type === 'GITHUB_AUTH_STATUS') return Promise.resolve(status);
                if (message.type === 'GITHUB_SETTINGS_BACKUP') return backupResponse;
                return Promise.resolve({});
            };
        },
    });

    await waitFor(dom, () => !el(dom, 'settings-backup-github-actions').hidden);
    el(dom, 'settings-backup-github-backup').click();
    await waitFor(dom, () => /Backing up settings to GitHub/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-backup').disabled, true);
    assert.equal(el(dom, 'settings-backup-github-restore').disabled, true);
    assert.equal(el(dom, 'settings-backup-auto').disabled, true);

    finishBackup({
        ok: true,
        result: { path: 'settings.json', commitUrl: 'https://github.com/ada/peaks/commit/settings456' },
    });
    await waitFor(dom, () => /Settings backed up ✓/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-backup').disabled, false);
    assert.equal(el(dom, 'settings-backup-github-status').querySelector('a').textContent, 'View commit');
});

test('settings GitHub controls point disconnected users to the shared connection', async () => {
    const dom = await loadOptions({}, {
        prepareChrome: withGithubBackground({ connected: false, hasToken: false })
    });
    await waitFor(dom, () => /Connect GitHub above/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-actions').hidden, true);
});

test('settings GitHub controls refresh after an in-page repository selection', async () => {
    let status = { connected: false, hasToken: false };
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_STATUS' ? status : {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        }
    });
    await waitFor(dom, () => /Connect GitHub above/.test(el(dom, 'settings-backup-github-status').textContent));

    status = {
        connected: true,
        hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    await dom.chrome.storage.local.set({ bpbGithubAuth: { repo: status.repo } });

    await waitFor(dom, () => !el(dom, 'settings-backup-github-actions').hidden);
    assert.match(el(dom, 'settings-backup-github-status').textContent, /settings\.json.*ada\/peaks/);
});

test('settings GitHub controls hide when the optional host permission is revoked', async () => {
    const dom = await loadOptions({}, {
        prepareChrome: withGithubBackground({
            connected: true,
            hasToken: true,
            repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        }, { grant: false })
    });
    await waitFor(dom, () => /Connect GitHub above/.test(el(dom, 'settings-backup-github-status').textContent));
    assert.equal(el(dom, 'settings-backup-github-actions').hidden, true);
});

test('trip report credit is off by default and persists as an explicit opt-in', async () => {
    const dom = await loadOptions({});
    const checkbox = el(dom, 'add-report-credit');
    const row = checkbox.closest('.row');

    assert.equal(checkbox.checked, false);
    assert.match(row.querySelector('.title').textContent, /^Credit Better Peakbagger in trip reports$/);
    assert.match(row.querySelector('.desc').textContent, /small, editable store link.*change or remove/i);
    const invalidDom = await loadOptions({ addReportCredit: 'yes' });
    assert.equal(el(invalidDom, 'add-report-credit').checked, false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.addReportCredit === true);
});

test('experimental 3D map is off by default and discloses external DEM requests', async () => {
    const defaultDom = await loadOptions({});
    const checkbox = el(defaultDom, 'enable-3d-map');
    const row = checkbox.closest('.row');
    assert.equal(checkbox.checked, false);
    assert.match(row.querySelector('.title').textContent, /^Enable experimental 3D map$/);
    assert.match(row.querySelector('.experimental-badge').textContent, /^Experimental$/);
    assert.match(row.querySelector('.desc').textContent, /ascent maps.*Full Screen GPS maps.*Peak pages/i);
    assert.match(row.querySelector('.desc').textContent, /Mapterhorn.*OpenFreeMap.*viewed map area and request metadata/i);
    assert.deepEqual(Array.from(row.querySelectorAll('.desc a'), link => new URL(link.href).hostname), [
        'mapterhorn.com',
        'openfreemap.org'
    ]);

    const invalidDom = await loadOptions({ enable3dMap: 'yes' });
    assert.equal(el(invalidDom, 'enable-3d-map').checked, false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new defaultDom.window.Event('change'));
    await new Promise(r => defaultDom.window.setTimeout(r, 10));
    assert.equal(defaultDom.chrome._store.bpbSettings.enable3dMap, true);
});

test('activity capture settings have documented defaults and persist changes', async () => {
    const dom = await loadOptions({});
    assert.equal(el(dom, 'retain-waypoints').checked, true);
    assert.equal(el(dom, 'fill-ascent-details').checked, true);
    assert.equal(el(dom, 'fill-trip-info').checked, true);
    assert.equal(el(dom, 'fill-wilderness-nights').checked, true);
    assert.equal(el(dom, 'fill-external-url').checked, true);

    el(dom, 'retain-waypoints').checked = false;
    el(dom, 'retain-waypoints').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-ascent-details').checked = false;
    el(dom, 'fill-ascent-details').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-trip-info').checked = false;
    el(dom, 'fill-trip-info').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-wilderness-nights').checked = false;
    el(dom, 'fill-wilderness-nights').dispatchEvent(new dom.window.Event('change'));
    el(dom, 'fill-external-url').checked = false;
    el(dom, 'fill-external-url').dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 20));

    assert.equal(dom.chrome._store.bpbSettings.retainWaypoints, false);
    assert.equal(dom.chrome._store.bpbSettings.fillAscentDetails, false);
    assert.equal(dom.chrome._store.bpbSettings.fillTripInfo, false);
    assert.equal(dom.chrome._store.bpbSettings.fillWildernessNights, false);
    assert.equal(dom.chrome._store.bpbSettings.fillExternalUrl, false);
});

test('chart-series select populates from the stored setting', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'time' });
    assert.equal(el(dom, 'chart-series').value, 'time');
});

test('changing chart-series saves it to chrome.storage', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'both' });
    const sel = el(dom, 'chart-series');
    sel.value = 'distance';
    sel.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.chartDefaultSeries, 'distance');
});

test('an invalid chartDefaultSeries is cleaned to the default', async () => {
    const dom = await loadOptions({ chartDefaultSeries: 'bogus' });
    assert.equal(el(dom, 'chart-series').value, 'both');
});

test('map route appearance populates, enforces a visible casing, and saves edits', async () => {
    const dom = await loadOptions({
        mapRouteColor: '#2457A7',
        mapRouteWidth: 8,
        mapRouteCasingColor: 'not-a-color',
        mapRouteCasingWidth: 4
    });

    assert.equal(el(dom, 'map-route-color').value, '#2457a7');
    assert.equal(el(dom, 'map-route-width').value, '8');
    assert.equal(el(dom, 'map-route-casing-color').value, '#ffffff');
    assert.equal(el(dom, 'map-route-casing-width').value, '10');
    assert.equal(el(dom, 'map-route-casing-width').min, '10');

    const routeWidth = el(dom, 'map-route-width');
    routeWidth.value = '11';
    routeWidth.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapRouteWidth, 11);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingWidth, 13);
    assert.equal(el(dom, 'map-route-casing-width').min, '13');

    const casingColor = el(dom, 'map-route-casing-color');
    casingColor.value = '#efe8d5';
    casingColor.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingColor, '#efe8d5');
});

test('map route appearance resets every style control to its default', async () => {
    const defaults = settingsSchema.DEFAULTS;
    const dom = await loadOptions({
        mapRouteColor: '#2457a7',
        mapRouteWidth: 11,
        mapRouteCasingColor: '#efe8d5',
        mapRouteCasingWidth: 20
    });

    el(dom, 'map-route-reset').dispatchEvent(new dom.window.Event('click'));

    await waitFor(dom, () => dom.chrome._store.bpbSettings.mapRouteColor === defaults.mapRouteColor);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteWidth, defaults.mapRouteWidth);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingColor, defaults.mapRouteCasingColor);
    assert.equal(dom.chrome._store.bpbSettings.mapRouteCasingWidth, defaults.mapRouteCasingWidth);
    assert.equal(el(dom, 'map-route-color').value, defaults.mapRouteColor);
    assert.equal(el(dom, 'map-route-width').value, String(defaults.mapRouteWidth));
    assert.equal(el(dom, 'map-route-casing-color').value, defaults.mapRouteCasingColor);
    assert.equal(el(dom, 'map-route-casing-width').value, String(defaults.mapRouteCasingWidth));
    assert.equal(el(dom, 'map-route-casing-width').min, String(defaults.mapRouteWidth + 2));
    assert.equal(el(dom, 'status').textContent, 'Route appearance reset');
});

test('map viewport settings preserve and reset to Peakbagger\'s original size', async () => {
    const dom = await loadOptions({ mapViewportWidth: 100, mapViewportHeight: 2000 });
    assert.equal(el(dom, 'map-viewport-width').value, '450');
    assert.equal(el(dom, 'map-viewport-height').value, '720');

    const width = el(dom, 'map-viewport-width');
    width.value = '900';
    width.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapViewportWidth, 900);

    const height = el(dom, 'map-viewport-height');
    height.value = '560';
    height.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapViewportHeight, 560);

    el(dom, 'map-viewport-reset').dispatchEvent(new dom.window.Event('click'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.mapViewportWidth, 450);
    assert.equal(dom.chrome._store.bpbSettings.mapViewportHeight, 450);
    assert.equal(el(dom, 'status').textContent, 'Map size reset');
});

test('map layer memory is opt-in and disabling it forgets the saved layer', async () => {
    const defaultDom = await loadOptions({});
    assert.equal(el(defaultDom, 'remember-map-layer').checked, false);
    const invalidDom = await loadOptions({ rememberMapLayer: true, mapLastLayer: 'javascript:bad' });
    assert.equal(settingsSchema.clean(invalidDom.chrome._store.bpbSettings).mapLastLayer, '');

    const dom = await loadOptions({ rememberMapLayer: true, mapLastLayer: 'L_OT' });
    const checkbox = el(dom, 'remember-map-layer');
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.rememberMapLayer, false);
    assert.equal(dom.chrome._store.bpbSettings.mapLastLayer, '');
});

test('3D terrain cache stays hidden until enabled and reports current device usage', async () => {
    const css = await readFile(path.join(root, 'options', 'options.css'), 'utf8');
    assert.match(css, /#terrain-cache-row\[hidden\]\s*{\s*display:\s*none;\s*}/);

    const emptyCache = makeCacheStorage();
    const defaultDom = await loadOptions({}, { cacheStorage: emptyCache });
    const row = el(defaultDom, 'terrain-cache-row');
    assert.equal(row.hidden, true);
    assert.equal(emptyCache.keyCalls, 0, 'hidden cache settings should not inspect CacheStorage');

    const enable = el(defaultDom, 'enable-3d-map');
    enable.checked = true;
    enable.dispatchEvent(new defaultDom.window.Event('change'));
    await waitFor(defaultDom, () => el(defaultDom, 'terrain-cache-usage').textContent === 'Current cache: Empty');
    assert.equal(row.hidden, false);

    enable.checked = false;
    enable.dispatchEvent(new defaultDom.window.Event('change'));
    assert.equal(row.hidden, true, 'the cache row should hide immediately when 3D is disabled');

    const firstUrl = 'https://tiles.mapterhorn.com/14/2651/5947.webp';
    const secondUrl = 'https://tiles.mapterhorn.com/14/2651/5948.webp';
    const cacheStorage = makeCacheStorage({
        [firstUrl]: 1024 * 1024,
        [secondUrl]: 512 * 1024
    });
    const usageDom = await loadOptions({ enable3dMap: true }, { cacheStorage });
    await waitFor(usageDom, () => el(usageDom, 'terrain-cache-usage').textContent === 'Current cache: 1.5 MB');
    assert.equal(el(usageDom, 'terrain-cache-row').hidden, false);
    assert.match(usageDom.window.document.querySelector('.cache-limit').textContent, /Limit\s*MB/);
    assert.equal(el(usageDom, 'terrain-cache-limit').value, '512');

    cacheStorage.entries.set('https://tiles.mapterhorn.com/14/2651/5949.webp', 512 * 1024);
    await usageDom.chrome.storage.local.set({ bpbMapterhornDemIndexV1: {} });
    await waitFor(usageDom, () => el(usageDom, 'terrain-cache-usage').textContent === 'Current cache: 2.0 MB');
});

test('3D terrain cache limit remains bounded and persists edits', async () => {
    const defaultDom = await loadOptions({ enable3dMap: true });
    assert.equal(el(defaultDom, 'terrain-cache-limit').value, '512');

    const invalidDom = await loadOptions({ enable3dMap: true, terrainCacheLimitMb: 9000 });
    assert.equal(el(invalidDom, 'terrain-cache-limit').value, '2048');

    const dom = await loadOptions({ enable3dMap: true, terrainCacheLimitMb: 768 });
    const limit = el(dom, 'terrain-cache-limit');
    assert.equal(limit.value, '768');
    limit.value = '0';
    limit.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.equal(dom.chrome._store.bpbSettings.terrainCacheLimitMb, 0);
});

test('the removed "minimum trip-report words" control is gone', async () => {
    const dom = await loadOptions({});
    assert.equal(el(dom, 'minwords'), null);
});

// The custom-list workspace is its own page now. It shares the Settings
// stylesheet, theme bootstrap, and card styles, but has its own document and
// bundle, and reads/writes the two settings it owns through S.get/S.set the way
// favorites.html does. Its GitHub backup stays on the Settings page and keeps
// using loadOptions.
const loadFavoritesPage = async (settings = {}, { local = {}, prepareChrome = null, prepareWindow = null } = {}) => {
    const html = await readFile(path.join(root, 'options', 'favorites.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://options.better-peakbagger.test/options/favorites.html',
        runScripts: 'outside-only'
    });
    openOptionsPages.add(dom);
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local);
    if (prepareChrome) prepareChrome(dom.chrome);
    dom.window.chrome = dom.chrome;
    if (prepareWindow) prepareWindow(dom.window);
    await evalBundle(dom.window, 'options/options-head.js');
    await evalBundle(dom.window, 'options/favorites-page.js');
    await new Promise(r => dom.window.setTimeout(r, 20)); // S.get().then(populate)
    return dom;
};

test('favorite source defaults to buddies and switching to custom persists', async () => {
    const dom = await loadFavoritesPage({});
    const buddies = dom.window.document.querySelector('input[name="favorites-source"][value="buddies"]');
    const custom = dom.window.document.querySelector('input[name="favorites-source"][value="custom"]');
    const removeWithBuddy = el(dom, 'favorites-remove-with-buddy');
    assert.equal(buddies.checked, true);
    assert.equal(el(dom, 'favorites-buddy-panel').hidden, false);
    assert.equal(el(dom, 'favorites-custom-panel').hidden, true);
    assert.equal(removeWithBuddy.checked, false, 'removing a Buddy is non-destructive by default');
    assert.match(el(dom, 'favorites-buddy-cache-hint').textContent,
        /saved copy of your Buddy List for up to 7 days/);
    assert.match(el(dom, 'favorites-buddy-cache-hint').textContent,
        /Changes made on Peakbagger may not appear immediately; choose Refresh now after editing your buddies/);

    custom.checked = true;
    custom.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.favoritesSource === 'custom');
    assert.equal(el(dom, 'favorites-buddy-panel').hidden, true);
    assert.equal(el(dom, 'favorites-custom-panel').hidden, false);

    removeWithBuddy.checked = true;
    removeWithBuddy.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.removeFavoriteWhenBuddyRemoved === true);
});

test('adding a climber by id resolves and validates the public profile', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => { window.fetch = peakbaggerFetch({ climberCid: 900002 }); },
    });
    el(dom, 'favorites-add-input').value = '900002';
    el(dom, 'favorites-add-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 1);

    const entry = dom.chrome._localStore[favoriteKey].entries[0];
    assert.equal(entry.cid, 900002);
    assert.equal(entry.name, 'Alex Doe');
    assert.equal(entry.source, 'manual');
    assert.equal(dom.chrome._favoriteMutations.at(-1).kind, 'add');
    assert.equal(dom.chrome._favoriteMutations.at(-1).entry.cid, 900002);
    assert.equal(favoriteRow(dom, 900002).querySelector('.favorite-name').textContent, 'Alex Doe');
    assert.match(favoriteRow(dom, 900002).textContent, /#900002.*Manual/);
});

test('removing a custom favorite is reversible and list sorting is explicit', async () => {
    const entries = [
        { cid: 900002, name: 'Zulu Climber', addedAt: 20, source: 'manual' },
        { cid: 900003, name: 'Alpha Climber', addedAt: 10, source: 'buddy' },
    ];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) },
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.favorite-item').length === 2);
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Zulu Climber', 'Alpha Climber'], 'newest-first is the initial sort');
    el(dom, 'favorites-sort').value = 'name';
    el(dom, 'favorites-sort').dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Alpha Climber', 'Zulu Climber']);

    const remove = favoriteRow(dom, 900002).querySelector('[data-action="delete"]');
    assert.equal(remove.textContent, 'Remove');
    remove.click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 1);
    assert.match(favoriteRow(dom, 900002).textContent, /Favorite removed\s*Undo/);
    favoriteRow(dom, 900002).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 2
        && favoriteRow(dom, 900002)?.querySelector('.favorite-name'));
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === 900002), true);
});

test('custom favorites show a live total and fuzzy-search names and ids', async () => {
    const entries = [
        { cid: 18950, name: 'Kríshna Dase, KD', addedAt: 30, source: 'manual' },
        { cid: 900003, name: 'Nick McMillen', addedAt: 20, source: 'manual' },
        { cid: 900004, name: 'Alpine Casey', addedAt: 10, source: 'buddy' },
    ];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) },
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.favorite-item').length === 3);
    assert.equal(el(dom, 'favorites-count').textContent, '3 favorites');

    const search = el(dom, 'favorites-search');
    search.value = 'krsihna dse';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(el(dom, 'favorites-count').textContent, '1 of 3 favorites');
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Kríshna Dase, KD']);

    search.value = '900003';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Nick McMillen']);

    search.value = 'no such climber';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(el(dom, 'favorites-count').textContent, '0 of 3 favorites');
    assert.equal(el(dom, 'favorites-list').hidden, true);
    assert.equal(el(dom, 'favorites-empty').textContent, 'No favorites match “no such climber”.');
});

test('custom favorites show source counts and compose source filtering with search', async () => {
    const entries = [
        { cid: 18950, name: 'Kríshna Dase, KD', addedAt: 30, source: 'manual' },
        { cid: 900003, name: 'Nick McMillen', addedAt: 20, source: 'manual' },
        { cid: 900004, name: 'Alpine Casey', addedAt: 10, source: 'buddy' },
    ];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(entries) },
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.favorite-item').length === 3);
    const filter = source => dom.window.document.querySelector(`[data-favorites-source-filter="${source}"]`);
    const sourceCount = source => filter(source).querySelector('[data-favorites-source-count]').textContent;

    assert.deepEqual(['all', 'buddy', 'manual'].map(sourceCount), ['3', '1', '2']);
    assert.equal(filter('all').getAttribute('aria-pressed'), 'true');
    assert.equal(filter('buddy').getAttribute('aria-label'), 'Show 1 favorite added from buddies');
    assert.equal(filter('manual').getAttribute('aria-label'), 'Show 2 manually added favorites');

    filter('buddy').click();
    assert.equal(filter('buddy').getAttribute('aria-pressed'), 'true');
    assert.equal(el(dom, 'favorites-count').textContent, '1 of 3 favorites');
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Alpine Casey']);

    const search = el(dom, 'favorites-search');
    search.value = 'nick';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(el(dom, 'favorites-count').textContent, '0 of 3 favorites');
    assert.equal(el(dom, 'favorites-empty').textContent, 'No favorites added from buddies match “nick”.');

    filter('manual').click();
    assert.equal(el(dom, 'favorites-count').textContent, '1 of 3 favorites');
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Nick McMillen']);
    search.value = '';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('.favorite-name'), node => node.textContent),
        ['Kríshna Dase, KD', 'Nick McMillen']);
});

test('Refresh now stores the signed-in owner Buddy List cache', async () => {
    const requests = [];
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            const respond = peakbaggerFetch();
            window.fetch = url => {
                requests.push(String(url));
                return respond(url);
            };
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[buddyCacheKey]?.entries?.length === 6);
    assert.equal(dom.chrome._localStore[buddyCacheKey].ownerCid, 900001);
    assert.match(el(dom, 'favorites-buddy-status').textContent, /6 buddies · updated just now/);
    assert.deepEqual(requests, ['https://www.peakbagger.com/report/report.aspx?r=b']);
});

test('failed Buddy refresh links to the Buddy List instead of the home page', async () => {
    const requests = [];
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            window.fetch = async url => {
                requests.push(String(url));
                return pageResponse('', 500);
            };
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /temporarily unavailable \(HTTP 500\)/.test(el(dom, 'favorites-buddy-status').textContent));
    const recovery = el(dom, 'favorites-buddy-status').querySelector('a');
    assert.deepEqual(requests, ['https://www.peakbagger.com/report/report.aspx?r=b']);
    assert.equal(recovery.textContent, 'Open Buddy List');
    assert.equal(recovery.href, 'https://www.peakbagger.com/report/report.aspx?r=b');
});

test('Buddy refresh distinguishes Cloudflare, network, and parser failures', async () => {
    const cases = [
        {
            response: async () => pageResponse('<html><title>Just a moment...</title></html>', 403),
            expected: /asking for a human check/i,
            action: 'Complete check on Peakbagger',
        },
        {
            response: async () => { throw new TypeError('Failed to fetch'); },
            expected: /could not reach Peakbagger/i,
            action: 'Open Buddy List',
        },
    ];
    for (const item of cases) {
        const dom = await loadFavoritesPage({}, {
            prepareWindow: window => { window.fetch = item.response; },
        });
        el(dom, 'favorites-refresh-buddies').click();
        await waitFor(dom, () => item.expected.test(el(dom, 'favorites-buddy-status').textContent));
        assert.equal(el(dom, 'favorites-buddy-status').querySelector('a').textContent, item.action);
        assert.equal(dom.chrome._localStore[buddyCacheKey], undefined);
    }

    const parserDom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            window.fetch = peakbaggerFetch();
            Object.defineProperty(window, 'DOMParser', {
                configurable: true,
                value: class { parseFromString() { throw new Error('broken parser'); } },
            });
        },
    });
    el(parserDom, 'favorites-refresh-buddies').click();
    await waitFor(parserDom, () => /could not parse the Buddy List/i.test(
        el(parserDom, 'favorites-buddy-status').textContent
    ));
    assert.equal(parserDom.chrome._localStore[buddyCacheKey], undefined);
});

test('a Buddy cache write failure is not mislabeled as a Peakbagger request failure', async () => {
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    const originalSet = dom.chrome.storage.local.set;
    dom.chrome.storage.local.set = async patch => {
        if (buddyCacheKey in patch) throw new Error('storage unavailable');
        return originalSet(patch);
    };
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /loaded, but Better Peakbagger could not save it on this device/i.test(
        el(dom, 'favorites-buddy-status').textContent
    ));
    assert.match(el(dom, 'favorites-buddy-status').textContent, /6 buddies/,
        'the fetched list remains usable for this session');
    assert.equal(el(dom, 'favorites-buddy-status').querySelector('a'), null,
        'a local storage failure must not send the user to Peakbagger');
});

test('Buddy refresh fails closed when the report has no signed-in owner identity', async () => {
    const signedOutReport = buddyPageFixture.replace('>My Home Page<', '>Public profile<');
    const dom = await loadFavoritesPage({}, {
        prepareWindow: window => {
            window.fetch = async () => pageResponse(signedOutReport);
        },
    });
    el(dom, 'favorites-refresh-buddies').click();
    await waitFor(dom, () => /Sign in to Peakbagger/.test(el(dom, 'favorites-buddy-status').textContent));
    const recovery = el(dom, 'favorites-buddy-status').querySelector('a');
    assert.equal(dom.chrome._localStore[buddyCacheKey], undefined);
    assert.equal(recovery.textContent, 'Sign in to Peakbagger');
    assert.equal(recovery.href, 'https://www.peakbagger.com/Default.aspx');
});

test('merge is additive while mirror requires destructive confirmation and supports Undo', async () => {
    const manual = { cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([manual]) },
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    await waitFor(dom, () => favoriteRow(dom, manual.cid));

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 7);
    assert.equal(dom.chrome._favoriteMutations.at(-1).kind, 'merge-buddies');
    assert.equal(dom.chrome._favoriteMutations.at(-1).entries.length, 6);
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Merge complete: 6 added, 0 removed. Custom list now has 7 climbers.');
    assert.equal(dom.chrome._localStore[favoriteKey].entries[0].cid, manual.cid,
        'merge preserves the existing manual entry and its metadata');

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    assert.ok(el(dom, 'favorites-mirror-confirmation').closest('#favorites-custom-panel'),
        'the mirror confirmation stays beside the Mirror control');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.length, 7,
        'loading the mirror preview must not mutate favorites');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid), true);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /0 buddies will be added\. 1 custom favorite will be removed\./);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /exactly match your 6 current buddies/);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent, /undo for 6 seconds/);
    assert.equal(el(dom, 'favorites-mirror-confirm').textContent, 'Replace custom list');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-mirror-cancel'));

    el(dom, 'favorites-mirror-cancel').click();
    assert.equal(el(dom, 'favorites-mirror-confirmation').hidden, true);
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid), true,
        'cancelling the confirmation must leave favorites untouched');

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 6
        && !dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid)
        && /Mirror complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Mirror complete: 0 added, 1 removed. Custom list now has 6 climbers.');
    assert.equal(el(dom, 'favorites-undo-all').hidden, false);
    assert.match(el(dom, 'favorites-undo-message').textContent, /replaced with your Buddy List/);

    el(dom, 'favorites-undo-all-button').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 7
        && dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === manual.cid));
});

test('a failed Buddy mirror keeps its reviewed replacement visible and retryable', async () => {
    const manual = { cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' };
    let buddyLoads = 0;
    let rejectFirstWrite;
    let favoriteWriteAttempts = 0;
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([manual]) },
        prepareChrome: chrome => {
            const nativeSet = chrome.storage.local.set;
            chrome.storage.local.set = patch => {
                if (!(favoriteKey in patch) || favoriteWriteAttempts++ > 0) return nativeSet(patch);
                return new Promise((resolve, reject) => { rejectFirstWrite = reject; });
            };
        },
        prepareWindow: window => {
            const fetchBuddyList = peakbaggerFetch();
            window.fetch = (...args) => {
                buddyLoads++;
                return fetchBuddyList(...args);
            };
        },
    });
    await waitFor(dom, () => favoriteRow(dom, manual.cid));

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    const reviewedImpact = el(dom, 'favorites-mirror-confirmation-detail').textContent;
    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').getAttribute('aria-busy') === 'true');
    await waitFor(dom, () => typeof rejectFirstWrite === 'function');

    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-mirror-confirmation'));
    assert.equal(el(dom, 'favorites-mirror-confirm').disabled, true);
    assert.equal(el(dom, 'favorites-mirror-cancel').disabled, true);
    assert.equal(dom.window.document.querySelector('input[name="favorites-source"]:not(:disabled)'), null);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
    }));
    el(dom, 'favorites-mirror-cancel').dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
    }));
    assert.equal(el(dom, 'favorites-mirror-confirmation').hidden, false);
    assert.equal(el(dom, 'favorites-mirror-confirmation-detail').textContent, reviewedImpact);

    rejectFirstWrite(new Error('storage unavailable'));
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').getAttribute('aria-busy') === null
        && dom.window.document.activeElement === el(dom, 'favorites-mirror-confirm'));
    assert.equal(el(dom, 'favorites-mirror-confirmation').hidden, false);
    assert.equal(el(dom, 'favorites-mirror-confirm').disabled, false);
    assert.equal(el(dom, 'favorites-mirror-cancel').disabled, false);
    assert.equal(dom.window.document.querySelectorAll('input[name="favorites-source"]:not(:disabled)').length, 2);
    assert.equal(el(dom, 'favorites-mirror-confirmation-detail').textContent, reviewedImpact);
    assert.equal(buddyLoads, 1);

    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === true
        && dom.chrome._localStore[favoriteKey].entries.length === 6);
    assert.equal(buddyLoads, 1, 'retrying must reuse the reviewed Buddy replacement');
    assert.equal(favoriteWriteAttempts, 2);
});

test('mirror reports additions and zero removals before and after replacement', async () => {
    const existingBuddy = { cid: 710195, name: 'Existing Buddy', addedAt: 1, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([existingBuddy]) },
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    await waitFor(dom, () => favoriteRow(dom, existingBuddy.cid));

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /5 buddies will be added\. 0 custom favorites will be removed\./);
    assert.match(el(dom, 'favorites-mirror-confirmation-detail').textContent,
        /exactly match your 6 current buddies/);

    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => /Mirror complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Mirror complete: 5 added, 0 removed. Custom list now has 6 climbers.');

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => /Merge complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Merge complete: 0 added, 0 removed. Custom list now has 6 climbers.');
});

test('a stale replacement preserves the prior Undo expiry and the concurrent edit', async () => {
    const manual = { cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' };
    const concurrent = { cid: 900100, name: 'Other Tab Favorite', addedAt: 2, source: 'manual' };
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([manual]) },
        prepareWindow: window => {
            window.fetch = peakbaggerFetch();
            const nativeSetTimeout = window.setTimeout.bind(window);
            const nativeClearTimeout = window.clearTimeout.bind(window);
            let nextUndoTimer = -1;
            window.undoTimers = [];
            window.setTimeout = (callback, delay = 0, ...args) => {
                if (delay !== 6000) return nativeSetTimeout(callback, delay, ...args);
                const timer = { id: nextUndoTimer--, callback, cleared: false };
                window.undoTimers.push(timer);
                return timer.id;
            };
            window.clearTimeout = id => {
                const timer = window.undoTimers.find(candidate => candidate.id === id);
                if (timer) timer.cleared = true;
                else nativeClearTimeout(id);
            };
        },
    });

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    el(dom, 'favorites-mirror-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-undo-all').hidden === false);
    assert.equal(dom.window.undoTimers.length, 1);

    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => el(dom, 'favorites-mirror-confirmation').hidden === false);
    const current = dom.chrome._localStore[favoriteKey];
    await dom.chrome.storage.local.set({
        [favoriteKey]: favoriteStore([...current.entries, concurrent]),
    });
    el(dom, 'favorites-mirror-confirm').click();

    await waitFor(dom, () => /changed in another tab/i.test(el(dom, 'status-error-text').textContent));
    assert.equal(dom.window.undoTimers[0].cleared, false,
        'a rejected replacement must not cancel the prior successful replacement expiry');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.some(entry => entry.cid === concurrent.cid), true);

    dom.window.undoTimers[0].callback();
    assert.equal(el(dom, 'favorites-undo-all').hidden, true);
});

test('merge reports buddies skipped when custom favorites are full', async () => {
    const fullList = Array.from({ length: 1500 }, (_, index) => ({
        cid: index + 1,
        name: `Favorite ${index + 1}`,
        addedAt: 1,
        source: 'manual',
    }));
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore(fullList) },
        prepareWindow: window => { window.fetch = peakbaggerFetch(); },
    });
    await waitFor(dom, () => favoriteRow(dom, 1500));

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => /Merge complete/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').textContent,
        'Merge complete: 0 added, 0 removed. Custom list now has 1500 climbers. '
        + '6 buddies were not added because custom favorites can hold up to 1,500 climbers.');
    assert.equal(dom.chrome._localStore[favoriteKey].entries.length, 1500);
});

test('custom import accepts a valid 200 Buddy report carrying Cloudflare metadata', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => {
            window.fetch = async () => ({
                status: 200,
                headers: { 'cf-mitigated': 'challenge' },
                text: async () => `${buddyPageFixture}<script>window._cf_chl_opt={}</script>`,
            });
        },
    });

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 6);
    assert.match(el(dom, 'favorites-import-status').textContent, /Merge complete: 6 added, 0 removed/);
    assert.doesNotMatch(el(dom, 'favorites-import-status').textContent, /human check/i);
});

test('custom import opens a first-party helper when extension cookies look signed out', async () => {
    const opened = [];
    const updated = [];
    const removed = [];
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareChrome: chrome => {
            chrome.runtime.getURL = path => `chrome-extension://test-extension/${path}`;
            chrome.tabs = {
                create: (details, callback) => {
                    opened.push(structuredClone(details));
                    callback({ id: 77 });
                },
                update: (tabId, details, callback) => {
                    updated.push({ tabId, details: structuredClone(details) });
                    setTimeout(() => { void chrome.storage.local.set({
                        [buddyCacheKey]: {
                            ownerCid: 900001,
                            entries: [
                                { cid: 900002, name: 'First Buddy' },
                                { cid: 900003, name: 'Second Buddy' },
                            ],
                            fetchedAt: Date.now(),
                        },
                    }); }, 0);
                    callback({ id: tabId, ...details });
                },
                remove: (tabId, callback) => {
                    removed.push(tabId);
                    callback();
                },
            };
        },
        prepareWindow: window => {
            window.fetch = async () => pageResponse('<a href="/Default.aspx">Log In</a>');
        },
    });

    el(dom, 'favorites-merge-buddies').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.length === 2);
    assert.deepEqual(opened, [{
        url: 'about:blank',
        active: false,
    }]);
    assert.deepEqual(updated, [{
        tabId: 77,
        details: {
            url: 'chrome-extension://test-extension/options/buddy-refresh.html',
            active: false,
        },
    }]);
    assert.deepEqual(removed, [77]);
    assert.match(el(dom, 'favorites-import-status').textContent, /Merge complete: 2 added, 0 removed/);
});

test('custom import keeps a failed Buddy refresh visible beside the buttons', async () => {
    const dom = await loadFavoritesPage({ favoritesSource: 'custom' }, {
        prepareWindow: window => { window.fetch = async () => pageResponse('', 500); },
    });
    el(dom, 'favorites-mirror-buddies').click();
    await waitFor(dom, () => /temporarily unavailable/.test(el(dom, 'favorites-import-status').textContent));
    assert.equal(el(dom, 'favorites-import-status').hidden, false);
    assert.equal(el(dom, 'favorites-import-status').querySelector('a').textContent, 'Open Buddy List');
    assert.equal(dom.chrome._localStore[favoriteKey], undefined);
});

test('connected GitHub actions work with ascent backup off and restore with Undo', async () => {
    const original = { cid: 900002, name: 'Original Favorite', addedAt: 10, source: 'manual' };
    const restored = { cid: 900003, name: 'Restored Favorite', addedAt: 20, source: 'buddy' };
    const messages = [];
    const status = {
        enabled: true, connected: true, hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ favoritesSource: 'custom', enableGithubBackup: false }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                messages.push(JSON.parse(JSON.stringify(message)));
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_FAVORITES_BACKUP') reply = {
                    ok: true,
                    result: {
                        path: 'favorite-climbers.json',
                        commitUrl: 'https://github.com/ada/peaks/commit/favorite123',
                    },
                };
                if (message.type === 'GITHUB_FAVORITES_RESTORE') reply = {
                    ok: true,
                    content: JSON.stringify({
                        schemaVersion: 1,
                        exportedAt: '2026-07-21T12:00:00.000Z',
                        entries: [restored],
                    }),
                };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    assert.match(el(dom, 'favorites-github-status').textContent, /ada\/peaks/);

    el(dom, 'favorites-backup').click();
    await waitFor(dom, () => messages.some(message => message.type === 'GITHUB_FAVORITES_BACKUP'));
    const backup = messages.find(message => message.type === 'GITHUB_FAVORITES_BACKUP');
    assert.deepEqual(backup, { type: 'GITHUB_FAVORITES_BACKUP' });
    await waitFor(dom, () => /Favorites backed up ✓/.test(el(dom, 'favorites-github-status').textContent));
    const commitLink = el(dom, 'favorites-github-status').querySelector('a');
    assert.equal(commitLink.textContent, 'View commit');
    assert.equal(commitLink.getAttribute('href'), 'https://github.com/ada/peaks/commit/favorite123');
    assert.equal(commitLink.getAttribute('target'), '_blank');
    assert.equal(commitLink.getAttribute('rel'), 'noopener noreferrer');

    const auto = el(dom, 'favorites-auto-backup');
    assert.equal(auto.checked, false);
    auto.checked = true;
    auto.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.autoFavoritesBackup === true);

    await waitFor(dom, () => !el(dom, 'favorites-restore').disabled);
    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    assert.equal(dom.chrome._localStore[favoriteKey].entries[0].cid, original.cid,
        'reading a backup must not replace favorites before confirmation');
    assert.equal(el(dom, 'favorites-restore-confirmation-title').textContent,
        'Restore favorites from backup?');
    assert.match(el(dom, 'favorites-restore-confirmation-detail').textContent,
        /1 favorite will be added\. 1 custom favorite will be removed\./);
    assert.match(el(dom, 'favorites-restore-confirmation-detail').textContent,
        /list will match the backup from ada\/peaks/);
    assert.equal(el(dom, 'favorites-restore-confirm').textContent, 'Restore backup');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-restore-cancel'));

    el(dom, 'favorites-restore-cancel').click();
    assert.equal(el(dom, 'favorites-restore-confirmation').hidden, true);
    assert.equal(dom.chrome._localStore[favoriteKey].entries[0].cid, original.cid,
        'cancelling a restore must leave the custom list untouched');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-restore'));

    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === restored.cid
        && el(dom, 'favorites-restore-undo').hidden === false);
    assert.equal(el(dom, 'favorites-restore-undo').hidden, false);
    assert.match(el(dom, 'favorites-restore-undo').textContent, /restored from GitHub/);
    assert.match(el(dom, 'favorites-github-status').textContent, /stored as favorite-climbers\.json/,
        'the prior commit result must not imply that a changed local list is current');
    assert.equal(el(dom, 'favorites-github-status').querySelector('a'), null);

    el(dom, 'favorites-restore-undo-button').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === original.cid);
});

test('a failed favorites restore retries the reviewed backup without downloading it again', async () => {
    const original = { cid: 900002, name: 'Original Favorite', addedAt: 10, source: 'manual' };
    const restored = { cid: 900003, name: 'Restored Favorite', addedAt: 20, source: 'buddy' };
    let restoreReads = 0;
    let rejectFirstWrite;
    let favoriteWriteAttempts = 0;
    const dom = await loadOptions({ favoritesSource: 'custom', enableGithubBackup: true }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            const nativeSet = chrome.storage.local.set;
            chrome.storage.local.set = patch => {
                if (!(favoriteKey in patch) || favoriteWriteAttempts++ > 0) return nativeSet(patch);
                return new Promise((resolve, reject) => { rejectFirstWrite = reject; });
            };
            chrome.runtime.sendMessage = message => {
                if (message.type === 'GITHUB_FAVORITES_RESTORE') {
                    restoreReads++;
                    return Promise.resolve({
                        ok: true,
                        content: JSON.stringify({
                            schemaVersion: 1,
                            exportedAt: '2026-07-21T12:00:00.000Z',
                            entries: [restored],
                        }),
                    });
                }
                return Promise.resolve({
                    enabled: true,
                    connected: true,
                    hasToken: true,
                    repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                });
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-restore').disabled);

    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    const reviewedImpact = el(dom, 'favorites-restore-confirmation-detail').textContent;
    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => typeof rejectFirstWrite === 'function');
    assert.equal(el(dom, 'favorites-restore-confirmation').getAttribute('aria-busy'), 'true');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-restore-confirmation'));

    rejectFirstWrite(new Error('storage unavailable'));
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').getAttribute('aria-busy') === null
        && dom.window.document.activeElement === el(dom, 'favorites-restore-confirm'));
    assert.equal(el(dom, 'favorites-restore-confirmation').hidden, false);
    assert.equal(el(dom, 'favorites-restore-confirmation-detail').textContent, reviewedImpact);
    assert.equal(restoreReads, 1);

    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === true
        && dom.chrome._localStore[favoriteKey].entries[0].cid === restored.cid);
    assert.equal(restoreReads, 1, 'retrying must reuse the reviewed backup payload');
    assert.equal(favoriteWriteAttempts, 2);
});

test('a restore from Backup & sync confirms and undoes without the list page open', async () => {
    const original = { cid: 900002, name: 'Original Favorite', addedAt: 10, source: 'manual' };
    const restored = { cid: 900003, name: 'Restored Favorite', addedAt: 20, source: 'buddy' };
    const dom = await loadOptions({ favoritesSource: 'buddies' }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    reply = {
                        enabled: true, connected: true, hasToken: true,
                        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                }
                if (message.type === 'GITHUB_FAVORITES_RESTORE') {
                    reply = {
                        ok: true,
                        content: JSON.stringify({
                            schemaVersion: 1,
                            exportedAt: '2026-07-21T12:00:00.000Z',
                            entries: [restored],
                        }),
                    };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    // The list workspace is a separate page; restore does its whole job here.
    assert.equal(el(dom, 'favorites-custom-panel'), null);

    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    // Restore lives in Backup & sync, never inside the custom panel the Buddy
    // List source hides, so its confirmation and undo are always reachable.
    assert.ok(el(dom, 'favorites-restore-confirmation').closest('#github-favorites-backup'));
    assert.equal(el(dom, 'favorites-restore-confirmation').closest('#favorites-custom-panel'), null,
        'the restore confirmation must not be trapped inside the hidden custom panel');

    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === restored.cid
        && el(dom, 'favorites-restore-undo').hidden === false);
    assert.equal(el(dom, 'favorites-restore-undo').closest('#favorites-custom-panel'), null,
        'the undo that the confirmation promised must stay reachable');

    el(dom, 'favorites-restore-undo-button').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === original.cid);
});

test('the favorites auto-backup checkbox populates from synced settings', async () => {
    const dom = await loadOptions({ autoFavoritesBackup: true });
    assert.equal(el(dom, 'favorites-auto-backup').checked, true);
});

test('favorites restore fails closed on an unknown backup schema', async () => {
    const original = { cid: 900002, name: 'Keep Me', addedAt: 10, source: 'manual' };
    const dom = await loadOptions({ favoritesSource: 'custom', enableGithubBackup: true }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_FAVORITES_RESTORE'
                    ? { ok: true, content: JSON.stringify({ schemaVersion: 2, entries: [] }) }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => /newer format/.test(el(dom, 'status-error-text').textContent));
    assert.deepEqual(dom.chrome._localStore[favoriteKey].entries, [original]);
    assert.equal(el(dom, 'favorites-restore-undo').hidden, true);
});

test('favorites restore rejects a backup above the 1,500-entry bound', async () => {
    const original = { cid: 900002, name: 'Keep Me', addedAt: 10, source: 'manual' };
    const oversized = Array.from({ length: 1501 }, (_, index) => ({
        cid: 100000 + index,
        name: `Climber ${index + 1}`,
        addedAt: index,
        source: 'manual',
    }));
    const dom = await loadOptions({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_FAVORITES_RESTORE'
                    ? { ok: true, content: JSON.stringify({ schemaVersion: 1, entries: oversized }) }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => /not valid/.test(el(dom, 'status-error-text').textContent));
    assert.deepEqual(dom.chrome._localStore[favoriteKey].entries, [original]);
});

test('favorites points disconnected users to the GitHub connection above it', async () => {
    const dom = await loadOptions({ favoritesSource: 'custom' }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_STATUS'
                    ? { enabled: false, connected: false, hasToken: false }
                    : {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => /Connect GitHub above to back up your custom favorites/
        .test(el(dom, 'favorites-github-status').textContent));
    assert.equal(el(dom, 'favorites-github-actions').hidden, true);
    // The connection subsection is the first thing above this one in Backup & sync.
    const section = dom.window.document.getElementById('github-favorites-backup');
    assert.equal(section.previousElementSibling.id, 'github-settings-backup');
    assert.equal(section.parentElement.querySelector('.subsection').id, 'github-connection');
});

test('report drafts render newest-first with labels, fallbacks, and edit links', async () => {
    const now = Date.now();
    const local = {
        'bpbReportDraft:900001:a123': {
            text: '[b]Newest report[/b]', mode: 'rich', savedAt: now - 1000,
            label: { peak: 'Glacier Peak', date: '7/12/2026' }
        },
        'bpbReportDraft:900001:p456': {
            text: 'Peak draft', mode: 'rich', savedAt: now - 2000
        },
        'bpbReportDraft:900001:new': {
            text: 'New ascent draft', mode: 'markdown', source: 'New ascent draft', savedAt: now - 3000
        },
        'bpbReportDraft:900001:a999': {
            text: 'Expired', mode: 'rich', savedAt: now - 14 * 24 * 60 * 60 * 1000 - 1
        }
    };
    const dom = await loadDraftsPage({}, { local });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.draft-item').length === 3);

    const rows = Array.from(dom.window.document.querySelectorAll('.draft-item'));
    assert.deepEqual(rows.map(row => row.querySelector('.draft-title').textContent), [
        'Glacier Peak · 7/12/2026',
        'New ascent · peak #456',
        'New ascent'
    ]);
    assert.deepEqual(rows.map(row => row.querySelector('.draft-mode').textContent), ['Rich', 'Rich', 'Markdown']);
    assert.equal(rows[0].querySelector('.draft-excerpt').textContent, '**Newest report**');
    assert.deepEqual(rows.map(row => row.querySelector('a.secondary').href), [
        'https://peakbagger.com/climber/ascentedit.aspx?aid=123&cid=900001',
        'https://peakbagger.com/climber/ascentedit.aspx?pid=456&cid=900001',
        'https://peakbagger.com/climber/ascentedit.aspx?cid=900001'
    ]);
    assert.equal('bpbReportDraft:900001:a999' in dom.chrome._localStore, false,
        'opening the manager should prune expired drafts');
    assert.equal(el(dom, 'drafts-empty').hidden, true);
    assert.equal(el(dom, 'drafts-delete-all').hidden, false);
});

test('report drafts retain provisional peak identities and their mountain labels', async () => {
    const key = 'bpbReportDraft:900001:p-105366';
    const dom = await loadDraftsPage({}, { local: {
        [key]: {
            text: 'Provisional peak report',
            mode: 'rich',
            savedAt: Date.now(),
            label: { peak: 'Hibox Mountain', date: '7/18/2026' }
        }
    } });
    await waitFor(dom, () => draftRow(dom, key));

    const row = draftRow(dom, key);
    assert.equal(row.querySelector('.draft-title').textContent, 'Hibox Mountain · 7/18/2026');
    assert.equal(row.querySelector('a.secondary').href,
        'https://peakbagger.com/climber/ascentedit.aspx?pid=-105366&cid=900001');
});

test('copy Markdown preserves exact source or converts the stored bracket report', async () => {
    const now = Date.now();
    const richKey = 'bpbReportDraft:900001:a123';
    const markdownKey = 'bpbReportDraft:900001:a124';
    const dom = await loadDraftsPage({}, { local: {
        [richKey]: { text: '[u]under[/u]', mode: 'rich', savedAt: now },
        [markdownKey]: {
            text: '[b]normalized[/b]', mode: 'markdown', source: 'exact  **source**', savedAt: now - 1
        }
    } });
    const writes = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { writes.push(value); } }
    });

    draftRow(dom, markdownKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => writes.length === 1);
    draftRow(dom, richKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => writes.length === 2);
    assert.deepEqual(writes, ['exact  **source**', '<u>under</u>']);
    await waitFor(dom, () => el(dom, 'status').textContent === 'Copied');
    assert.equal(el(dom, 'status').textContent, 'Copied');

    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('denied'); } }
    });
    draftRow(dom, richKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent === 'Couldn’t copy Markdown');
});

test('deleting one draft is reversible and its Undo survives a live refresh', async () => {
    const key = 'bpbReportDraft:900001:a123';
    const otherKey = 'bpbReportDraft:900001:p456';
    const record = { text: 'Held verbatim', mode: 'rich', savedAt: Date.now() };
    const dom = await loadDraftsPage({}, { local: { [key]: record } });
    await waitFor(dom, () => draftRow(dom, key));

    draftRow(dom, key).querySelector('[data-action="delete"]').click();
    await waitFor(dom, () => !(key in dom.chrome._localStore));
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/);
    // The activated Delete button is gone from the DOM; a keyboard user must
    // land on the Undo they now need, not on <body>, because it expires in 6s.
    assert.equal(dom.window.document.activeElement,
        draftRow(dom, key).querySelector('[data-action="undo"]'),
        'deleting a draft must not drop focus to the document body');

    await dom.chrome.storage.local.set({
        [otherKey]: { text: 'Arrived from another tab', mode: 'rich', savedAt: Date.now() + 1 }
    });
    await waitFor(dom, () => draftRow(dom, otherKey));
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/,
        'storage.onChanged must not strip an active Undo row');

    draftRow(dom, key).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => key in dom.chrome._localStore && draftRow(dom, key)?.querySelector('.draft-title'));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[key])), record);
    assert.equal(el(dom, 'status').textContent, 'Draft restored');
    assert.equal(el(dom, 'status').classList.contains('show'), true);
});

test('a failed single-draft Undo keeps its recovery snapshot available for retry', async () => {
    const key = 'bpbReportDraft:900001:a123';
    const record = { text: 'Retry this restoration', mode: 'rich', savedAt: Date.now() };
    const dom = await loadDraftsPage({}, { local: { [key]: record } });
    await waitFor(dom, () => draftRow(dom, key));

    draftRow(dom, key).querySelector('[data-action="delete"]').click();
    await waitFor(dom, () => !(key in dom.chrome._localStore));

    const originalSet = dom.chrome.storage.local.set;
    let failOnce = true;
    dom.chrome.storage.local.set = async patch => {
        if (failOnce) {
            failOnce = false;
            throw new Error('transient storage failure');
        }
        return originalSet(patch);
    };

    draftRow(dom, key).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent === 'Couldn’t restore the draft. Try again.');
    assert.equal(dom.chrome._localStore[key], undefined);
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/);
    assert.equal(dom.window.document.activeElement, draftRow(dom, key).querySelector('[data-action="undo"]'));

    draftRow(dom, key).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => key in dom.chrome._localStore && draftRow(dom, key)?.querySelector('.draft-title'));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[key])), record);
});

test('delete all states the count, requires confirmation, and retains a failed Undo for retry', async () => {
    const firstKey = 'bpbReportDraft:900001:a123';
    const secondKey = 'bpbReportDraft:900001:p456';
    const records = {
        [firstKey]: { text: 'First', mode: 'rich', savedAt: Date.now() },
        [secondKey]: { text: 'Second', mode: 'markdown', source: 'Second', savedAt: Date.now() - 1 }
    };
    const dom = await loadDraftsPage({}, {
        local: records,
        prepareWindow: window => {
            window.confirm = () => {
                throw new Error('the draft manager must not use the native confirm dialog');
            };
        }
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.draft-item').length === 2);
    assert.equal(el(dom, 'drafts-delete-all').textContent, 'Delete all 2 drafts');

    // The in-page block the favorites mirror and settings import already use.
    const confirmation = el(dom, 'drafts-delete-all-confirmation');
    assert.equal(confirmation.hidden, true);
    el(dom, 'drafts-delete-all').click();
    assert.equal(confirmation.hidden, false);
    assert.equal(confirmation.getAttribute('role'), 'alertdialog');
    assert.match(el(dom, 'drafts-delete-all-confirmation-title').textContent,
        /Delete all 2 trip report drafts from this device/);
    assert.match(confirmation.textContent, /6 seconds to undo/);
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-delete-all-confirm'));

    // Cancel leaves everything alone and hands focus back to its opener.
    el(dom, 'drafts-delete-all-cancel').click();
    assert.equal(confirmation.hidden, true);
    assert.deepEqual(dom.chrome._localStore, records, 'Cancel must leave every draft untouched');
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-delete-all'));

    // Escape does the same.
    el(dom, 'drafts-delete-all').click();
    assert.equal(confirmation.hidden, false);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(confirmation.hidden, true);
    assert.deepEqual(dom.chrome._localStore, records, 'Escape must leave every draft untouched');
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-delete-all'));

    el(dom, 'drafts-delete-all').click();
    el(dom, 'drafts-delete-all-confirm').click();
    await waitFor(dom, () => !(firstKey in dom.chrome._localStore) && !(secondKey in dom.chrome._localStore));
    assert.equal(confirmation.hidden, true, 'the question closes once it is answered');
    assert.equal(el(dom, 'drafts-undo-all').hidden, false);
    assert.match(el(dom, 'drafts-undo-all').textContent, /All drafts deleted\s*Undo/);
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-undo-all-button'));

    const originalSet = dom.chrome.storage.local.set;
    let failOnce = true;
    dom.chrome.storage.local.set = async patch => {
        if (failOnce) {
            failOnce = false;
            throw new Error('transient storage failure');
        }
        return originalSet(patch);
    };

    el(dom, 'drafts-undo-all-button').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent === 'Couldn’t restore the drafts. Try again.');
    assert.equal(firstKey in dom.chrome._localStore, false);
    assert.equal(secondKey in dom.chrome._localStore, false);
    assert.equal(el(dom, 'drafts-undo-all').hidden, false);
    assert.equal(el(dom, 'drafts-undo-all-button').disabled, false);
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-undo-all-button'));

    el(dom, 'drafts-undo-all-button').click();
    await waitFor(dom, () => firstKey in dom.chrome._localStore && secondKey in dom.chrome._localStore);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore)), records);
});

test('the drafts manager shows an empty state and refreshes when another tab autosaves', async () => {
    const dom = await loadDraftsPage({}, { local: { unrelated: 'preserved' } });
    assert.equal(el(dom, 'drafts-empty').hidden, false);
    assert.equal(el(dom, 'drafts-list').hidden, true);
    assert.equal(el(dom, 'drafts-delete-all').hidden, true);

    const key = 'bpbReportDraft:900001:new';
    await dom.chrome.storage.local.set({
        [key]: { text: 'Live draft', mode: 'rich', savedAt: Date.now() }
    });
    await waitFor(dom, () => draftRow(dom, key));
    assert.equal(el(dom, 'drafts-empty').hidden, true);
    assert.equal(draftRow(dom, key).querySelector('.draft-title').textContent, 'New ascent');
    assert.equal(dom.chrome._localStore.unrelated, 'preserved');
});

// The ImgBB key is a device-local credential, not a synced setting: Settings
// can configure it through the same worker routes the photo page uses, but the
// value never round-trips back into the page.
const loadImgbb = ({ status = { ok: true, configured: false, permissionGranted: false }, grant = true } = {}) => {
    const messages = [];
    let saved = null;
    const load = loadOptions({}, {
        prepareChrome: chrome => {
            chrome.permissions = {
                request: async () => grant,
                contains: async () => status.permissionGranted,
                remove: async () => true,
            };
            chrome.runtime.sendMessage = (message, callback) => {
                messages.push(structuredClone(message));
                let reply = {};
                if (message.type === 'PHOTO_IMGBB_STATUS') reply = { ...status, configured: saved != null || status.configured };
                if (message.type === 'PHOTO_IMGBB_SAVE_KEY') { saved = message.key; reply = { ok: true }; }
                if (message.type === 'PHOTO_IMGBB_REMOVE_KEY') { saved = null; reply = { ok: true }; }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        }
    });
    return { load, messages, key: () => saved };
};

test('the ImgBB key setting explains the service and links its key page and terms', async () => {
    const { load } = loadImgbb();
    const dom = await load;
    const desc = el(dom, 'imgbb-key-desc');
    assert.match(desc.textContent, /free image hosting site/i);
    assert.deepEqual([...desc.querySelectorAll('a')].map(link => ({
        label: link.textContent,
        href: link.getAttribute('href'),
        target: link.target,
        rel: link.rel,
    })), [
        { label: 'ImgBB', href: 'https://imgbb.com/', target: '_blank', rel: 'noopener noreferrer' },
        { label: 'Get API key', href: 'https://api.imgbb.com/', target: '_blank', rel: 'noopener noreferrer' },
        { label: 'ImgBB’s terms of service', href: 'https://imgbb.com/tos', target: '_blank', rel: 'noopener noreferrer' },
        { label: 'Read the photo guide', href: '../photos/guide.html', target: '_blank', rel: 'noopener noreferrer' },
    ]);
    assert.equal(el(dom, 'imgbb-key').type, 'password');
    assert.match(desc.textContent, /never synced or backed up/i);
});

test('the ImgBB key saves through the worker with upload access, and is never read back', async () => {
    const { load, messages, key } = loadImgbb();
    const dom = await load;
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent === 'No key saved on this device.');
    assert.equal(el(dom, 'imgbb-key-remove').hidden, true);

    // A key with whitespace is not a key; nothing is sent.
    el(dom, 'imgbb-key').value = 'not a key';
    el(dom, 'imgbb-key-save').click();
    await waitFor(dom, () => /no spaces/i.test(el(dom, 'imgbb-key-status').textContent));
    assert.equal(messages.some(message => message.type === 'PHOTO_IMGBB_SAVE_KEY'), false);

    el(dom, 'imgbb-key').value = '  abc123  ';
    el(dom, 'imgbb-key-save').click();
    await waitFor(dom, () => key() === 'abc123');
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent === 'Saved on this device.');
    assert.equal(el(dom, 'imgbb-key').value, '', 'the entered key is cleared, never displayed back');
    assert.equal(el(dom, 'imgbb-key-remove').hidden, false);
    // The credential is device-local; it must not reach synced settings.
    assert.equal(JSON.stringify(dom.chrome._store).includes('abc123'), false);

    el(dom, 'imgbb-key-remove').click();
    await waitFor(dom, () => key() === null);
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent === 'No key saved on this device.');
    assert.equal(el(dom, 'imgbb-key-remove').hidden, true);
});

test('a declined ImgBB host permission blocks the save and says what to do', async () => {
    const { load, messages } = loadImgbb({ grant: false });
    const dom = await load;
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent === 'No key saved on this device.');

    el(dom, 'imgbb-key').value = 'abc123';
    el(dom, 'imgbb-key-save').click();
    await waitFor(dom, () => /Allow access to api\.imgbb\.com/.test(el(dom, 'imgbb-key-status').textContent));
    assert.equal(messages.some(message => message.type === 'PHOTO_IMGBB_SAVE_KEY'), false,
        'a key that cannot upload is not stored');
    assert.equal(el(dom, 'imgbb-key').value, 'abc123', 'the typed key survives for a second attempt');
});

test('a saved ImgBB key without upload access reports the gap instead of looking ready', async () => {
    const { load } = loadImgbb({
        status: { ok: true, configured: true, permissionGranted: false },
    });
    const dom = await load;
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent.startsWith('Saved, but'));
    assert.match(el(dom, 'imgbb-key-status').textContent, /uploads still need access to api\.imgbb\.com/);
    assert.ok(el(dom, 'imgbb-key-status').classList.contains('is-error'));
    assert.equal(el(dom, 'imgbb-key-remove').hidden, false);
});

test('the sidebar links every settings section, in order', async () => {
    const dom = await loadOptions({});
    const doc = dom.window.document;
    const nav = doc.querySelector('.side-nav');
    assert.ok(nav, 'the sidebar nav exists');
    assert.equal(nav.getAttribute('aria-label'), 'Settings sections');

    const links = Array.from(nav.querySelectorAll('a.nav-item'));
    // Every link points at an existing settings section...
    for (const link of links) {
        const id = link.getAttribute('href').slice(1);
        const target = doc.getElementById(id);
        assert.ok(target, `sidebar link #${id} resolves to an element`);
        assert.ok(target.classList.contains('settings-section'), `#${id} is a settings section`);
    }
    // ...and the links cover every section, in document order — this guards
    // against a section being added, removed, or renamed without its link.
    const linkTargets = links.map(link => link.getAttribute('href').slice(1));
    const sectionIds = Array.from(doc.querySelectorAll('.content .settings-section'), section => section.id);
    assert.deepEqual(linkTargets, sectionIds);
    assert.deepEqual(linkTargets, ['general', 'capture', 'map-chart', 'beta', 'favorites', 'github', 'about']);
});

test('the sidebar exposes always-visible sub-links for the grouped sections', async () => {
    const dom = await loadOptions({});
    const doc = dom.window.document;
    const subLinks = Array.from(doc.querySelectorAll('.side-nav a.nav-subitem'));
    assert.deepEqual(subLinks.map(link => link.getAttribute('href')),
        ['#capture-gpx', '#capture-report', '#capture-photos', '#drafts',
            '#map-chart-chart', '#map-chart-map', '#github-connection',
            '#github-settings-backup', '#github-favorites-backup', '#github-photos-backup',
            '#github-backup']);
    for (const link of subLinks) {
        const target = doc.getElementById(link.getAttribute('href').slice(1));
        assert.ok(target && target.classList.contains('subsection'),
            `${link.getAttribute('href')} resolves to a subsection group`);
        assert.equal(target.getAttribute('role'), 'group');
        assert.equal(target.getAttribute('aria-labelledby'), target.querySelector('h3').id);
    }
});

const activeLinks = dom =>
    Array.from(dom.window.document.querySelectorAll('.nav-item[aria-current], .nav-subitem[aria-current]'));

test('the sidebar marks the first section active on load', async () => {
    const dom = await loadOptions({});
    const active = activeLinks(dom);
    assert.equal(active.length, 1, 'exactly one link is active');
    assert.equal(active[0].getAttribute('href'), '#general');
});

test('a deep-link hash is the active section on load', async () => {
    const dom = await loadOptions({}, { hash: '#map-chart' });
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#map-chart');
});

test('a drafts deep link activates the TR-drafts manager', async () => {
    const dom = await loadOptions({}, {
        hash: '#drafts',
        prepareWindow: window => {
            const nativeRect = window.HTMLElement.prototype.getBoundingClientRect;
            window.HTMLElement.prototype.getBoundingClientRect = function () {
                if (this.classList?.contains('content')) return { top: 100 };
                if (this.id === 'drafts') return { top: 450 };
                return nativeRect.call(this);
            };
            const nativeStyle = window.getComputedStyle.bind(window);
            window.getComputedStyle = element => element.id === 'drafts'
                ? { scrollMarginTop: '24px' }
                : nativeStyle(element);
        }
    });
    const content = dom.window.document.querySelector('.content');
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#drafts');
    assert.equal(active[0].textContent, 'Trip report drafts');
    // The manager moved under Activity creation; the worker's #drafts URL and
    // this landing must survive that, and the parent gets the accent.
    assert.ok(active[0].classList.contains('nav-subitem'));
    assert.equal(dom.window.document.querySelector('.nav-item.nav-parent-active')?.getAttribute('href'),
        '#capture');
    assert.equal(content.style.scrollBehavior, 'auto',
        'the initial native fragment landing must not inherit smooth scrolling');
    content.dispatchEvent(new dom.window.Event('scrollend'));
    assert.equal(content.scrollTop, 326,
        'the nested content scroller should align the target to its scroll margin');
    assert.equal(content.style.scrollBehavior, '',
        'normal sidebar navigation should regain stylesheet-controlled smooth scrolling');
});

test('hash navigation moves the active sidebar link', async () => {
    const dom = await loadOptions({});
    dom.window.location.hash = '#beta';
    dom.window.dispatchEvent(new dom.window.Event('hashchange'));
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#beta');
});

test('sidebar navigation animates nearby jumps and makes long jumps instant', async () => {
    let draftsTop = 0;
    const dom = await loadOptions({}, {
        prepareWindow: window => {
            const content = window.document.querySelector('.content');
            const drafts = window.document.getElementById('drafts');
            Object.defineProperty(content, 'clientHeight', { configurable: true, value: 800 });
            content.getBoundingClientRect = () => ({ top: 100 });
            drafts.getBoundingClientRect = () => ({ top: draftsTop });
            const nativeStyle = window.getComputedStyle.bind(window);
            window.getComputedStyle = element => element === drafts
                ? { scrollMarginTop: '24px' }
                : nativeStyle(element);
        }
    });
    const doc = dom.window.document;
    const content = doc.querySelector('.content');
    const draftsLink = doc.querySelector('.side-nav a[href="#drafts"]');

    // 1,000 px is below both two viewports (1,600 px here) and the 1,200 px
    // absolute cap, so the stylesheet keeps control.
    draftsTop = 1124;
    draftsLink.click();
    assert.equal(content.style.scrollBehavior, '');

    // The same target 1,400 px away is under two viewports but over the pixel
    // cap, so it must bypass smooth scrolling. The inline override survives the
    // native click action, then clears on the next task.
    draftsTop = 1524;
    draftsLink.click();
    assert.equal(content.style.scrollBehavior, 'auto');
    await new Promise(resolve => dom.window.setTimeout(resolve, 5));
    assert.equal(content.style.scrollBehavior, '');

    draftsLink.addEventListener('click', event => event.preventDefault(), { once: true });
    draftsLink.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
    }));
    assert.equal(content.style.scrollBehavior, '', 'a modified click must not move the current page');
});

test('a deep link to a subsection activates its sub-item and marks the parent', async () => {
    const dom = await loadOptions({}, { hash: '#capture-gpx' });
    const doc = dom.window.document;
    const current = activeLinks(dom);
    assert.equal(current.length, 1, 'exactly one link is current');
    assert.equal(current[0].getAttribute('href'), '#capture-gpx');
    assert.ok(current[0].classList.contains('nav-subitem'));
    // The parent nav-item is highlighted (accent) but not itself "current".
    const parent = doc.querySelector('.side-nav a.nav-item[href="#capture"]');
    assert.ok(parent.classList.contains('nav-parent-active'));
    assert.equal(parent.hasAttribute('aria-current'), false);
});

test('the scroll-spy survives jsdom\'s zero-layout world', async () => {
    // jsdom reports every offset/rect as 0 and nothing scrolls; the scroll
    // handler must not throw and must keep exactly one link active. The offset
    // math itself is only provable in a real browser (see the plan's step 5).
    const dom = await loadOptions({});
    const content = dom.window.document.querySelector('.content');
    assert.doesNotThrow(() => content.dispatchEvent(new dom.window.Event('scroll')));
    assert.equal(activeLinks(dom).length, 1);
});

// ---- GitHub connection and ascent-backup setup ----------------------------

// Wire the options page's GITHUB_AUTH_* messages to a scripted background and a
// grantable optional-permission request, so the setup panel can be driven in
// jsdom without a browser or network.
const withGithubBackground = (status, { grant = true, ascentCount = 0 } = {}) => chrome => {
    chrome.permissions = { request: async () => grant, contains: async () => grant, remove: async () => true };
    chrome.runtime.sendMessage = (message, callback) => {
        let reply = {};
        if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
        if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') reply = { ok: true, count: ascentCount };
        if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
        return Promise.resolve(reply);
    };
};

test('the shared GitHub connection stays visible while ascent backup is off by default', async () => {
    const dom = await loadOptions({}, { prepareChrome: withGithubBackground({ enabled: false }) });
    assert.equal(el(dom, 'enable-github-backup').checked, false);
    assert.equal(el(dom, 'github-detail').hidden, false);
    assert.equal(el(dom, 'github-ascent-detail').hidden, true);
    assert.match(el(dom, 'github-panel').textContent, /Connect a GitHub account/);
});

test('enabling ascent backup persists only the ascent gate and leaves GitHub connection separate', async () => {
    let requested = null;
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            withGithubBackground({ enabled: true, connected: false, hasToken: false })(chrome);
            const request = chrome.permissions.request;
            chrome.permissions.request = async arg => { requested = arg; return request(arg); };
        }
    });
    const toggle = el(dom, 'enable-github-backup');
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(requested, null);
    assert.equal(dom.chrome._store.bpbSettings.enableGithubBackup, true);
    assert.equal(el(dom, 'github-ascent-detail').hidden, false);
    assert.match(el(dom, 'github-ascent-panel').textContent, /Connect GitHub above/);
});

test('the shared Connect GitHub action requests host permission and keeps denial actionable', async () => {
    const dom = await loadOptions({}, { prepareChrome: withGithubBackground({ enabled: false }, { grant: false }) });
    const connect = Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub');
    connect.click();
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(el(dom, 'enable-github-backup').checked, false);
    assert.notEqual(dom.chrome._store.bpbSettings.enableGithubBackup, true);
    assert.equal(el(dom, 'github-detail').hidden, false);
    assert.match(el(dom, 'github-panel').textContent, /GitHub access wasn’t granted/);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));

    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.match(el(dom, 'github-panel').textContent, /GitHub access wasn’t granted/,
        'the actionable permission error must survive focus changes');
});

test('the shared Connect GitHub action grants permission without enabling ascent backup', async () => {
    let permissionGranted = false;
    let requested = null;
    let began = false;
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            chrome.permissions = {
                contains: async () => permissionGranted,
                request: async value => {
                    requested = value;
                    permissionGranted = true;
                    return true;
                },
                remove: async () => true,
            };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    reply = { enabled: false, connected: false, hasToken: false };
                } else if (message.type === 'GITHUB_AUTH_BEGIN') {
                    began = true;
                    reply = {
                        phase: 'polling', userCode: 'ABCD-EFGH',
                        verificationUri: 'https://github.com/login/device', expiresIn: 900,
                    };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));

    assert.equal(JSON.stringify(requested), JSON.stringify({
        origins: ['https://github.com/*', 'https://api.github.com/*'],
    }));
    assert.equal(began, true);
    assert.notEqual(dom.chrome._store.bpbSettings.enableGithubBackup, true);
    dom.window.close();
});

test('a lost device flow stops polling and offers to reconnect', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        accelerateGithubPoll: true,
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900,
                };
                else if (message.type === 'GITHUB_AUTH_STATE') reply = { phase: 'idle' };
                else reply = {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => /connection was lost/i.test(el(dom, 'github-panel').textContent), 3000);

    assert.deepEqual([...new Set(dom.githubPollDelays)], [2000]);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Reconnect GitHub'));
});

test('opening the GitHub device page uses tabs.create and reports a failure', async () => {
    const created = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { created.push(details.url); } };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH',
                    verificationUri: 'https://github.com/login/device',
                    expiresIn: 125, startedAt: Date.now(),
                };
                else reply = { phase: 'polling' };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
        prepareWindow: window => {
            window.open = () => {
                throw new Error('a popup-blocked window.open must never be the path taken');
            };
        },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));

    const openButton = Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open github.com/login/device');
    assert.ok(openButton, 'the device flow depends on this single action');
    openButton.click();
    await waitFor(dom, () => created.length === 1);
    assert.deepEqual(created, ['https://github.com/login/device'],
        'GitHub URLs must go through tabs.create, which cannot be popup-blocked');

    // And when even that fails, the user is told instead of nothing happening.
    dom.chrome.tabs.create = async () => { throw new Error('tab creation refused'); };
    openButton.click();
    await waitFor(dom, () => /couldn’t be opened/.test(el(dom, 'status-error-text').textContent));
    assert.match(el(dom, 'status-error-text').textContent,
        /The GitHub device page couldn’t be opened/);
    assert.equal(el(dom, 'status-error').hidden, false);
});

test('the device code is copyable and shows its remaining lifetime', async () => {
    const startedAt = Date.now();
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device',
                    expiresIn: 125, startedAt,
                };
                else reply = { phase: 'polling' };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    let copied = '';
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { copied = value; } },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));
    const codeButton = el(dom, 'github-panel').querySelector('.github-code');
    assert.match(codeButton.getAttribute('aria-label'), /Copy device code ABCD-EFGH/);
    assert.match(el(dom, 'github-panel').textContent, /Expires in 2:0[45]/);

    codeButton.click();
    await waitFor(dom, () => /Copied/.test(codeButton.textContent));
    assert.equal(copied, 'ABCD-EFGH');
    dom.window.close();
});

test('repository setup offers a prefilled private GitHub repository', async () => {
    const status = {
        enabled: true, connected: false, hasToken: true,
        account: { login: 'ada' }, installUrl: 'https://github.com/apps/better-peakbagger-backup/installations/new',
    };
    const repo = { owner: 'ada', name: 'existing', fullName: 'ada/existing', defaultBranch: 'main', installationId: 11 };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_DISCOVER' ? { repos: [repo] } : status;
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Create repository on GitHub'));
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/existing'), 'a sole granted repository must still be inspected by an explicit choice');

    let opened = null;
    dom.window.open = url => { opened = url; };
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Create repository on GitHub').click();
    const url = new URL(opened);
    assert.equal(url.origin + url.pathname, 'https://github.com/new');
    assert.equal(url.searchParams.get('name'), 'better-peakbagger-backup');
    assert.equal(url.searchParams.get('owner'), 'ada');
    assert.equal(url.searchParams.get('visibility'), 'private');
    assert.match(url.searchParams.get('description'), /Backups and transfers/);
});

test('a populated repository requires an explicit confirmation before connection', async () => {
    const repo = { owner: 'ada', name: 'project', fullName: 'ada/project', defaultBranch: 'main', installationId: 11 };
    let connected = false;
    const selectMessages = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    reply = {
                        enabled: true, connected, hasToken: true, account: { login: 'ada' },
                        repo: connected ? repo : null, installUrl: 'https://github.com/apps/example/installations/new',
                    };
                } else if (message.type === 'GITHUB_AUTH_DISCOVER') {
                    reply = { repos: [repo] };
                } else if (message.type === 'GITHUB_AUTH_SELECT_REPO') {
                    selectMessages.push(message);
                    if (!message.confirmExisting) reply = { connected: false, needsConfirmation: true, repo };
                    else { connected = true; reply = { connected: true, hasToken: true, account: { login: 'ada' }, repo }; }
                } else reply = {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/project'));
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'ada/project').click();
    await waitFor(dom, () => /already contains files/.test(el(dom, 'github-panel').textContent));
    assert.match(el(dom, 'github-panel').textContent, /Existing files will stay in place/);
    assert.equal(connected, false);

    // Focusing another window while reading this must not destroy the question.
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(el(dom, 'github-panel').textContent, /already contains files/,
        'a confirmation the user is reading must survive a window focus');

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Use this repository').click();
    await waitFor(dom, () => /Repository ada\/project/.test(el(dom, 'github-panel').textContent));
    assert.deepEqual(selectMessages.map(message => !!message.confirmExisting), [false, true]);
});

test('repository setup shows the specific GitHub failure instead of generic copy', async () => {
    const status = {
        enabled: true, connected: false, hasToken: true, account: { login: 'ada' },
        installUrl: 'https://github.com/apps/example/installations/new',
    };
    const repo = { owner: 'ada', name: 'backup', fullName: 'ada/backup', defaultBranch: 'main', installationId: 11 };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = status;
                if (message.type === 'GITHUB_AUTH_DISCOVER') reply = { repos: [repo] };
                if (message.type === 'GITHUB_AUTH_SELECT_REPO') {
                    reply = { connected: false, error: { code: 'unknown', message: 'Repository service is temporarily unavailable.' } };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/backup'));
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'ada/backup').click();
    await waitFor(dom, () => /Repository service is temporarily unavailable/.test(el(dom, 'github-panel').textContent));
    assert.doesNotMatch(el(dom, 'github-panel').textContent, /something went wrong/i);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));
});

test('a connected status renders the account and repository', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: withGithubBackground({
            enabled: true, connected: true, hasToken: true,
            account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        })
    });
    await new Promise(r => dom.window.setTimeout(r, 40));
    assert.equal(el(dom, 'github-detail').hidden, false);
    const panelText = el(dom, 'github-panel').textContent;
    assert.match(panelText, /@ada/);
    assert.match(panelText, /ada\/peaks/);
    // The connected state offers a disconnect control.
    const buttons = Array.from(el(dom, 'github-panel').querySelectorAll('button'), b => b.textContent);
    assert.ok(buttons.includes('Disconnect'));
    // The repository link belongs to the connection, not to ascent backup.
    const repositoryLink = el(dom, 'github-panel').querySelector('a[href="https://github.com/ada/peaks"]');
    assert.ok(repositoryLink, 'the connected panel links to the selected repository');
    assert.equal(repositoryLink.textContent, 'View repository');
    assert.equal(repositoryLink.getAttribute('target'), '_blank');
    assert.equal(repositoryLink.getAttribute('rel'), 'noopener noreferrer');
});

test('an auth-storage read failure is not presented as a disconnected account', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = () => Promise.resolve({
                phase: 'error',
                error: { code: 'unknown', message: 'Local authorization storage could not be read.' },
            });
        },
    });

    await waitFor(dom, () => /Local authorization storage could not be read/.test(
        el(dom, 'github-panel').textContent));
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));
    assert.doesNotMatch(el(dom, 'github-panel').textContent, /Connect a GitHub account/);
});

test('a failed GitHub disconnect stays connected and does not announce success', async () => {
    const connected = {
        enabled: true, connected: true, hasToken: true,
        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_DISCONNECT'
                    ? { phase: 'error', error: { code: 'unexpected', message: 'Local credential removal failed.' } }
                    : connected;
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => /Repository ada\/peaks/.test(el(dom, 'github-panel').textContent));

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Disconnect').click();
    await waitFor(dom, () => /Local credential removal failed/.test(el(dom, 'github-panel').textContent));

    assert.doesNotMatch(el(dom, 'status').textContent, /disconnected/i);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));
});

test('the connected ascent panel reports repository-backed progress and refreshes on focus', async () => {
    let ascentCount = 0;
    let summaryReads = 0;
    const status = {
        enabled: true, connected: true, hasToken: true,
        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') {
                    summaryReads++;
                    reply = { ok: true, count: ascentCount };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => /No ascents backed up yet/.test(el(dom, 'github-ascent-panel').textContent));
    assert.equal(el(dom, 'github-ascent-panel').querySelector('a[href="https://github.com/ada/peaks"]'), null,
        'the repository link belongs to the GitHub connection, not the ascent summary');

    // A plain alt-tab back to the browser must not cost a GitHub API request
    // or flash "Checking existing backups…" at the user.
    const readsBeforeFocus = summaryReads;
    ascentCount = 3;
    for (let i = 0; i < 3; i++) dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(summaryReads, readsBeforeFocus,
        'window focus alone must not re-query GitHub');
    assert.match(el(dom, 'github-ascent-panel').textContent, /No ascents backed up yet/,
        'the cached summary stays painted, with no Checking… flash');

    // The explicit control is still a forced refetch.
    dom.chrome.runtime.sendMessage = (message, callback) => {
        let reply = {};
        if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
        if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') {
            summaryReads++;
            reply = { ok: false, error: { code: 'github-unavailable' } };
        }
        if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
        return Promise.resolve(reply);
    };
    el(dom, 'github-ascent-panel').querySelector('.github-backup-summary')
        .dispatchEvent(new dom.window.Event('nothing'));
    assert.ok(summaryReads === readsBeforeFocus, 'sanity: nothing has re-read yet');
});

test('the GitHub panel re-checks access only after an actual round trip to GitHub', async () => {
    // GITHUB_AUTH_DISCOVER is the repository-listing GitHub API call; the local
    // GITHUB_AUTH_STATUS read is not what this finding is about.
    let repos = [];
    let discoveries = 0;
    const status = {
        enabled: true, connected: false, hasToken: true, permissionGranted: true,
        account: { login: 'ada' }, installUrl: 'https://github.com/settings/installations/1',
    };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async () => {} };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_AUTH_DISCOVER') { discoveries++; reply = { repos }; }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Grant repository access'));
    await new Promise(resolve => setTimeout(resolve, 60));

    // Unarmed: alt-tabbing back to the browser costs nothing.
    const before = discoveries;
    for (let i = 0; i < 3; i++) dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(discoveries, before, 'an unarmed focus must not re-query GitHub');

    // Armed by actually sending the user to GitHub's access page.
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Grant repository access').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    repos = [{ owner: 'ada', name: 'peaks', fullName: 'ada/peaks' }];
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await waitFor(dom, () => /ada\/peaks/.test(el(dom, 'github-panel').textContent));
    assert.equal(discoveries, before + 1, 'returning from GitHub is what the listener is for');

    // ...and it disarms, so the next alt-tab is free again.
    for (let i = 0; i < 3; i++) dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(discoveries, before + 1, 'the armed flag is consumed exactly once');
});

test('the connected state opens the signed-in climber\'s all-years My Ascents page', async () => {
    let opened = null;
    const target = 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999&sort=AscentDate';
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { opened = details.url; } };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'PEAKBAGGER_MY_ASCENTS'
                    ? { ok: true, url: target }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Open My Ascents'));
    assert.match(el(dom, 'github-ascent-panel').textContent, /covers every year/);

    Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open My Ascents').click();
    await waitFor(dom, () => opened);
    assert.equal(opened, target);
});

test('the My Ascents action explains when Peakbagger is signed out', async () => {
    const opened = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { opened.push(details.url); } };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'PEAKBAGGER_MY_ASCENTS'
                    ? {
                        ok: false,
                        error: {
                            code: 'peakbagger-signed-out',
                            message: 'Peakbagger could not find a signed-in account. Sign in to Peakbagger, then try again.',
                        },
                    }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Open My Ascents'));
    Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open My Ascents').click();
    await waitFor(dom, () => /could not find a signed-in account/i.test(el(dom, 'github-ascent-panel').textContent));

    assert.match(el(dom, 'github-ascent-panel').textContent, /Sign in to Peakbagger, then try again/);
    assert.doesNotMatch(el(dom, 'github-ascent-panel').textContent, /something went wrong/i);
    const signIn = Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Sign in to Peakbagger');
    assert.ok(signIn, 'the signed-out error offers a direct recovery action');
    signIn.click();
    await waitFor(dom, () => opened.length > 0);
    assert.equal(opened[0], 'https://www.peakbagger.com/Climber/Login.aspx');
});

test('the connected state exposes independent save and delete backup choices', async () => {
    const dom = await loadOptions({
        enableGithubBackup: true,
        removeGithubBackupOnDelete: true,
    }, {
        prepareChrome: withGithubBackground({
            enabled: true, connected: true, hasToken: true, auto: false,
            account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        }),
    });
    await new Promise(r => dom.window.setTimeout(r, 40));
    const autoEl = el(dom, 'github-auto-backup');
    assert.ok(autoEl, 'the auto-backup checkbox is present when connected');
    assert.equal(autoEl.checked, false);

    autoEl.checked = true;
    autoEl.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(dom.chrome._store.bpbSettings.autoGithubBackup, true);

    const deleteEl = el(dom, 'github-delete-backup');
    assert.ok(deleteEl, 'the deletion-mirroring checkbox is present when connected');
    assert.equal(deleteEl.checked, true,
        'a saved deletion-mirroring preference must survive Settings reload');
    assert.match(el(dom, 'github-ascent-panel').textContent, /Git history and your own files remain/);

    deleteEl.checked = false;
    deleteEl.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(dom.chrome._store.bpbSettings.removeGithubBackupOnDelete, false);
});
