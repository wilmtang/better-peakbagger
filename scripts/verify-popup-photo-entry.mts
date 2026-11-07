/// <reference lib="dom" />
/* eslint-disable @typescript-eslint/no-shadow -- page-world callbacks take the outer value as their argument. */
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden packaged check of the popup's photo editor entry against the real
// worker route and real tabs. State geometry runs with the popup as a tab, where
// only the pending and failure replies are stubbed. The real toolbar popup then
// proves native sizing and the sender it actually presents, which has no tab.
// Window focus is what the browser reports; a hidden run shows no real window.
/* global document, chrome, innerWidth, window */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

declare global { interface Window { photoOpenReply?: (value: unknown) => void } }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const screenshots = process.env.BPB_POPUP_SCREENSHOTS;
const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-popup-photo-verification-'));
const ENTRY = '#open-photo-editor', STATUS = '#photo-editor-status';
const ANCHORS = [ENTRY, '#open-settings', '.brand', '#state'];
let context: BrowserContext | undefined;

const geometry = (page: Page) => page.evaluate(selectors => selectors.map(selector => {
    const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
    return { selector, x, y, width, height };
}), ANCHORS);

try {
    assertChromeLaunchAllowed();
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, viewport: { width: 390, height: 600 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const errors: string[] = [];
    context.on('page', opened => opened.on('pageerror', error => errors.push(String(error))));
    const setup = await context.newPage();
    setup.on('pageerror', error => errors.push(String(error)));
    await setup.goto('chrome://extensions-internals/');
    const id = await setup.waitForFunction(() => {
        try {
            return JSON.parse(document.body.innerText).find((record: { name: string; location: string; id: string }) =>
                record.name === 'Better Peakbagger' && record.location === 'COMMAND_LINE')?.id;
        } catch { return false; }
    }).then(handle => handle.jsonValue());
    const popupUrl = `chrome-extension://${id}/popup/popup.html`;
    const photoUrl = `chrome-extension://${id}/photos/photos.html`;
    const photoPages = () => context!.pages().filter(page => page.url().startsWith(photoUrl));
    const closePhotoPages = () => Promise.all(photoPages().map(page => page.close()));
    const openPopup = async () => {
        const page = await context!.newPage();
        await page.goto(popupUrl);
        await page.locator(ENTRY).waitFor();
        return page;
    };
    // The worker keeps running while the popup that asked is gone, as it does
    // when a real toolbar popup closes; wait on the resulting tab, never a delay.
    const activate = async () => {
        const page = await openPopup();
        const closed = page.waitForEvent('close');
        await page.locator(ENTRY).click();
        await closed;
    };
    const waitForPhotoPages = async (count: number) => {
        for (const deadline = Date.now() + 15000; photoPages().length !== count;) {
            assert(Date.now() < deadline, `Expected ${count} photo tabs, saw ${photoPages().map(page => page.url())}`);
            await context!.waitForEvent('page', { timeout: 500 }).catch(() => {});
        }
    };

    const states: string[] = [];
    for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        await setup.goto(popupUrl);
        await setup.evaluate(async theme => {
            const { bpbSettings } = await chrome.storage.sync.get('bpbSettings');
            await chrome.storage.sync.set({ bpbSettings: { ...(bpbSettings as object), theme } });
        }, theme);
        const page = await openPopup();
        await page.setViewportSize({ width: 390 * zoom, height: 600 * zoom });
        await page.waitForFunction(theme => document.documentElement.dataset.bpbTheme === theme, theme);
        await page.waitForFunction(() => document.querySelector('#state')!.textContent!.length > 0);
        await page.evaluate(zoom => {
            document.documentElement.style.zoom = String(zoom);
            const real = chrome.runtime.sendMessage.bind(chrome.runtime);
            Object.defineProperty(chrome.runtime, 'sendMessage', { configurable: true, value: (message: { type: string }) =>
                message.type === 'PHOTO_STANDALONE_OPEN'
                    ? new Promise(resolve => { window.photoOpenReply = resolve; })
                    : real(message) });
        }, zoom);
        const shot = (state: string) => screenshots
            ? page.screenshot({ path: path.join(screenshots, `popup-photo-${theme}-${zoom}x-${state}.png`) }) : null;
        const entry = page.locator(ENTRY);
        await entry.focus();
        const before = await geometry(page);
        const stable = async (state: string) => {
            assert.deepEqual(await geometry(page), before, `${theme} ${zoom}x ${state} moved the entry`);
            assert(await entry.evaluate(element => document.activeElement === element), `${state} lost focus`);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${state} overflowed`);
            await shot(state);
            states.push(`${theme}/${zoom}x/${state}`);
        };
        await stable('idle');
        await entry.hover(); await stable('hover');
        await entry.press('Enter');
        await page.locator(STATUS).filter({ hasText: 'Opening the photo editor' }).waitFor();
        assert.equal(await entry.getAttribute('aria-busy'), 'true');
        await stable('pending');
        await page.evaluate(() => window.photoOpenReply!({ ok: false }));
        await page.locator(STATUS).filter({ hasText: 'Couldn’t open the editor' }).waitFor();
        assert.equal(await entry.getAttribute('aria-busy'), null);
        await stable('error');
        // The header button costs results no height, so it stays reachable beside them.
        await page.evaluate(() => { document.querySelector<HTMLElement>('#results')!.hidden = false; });
        assert(await entry.isVisible(), 'The entry must stay available beside capture results');
        await page.close();
    }

    // No "tabs" permission is declared. Finding an existing tab therefore relies
    // on the browser exposing the extension's own URLs, which only a real
    // browser can demonstrate.
    await activate();
    await waitForPhotoPages(1);
    assert.equal(new URL(photoPages()[0].url()).search, '');
    const first = photoPages()[0];
    await activate();
    await activate();
    await first.waitForFunction(() => document.visibilityState === 'visible');
    assert.equal(photoPages().length, 1, 'An existing standalone editor must be reused');

    await closePhotoPages();
    const bound = await context.newPage();
    await bound.goto(`${photoUrl}?mode=edit&returnToken=fixture-token`);
    await activate();
    await waitForPhotoPages(2);
    assert.equal(photoPages().filter(page => new URL(page.url()).search === '').length, 1,
        'A report-bound tab must not be taken over');

    // The real toolbar popup: autosized by the browser, and a sender with no tab.
    await closePhotoPages();
    await bound.close();
    const nativeEntry = await setup.evaluate(async () => {
        await chrome.storage.sync.set({ bpbSettings: { theme: 'light', enableGarminInbox: true } });
        await chrome.action.openPopup();
        for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) {
            const popup = chrome.extension.getViews({ type: 'popup' })[0];
            const inbox = popup?.document.querySelector('.inbox-entry') as HTMLElement | null;
            const entry = popup?.document.querySelector('#open-photo-editor') as HTMLElement | null;
            if (!entry || inbox?.hidden !== false || !popup!.document.querySelector('#state')!.textContent) continue;
            // Measure only once the stylesheet applies and the autosized layout has settled.
            if (popup!.getComputedStyle(entry).width !== '32px' || popup!.innerWidth !== 390) continue;
            await new Promise(resolve => popup!.requestAnimationFrame(() => popup!.requestAnimationFrame(resolve)));
            const box = entry.getBoundingClientRect();
            const layout = { width: popup!.innerWidth, height: popup!.innerHeight, entryRight: box.right, entryBottom: box.bottom,
                overflow: popup!.document.documentElement.scrollWidth };
            (popup!.document.getElementById('open-photo-editor') as HTMLButtonElement).click();
            return layout;
        }
        throw new Error('The real popup did not show the photo editor entry');
    });
    assert.equal(nativeEntry.width, 390);
    assert.ok(nativeEntry.overflow <= 390 && nativeEntry.entryRight <= 374 && nativeEntry.entryRight > 300 && nativeEntry.entryBottom > 0 && nativeEntry.entryBottom <= nativeEntry.height,
        `Native popup clipped the entry: ${JSON.stringify(nativeEntry)}`);
    await waitForPhotoPages(1);
    await setup.waitForFunction(() => chrome.extension.getViews({ type: 'popup' }).length === 0);
    const activeUrl = await setup.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url);
    assert.equal(activeUrl, photoUrl, 'The opened editor must be the active tab');

    // Reusing a tab in another window must bring that window forward.
    const focus = await setup.evaluate(async photoUrl => {
        const [editor] = await chrome.tabs.query({ url: photoUrl });
        const other = await chrome.windows.create({ url: 'about:blank', focused: true });
        const before = (await chrome.windows.getLastFocused()).id;
        const popupTab = await chrome.tabs.create({ windowId: other!.id, url: chrome.runtime.getURL('popup/popup.html'), active: true });
        return { editorWindow: editor.windowId, editorTab: editor.id!, other: other!.id, before, popupTab: popupTab.id };
    }, photoUrl);
    assert.equal(focus.before, focus.other, 'the fixture must start focused on the other window');
    const popupInOtherWindow = await (async () => {
        for (const deadline = Date.now() + 15000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) {
            const found = context!.pages().find(page => page !== setup && page.url() === popupUrl);
            if (found) return found;
        }
        throw new Error('The popup tab did not open in the other window');
    })();
    await popupInOtherWindow.locator(ENTRY).waitFor();
    await popupInOtherWindow.locator(ENTRY).click();
    await setup.waitForFunction(async ({ editorWindow, editorTab }) =>
        (await chrome.windows.getLastFocused()).id === editorWindow
            && ((await chrome.tabs.get(editorTab)) as unknown as chrome.tabs.Tab).active, focus);
    assert.equal(photoPages().length, 1, 'Focusing the other window must not duplicate the editor');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: context.browser()?.version(), hidden: true, viewport: '390×600 at 100%/200% CSS zoom',
        cases: states.length, reused: true, boundTabSpared: true, nativePopup: nativeEntry, windowFocus: 'browser-reported in a hidden run', passed: true }));
} finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
}
