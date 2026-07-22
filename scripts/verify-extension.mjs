// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the REAL unpacked extension in hidden Chrome and drives a local
// Peakbagger stand-in, so the actual manifest decides script order and worlds.
//
// This covers what nothing else does. npm test evaluates the built bundles in
// jsdom, so it cannot see how a browser interprets manifest order and worlds.
// scripts/verify-terrain-visual.mjs provides storage and bridge-protocol stubs,
// so it does not exercise the real cross-world bridge. The worker also has to
// boot through the manifest's single bundled background entry. Two shipped
// regressions lived in exactly those blind spots.
//
// Browser notes, both learned the hard way:
//   - Chrome *stable* 137+ refuses --load-extension. Use Chrome for Testing,
//     which Playwright installs.
//   - Playwright's default headless is chrome-headless-shell, a separate binary
//     with no extension support at all. channel:'chromium' + headless:true runs
//     full Chrome for Testing in new headless, which does load extensions.
//
// Hidden: no window is shown and the user's browser/profile is never touched.

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createBrowserFixtureServer,
    createFailureCollector,
    createSyntheticCaptureJob,
    storeUrls,
    surfaceSelectors,
    verificationViewport,
    waitForCondition
} from './browser-verification-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The unpacked extension is the built bundle tree, not the source root.
const dist = process.env.BPB_VERIFY_EXTENSION_SOURCE
    ? path.resolve(process.env.BPB_VERIFY_EXTENSION_SOURCE)
    : path.join(root, 'dist');

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.error('This check needs Playwright: npm install && npx playwright install chromium');
    process.exit(1);
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-extension-'));
const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
const port = fixture.port;
const buddyListFixture = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'report-buddy-list.html'), 'utf8');

const failureCollector = createFailureCollector();
const { failures, check } = failureCollector;

let context;
try {
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        ignoreHTTPSErrors: true,
        viewport: verificationViewport,
        args: [
            `--disable-extensions-except=${dist}`,
            `--load-extension=${dist}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'
        ]
    });

    // --- The MV3 service worker actually boots -------------------------------
    // Chrome boots the bundled worker selected by the manifest. A missing
    // source in its bundle or an initialization failure can prevent the
    // coordinator from registering its listener and leave capture silently dead.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    check(!!worker, 'the extension service worker never started');
    const extensionId = worker ? new URL(worker.url()).host : null;

    if (extensionId) {
        const optionsPage = await context.newPage();
        await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
        // A live worker answers; a bailed-out one has no listener at all.
        const reply = await optionsPage.evaluate(async () =>
            chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: -1 })
                .then(value => ({ ok: true, value: value ?? null }))
                .catch(error => ({ ok: false, error: String(error) })));
        check(reply.ok, `the worker never answered CAPTURE_STATUS (capture would be dead): ${reply.error || ''}`);

        const storageProbe = await optionsPage.evaluate(async () => {
            const keys = {
                sync: 'bpbBrowserVerifySync',
                local: 'bpbBrowserVerifyLocal',
                session: 'bpbBrowserVerifySession'
            };
            const changed = new Promise(resolve => {
                const listener = (changes, area) => {
                    if (area === 'local' && changes[keys.local]?.newValue === 'local') {
                        chrome.storage.onChanged.removeListener(listener);
                        resolve(true);
                    }
                };
                chrome.storage.onChanged.addListener(listener);
            });
            await Promise.all([
                chrome.storage.sync.set({ [keys.sync]: 'sync' }),
                chrome.storage.local.set({ [keys.local]: 'local' }),
                chrome.storage.session.set({ [keys.session]: 'session' })
            ]);
            const [sync, local, session, onChanged] = await Promise.all([
                chrome.storage.sync.get(keys.sync),
                chrome.storage.local.get(keys.local),
                chrome.storage.session.get(keys.session),
                changed
            ]);
            await Promise.all([
                chrome.storage.sync.remove(keys.sync),
                chrome.storage.local.remove(keys.local),
                chrome.storage.session.remove(keys.session)
            ]);
            return {
                origin: location.origin,
                version: chrome.runtime.getManifest().version,
                optionsOpenInTab: chrome.runtime.getManifest().options_ui?.open_in_tab,
                renderedVersion: document.getElementById('about-version')?.textContent,
                values: [sync[keys.sync], local[keys.local], session[keys.session]],
                onChanged
            };
        });
        check(storageProbe.origin.startsWith('chrome-extension://')
            && storageProbe.renderedVersion === `Version ${storageProbe.version}`
            && storageProbe.optionsOpenInTab === true,
        `the Chrome options origin or manifest version was wrong: ${JSON.stringify(storageProbe)}`);
        check(storageProbe.onChanged && storageProbe.values.join(',') === 'sync,local,session',
            `Chrome storage areas or storage.onChanged did not round-trip: ${JSON.stringify(storageProbe)}`);
        await optionsPage.locator('#units').selectOption('metric');
        const optionPersisted = await optionsPage.waitForFunction(async () =>
            (await chrome.storage.sync.get('bpbSettings')).bpbSettings?.units === 'metric',
        null, { timeout: 5000 }).then(() => true).catch(() => false);
        check(optionPersisted, 'the Chrome options page did not persist a real setting change');
        await optionsPage.locator('#units').selectOption('auto');
        await optionsPage.evaluate(async () => {
            const { bpbSettings = {} } = await chrome.storage.sync.get('bpbSettings');
            await Promise.all([
                chrome.storage.sync.set({
                    bpbSettings: { ...bpbSettings, enableGithubBackup: true }
                }),
                chrome.storage.local.set({
                    bpbGithubAuth: {
                        token: 'browser-verification-only',
                        repo: { owner: 'fixture', name: 'backup', branch: 'main', fullName: 'fixture/backup' }
                    }
                })
            ]);
        });

        let buddyRequests = 0;
        let fallbackReportRequests = 0;
        const signedInBuddyUrl = 'https://www.peakbagger.com/report/report.aspx?r=b';
        await context.route(signedInBuddyUrl, route => {
            fallbackReportRequests++;
            return route.fulfill({ status: 200, contentType: 'text/html', body: buddyListFixture });
        });
        await optionsPage.evaluate(({ signedInBuddyUrl, buddyListFixture }) => {
            window.__bpbNativeFetch = window.fetch;
            window.__bpbBuddyRequests = 0;
            window.fetch = async (input, init) => {
                if (String(input) !== signedInBuddyUrl) return window.__bpbNativeFetch(input, init);
                const request = ++window.__bpbBuddyRequests;
                if (request === 1) {
                    return { status: 200, headers: {}, text: async () => buddyListFixture };
                }
                if (request === 4) {
                    return {
                        status: 401,
                        headers: {},
                        text: async () => '<html><body><a href="/Default.aspx">Log In</a></body></html>',
                    };
                }
                return { status: 500, headers: {}, text: async () => 'fixture failure' };
            };
        }, { signedInBuddyUrl, buddyListFixture });
        const buddyCacheHint = await optionsPage.locator('#favorites-buddy-cache-hint').textContent();
        check(/saved copy of your Buddy List for up to 7 days/.test(buddyCacheHint || '')
            && /may not appear immediately; choose Refresh now/.test(buddyCacheHint || ''),
        `the Buddy source did not explain its saved-copy freshness: ${JSON.stringify(buddyCacheHint)}`);
        await optionsPage.locator('#favorites-refresh-buddies').click();
        const buddyRefresh = await optionsPage.waitForFunction(async () => {
            const cache = (await chrome.storage.local.get('bpbBuddyCache')).bpbBuddyCache;
            const status = document.getElementById('favorites-buddy-status')?.textContent || '';
            return cache?.entries?.length === 6 && /6 buddies/.test(status)
                ? { ownerCid: cache.ownerCid, entries: cache.entries.length, status }
                : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        buddyRequests = await optionsPage.evaluate(() => window.__bpbBuddyRequests);
        check(buddyRequests === 1 && buddyRefresh?.ownerCid === 900001 && buddyRefresh?.entries === 6,
            `the options Buddy refresh did not use the direct signed-in report: ${JSON.stringify({ buddyRequests, buddyRefresh })}`);
        if (process.env.BPB_VERIFY_FAVORITES_BUDDY_SCREENSHOT) {
            await optionsPage.locator('#favorites').screenshot({ path: process.env.BPB_VERIFY_FAVORITES_BUDDY_SCREENSHOT });
        }

        await optionsPage.locator('#favorites-refresh-buddies').click();
        const buddyRecovery = await optionsPage.waitForFunction(() => {
            const status = document.getElementById('favorites-buddy-status');
            const link = status?.querySelector('a');
            return /temporarily unavailable \(HTTP 500\)/.test(status?.textContent || '') && link
                ? { label: link.textContent, href: link.href }
                : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        buddyRequests = await optionsPage.evaluate(() => window.__bpbBuddyRequests);
        check(buddyRequests === 2
            && buddyRecovery?.label === 'Open Buddy List'
            && buddyRecovery?.href === signedInBuddyUrl,
        `the options Buddy recovery did not point back to the direct report: ${JSON.stringify({ buddyRequests, buddyRecovery })}`);

        await optionsPage.locator('input[name="favorites-source"][value="custom"]').check();
        await optionsPage.locator('#favorites-mirror-buddies').click();
        const importRecovery = await optionsPage.waitForFunction(() => {
            const status = document.getElementById('favorites-import-status');
            const link = status?.querySelector('a');
            return !status?.hidden
                && /temporarily unavailable \(HTTP 500\)/.test(status?.textContent || '')
                && link
                ? { label: link.textContent, href: link.href }
                : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        buddyRequests = await optionsPage.evaluate(() => window.__bpbBuddyRequests);
        check(buddyRequests === 3
            && importRecovery?.label === 'Open Buddy List'
            && importRecovery?.href === signedInBuddyUrl,
        `the custom import failure was not persistent and actionable: ${JSON.stringify({ buddyRequests, importRecovery })}`);

        await optionsPage.locator('#favorites-merge-buddies').click();
        await waitForCondition(
            () => context.pages().some(page => page.url() === signedInBuddyUrl),
            { description: 'the first-party Buddy helper navigation', timeoutMs: 5000 }
        ).catch(() => false);
        const fallbackImport = await optionsPage.waitForFunction(async () => {
            const favorites = (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers;
            const status = document.getElementById('favorites-import-status');
            return favorites?.entries?.length === 6
                && /Merge complete: 6 added, 0 removed/.test(status?.textContent || '')
                ? { count: favorites.entries.length, status: status.textContent }
                : false;
        }, null, { timeout: 10000 }).then(handle => handle.jsonValue()).catch(() => null);
        buddyRequests = await optionsPage.evaluate(() => window.__bpbBuddyRequests);
        await optionsPage.evaluate(() => { window.fetch = window.__bpbNativeFetch; });
        const fallbackDebug = await optionsPage.evaluate(async () => ({
            importStatus: document.getElementById('favorites-import-status')?.textContent || '',
            cache: (await chrome.storage.local.get('bpbBuddyCache')).bpbBuddyCache || null,
            favorites: (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers || null,
        }));
        const fallbackPageUrls = context.pages().map(page => page.url());
        const fallbackTabClosed = !fallbackPageUrls.includes(signedInBuddyUrl)
            && !fallbackPageUrls.some(url => url.endsWith('/options/buddy-refresh.html'));
        check(buddyRequests === 4
            && fallbackReportRequests === 1
            && fallbackImport?.count === 6
            && fallbackTabClosed,
        `the first-party Buddy import fallback failed or leaked its tab: ${JSON.stringify({
            buddyRequests, fallbackReportRequests, fallbackImport, fallbackTabClosed, fallbackPageUrls,
            fallbackDebug
        })}`);

        await optionsPage.evaluate(async ({ signedInBuddyUrl, buddyListFixture }) => {
            const current = (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers;
            await chrome.storage.local.set({
                bpbFavoriteClimbers: {
                    schemaVersion: 1,
                    entries: [
                        { cid: 900099, name: 'Manual Favorite', addedAt: 1, source: 'manual' },
                        ...current.entries,
                    ],
                },
            });
            window.fetch = async (input, init) => String(input) === signedInBuddyUrl
                ? { status: 200, headers: {}, text: async () => buddyListFixture }
                : window.__bpbNativeFetch(input, init);
        }, { signedInBuddyUrl, buddyListFixture });
        await optionsPage.locator('.favorite-item[data-cid="900099"]').waitFor({ state: 'visible', timeout: 5000 });
        const favoriteSourceCounts = await optionsPage.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('[data-favorites-source-filter]')].map(button => [
                button.dataset.favoritesSourceFilter,
                button.querySelector('[data-favorites-source-count]')?.textContent || '',
            ])
        ));
        await optionsPage.locator('[data-favorites-source-filter="manual"]').click();
        const manualFavoritesFiltered = await optionsPage.waitForFunction(() => {
            const rows = [...document.querySelectorAll('.favorite-item')];
            return rows.length === 1 && rows[0].dataset.cid === '900099'
                && document.getElementById('favorites-count')?.textContent === '1 of 7 favorites';
        }, null, { timeout: 5000 }).then(() => true).catch(() => false);
        await optionsPage.locator('[data-favorites-source-filter="buddy"]').click();
        const buddyFavoritesFiltered = await optionsPage.waitForFunction(() =>
            document.querySelectorAll('.favorite-item').length === 6
                && !document.querySelector('.favorite-item[data-cid="900099"]')
                && document.getElementById('favorites-count')?.textContent === '6 of 7 favorites',
        null, { timeout: 5000 }).then(() => true).catch(() => false);
        check(favoriteSourceCounts.all === '7'
            && favoriteSourceCounts.buddy === '6'
            && favoriteSourceCounts.manual === '1'
            && manualFavoritesFiltered
            && buddyFavoritesFiltered,
        `the custom Favorites source counts or filters were wrong: ${JSON.stringify({
            favoriteSourceCounts, manualFavoritesFiltered, buddyFavoritesFiltered
        })}`);
        await optionsPage.locator('[data-favorites-source-filter="all"]').click();
        await optionsPage.locator('.favorite-item[data-cid="900099"]').waitFor({ state: 'visible', timeout: 5000 });
        await optionsPage.locator('#favorites-mirror-buddies').click();
        const mirrorConfirmation = await optionsPage.waitForFunction(async () => {
            const dialog = document.getElementById('favorites-mirror-confirmation');
            const favorites = (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers;
            return dialog && !dialog.hidden && favorites?.entries?.length === 7
                ? {
                    role: dialog.getAttribute('role'),
                    text: dialog.textContent || '',
                    confirm: document.getElementById('favorites-mirror-confirm')?.textContent || '',
                    focused: document.activeElement?.id || '',
                }
                : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        check(mirrorConfirmation?.role === 'alertdialog'
            && /0 buddies will be added\. 1 custom favorite will be removed\./.test(mirrorConfirmation.text)
            && /exactly match your 6 current buddies/.test(mirrorConfirmation.text)
            && /undo for 6 seconds/.test(mirrorConfirmation.text)
            && mirrorConfirmation.confirm === 'Replace custom list'
            && mirrorConfirmation.focused === 'favorites-mirror-cancel',
        `the Buddy mirror did not stop at an explicit destructive confirmation: ${JSON.stringify(mirrorConfirmation)}`);
        if (process.env.BPB_VERIFY_FAVORITES_MIRROR_SCREENSHOT) {
            await optionsPage.locator('#favorites').screenshot({ path: process.env.BPB_VERIFY_FAVORITES_MIRROR_SCREENSHOT });
        }
        await optionsPage.locator('#favorites-mirror-cancel').click();
        const mirrorCancelled = await optionsPage.evaluate(async () => {
            const favorites = (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers;
            return document.getElementById('favorites-mirror-confirmation')?.hidden === true
                && favorites?.entries?.some(entry => entry.cid === 900099);
        });
        check(mirrorCancelled, 'cancelling the Buddy mirror changed custom favorites');

        await optionsPage.locator('#favorites-mirror-buddies').click();
        await optionsPage.locator('#favorites-mirror-confirmation').waitFor({ state: 'visible', timeout: 5000 });
        await optionsPage.locator('#favorites-mirror-confirm').click();
        const mirrorApplied = await optionsPage.waitForFunction(async () => {
            const favorites = (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers;
            const status = document.getElementById('favorites-import-status')?.textContent || '';
            return favorites?.entries?.length === 6
                && !favorites.entries.some(entry => entry.cid === 900099)
                && /Mirror complete: 0 added, 1 removed/.test(status);
        }, null, { timeout: 5000 }).then(() => true).catch(() => false);
        check(mirrorApplied, 'confirming the Buddy mirror did not replace the custom list');
        await optionsPage.evaluate(() => { window.fetch = window.__bpbNativeFetch; });

        if (process.env.BPB_VERIFY_FAVORITES_SCREENSHOT) {
            await optionsPage.locator('#favorites').screenshot({ path: process.env.BPB_VERIFY_FAVORITES_SCREENSHOT });
        }
        if (process.env.BPB_VERIFY_FAVORITES_NARROW_SCREENSHOT) {
            const previousViewport = optionsPage.viewportSize();
            await optionsPage.setViewportSize({ width: 480, height: 760 });
            await optionsPage.locator('#favorites-source-filter').scrollIntoViewIfNeeded();
            await optionsPage.screenshot({ path: process.env.BPB_VERIFY_FAVORITES_NARROW_SCREENSHOT });
            if (previousViewport) await optionsPage.setViewportSize(previousViewport);
        }
        if (process.env.BPB_VERIFY_FAVORITES_DARK_SCREENSHOT) {
            await optionsPage.locator('#theme').selectOption('dark');
            await optionsPage.waitForFunction(() => document.documentElement.getAttribute('data-bpb-theme') === 'dark');
            await optionsPage.locator('#favorites').screenshot({ path: process.env.BPB_VERIFY_FAVORITES_DARK_SCREENSHOT });
            await optionsPage.locator('#theme').selectOption('system');
        }

        await optionsPage.evaluate(async () => {
            const entries = Array.from({ length: 1500 }, (_, index) => ({
                cid: 100000 + index,
                name: index === 1498
                    ? 'Navigation Alpine Climber 1499'
                    : `Navigation Scale Climber ${String(index + 1).padStart(4, '0')}`,
                addedAt: index,
                source: index % 2 ? 'buddy' : 'manual',
            }));
            const { bpbSettings = {} } = await chrome.storage.sync.get('bpbSettings');
            await Promise.all([
                chrome.storage.sync.set({
                    bpbSettings: { ...bpbSettings, favoritesSource: 'custom' },
                }),
                chrome.storage.local.set({
                    bpbFavoriteClimbers: { schemaVersion: 1, entries },
                }),
            ]);
        });
        const scaleFavoritesRendered = await optionsPage.waitForFunction(() =>
            document.querySelectorAll('.favorite-item').length === 1500,
        null, { timeout: 10000 }).then(() => true).catch(() => false);
        const fullFavoriteCount = await optionsPage.locator('#favorites-count').textContent();
        await optionsPage.locator('#favorites-search').fill('alpin clmber 1499');
        const fuzzyFavoriteSearch = await optionsPage.waitForFunction(() => {
            const rows = [...document.querySelectorAll('.favorite-item')];
            const count = document.getElementById('favorites-count')?.textContent || '';
            return rows.length === 1 && count === '1 of 1,500 favorites'
                ? { name: rows[0].querySelector('.favorite-name')?.textContent || '', count }
                : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        check(fullFavoriteCount === '1,500 favorites'
            && fuzzyFavoriteSearch?.name === 'Navigation Alpine Climber 1499',
        `the real 1,500-row custom list did not report or fuzzy-filter its total: ${JSON.stringify({
            fullFavoriteCount, fuzzyFavoriteSearch
        })}`);
        await optionsPage.locator('#favorites-search').fill('');
        await optionsPage.waitForFunction(() => document.querySelectorAll('.favorite-item').length === 1500,
            null, { timeout: 10000 });
        const longDistanceNavigation = await optionsPage.evaluate(() => {
            const content = document.querySelector('.content');
            const target = document.getElementById('drafts');
            const link = document.querySelector('.side-nav a[href="#drafts"]');
            const previousBehavior = content.style.scrollBehavior;
            content.style.scrollBehavior = 'auto';
            content.scrollTop = 0;
            void content.scrollTop;
            if (previousBehavior) content.style.scrollBehavior = previousBehavior;
            else content.style.removeProperty('scroll-behavior');

            const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
            const distance = () => target.getBoundingClientRect().top
                - content.getBoundingClientRect().top - margin;
            const before = distance();
            link.click();
            return {
                before,
                after: distance(),
                viewportHeight: content.clientHeight,
                scrollTop: content.scrollTop,
                hash: location.hash,
            };
        });
        check(scaleFavoritesRendered
            && longDistanceNavigation.before > Math.min(longDistanceNavigation.viewportHeight * 2, 1200)
            && Math.abs(longDistanceNavigation.after) <= 2
            && longDistanceNavigation.scrollTop > 0
            && longDistanceNavigation.hash === '#drafts',
        `the 1,500-row options list did not make long-distance sidebar navigation instant: ${JSON.stringify({
            scaleFavoritesRendered, longDistanceNavigation
        })}`);

        await optionsPage.evaluate(async () => {
            const { bpbSettings = {} } = await chrome.storage.sync.get('bpbSettings');
            await Promise.all([
                chrome.storage.sync.set({
                    bpbSettings: { ...bpbSettings, favoritesSource: 'custom', theme: 'dark' },
                }),
                chrome.storage.local.set({
                    bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
                }),
            ]);
        });
        const climberPage = await context.newPage();
        await climberPage.setViewportSize({ width: 536, height: 500 });
        await climberPage.goto(`https://www.peakbagger.com:${port}/climber/climber.aspx?cid=900002`, { waitUntil: 'load' });
        await climberPage.locator('#bpb-climber-favorite').waitFor({ state: 'visible', timeout: 5000 });
        const favoriteToggle = await climberPage.evaluate(() => {
            const heading = document.querySelector('#TitleLabel h1');
            const host = document.getElementById('TitleLabel');
            const button = document.getElementById('bpb-climber-favorite');
            const headingRect = heading.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            return {
                text: button.textContent,
                label: button.getAttribute('aria-label'),
                title: button.title,
                pressed: button.getAttribute('aria-pressed'),
                hostDisplay: getComputedStyle(host).display,
                sameHost: button.parentElement === host && heading.parentElement === host,
                buttonWidth: buttonRect.width,
                followsHeading: buttonRect.left >= headingRect.right - 1,
                verticallyAligned: buttonRect.top < headingRect.bottom && buttonRect.bottom > headingRect.top,
                theme: document.documentElement.getAttribute('data-bpb-theme'),
            };
        });
        check(favoriteToggle?.text === '☆'
            && favoriteToggle?.label === 'Add Morgan Longlastname to your favorites'
            && favoriteToggle?.title === favoriteToggle?.label
            && favoriteToggle?.pressed === 'false'
            && favoriteToggle?.hostDisplay === 'inline-flex'
            && favoriteToggle?.sameHost
            && favoriteToggle?.buttonWidth === 30
            && favoriteToggle?.followsHeading
            && favoriteToggle?.verticallyAligned
            && favoriteToggle?.theme === 'dark',
        `the climber favorite toggle was not compact and inline with the title: ${JSON.stringify(favoriteToggle)}`);
        if (process.env.BPB_VERIFY_CLIMBER_FAVORITE_SCREENSHOT) {
            await climberPage.screenshot({ path: process.env.BPB_VERIFY_CLIMBER_FAVORITE_SCREENSHOT });
        }
        await climberPage.locator('#bpb-climber-favorite').click();
        const favoriteAppliedUi = await climberPage.waitForFunction(() => {
            const button = document.getElementById('bpb-climber-favorite');
            return button?.textContent === '★'
                && button.getAttribute('aria-pressed') === 'true'
                ? { text: button.textContent, pressed: button.getAttribute('aria-pressed') }
                : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        const favoriteAppliedStorage = await optionsPage.waitForFunction(async () => {
            const favorites = (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers;
            return favorites?.entries?.some(entry => entry.cid === 900002) ? favorites : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        check(!!favoriteAppliedUi && !!favoriteAppliedStorage,
            `the compact climber favorite toggle did not persist or fill after clicking: ${JSON.stringify({ favoriteAppliedUi, favoriteAppliedStorage })}`);

        // Reset the manual toggle, then exercise the real native form
        // navigation. The content script must wait for the refreshed report to
        // confirm Peakbagger accepted each action before touching favorites.
        await climberPage.locator('#bpb-climber-favorite').click();
        await optionsPage.waitForFunction(async () => {
            const favorites = (await chrome.storage.local.get('bpbFavoriteClimbers')).bpbFavoriteClimbers;
            return !favorites?.entries?.some(entry => entry.cid === 900002);
        }, null, { timeout: 5000 });
        const buddyMutationBaseline = {
            ...fixture.requests,
            buddyReportStates: [...fixture.requests.buddyReportStates],
            storage: await optionsPage.evaluate(async () =>
                chrome.storage.local.get(['bpbFavoriteClimbers', 'bpbBuddyCache'])),
        };
        await Promise.all([
            climberPage.waitForNavigation({ waitUntil: 'load' }),
            climberPage.locator('#BuddyButton').click(),
        ]);
        const buddyAddedUi = await climberPage.waitForFunction(() => {
            const nativeButton = document.getElementById('BuddyButton');
            const favorite = document.getElementById('bpb-climber-favorite');
            return nativeButton?.value === 'Remove from My Buddy List'
                && favorite?.textContent === '★'
                ? { nativeValue: nativeButton.value, favorite: favorite.textContent }
                : false;
        }, null, { timeout: 10000 }).then(handle => handle.jsonValue()).catch(() => null);
        await optionsPage.bringToFront();
        const buddyAddedStorage = await optionsPage.evaluate(async () => {
            const { bpbFavoriteClimbers: favorites, bpbBuddyCache: cache } = await chrome.storage.local.get([
                'bpbFavoriteClimbers', 'bpbBuddyCache'
            ]);
            return {
                favorite: favorites?.entries?.find(entry => entry.cid === 900002) || null,
                cached: cache?.entries?.some(entry => entry.cid === 900002) || false,
            };
        });
        check(buddyAddedUi?.favorite === '★'
            && buddyAddedStorage.favorite?.source === 'buddy'
            && buddyAddedStorage.cached,
        `a confirmed native Buddy addition did not refresh and join custom favorites: ${JSON.stringify({
            buddyAddedUi, buddyAddedStorage, buddyMutationBaseline, fixtureRequests: fixture.requests
        })}`);

        await climberPage.bringToFront();
        await Promise.all([
            climberPage.waitForNavigation({ waitUntil: 'load' }),
            climberPage.locator('#BuddyButton').click(),
        ]);
        await waitForCondition(
            () => fixture.requests.buddyReports - buddyMutationBaseline.buddyReports >= 2,
            { description: 'the default-removal Buddy report', timeoutMs: 10000 }
        );
        await optionsPage.bringToFront();
        const removalPreserved = await optionsPage.waitForFunction(async () => {
            const { bpbFavoriteClimbers: favorites, bpbBuddyCache: cache } = await chrome.storage.local.get([
                'bpbFavoriteClimbers', 'bpbBuddyCache'
            ]);
            return favorites?.entries?.some(entry => entry.cid === 900002)
                && cache?.entries && !cache.entries.some(entry => entry.cid === 900002);
        }, null, { timeout: 10000 }).then(() => true).catch(() => false);
        check(removalPreserved,
            'the default native Buddy removal did not refresh the cache while preserving the custom favorite');

        await optionsPage.locator('#favorites-remove-with-buddy').check();
        await optionsPage.waitForFunction(async () =>
            (await chrome.storage.sync.get('bpbSettings')).bpbSettings?.removeFavoriteWhenBuddyRemoved === true,
        null, { timeout: 10000 });
        await climberPage.bringToFront();
        await Promise.all([
            climberPage.waitForNavigation({ waitUntil: 'load' }),
            climberPage.locator('#BuddyButton').click(),
        ]);
        await optionsPage.bringToFront();
        await optionsPage.waitForFunction(async () =>
            (await chrome.storage.local.get('bpbBuddyCache')).bpbBuddyCache?.entries?.some(entry => entry.cid === 900002),
        null, { timeout: 10000 });
        await climberPage.bringToFront();
        await Promise.all([
            climberPage.waitForNavigation({ waitUntil: 'load' }),
            climberPage.locator('#BuddyButton').click(),
        ]);
        const removalSyncedUi = await climberPage.waitForFunction(() =>
            document.getElementById('BuddyButton')?.value === 'Add to My Buddy List'
                && document.getElementById('bpb-climber-favorite')?.textContent === '☆',
        null, { timeout: 10000 }).then(() => true).catch(() => false);
        await optionsPage.bringToFront();
        const removalSyncedStorage = await optionsPage.waitForFunction(async () => {
            const { bpbFavoriteClimbers: favorites, bpbBuddyCache: cache } = await chrome.storage.local.get([
                'bpbFavoriteClimbers', 'bpbBuddyCache'
            ]);
            return favorites?.entries && !favorites.entries.some(entry => entry.cid === 900002)
                && cache?.entries && !cache.entries.some(entry => entry.cid === 900002);
        }, null, { timeout: 10000 }).then(() => true).catch(() => false);
        check(removalSyncedUi && removalSyncedStorage
            && fixture.requests.buddyMutations - buddyMutationBaseline.buddyMutations === 4
            && fixture.requests.buddyReports - buddyMutationBaseline.buddyReports === 4,
        `opt-in Buddy removal sync or its one-refresh-per-action contract failed: ${JSON.stringify({
            removalSyncedUi,
            removalSyncedStorage,
            before: buddyMutationBaseline,
            after: fixture.requests,
        })}`);
        await climberPage.close();

        await optionsPage.locator('#favorites-remove-with-buddy').uncheck();
        await optionsPage.locator('input[name="favorites-source"][value="buddies"]').check();
        await optionsPage.locator('#theme').selectOption('system');
        await optionsPage.close();

        const popupPage = await context.newPage();
        await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        const popupState = await popupPage.waitForFunction(() => {
            const text = document.getElementById('state')?.textContent || '';
            return /Open an activity to begin/.test(text) ? text : false;
        }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
        check(/Garmin Connect or Strava/.test(popupState || ''),
            `the Chrome popup did not query its real active tab and render the worker response: ${JSON.stringify(popupState)}`);
        await popupPage.close();
    }

    const openAscent = async () => {
        const page = await context.newPage();
        await page.goto(`https://www.peakbagger.com:${port}/climber/ascent.aspx?aid=1`, { waitUntil: 'load' });
        await page.waitForTimeout(2000);
        return page;
    };

    const readToggle = page => page.evaluate(() => {
        const button = document.getElementById('bpb-terrain-toggle');
        return {
            // theme.js imports settings in the isolated-world bundle, so this
            // attribute proves that bundle initialized there.
            isolatedWorldReady: document.documentElement.getAttribute('data-bpb-theme'),
            analyzerPanel: !!document.getElementById('bpb-gpx-analysis'),
            stats: document.querySelector('#bpb-gpx-analysis div')?.textContent || '',
            exists: !!button,
            hidden: button ? button.hasAttribute('hidden') : null,
            display: button ? getComputedStyle(button).display : null,
            visible: button ? button.getBoundingClientRect().width > 0 : null,
            disabled: button ? button.disabled : null,
            title: button ? button.title : null
        };
    });

    // --- 3D off (the default): the toggle stays available but gates traffic --
    const offPage = await openAscent();
    const off = await readToggle(offPage);
    check(off.isolatedWorldReady !== null,
        'settings.js did not initialise in the isolated world (the bridge would be silent)');
    check(off.analyzerPanel, 'the GPX analyzer panel never rendered');
    check(/Interactive Stats/.test(off.stats), `the analyzer never produced stats: ${off.stats.slice(0, 80)}`);
    check(off.visible === true,
        `with 3D disabled the toggle must remain visible, but display=${off.display} visible=${off.visible}`);
    check(off.disabled === false,
        `the disabled feature's toggle should still be actionable after the route parses: title=${JSON.stringify(off.title)}`);
    await offPage.locator('#bpb-terrain-toggle').click();
    const consent = await offPage.locator('#bpb-terrain-consent').waitFor({ state: 'visible', timeout: 5000 })
        .then(async () => offPage.evaluate(() => {
            const dialog = document.querySelector('#bpb-terrain-consent [role="dialog"]');
            return {
                text: dialog?.textContent || '',
                modal: dialog?.getAttribute('aria-modal'),
                links: Array.from(dialog?.querySelectorAll('a') || [], link => link.href)
            };
        })).catch(() => null);
    check(consent?.modal === 'true', `the first-use 3D confirmation did not render as a modal: ${JSON.stringify(consent)}`);
    check(/Mapterhorn/.test(consent?.text || '') && /OpenFreeMap/.test(consent?.text || ''),
        `the first-use confirmation did not name both providers: ${JSON.stringify(consent)}`);
    check(consent?.links.some(link => link === 'https://mapterhorn.com/privacy-policy/')
        && consent?.links.some(link => link === 'https://openfreemap.org/privacy/'),
        `the first-use confirmation is missing provider privacy links: ${JSON.stringify(consent)}`);
    await offPage.locator('.bpb-terrain-consent-secondary').click();
    check(await offPage.locator('#bpb-terrain-consent').count() === 0,
        'declining the first-use confirmation did not close it');

    // Re-open and accept through a real protocol-driven pointer event. HTTPS
    // is intercepted so this verifies the privileged setting write and
    // continuation without contacting any tile provider.
    await context.route('https://**', route => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.hostname === 'www.peakbagger.com' && requestUrl.port === String(port)) {
            return route.continue();
        }
        return route.abort();
    });
    await offPage.locator('#bpb-terrain-toggle').click();
    await offPage.locator('#bpb-terrain-consent').waitFor({ state: 'visible', timeout: 5000 });
    await offPage.locator('.bpb-terrain-consent-primary').click();
    await offPage.locator('#bpb-terrain-consent').waitFor({ state: 'detached', timeout: 5000 });
    if (extensionId) {
        const consentCheckPage = await context.newPage();
        await consentCheckPage.goto(`chrome-extension://${extensionId}/options/options.html`);
        const enabledByConsent = await consentCheckPage.evaluate(async () =>
            (await chrome.storage.sync.get('bpbSettings')).bpbSettings?.enable3dMap === true);
        check(enabledByConsent, 'trusted confirmation did not persist enable3dMap');
        await consentCheckPage.close();
    }
    await offPage.close();

    // --- 3D on: the toggle appears and enables once the route parses ---------
    if (extensionId) {
        const optionsPage = await context.newPage();
        await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
        await optionsPage.evaluate(async () => {
            const current = (await chrome.storage.sync.get('bpbSettings')).bpbSettings || {};
            await chrome.storage.sync.set({ bpbSettings: { ...current, enable3dMap: true } });
        });
        await optionsPage.close();

        const onPage = await openAscent();
        const on = await readToggle(onPage);
        check(on.visible === true, `with 3D enabled the toggle must be visible (display=${on.display})`);
        check(on.disabled === false,
            `the toggle should enable once the route parses, but stayed greyed: title=${JSON.stringify(on.title)}`);
        await onPage.close();

        const bigMapPage = await context.newPage();
        const bigMapErrors = [];
        bigMapPage.on('pageerror', error => bigMapErrors.push(String(error)));
        const bigMapCdp = await context.newCDPSession(bigMapPage);
        await bigMapCdp.send('Runtime.enable');
        bigMapCdp.on('Runtime.exceptionThrown', event => {
            bigMapErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'unknown exception');
        });
        await bigMapPage.goto(`https://www.peakbagger.com:${port}/map/BigMap.aspx?t=A&d=2296`, { waitUntil: 'load' });
        const bigMapToggle = await bigMapPage.waitForFunction(() => {
            const button = document.getElementById('bpb-terrain-toggle');
            if (!button) return false;
            const rect = button.getBoundingClientRect();
            const state = {
                visible: rect.width > 0 && rect.height > 0,
                disabled: button.disabled,
                display: getComputedStyle(button).display
            };
            return state.visible && !state.disabled ? state : false;
        }, null, { timeout: 10000 }).then(handle => handle.jsonValue()).catch(() => null);
        const bigMapState = await bigMapPage.evaluate(() => {
            const iframe = document.getElementById('if');
            return {
                url: location.href,
                // Bundle readiness is proven by the toggle (checked below); no
                // module publishes a global anymore.
                mountExists: !!document.getElementById('bpb-map-viewport'),
                iframeMapReady: !!iframe?.contentWindow?.mapsPlaceholder,
                iframeLeafletReady: !!iframe?.contentWindow?.L,
                stylesheets: [...document.styleSheets].map(sheet => sheet.href)
            };
        });
        check(bigMapToggle?.visible === true,
            `with 3D enabled the BigMap toggle must be visible (toggle=${JSON.stringify(bigMapToggle)}, page=${JSON.stringify(bigMapState)}, errors=${JSON.stringify(bigMapErrors)})`);
        check(bigMapToggle?.disabled === false,
            `the BigMap toggle should enable once its native route is ready (state=${JSON.stringify(bigMapToggle)})`);
        await bigMapPage.close();

        const peakBigMapPage = await context.newPage();
        const peakBigMapErrors = [];
        peakBigMapPage.on('pageerror', error => peakBigMapErrors.push(String(error)));
        await peakBigMapPage.goto(
            `https://www.peakbagger.com:${port}/map/BigMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300&cyn=0`,
            { waitUntil: 'load' }
        );
        const peakBigMapToggle = await peakBigMapPage.locator('#bpb-terrain-toggle')
            .waitFor({ state: 'visible', timeout: 10000 })
            .then(async () => peakBigMapPage.locator('#bpb-terrain-toggle').isEnabled())
            .catch(() => false);
        check(peakBigMapToggle,
            `the Full Screen peak map must show an enabled 3D toggle (errors=${JSON.stringify(peakBigMapErrors)})`);
        await peakBigMapPage.evaluate(() => {
            window.__bpbPeakBigMapTerrainInit = null;
            window.addEventListener('message', event => {
                const data = event.data;
                if (event.source === window && data?.__bpbTerrain === true
                    && data.dir === 'toCS' && data.type === 'init') {
                    window.__bpbPeakBigMapTerrainInit = data;
                }
            });
        });
        await peakBigMapPage.locator('#bpb-terrain-toggle').click();
        const peakBigMapInit = await peakBigMapPage.waitForFunction(
            () => window.__bpbPeakBigMapTerrainInit, null, { timeout: 5000 }
        ).then(handle => handle.jsonValue()).catch(() => null);
        check(JSON.stringify(peakBigMapInit?.focus) === JSON.stringify([48.83115, -121.60214])
            && peakBigMapInit?.focusZoom === 13
            && peakBigMapInit?.focusPeak?.id === 2829
            && peakBigMapInit?.focusPeak?.name === 'Mount Shuksan'
            && peakBigMapInit?.focusPeak?.state === 'unclimbed'
            && !Object.hasOwn(peakBigMapInit || {}, 'routeSegments'),
            `the Full Screen peak map did not start a route-free summit view (init=${JSON.stringify(peakBigMapInit)})`);
        const peakBigMapFrameCreated = await peakBigMapPage.locator('#bpb-terrain-frame')
            .waitFor({ state: 'attached', timeout: 3000 }).then(() => true).catch(() => false);
        check(peakBigMapFrameCreated,
            'the Full Screen peak map did not create the extension-owned terrain frame');
        await peakBigMapPage.close();

        const peakPage = await context.newPage();
        const peakErrors = [];
        peakPage.on('pageerror', error => peakErrors.push(String(error)));
        await peakPage.goto(`https://www.peakbagger.com:${port}/Peak.aspx?pid=2829`, { waitUntil: 'load' });
        const peakState = await peakPage.waitForFunction(() => {
            const button = document.getElementById('bpb-terrain-toggle');
            const mount = document.getElementById('bpb-map-viewport');
            const iframe = document.getElementById('Gmap');
            if (!button || !mount || !iframe) return false;
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !button.disabled ? {
                text: button.textContent,
                mountClass: mount.className,
                mountHeight: mount.getBoundingClientRect().height,
                iframePreserved: iframe.parentElement === mount,
                // The MAIN-world coordinator bundle self-contains basemap,
                // peak-markers, and schema via ES imports, so its toggle existing
                // (this state being truthy) proves those loaded. The isolated
                // theme bundle is confirmed separately by the theme attribute.
                isolatedWorldReady: document.documentElement.getAttribute('data-bpb-theme') !== null
            } : false;
        }, null, { timeout: 10000 }).then(handle => handle.jsonValue()).catch(() => null);
        check(peakState?.text === '3D',
            `the Peak page must show an enabled 3D toggle (state=${JSON.stringify(peakState)}, errors=${JSON.stringify(peakErrors)})`);
        check(peakState?.mountClass === 'bpb-terrain-mount-peak' && peakState?.iframePreserved === true,
            `the Peak map wrapper must preserve the native iframe (state=${JSON.stringify(peakState)})`);
        check(peakState?.mountHeight === 425,
            `the Peak map wrapper must preserve the native 425px height (state=${JSON.stringify(peakState)})`);
        check(peakState?.isolatedWorldReady,
            `the Peak isolated-world theme bundle did not initialize (state=${JSON.stringify(peakState)})`);
        if (process.env.BPB_VERIFY_PEAK_SCREENSHOT) {
            await peakPage.screenshot({ path: process.env.BPB_VERIFY_PEAK_SCREENSHOT, fullPage: true });
        }
        await peakPage.evaluate(() => {
            window.__bpbPeakTerrainInit = null;
            window.addEventListener('message', event => {
                const data = event.data;
                if (event.source === window && data?.__bpbTerrain === true
                    && data.dir === 'toCS' && data.type === 'init') {
                    window.__bpbPeakTerrainInit = data;
                }
            });
        });
        await peakPage.locator('#bpb-terrain-toggle').click();
        const peakInit = await peakPage.waitForFunction(() => window.__bpbPeakTerrainInit, null, { timeout: 5000 })
            .then(handle => handle.jsonValue()).catch(() => null);
        check(JSON.stringify(peakInit?.focus) === JSON.stringify([48.83115, -121.60214])
            && peakInit?.focusZoom === 13
            && peakInit?.focusPeak?.id === 2829
            && !Object.hasOwn(peakInit || {}, 'routeSegments'),
            `the real Peak-page click did not start a route-free summit view (init=${JSON.stringify(peakInit)})`);
        const peakFrameCreated = await peakPage.locator('#bpb-terrain-frame').waitFor({ state: 'attached', timeout: 3000 })
            .then(() => true).catch(() => false);
        check(peakFrameCreated, 'the isolated terrain bridge did not create a frame for the Peak-page summit view');
        await peakPage.close();
    }

    // --- Ascent-list filter and in-place sort -------------------------------
    {
        const filterPage = await context.newPage();
        await filterPage.goto(
            `https://www.peakbagger.com:${port}/climber/PeakAscents.aspx?pid=1039`,
            { waitUntil: 'load' }
        );
        const mounted = await filterPage.locator('#pbaf-bar').waitFor({ state: 'visible', timeout: 10000 })
            .then(() => true).catch(() => false);
        check(mounted, 'the Chrome ascent filter never mounted');
        if (mounted) {
            const before = await filterPage.evaluate(() => ({
                visible: [...document.querySelectorAll('table.gray tr')]
                    .filter(row => row.cells.length > 1 && row.cells[0].tagName === 'TD'
                        && getComputedStyle(row).display !== 'none').length,
                first: document.querySelector('table.gray tr td')?.textContent.trim(),
                controls: document.querySelectorAll('.pbaf-table-sort').length
            }));
            await filterPage.locator('.pbaf-reset').click();
            await filterPage.locator('.pbaf-table-sort').first().click();
            const after = await filterPage.evaluate(() => ({
                visible: [...document.querySelectorAll('table.gray tr')]
                    .filter(row => row.cells.length > 1 && row.cells[0].tagName === 'TD'
                        && getComputedStyle(row).display !== 'none').length,
                first: document.querySelector('table.gray tr td')?.textContent.trim()
            }));
            check(before.controls > 1 && after.visible > before.visible && after.first !== before.first,
                `the Chrome ascent filter did not reveal rows and sort in place: ${JSON.stringify({ before, after })}`);
        }
        await filterPage.close();
    }

    // --- Owner-only full-profile backup surface ----------------------------
    {
        const profilePage = await context.newPage();
        await profilePage.goto(
            `https://www.peakbagger.com:${port}/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999`,
            { waitUntil: 'load' }
        );
        const state = await profilePage.locator(surfaceSelectors.profileBackup)
            .waitFor({ state: 'visible', timeout: 10000 })
            .then(() => profilePage.evaluate(selector => {
                const panel = document.querySelector(selector);
                return {
                    copy: panel?.textContent || '',
                    primary: panel?.querySelector('.bpb-profile-primary')?.textContent || ''
                };
            }, surfaceSelectors.profileBackup))
            .catch(() => null);
        check(state?.primary === 'Back up all ascents' && /fixture\/backup/.test(state.copy),
            `the Chrome full-profile backup surface did not mount for its verified owner: ${JSON.stringify(state)}`);
        await profilePage.close();
    }

    // --- Buddy List sorter-only surface ------------------------------------
    {
        const buddyPage = await context.newPage();
        await buddyPage.goto(
            `https://www.peakbagger.com:${port}/report/report.aspx?r=b&cid=900001`,
            { waitUntil: 'load' }
        );
        const controls = buddyPage.locator('#RGridView .pbaf-table-sort');
        const mounted = await controls.first().waitFor({ state: 'visible', timeout: 10000 })
            .then(() => true).catch(() => false);
        check(mounted, 'the Chrome Buddy List sorter never mounted through the real manifest');
        if (mounted) {
            const before = await buddyPage.evaluate(() => ({
                labels: [...document.querySelectorAll('#RGridView .pbaf-table-sort')]
                    .map(control => control.firstChild.textContent.trim()),
                betaBar: !!document.getElementById('pbaf-bar'),
                firstPeak: document.querySelector('#RGridView tr:nth-child(2) td:nth-child(4)')?.textContent.trim()
            }));
            await buddyPage.getByRole('button', { name: /^Peak or Point\./ }).click();
            const after = await buddyPage.evaluate(() => ({
                firstPeak: document.querySelector('#RGridView tr:nth-child(2) td:nth-child(4)')?.textContent.trim(),
                sort: document.querySelector('#RGridView th:nth-child(4)')?.getAttribute('aria-sort')
            }));
            check(before.labels.length === 6 && before.betaBar === false
                && after.sort === 'ascending' && after.firstPeak !== before.firstPeak,
            `the Chrome Buddy List did not expose six sorter-only controls: ${JSON.stringify({ before, after })}`);
        }
        await buddyPage.close();
    }

    // --- Trip-report editor on the real ascent form --------------------------
    // Real typing, real keyboard shortcuts, and real input rules against the
    // TipTap surface and the CodeMirror markdown pane, which jsdom cannot
    // cover with fidelity.
    {
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        const editorTheme = process.env.BPB_VERIFY_EDITOR_THEME;
        if (extensionId) {
            const optionsPage = await context.newPage();
            await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
            await optionsPage.evaluate(async theme => {
                const current = (await chrome.storage.sync.get('bpbSettings')).bpbSettings || {};
                await chrome.storage.sync.set({
                    bpbSettings: {
                        ...current,
                        addReportCredit: true,
                        ...(['light', 'dark'].includes(theme) && { theme })
                    }
                });
            }, editorTheme || null);
            await optionsPage.close();
        }
        const editorUrl = `https://www.peakbagger.com:${port}/climber/ascentedit.aspx?cid=900001`;
        const editorPage = await context.newPage();
        const editorErrors = [];
        editorPage.on('pageerror', error => editorErrors.push(String(error)));
        await editorPage.goto(editorUrl, { waitUntil: 'load' });

        const mounted = await editorPage.locator('#bpb-report-editor').waitFor({ state: 'visible', timeout: 10000 })
            .then(() => true).catch(() => false);
        check(mounted, `the trip-report editor never mounted on the real form (errors=${JSON.stringify(editorErrors)})`);

        if (mounted) {
            await editorPage.locator('#GPXUpload').setInputFiles(fixture.gpxPath);
            const uploadState = await editorPage.waitForFunction(() => {
                const process = document.querySelector('.bpb-process-button');
                const date = document.getElementById('DateText')?.value || '';
                const now = new Date();
                const pad = value => String(value).padStart(2, '0');
                const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                return process ? {
                    date,
                    today,
                    label: process.textContent,
                    ariaLabel: process.getAttribute('aria-label'),
                    nativePreviewHidden: document.getElementById('GPXPreview')
                        ?.classList.contains('bpb-native-preview-hidden') || false
                } : false;
            }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
            check(uploadState?.date === uploadState?.today
                && /Process/.test(uploadState?.label || '')
                && uploadState?.ariaLabel === 'Process the chosen GPX and fill this form'
                && uploadState?.nativePreviewHidden,
            `the Chrome ascent editor did not autofill its date and swap trusted GPX selection to Process: ${
                JSON.stringify(uploadState)}`);

            const creditState = await editorPage.waitForFunction(() => {
                const link = document.querySelector('#bpb-report-editor a[href*="better-peakbagger"]');
                const textarea = document.getElementById('JournalText');
                return link && textarea?.value.includes(link.href) ? {
                    href: link.href,
                    serialized: textarea.value
                } : false;
            }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
            check(creditState?.href === storeUrls.chrome
                && creditState.serialized.includes(storeUrls.chrome),
            `the Chrome report credit did not render and serialize its store URL: ${JSON.stringify(creditState)}`);
            // The remainder of the deep editor verifier intentionally starts
            // from the fixture's empty report.
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Plain', exact: true
            }).click();
            await editorPage.locator('#JournalText').fill('');
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Rich text', exact: true
            }).click();

            const nativeHidden = await editorPage.evaluate(() => {
                const textarea = document.getElementById('JournalText');
                return getComputedStyle(textarea).display === 'none' && !!textarea.form;
            });
            check(nativeHidden, 'the native textarea should be hidden but still inside the form');

            const surfaceTopBeforePanel = await editorPage.evaluate(() =>
                document.querySelector('#bpb-report-editor .bpb-re-surface')?.getBoundingClientRect().top);

            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Insert image', exact: true
            }).click();
            const imageHostingHelp = await editorPage.evaluate(() => {
                const box = document.querySelector('#bpb-report-editor .bpb-re-imagebox');
                const hint = box?.querySelector('.bpb-re-image-hosting');
                const controls = box ? [...box.querySelectorAll('input, button')] : [];
                const hintRect = hint?.getBoundingClientRect();
                const controlRects = controls.map(control => control.getBoundingClientRect());
                return box && hint && hintRect && controlRects.length ? {
                    visible: getComputedStyle(box).display !== 'none',
                    belowControls: hintRect.top >= Math.max(...controlRects.map(rect => rect.bottom)),
                    links: [...hint.querySelectorAll('a')].map(link => ({
                        label: link.textContent,
                        href: link.href,
                        target: link.target,
                        rel: link.rel
                    }))
                } : null;
            });
            check(imageHostingHelp?.visible && imageHostingHelp.belowControls,
                `image-hosting help was not visible below the image controls (state=${
                    JSON.stringify(imageHostingHelp)})`);
            check(JSON.stringify(imageHostingHelp?.links) === JSON.stringify([
                {
                    label: 'Peakbagger Photos',
                    href: 'https://www.peakbagger.com/climber/photo.aspx',
                    target: '_blank',
                    rel: 'noopener noreferrer'
                },
                {
                    label: 'Imgur',
                    href: 'https://imgur.com/upload',
                    target: '_blank',
                    rel: 'noopener noreferrer'
                },
                {
                    label: 'ImgBB',
                    href: 'https://imgbb.com/',
                    target: '_blank',
                    rel: 'noopener noreferrer'
                }
            ]), `image-hosting help links were incomplete or unsafe (state=${
                JSON.stringify(imageHostingHelp)})`);
            const contextualPanelLayout = await editorPage.evaluate(before => {
                const editor = document.getElementById('bpb-report-editor');
                const toolbar = editor?.querySelector('.bpb-re-toolbar');
                const surface = editor?.querySelector('.bpb-re-surface');
                const box = editor?.querySelector('.bpb-re-imagebox');
                const toolbarRect = toolbar?.getBoundingClientRect();
                const surfaceRect = surface?.getBoundingClientRect();
                const boxRect = box?.getBoundingClientRect();
                return toolbarRect && surfaceRect && boxRect ? {
                    surfaceDelta: surfaceRect.top - before,
                    overlay: getComputedStyle(box).position === 'static'
                        ? getComputedStyle(editor.querySelector('.bpb-re-contextual')).position
                        : getComputedStyle(box).position,
                    panelEndsAtToolbar: Math.abs(boxRect.bottom - toolbarRect.top) <= 1,
                    panelClearsSurface: boxRect.bottom <= toolbarRect.top
                        && toolbarRect.bottom <= surfaceRect.top
                } : null;
            }, surfaceTopBeforePanel);
            check(Math.abs(contextualPanelLayout?.surfaceDelta ?? Infinity) <= 0.5
                && contextualPanelLayout.overlay === 'absolute'
                && contextualPanelLayout.panelEndsAtToolbar
                && contextualPanelLayout.panelClearsSurface,
            `opening the image panel moved or covered the writing surface (layout=${
                JSON.stringify(contextualPanelLayout)})`);
            if (process.env.BPB_VERIFY_EDITOR_PANEL_SCREENSHOT) {
                const editorBox = await editorPage.locator('#bpb-report-editor').boundingBox();
                const panelBox = await editorPage.locator('.bpb-re-imagebox').boundingBox();
                if (editorBox && panelBox) {
                    const left = Math.min(editorBox.x, panelBox.x);
                    const top = Math.max(0, Math.min(editorBox.y, panelBox.y) - 8);
                    const right = Math.max(editorBox.x + editorBox.width, panelBox.x + panelBox.width);
                    const bottom = Math.max(editorBox.y + 140, panelBox.y + panelBox.height) + 8;
                    await editorPage.screenshot({
                        path: process.env.BPB_VERIFY_EDITOR_PANEL_SCREENSHOT,
                        clip: { x: left, y: top, width: right - left, height: bottom - top }
                    });
                }
            }
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Insert image', exact: true
            }).click();
            const imageDismissed = await editorPage.locator('.bpb-re-imagebox').evaluate(box => box.hidden);
            check(imageDismissed, 'clicking Insert image again did not dismiss its panel');
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Link (Ctrl+K)', exact: true
            }).click();
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Link (Ctrl+K)', exact: true
            }).click();
            const linkDismissed = await editorPage.locator('.bpb-re-linkbox').evaluate(box => box.hidden);
            check(linkDismissed, 'clicking Link again did not dismiss its panel');
            if (process.env.BPB_VERIFY_EDITOR_IMAGE_SCREENSHOT) {
                await editorPage.locator('#bpb-report-editor').screenshot({
                    path: process.env.BPB_VERIFY_EDITOR_IMAGE_SCREENSHOT
                });
            }

            const mountainUrl = 'https://better-peakbagger.test/showcase-alpine-ridge.png';
            const mountain = await readFile(path.join(root, 'store-assets', 'showcase-trip-report-mountain.png'));
            await editorPage.route(mountainUrl, route => route.fulfill({
                contentType: 'image/png',
                body: mountain
            }));
            const videoUrl = 'https://better-peakbagger.test/showcase-activity.mp4';
            const video = await readFile(path.join(root, 'store-assets', 'showcase-activity-capture.mp4'));
            await editorPage.route(videoUrl, route => route.fulfill({
                contentType: 'video/mp4',
                body: video
            }));
            const youtubeUrl = 'https://www.youtube.com/embed/aqz-KE-bpKQ';
            await editorPage.route(youtubeUrl, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><title>YouTube fixture</title><p>YouTube fixture</p>'
            }));

            // A selected Rich image exposes one restrained corner handle. A
            // real pointer drag and keyboard adjustment must both persist the
            // resized dimensions through the shipped TipTap → JournalText path.
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Plain', exact: true
            }).click();
            const plainBarLayout = await editorPage.evaluate(() => {
                const bar = document.querySelector('#bpb-report-editor .bpb-re-bar');
                const hint = document.querySelector('#bpb-report-editor .bpb-re-plain-hint');
                const modes = document.querySelector('#bpb-report-editor .bpb-re-modes');
                const barRect = bar?.getBoundingClientRect();
                const hintRect = hint?.getBoundingClientRect();
                const modesRect = modes?.getBoundingClientRect();
                return bar && hint && modes && barRect && hintRect && modesRect ? {
                    hintInBar: hint.parentElement === bar,
                    centerDelta: Math.abs(
                        (hintRect.top + hintRect.height / 2) - (modesRect.top + modesRect.height / 2)),
                    barHeight: barRect.height,
                    modesHeight: modesRect.height
                } : null;
            });
            check(plainBarLayout?.hintInBar
                && plainBarLayout.centerDelta <= 1
                && plainBarLayout.barHeight <= plainBarLayout.modesHeight + 12,
            `the Plain syntax hint did not reuse the toolbar row (layout=${JSON.stringify(plainBarLayout)})`);
            if (process.env.BPB_VERIFY_EDITOR_PLAIN_SCREENSHOT) {
                const editorBox = await editorPage.locator('#bpb-report-editor').boundingBox();
                const textareaBox = await editorPage.locator('#JournalText').boundingBox();
                if (editorBox && textareaBox) {
                    const left = Math.min(editorBox.x, textareaBox.x);
                    const top = Math.min(editorBox.y, textareaBox.y);
                    const right = Math.max(editorBox.x + editorBox.width, textareaBox.x + textareaBox.width);
                    const bottom = Math.min(
                        Math.max(editorBox.y + editorBox.height, textareaBox.y + textareaBox.height),
                        top + 260);
                    await editorPage.screenshot({
                        path: process.env.BPB_VERIFY_EDITOR_PLAIN_SCREENSHOT,
                        clip: { x: left, y: top, width: right - left, height: bottom - top }
                    });
                }
            }
            await editorPage.locator('#JournalText').fill(
                `[img src="${mountainUrl}" alt="Alpine ridge" width="440"]`);
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Rich text', exact: true
            }).click();
            const richImage = editorPage.locator(
                '#bpb-report-editor .bpb-re-surface .bpb-re-image-resize img');
            const richImageLoaded = await editorPage.waitForFunction(() => {
                const image = document.querySelector(
                    '#bpb-report-editor .bpb-re-surface .bpb-re-image-resize img');
                return image?.complete && image.naturalWidth > 0;
            }, null, { timeout: 5000 }).then(() => true).catch(() => false);
            check(richImageLoaded, 'the Rich image-resize fixture did not load');
            if (richImageLoaded) {
                await richImage.click();
                const resizeHandle = editorPage.locator(
                    '#bpb-report-editor .bpb-re-surface [aria-label="Resize image"]');
                const handleReady = await editorPage.waitForFunction(() => {
                    const handle = document.querySelector(
                        '#bpb-report-editor .bpb-re-surface [aria-label="Resize image"]');
                    if (!handle) return false;
                    const style = getComputedStyle(handle);
                    return style.opacity === '1' && style.pointerEvents === 'auto';
                }, null, { timeout: 3000 }).then(() => true).catch(() => false);
                check(handleReady, 'selecting a Rich image did not reveal its resize handle');

                if (handleReady && process.env.BPB_VERIFY_EDITOR_RESIZE_SCREENSHOT) {
                    await editorPage.locator('#bpb-report-editor').screenshot({
                        path: process.env.BPB_VERIFY_EDITOR_RESIZE_SCREENSHOT
                    });
                }

                const box = handleReady ? await resizeHandle.boundingBox() : null;
                if (box) {
                    const startX = box.x + box.width / 2;
                    const startY = box.y + box.height / 2;
                    await editorPage.mouse.move(startX, startY);
                    await editorPage.mouse.down();
                    await editorPage.mouse.move(startX - 100, startY - 60, { steps: 6 });
                    await editorPage.mouse.up();
                }

                const pointerResize = await editorPage.waitForFunction(() => {
                    const source = document.getElementById('JournalText').value;
                    const width = Number(/\bwidth="(\d+)"/.exec(source)?.[1]);
                    const height = Number(/\bheight="(\d+)"/.exec(source)?.[1]);
                    return width < 440 && width >= 64 && height >= 40 ? { width, height, source } : null;
                }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
                check(pointerResize && pointerResize.width >= 330 && pointerResize.width <= 350
                    && pointerResize.height >= 195 && pointerResize.height <= 215,
                `dragging the Rich image did not persist a proportional resize (state=${JSON.stringify(pointerResize)})`);

                if (pointerResize) {
                    await resizeHandle.focus();
                    await editorPage.keyboard.press('ArrowRight');
                    const keyboardResize = await editorPage.waitForFunction(previous => {
                        const source = document.getElementById('JournalText').value;
                        const width = Number(/\bwidth="(\d+)"/.exec(source)?.[1]);
                        return width === previous + 10 ? { width, source } : null;
                    }, pointerResize.width, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
                    check(keyboardResize?.width === pointerResize.width + 10,
                        `the focused resize handle ignored ArrowRight (state=${JSON.stringify(keyboardResize)})`);
                }
            }

            // Rich videos use the same bounded, aspect-locked resizing path
            // and must retain their dimensions through JournalText.
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Plain', exact: true
            }).click();
            await editorPage.locator('#JournalText').fill(
                `[video src="${videoUrl}" width="320" height="180"][/video]`);
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Rich text', exact: true
            }).click();
            const richVideo = editorPage.locator(
                '#bpb-report-editor .bpb-re-surface .bpb-re-video-resize video');
            const richVideoLoaded = await editorPage.waitForFunction(() => {
                const video = document.querySelector(
                    '#bpb-report-editor .bpb-re-surface .bpb-re-video-resize video');
                return video?.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0;
            }, null, { timeout: 5000 }).then(() => true).catch(() => false);
            check(richVideoLoaded, 'the Rich video fixture did not load metadata');
            if (richVideoLoaded) {
                await richVideo.click();
                const resizeHandle = editorPage.locator(
                    '#bpb-report-editor .bpb-re-surface [aria-label="Resize video"]');
                const handleReady = await editorPage.waitForFunction(() => {
                    const handle = document.querySelector(
                        '#bpb-report-editor .bpb-re-surface [aria-label="Resize video"]');
                    if (!handle) return false;
                    const style = getComputedStyle(handle);
                    return style.opacity === '1' && style.pointerEvents === 'auto';
                }, null, { timeout: 3000 }).then(() => true).catch(() => false);
                check(handleReady, 'selecting a Rich video did not reveal its resize handle');
                if (handleReady && process.env.BPB_VERIFY_EDITOR_VIDEO_SCREENSHOT) {
                    await editorPage.locator('#bpb-report-editor').screenshot({
                        path: process.env.BPB_VERIFY_EDITOR_VIDEO_SCREENSHOT
                    });
                }

                const box = handleReady ? await resizeHandle.boundingBox() : null;
                if (box) {
                    const startX = box.x + box.width / 2;
                    const startY = box.y + box.height / 2;
                    await editorPage.mouse.move(startX, startY);
                    await editorPage.mouse.down();
                    await editorPage.mouse.move(startX - 80, startY - 45, { steps: 6 });
                    await editorPage.mouse.up();
                }

                const pointerResize = await editorPage.waitForFunction(() => {
                    const source = document.getElementById('JournalText').value;
                    const width = Number(/\bwidth="(\d+)"/.exec(source)?.[1]);
                    const height = Number(/\bheight="(\d+)"/.exec(source)?.[1]);
                    return width < 320 && width >= 230 && height >= 125
                        ? { width, height, source } : null;
                }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
                check(pointerResize && pointerResize.width >= 230 && pointerResize.width <= 250
                    && pointerResize.height >= 125 && pointerResize.height <= 145,
                `dragging the Rich video did not persist a proportional resize (state=${JSON.stringify(pointerResize)})`);

                if (pointerResize) {
                    await resizeHandle.focus();
                    await editorPage.keyboard.press('ArrowRight');
                    const keyboardResize = await editorPage.waitForFunction(previous => {
                        const source = document.getElementById('JournalText').value;
                        const width = Number(/\bwidth="(\d+)"/.exec(source)?.[1]);
                        return width === previous + 10 ? { width, source } : null;
                    }, pointerResize.width, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
                    check(keyboardResize?.width === pointerResize.width + 10,
                        `the focused video resize handle ignored ArrowRight (state=${JSON.stringify(keyboardResize)})`);
                }
            }

            // YouTube is the sole iframe exception. Its Markdown preview and
            // Rich node view must use the canonical player URL and retain the
            // same bounded, aspect-locked resize behavior as native video.
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Plain', exact: true
            }).click();
            await editorPage.locator('#JournalText').fill(
                `[iframe src="${youtubeUrl}" width="320" height="180"][/iframe]`);
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Markdown', exact: true
            }).click();
            const markdownYouTube = await editorPage.waitForFunction(expected => {
                const iframe = document.querySelector('#bpb-report-editor .bpb-re-preview iframe');
                return iframe?.getAttribute('src') === expected ? {
                    src: iframe.getAttribute('src'),
                    title: iframe.getAttribute('title'),
                    referrerPolicy: iframe.getAttribute('referrerpolicy'),
                    allow: iframe.getAttribute('allow')
                } : null;
            }, youtubeUrl, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
            check(markdownYouTube?.src === youtubeUrl
                && markdownYouTube?.title === 'YouTube video'
                && markdownYouTube?.referrerPolicy === 'strict-origin-when-cross-origin'
                && markdownYouTube?.allow === 'accelerometer; encrypted-media; gyroscope; picture-in-picture',
            `Markdown did not render the canonical YouTube iframe (state=${JSON.stringify(markdownYouTube)})`);

            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Rich text', exact: true
            }).click();
            const richYouTubeReady = await editorPage.waitForFunction(expected => {
                const iframe = document.querySelector(
                    '#bpb-report-editor .bpb-re-surface .bpb-re-youtube-resize iframe');
                return iframe?.getAttribute('src') === expected
                    && iframe.getAttribute('title') === 'YouTube video'
                    && iframe.getAttribute('referrerpolicy') === 'strict-origin-when-cross-origin';
            }, youtubeUrl, { timeout: 5000 }).then(() => true).catch(() => false);
            check(richYouTubeReady, 'the Rich YouTube iframe did not render its canonical player URL');
            if (richYouTubeReady) {
                // Player clicks belong to YouTube. The editor-owned corner
                // affordance stays available without intercepting playback
                // controls inside the frame.
                const resizeHandle = editorPage.locator(
                    '#bpb-report-editor .bpb-re-surface [aria-label="Resize YouTube video"]');
                const handleReady = await editorPage.waitForFunction(() => {
                    const handle = document.querySelector(
                        '#bpb-report-editor .bpb-re-surface [aria-label="Resize YouTube video"]');
                    if (!handle) return false;
                    const style = getComputedStyle(handle);
                    return style.opacity === '1' && style.pointerEvents === 'auto';
                }, null, { timeout: 3000 }).then(() => true).catch(() => false);
                check(handleReady, 'the Rich YouTube iframe did not expose its resize handle');
                if (handleReady && process.env.BPB_VERIFY_EDITOR_YOUTUBE_SCREENSHOT) {
                    await editorPage.locator('#bpb-report-editor').screenshot({
                        path: process.env.BPB_VERIFY_EDITOR_YOUTUBE_SCREENSHOT
                    });
                }

                const box = handleReady ? await resizeHandle.boundingBox() : null;
                if (box) {
                    const startX = box.x + box.width / 2;
                    const startY = box.y + box.height / 2;
                    await editorPage.mouse.move(startX, startY);
                    await editorPage.mouse.down();
                    await editorPage.mouse.move(startX - 80, startY - 45, { steps: 6 });
                    await editorPage.mouse.up();
                }

                const pointerResize = await editorPage.waitForFunction(() => {
                    const source = document.getElementById('JournalText').value;
                    const width = Number(/\bwidth="(\d+)"/.exec(source)?.[1]);
                    const height = Number(/\bheight="(\d+)"/.exec(source)?.[1]);
                    return width < 320 && width >= 230 && height >= 125
                        ? { width, height, source } : null;
                }, null, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
                const youtubeResizeState = pointerResize ? null : await editorPage.evaluate(() => {
                    const iframe = document.querySelector('.bpb-re-youtube-resize iframe');
                    const container = document.querySelector('.bpb-re-youtube-resize');
                    return { source: document.getElementById('JournalText').value,
                        style: iframe && { width: iframe.style.width, height: iframe.style.height },
                        iframe: iframe?.getBoundingClientRect(),
                        resizeState: container?.dataset.resizeState };
                });
                check(pointerResize && pointerResize.width >= 230 && pointerResize.width <= 250
                    && pointerResize.height >= 125 && pointerResize.height <= 145,
                `dragging the Rich YouTube iframe did not persist a proportional resize (state=${
                    JSON.stringify(pointerResize || youtubeResizeState)})`);

                if (pointerResize) {
                    await resizeHandle.focus();
                    await editorPage.keyboard.press('ArrowRight');
                    const keyboardResize = await editorPage.waitForFunction(previous => {
                        const source = document.getElementById('JournalText').value;
                        const width = Number(/\bwidth="(\d+)"/.exec(source)?.[1]);
                        return width === previous + 10 ? { width, source } : null;
                    }, pointerResize.width, { timeout: 5000 }).then(handle => handle.jsonValue()).catch(() => null);
                    check(keyboardResize?.width === pointerResize.width + 10,
                        `the focused YouTube resize handle ignored ArrowRight (state=${JSON.stringify(keyboardResize)})`);
                }
            }

            // Existing hex colors must survive the real TipTap/DOM boundary.
            // CSSOM exposes rgb(), so assert the raw color token that the
            // converter is required to preserve.
            const hexSource = 'Under [span style="color:#2471a3"]blue[/span] skies.';
            const hexMarkdown = 'Under <span style="color:#2471a3">blue</span> skies.';
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Plain', exact: true
            }).click();
            await editorPage.locator('#JournalText').fill(hexSource);
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Rich text', exact: true
            }).click();
            const richHex = await editorPage.evaluate(() => {
                const span = document.querySelector('.bpb-re-surface span[style]');
                return span && {
                    text: span.textContent,
                    style: span.getAttribute('style'),
                    token: span.getAttribute('data-bpb-report-color')
                };
            });
            check(richHex?.text === 'blue' && richHex?.token === '#2471a3',
                `Rich mode did not preserve the raw hex color (state=${JSON.stringify(richHex)})`);

            await editorPage.locator('.bpb-re-surface').click();
            await editorPage.keyboard.press('End');
            await editorPage.keyboard.type(' Clear weather.');
            const richHexSynced = await editorPage.waitForFunction(expected =>
                document.getElementById('JournalText').value === `${expected} Clear weather.`,
            hexSource, { timeout: 5000 }).then(() => true).catch(() => false);
            check(richHexSynced, `an unrelated Rich edit lost the hex color (value=${
                JSON.stringify(await editorPage.evaluate(() => document.getElementById('JournalText').value))})`);

            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Markdown', exact: true
            }).click();
            const markdownHex = await editorPage.evaluate(() => ({
                source: [...document.querySelectorAll('.bpb-re-mdpane .cm-line')]
                    .map(line => line.textContent).join('\n'),
                previewStyle: document.querySelector('.bpb-re-preview span[style]')?.getAttribute('style')
            }));
            check(markdownHex.source === `${hexMarkdown} Clear weather.`
                && /#2471a3/i.test(markdownHex.previewStyle || ''),
            `Markdown mode lost the hex source or preview color (state=${JSON.stringify(markdownHex)})`);

            // Reset through Plain so the existing real-typing scenario still
            // starts from the fixture's empty report and invalidates mdSource.
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Plain', exact: true
            }).click();
            await editorPage.locator('#JournalText').fill('');
            await editorPage.locator('#bpb-report-editor').getByRole('button', {
                name: 'Rich text', exact: true
            }).click();

            await editorPage.locator('.bpb-re-surface').click();
            await editorPage.keyboard.type('Summit day was ');
            await editorPage.keyboard.press(`${modifier}+b`);
            await editorPage.keyboard.type('windy');
            await editorPage.keyboard.press(`${modifier}+b`);
            await editorPage.keyboard.type('.');
            await editorPage.keyboard.press('Enter');
            await editorPage.keyboard.type('Second paragraph.');
            // "1. " at the start of a fresh paragraph is a markdown input rule
            // and must become a real ordered list, not literal text.
            await editorPage.keyboard.press('Enter');
            await editorPage.keyboard.type('1. rope');

            const synced = await editorPage.waitForFunction(() =>
                document.getElementById('JournalText').value
                === 'Summit day was [b]windy[/b].\n\nSecond paragraph.\n\n[ol][li]rope[/li][/ol]',
            null, { timeout: 5000 })
                .then(() => true).catch(() => false);
            check(synced, `real typing + Ctrl/Cmd+B + the "1. " input rule did not sync bracket markup into JournalText (value=${
                JSON.stringify(await editorPage.evaluate(() => document.getElementById('JournalText').value))})`);

            const listActive = await editorPage.evaluate(() =>
                document.querySelector('#bpb-report-editor [aria-label="Numbered list"]')
                    ?.getAttribute('aria-pressed'));
            check(listActive === 'true',
                `the toolbar did not track the caret's ordered list (aria-pressed=${JSON.stringify(listActive)})`);

            const savedStatus = await editorPage.waitForFunction(() =>
                /Draft saved on this device/.test(document.querySelector('.bpb-re-status')?.textContent || ''),
            null, { timeout: 5000 }).then(() => true).catch(() => false);
            check(savedStatus, 'the local-draft autosave status never appeared');

            await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Markdown', exact: true }).click();
            const markdownValue = await editorPage.evaluate(() =>
                [...document.querySelectorAll('.bpb-re-mdpane .cm-line')]
                    .map(line => line.textContent).join('\n'));
            check(markdownValue === 'Summit day was **windy**.\n\nSecond paragraph.\n\n1. rope',
                `switching to markdown did not convert the content (value=${JSON.stringify(markdownValue)})`);

            // The split pane: source and live preview visible together, no tab
            // to click, and the preview already shows the saved rendering.
            const split = await editorPage.evaluate(() => {
                const source = document.querySelector('.bpb-re-mdpane .cm-editor');
                const preview = document.querySelector('.bpb-re-mdsplit .bpb-re-preview');
                if (!source || !preview) return null;
                const a = source.getBoundingClientRect();
                const b = preview.getBoundingClientRect();
                return {
                    bothVisible: a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0,
                    disjoint: b.left >= a.right - 1 || b.top >= a.bottom - 1,
                    previewHtml: preview.innerHTML
                };
            });
            check(split?.bothVisible === true && split?.disjoint === true,
                `markdown mode did not show source and live preview as a split (state=${JSON.stringify(split && { ...split, previewHtml: undefined })})`);
            check(/<b>windy<\/b>/.test(split?.previewHtml || '') && /<ol><li>rope<\/li><\/ol>/.test(split?.previewHtml || ''),
                `the live preview did not render the final formatting (html=${JSON.stringify(split?.previewHtml)})`);

            // A reload serves the pristine form again; the draft must be
            // offered back and restore into the mode it was written in.
            await editorPage.reload({ waitUntil: 'load' });
            const offered = await editorPage.locator('.bpb-re-draft').waitFor({ state: 'visible', timeout: 10000 })
                .then(() => true).catch(() => false);
            check(offered, 'a differing local draft was not offered after reload');
            if (offered) {
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Rich text', exact: true
                }).click();
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Insert image', exact: true
                }).click();
                const draftPanelLayout = await editorPage.evaluate(() => {
                    const draft = document.querySelector('#bpb-report-editor .bpb-re-draft');
                    const panel = document.querySelector('#bpb-report-editor .bpb-re-imagebox');
                    const draftRect = draft?.getBoundingClientRect();
                    const panelRect = panel?.getBoundingClientRect();
                    return draftRect && panelRect ? {
                        disjoint: panelRect.bottom <= draftRect.top + 1,
                        panelBottom: panelRect.bottom,
                        draftTop: draftRect.top
                    } : null;
                });
                check(draftPanelLayout?.disjoint,
                    `the image panel covered draft recovery actions (layout=${JSON.stringify(draftPanelLayout)})`);
                if (process.env.BPB_VERIFY_EDITOR_DRAFT_PANEL_SCREENSHOT) {
                    const editorBox = await editorPage.locator('#bpb-report-editor').boundingBox();
                    const panelBox = await editorPage.locator('.bpb-re-imagebox').boundingBox();
                    if (editorBox && panelBox) {
                        const left = Math.min(editorBox.x, panelBox.x);
                        const top = Math.max(0, panelBox.y - 8);
                        const right = Math.max(editorBox.x + editorBox.width, panelBox.x + panelBox.width);
                        const bottom = Math.min(editorBox.y + editorBox.height, editorBox.y + 180);
                        await editorPage.screenshot({
                            path: process.env.BPB_VERIFY_EDITOR_DRAFT_PANEL_SCREENSHOT,
                            clip: { x: left, y: top, width: right - left, height: bottom - top }
                        });
                    }
                }
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Insert image', exact: true
                }).click();
                await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Restore draft', exact: true }).click();
                const restored = await editorPage.evaluate(() => ({
                    mode: document.getElementById('bpb-report-editor').dataset.mode,
                    value: document.getElementById('JournalText').value
                }));
                check(restored.mode === 'markdown'
                    && restored.value === 'Summit day was [b]windy[/b].\n\nSecond paragraph.\n\n[ol][li]rope[/li][/ol]',
                `restoring the draft did not bring back content and mode (state=${JSON.stringify(restored)})`);
            }

            // Exercise the broader Marked-token pipeline through the real
            // manifest order, not just the unit-test loader: replace the
            // CodeMirror document with real keyboard input.
            await editorPage.locator('.bpb-re-mdpane .cm-content').click();
            await editorPage.keyboard.press(`${modifier}+a`);
            await editorPage.keyboard.insertText([
                '## Route notes',
                '',
                '> Windy ~~retreat~~.',
                '',
                '| Peak | Elev |',
                '| --- | ---: |',
                '| Baker | 10781 |',
                '',
                '`inline_code()`',
                '',
                `![Alpine ridge|300x180](${mountainUrl})`,
                '',
                `![Video](${mountainUrl})`,
                '',
                '---'
            ].join('\n'));
            const expandedSync = await editorPage.waitForFunction(imageUrl => {
                const value = document.getElementById('JournalText').value;
                return value.includes('[h2]Route notes[/h2]')
                    && value.includes('[blockquote]Windy [s]retreat[/s].[/blockquote]')
                    && value.includes('[table border="1"]')
                    && value.includes('[code]inline_code()[/code]')
                    && value.includes(`[img src="${imageUrl}" alt="Alpine ridge" width="300" height="180"]`)
                    && value.includes(`[video src="${imageUrl}" controls preload="metadata" playsinline referrerpolicy="no-referrer"][/video]`)
                    && value.endsWith('[hr]');
            }, mountainUrl, { timeout: 5000 }).then(() => true).catch(() => false);
            check(expandedSync, `expanded Markdown did not reach JournalText (value=${
                JSON.stringify(await editorPage.evaluate(() => document.getElementById('JournalText').value))})`);
            const expandedPreview = await editorPage.waitForFunction(() => {
                const preview = document.querySelector('.bpb-re-preview');
                const image = preview?.querySelector('img');
                const video = preview?.querySelector('video');
                return ['H2', 'BLOCKQUOTE', 'TABLE', 'S', 'CODE', 'HR']
                    .every(tag => preview && preview.querySelector(tag))
                    && image?.getAttribute('width') === '300'
                    && image?.getAttribute('height') === '180'
                    && video?.hasAttribute('controls')
                    && !video?.hasAttribute('autoplay');
            }, null, { timeout: 5000 }).then(() => true).catch(() => false);
            check(expandedPreview, 'the live preview omitted a supported semantic element');
            if (process.env.BPB_VERIFY_EDITOR_SCREENSHOT) {
                await editorPage.locator('#bpb-report-editor').screenshot({
                    path: process.env.BPB_VERIFY_EDITOR_SCREENSHOT
                });
            }
            if (process.env.BPB_VERIFY_EDITOR_PAGE_SCREENSHOT) {
                await editorPage.setViewportSize({ width: 1280, height: 800 });
                await editorPage.locator('#bpb-report-editor').scrollIntoViewIfNeeded();
                await editorPage.evaluate(() => {
                    const top = document.getElementById('bpb-report-editor').getBoundingClientRect().top;
                    window.scrollBy(0, Math.max(0, top - 110));
                });
                await editorPage.screenshot({ path: process.env.BPB_VERIFY_EDITOR_PAGE_SCREENSHOT });
            }

            // The contextual table controls on the TipTap surface: insert a
            // table from the toolbar, then grow it by one row.
            await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Rich text', exact: true }).click();
            const rowsBefore = await editorPage.evaluate(() =>
                (document.getElementById('JournalText').value.match(/\[tr\]/g) || []).length);
            await editorPage.locator('#bpb-report-editor [aria-label="Insert table"]').click();
            const tableBarShown = await editorPage.locator('.bpb-re-tablebar').waitFor({ state: 'visible', timeout: 5000 })
                .then(() => true).catch(() => false);
            check(tableBarShown, 'inserting a table did not reveal the contextual table controls');
            const inserted = await editorPage.waitForFunction(before =>
                (document.getElementById('JournalText').value.match(/\[tr\]/g) || []).length === before + 3,
            rowsBefore, { timeout: 5000 }).then(() => true).catch(() => false);
            check(inserted, `the toolbar table insert did not produce a 3-row table (value=${
                JSON.stringify(await editorPage.evaluate(() => document.getElementById('JournalText').value.slice(0, 400)))})`);
            await editorPage.locator('#bpb-report-editor').getByRole('button', { name: 'Add row below', exact: true }).click();
            const grew = await editorPage.waitForFunction(before =>
                (document.getElementById('JournalText').value.match(/\[tr\]/g) || []).length === before + 4,
            rowsBefore, { timeout: 5000 }).then(() => true).catch(() => false);
            check(grew, 'Add row below did not grow the table by one row');
            if (process.env.BPB_VERIFY_EDITOR_RICH_SCREENSHOT) {
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Rich text', exact: true
                }).click();
                await editorPage.locator('#bpb-report-editor').screenshot({
                    path: process.env.BPB_VERIFY_EDITOR_RICH_SCREENSHOT
                });
            }
            // A store capture must come from the shipped editor, not a drawn
            // facsimile. These opt-in frames use the real rich and Markdown
            // conversion paths, with an intercepted local mountain image so
            // the capture remains offline and repeatable.
            const richShowcasePath = process.env.BPB_VERIFY_EDITOR_SHOWCASE_RICH_SCREENSHOT;
            const markdownShowcasePath = process.env.BPB_VERIFY_EDITOR_SHOWCASE_MARKDOWN_SCREENSHOT;
            if (richShowcasePath || markdownShowcasePath) {
                const richSource = [
                    '[h2]Alpine dawn[/h2]',
                    '',
                    'The ridge caught the first light as the valley filled with cloud.',
                    '',
                    `[img src="${mountainUrl}" alt="Sunrise over an alpine ridge" width="440"]`,
                    '',
                    '[b]Route notes:[/b] Dry rock, shaded snow, and a calm descent.'
                ].join('\n');
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Plain', exact: true
                }).click();
                await editorPage.locator('#JournalText').fill(richSource);
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Rich text', exact: true
                }).click();
                const richImageLoaded = await editorPage.waitForFunction(() => {
                    const image = document.querySelector('#bpb-report-editor .bpb-re-surface img');
                    return image?.complete && image.naturalWidth > 0;
                }, null, { timeout: 5000 }).then(() => true).catch(() => false);
                check(richImageLoaded, 'the rich-text showcase image did not load');
                if (richShowcasePath) {
                    await editorPage.locator('#bpb-report-editor').screenshot({ path: richShowcasePath });
                }
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Plain', exact: true
                }).click();
                await editorPage.locator('#JournalText').fill('');
                await editorPage.locator('#bpb-report-editor').getByRole('button', {
                    name: 'Markdown', exact: true
                }).click();
                await editorPage.locator('#bpb-report-editor .cm-content').click();
                await editorPage.keyboard.insertText([
                    '## Alpine dawn',
                    '',
                    'The ridge caught the first light as the valley filled with cloud.',
                    '',
                    `![Sunrise over an alpine ridge](${mountainUrl})`,
                    '',
                    '**Route notes:** Dry rock, shaded snow, and a calm descent.'
                ].join('\n'));
                const markdownImageLoaded = await editorPage.waitForFunction(() => {
                    const image = document.querySelector('#bpb-report-editor .bpb-re-preview img');
                    return image?.complete && image.naturalWidth > 0;
                }, null, { timeout: 5000 }).then(() => true).catch(() => false);
                check(markdownImageLoaded, 'the Markdown showcase image preview did not load');
                if (markdownShowcasePath) {
                    await editorPage.locator('#bpb-report-editor').screenshot({ path: markdownShowcasePath });
                }
            }
            check(editorErrors.length === 0, `the editor page threw: ${JSON.stringify(editorErrors)}`);
        }
        await editorPage.close();
    }

    // --- Real draft-tab handoff --------------------------------------------
    // Seed only the private post-capture state. The worker still owns tab
    // creation/grouping, identity registration, sender validation, file
    // assignment, and exactly-once Preview. The native toolbar activeTab grant
    // remains a manual release boundary.
    if (extensionId) {
        const sourcePage = await context.newPage();
        const sourceUrl = `https://www.peakbagger.com:${port}/climber/ascent.aspx?aid=handoff-source`;
        await sourcePage.goto(sourceUrl, { waitUntil: 'load' });
        const controlPage = await context.newPage();
        await controlPage.goto(`chrome-extension://${extensionId}/options/options.html`);
        const seeded = await controlPage.evaluate(async ({ sourceUrl }) => {
            const [sourceTab] = (await chrome.tabs.query({})).filter(tab => tab.url === sourceUrl);
            if (!sourceTab) return { error: 'source tab not found' };
            return { sourceTabId: sourceTab.id };
        }, { sourceUrl });
        check(Number.isInteger(seeded.sourceTabId),
            `the Chrome draft source tab identity was unavailable: ${JSON.stringify(seeded)}`);
        if (Number.isInteger(seeded.sourceTabId)) {
            const job = createSyntheticCaptureJob(seeded.sourceTabId);
            const opened = await controlPage.evaluate(async ({ sourceTabId, job }) => {
                await chrome.storage.session.set({
                    bpbCaptureJobs: { [sourceTabId]: job },
                    bpbDraftTabs: {}
                });
                const reply = await chrome.runtime.sendMessage({
                    type: 'CAPTURE_OPEN_DRAFTS',
                    tabId: sourceTabId,
                    selectedIds: [2829]
                });
                if (!reply?.tabIds?.length) return { reply };
                return { reply };
            }, { sourceTabId: seeded.sourceTabId, job });
            const draftTabId = opened.reply?.tabIds?.[0];
            if (Number.isInteger(draftTabId)) {
                try {
                    opened.tab = await waitForCondition(() => controlPage.evaluate(
                        async ({ draftTabId, requireGroup }) => {
                            const tab = await chrome.tabs.get(draftTabId);
                            const url = tab.pendingUrl || tab.url || '';
                            const identityReady = /peakbagger\.com\/climber\/ascentedit\.aspx\?pid=2829&cid=900001/i.test(url);
                            const groupReady = !requireGroup || Number(tab.groupId) >= 0;
                            return identityReady && groupReady ? tab : null;
                        },
                        { draftTabId, requireGroup: !opened.reply?.groupWarning },
                    ), {
                        description: 'the Chrome worker to create and group the identity-bound draft tab',
                        timeoutMs: 15_000,
                    });
                } catch (error) {
                    opened.waitError = error.message;
                    opened.tab = await controlPage.evaluate(async tabId =>
                        chrome.tabs.get(tabId), draftTabId).catch(readError => ({ error: String(readError) }));
                }
            }
            check(Number.isInteger(draftTabId)
                && /peakbagger\.com\/climber\/ascentedit\.aspx\?pid=2829&cid=900001/i.test(
                    opened.tab?.pendingUrl || opened.tab?.url || ''),
            `the Chrome worker did not create an identity-bound draft tab: ${JSON.stringify(opened)}`);
            check(opened.reply?.groupWarning || Number(opened.tab?.groupId) >= 0,
                `the Chrome draft tab was neither grouped nor reported honestly: ${JSON.stringify(opened)}`);

            if (Number.isInteger(draftTabId)) {
                const wrongUrl = `https://www.peakbagger.com:${port}/climber/ascentedit.aspx?pid=999&cid=900001`;
                await controlPage.evaluate(({ draftTabId, wrongUrl }) =>
                    chrome.tabs.update(draftTabId, { url: wrongUrl }), { draftTabId, wrongUrl });
                const draftPage = await waitForCondition(() =>
                    context.pages().find(page => page.url() === wrongUrl), {
                    description: 'the Chrome draft tab to reach the wrong-identity fixture'
                });
                const mismatch = await draftPage.locator('#bpb-draft-banner').waitFor({
                    state: 'visible', timeout: 10000
                }).then(() => draftPage.locator('#bpb-draft-banner').textContent()).catch(() => null);
                check(/does not match its prepared ascent draft/.test(mismatch || '')
                    && fixture.requests.previewPosts === 0,
                `the Chrome worker accepted the wrong peak identity: ${JSON.stringify({ mismatch, requests: fixture.requests })}`);

                const correctUrl = `https://www.peakbagger.com:${port}/climber/ascentedit.aspx?pid=2829&cid=900001`;
                await draftPage.goto(correctUrl, { waitUntil: 'load' });
                try {
                    await waitForCondition(() => fixture.requests.previewPosts === 1, {
                        description: 'the Chrome draft GPS Preview POST',
                        timeoutMs: 15_000
                    });
                } catch (error) {
                    const pageState = await draftPage.evaluate(() => ({
                        url: location.href,
                        banner: document.getElementById('bpb-draft-banner')?.textContent || null,
                        date: document.getElementById('DateText')?.value || null,
                        files: document.getElementById('GPXUpload')?.files?.length ?? null,
                        preview: document.getElementById('GPXPreview')?.value || null
                    })).catch(readError => ({ error: String(readError) }));
                    const privateState = await controlPage.evaluate(async ({ sourceTabId, draftTabId }) => {
                        const values = await chrome.storage.session.get(['bpbCaptureJobs', 'bpbDraftTabs']);
                        return {
                            job: values.bpbCaptureJobs?.[sourceTabId] || null,
                            draft: values.bpbDraftTabs?.[draftTabId] || null
                        };
                    }, { sourceTabId: seeded.sourceTabId, draftTabId });
                    throw new Error(`Chrome draft Preview did not submit: ${JSON.stringify({
                        requests: fixture.requests, pageState, privateState
                    })}`, { cause: error });
                }
                await draftPage.waitForFunction(() =>
                    /Preview is ready/.test(document.getElementById('bpb-draft-banner')?.textContent || ''),
                null, { timeout: 10000 });
                check(fixture.requests.previewPosts === 1
                    && fixture.requests.savePosts === 0
                    && fixture.requests.lastPreview?.attachedGpx
                    && fixture.requests.lastPreview?.dateFilled
                    && fixture.requests.lastPreview?.suffixBlank,
                `the Chrome draft handoff did not attach/fill/Preview exactly once: ${JSON.stringify(fixture.requests)}`);

                const privateState = await controlPage.evaluate(async ({ sourceTabId, draftTabId }) => {
                    const values = await chrome.storage.session.get(['bpbCaptureJobs', 'bpbDraftTabs']);
                    return {
                        job: values.bpbCaptureJobs?.[sourceTabId] || null,
                        draft: values.bpbDraftTabs?.[draftTabId] || null
                    };
                }, { sourceTabId: seeded.sourceTabId, draftTabId });
                check(privateState.job?.phase === 'previewed'
                    && privateState.job?.uploadGpx === null
                    && privateState.draft?.complete === true
                    && privateState.draft?.previewStarted === true,
                `the Chrome worker did not complete the exactly-once handoff: ${JSON.stringify(privateState)}`);
                await draftPage.close();
            }
        }
        await controlPage.close();
        await sourcePage.close();
    }
} finally {
    if (context) await context.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
}

if (failures.length) {
    console.error('Real-extension verification FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log('Real-extension verification passed (hidden Chrome for Testing, new headless):');
console.log('  - the MV3 service worker boots and answers messages (capture is alive)');
console.log('  - sync/local/session storage, storage.onChanged, options persistence, and popup status passed');
console.log('  - options loads the signed-in Buddy report directly, falls back through a first-party tab, and keeps failures actionable');
console.log('  - Buddy merge/mirror reports additions and removals, requires confirmation, and preserves favorites on cancel');
console.log('  - the real 1,500-row favorite list reports its total, fuzzy-searches, and keeps long navigation instant');
console.log('  - the compact profile star persists, and four native Buddy actions refreshed/synced under both removal policies');
console.log('  - settings.js initialises in the isolated world and the bridge answers');
console.log('  - the GPX analyzer renders stats from the real manifest load order');
console.log('  - the 3D toggle stays visible when disabled and opens the provider/privacy confirmation');
console.log('  - trusted confirmation persists the feature gate without contacting tile providers');
console.log('  - the Full Screen BigMap receives settings and shows an enabled 3D toggle');
console.log('  - the Peak Dynamic Map preserves its native frame and shows an enabled 3D toggle');
console.log('  - clicking Peak 3D creates the isolated frame with a route-free summit focus');
console.log('  - the PeakAscents filter mounts, reveals rows, and sorts in place');
console.log('  - the Buddy List exposes six in-place sort controls and no beta filter');
console.log('  - the owner-only full-profile backup surface mounts with a connected fixture repository');
console.log('  - a fresh ascent form autofills its local date and trusted GPX selection swaps Preview for Process');
console.log('  - the opt-in report credit renders and serializes the Chrome Web Store URL');
console.log('  - a real grouped draft tab rejects a wrong identity, attaches GPX, fills fields,');
console.log('    submits Preview exactly once, and never submits Save');
console.log('  - the trip-report editor mounts on the captured ascent form; real typing,');
console.log('    Ctrl/Cmd+B, and the "1. " input rule sync bracket markup into JournalText');
console.log('    with live toolbar states; selected Rich images/videos and YouTube players resize proportionally by');
console.log('    pointer or keyboard; markdown mode shows a CodeMirror source beside a');
console.log('    live preview that renders headings, quotes, tables, strike, code, rules,');
console.log('    and Obsidian-style pipe-sized images, direct videos, and YouTube embeds;');
console.log('    hex colors survive Rich edits and Markdown preview; the toolbar inserts');
console.log('    and grows tables; and a reloaded page offers and restores the draft');
