// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hidden browser layout gate for capture failure and recovery states. It uses
// real Chrome action popup for intrinsic sizing, then the shipped popup bundle
// and styles with a narrow browser-API mock for recovery-state layout. Hidden
// checks do not establish visible popup chrome, dismissal, or focus.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, firefox } from 'playwright';
import { createResourceStack } from './resource-stack.mjs';

const popupHtml = await fs.readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
const panelCss = await fs.readFile(new URL('../src/theme/panel.css', import.meta.url), 'utf8');
const popupCss = await fs.readFile(new URL('../popup/popup.css', import.meta.url), 'utf8');
const popupBundle = await fs.readFile(new URL('../dist/popup/popup.js', import.meta.url), 'utf8');
const icon = await fs.readFile(new URL('../icons/icon-32.png', import.meta.url));
const artifactDir = process.env.BPB_CAPTURE_POPUP_ARTIFACTS
    ? path.resolve(process.env.BPB_CAPTURE_POPUP_ARTIFACTS)
    : null;
if (artifactDir) await fs.mkdir(artifactDir, { recursive: true });

const shell = popupHtml
    .replace(/\s*<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '')
    .replace(/\s*<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, '')
    .replace('../icons/icon-32.png', `data:image/png;base64,${icon.toString('base64')}`);

const CASES = Object.freeze([
    { code: 'unsupported', provider: null, title: 'Open an activity to begin', action: 'Settings' },
    { code: 'provider-page-not-ready', provider: 'strava', title: 'Activity is still loading', action: 'Reload activity' },
    { code: 'provider-signed-out', provider: 'garmin', title: 'Sign in to your activity provider', action: 'Open Garmin sign in' },
    { code: 'provider-human-check', provider: 'strava', title: 'Your activity provider needs a human check', action: 'Return to Strava' },
    { code: 'provider-rate-limited', provider: 'strava', title: 'Your activity provider needs a pause', action: null, retryAt: Date.UTC(2030, 0, 1, 12) },
    { code: 'cloudflare', provider: 'strava', title: 'Peakbagger needs a human check', action: 'Open Peakbagger' },
    { code: 'provider-unavailable', provider: 'strava', title: 'Your activity provider is unavailable', action: 'Try again' },
    { code: 'track-too-large', provider: 'strava', title: 'This route is too large', action: null },
]);

const VARIANTS = Object.freeze([
    { name: 'light', theme: 'light', viewport: { width: 390, height: 620 }, deviceScaleFactor: 1 },
    { name: 'dark', theme: 'dark', viewport: { width: 390, height: 620 }, deviceScaleFactor: 1 },
    // Device scale is pixel density, not browser zoom. Native sizing below
    // separately checks opening the action popup over a tab at 200% zoom.
    { name: 'scale-2', theme: 'light', viewport: { width: 390, height: 620 }, deviceScaleFactor: 2 },
]);

const verifyNativeSizing = async () => {
    const resources = createResourceStack();
    let failure = null;
    try {
        const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'bpb-capture-popup-'));
        resources.defer('popup profile', () => fs.rm(profile, { recursive: true, force: true }));
        const dist = await fs.realpath(new URL('../dist', import.meta.url));
        const context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium',
            headless: true,
            // Do not assign a viewport: browser action autosizing is the test.
            viewport: null,
            ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
        });
        resources.defer('popup browser', () => context.close());
        const control = await context.newPage();
        await control.goto('chrome://extensions-internals/');
        const record = await control.waitForFunction(() => {
            try {
                return JSON.parse(globalThis.document.body.innerText).find(item =>
                    item.location === 'COMMAND_LINE' && item.name === 'Better Peakbagger') || false;
            } catch { return false; }
        }, null, { timeout: 15_000 }).then(handle => handle.jsonValue());
        if (await fs.realpath(record.path) !== dist) throw new Error('Wrong extension registered');
        await control.goto(`chrome-extension://${record.id}/options/options.html`);

        const readLayout = () => control.evaluate(() => {
            const views = globalThis.chrome.extension.getViews({ type: 'popup' });
            if (views.length !== 1) return { views: views.length };
            const popup = views[0];
            const document = popup.document;
            const card = document.querySelector('.state-card')?.getBoundingClientRect();
            return {
                viewportWidth: popup.innerWidth,
                viewportHeight: popup.innerHeight,
                bodyWidth: document.body.getBoundingClientRect().width,
                documentWidth: document.documentElement.scrollWidth,
                deviceScaleFactor: popup.devicePixelRatio,
                theme: document.documentElement.dataset.bpbTheme,
                title: document.querySelector('.state-title')?.textContent,
                cardBottom: card?.bottom,
            };
        });
        const results = [];
        for (const theme of ['light', 'dark']) {
            for (const tabZoom of [1, 2]) {
                await control.evaluate(async ({ theme, tabZoom }) => {
                    await globalThis.chrome.storage.sync.set({ bpbSettings: { theme } });
                    await globalThis.chrome.tabs.setZoom(tabZoom);
                    if (await globalThis.chrome.tabs.getZoom() !== tabZoom) {
                        throw new Error('Source tab zoom did not apply');
                    }
                    await globalThis.chrome.action.openPopup();
                }, { theme, tabZoom });
                try {
                    await control.waitForFunction(theme => {
                        const popup = globalThis.chrome.extension.getViews({ type: 'popup' })[0];
                        return popup?.document.querySelector('.state-title')?.textContent
                            === 'Open an activity to begin'
                            && popup.document.documentElement.dataset.bpbTheme === theme
                            && popup.innerWidth === 390
                            && popup.document.body.getBoundingClientRect().width === 390;
                    }, theme, { timeout: 5_000 });
                } catch (error) {
                    throw new Error(`Native popup sizing failed (${theme}, tab zoom ${tabZoom}): `
                        + JSON.stringify(await readLayout()), { cause: error });
                }
                const layout = await readLayout();
                if (layout.documentWidth > 390 || layout.cardBottom > layout.viewportHeight) {
                    throw new Error(`Native popup clipped: ${JSON.stringify(layout)}`);
                }
                results.push({ theme, tabZoom, ...layout });
                await control.evaluate(() => {
                    globalThis.chrome.extension.getViews({ type: 'popup' })[0].close();
                });
                await control.waitForFunction(() =>
                    globalThis.chrome.extension.getViews({ type: 'popup' }).length === 0);
            }
        }
        console.log(JSON.stringify({
            browser: 'chrome-action-popup', version: context.browser().version(),
            hidden: true, viewportOverride: null, results,
        }));
    } catch (error) {
        failure = error;
    }
    await resources.dispose(failure);
};

const renderCase = async (browser, browserName, item, variant) => {
    const context = await browser.newContext({
        viewport: variant.viewport,
        deviceScaleFactor: variant.deviceScaleFactor,
        colorScheme: variant.theme,
    });
    const page = await context.newPage();
    try {
        await page.setContent(shell, { waitUntil: 'domcontentloaded' });
        await page.addStyleTag({ content: panelCss });
        await page.addStyleTag({ content: popupCss });
        await page.evaluate(({ theme, job }) => {
            globalThis.document.documentElement.setAttribute('data-bpb-theme', theme);
            globalThis.chrome = {
                tabs: {
                    query: async () => [{ id: 9 }],
                    create: async () => ({}),
                    update: async () => ({}),
                    reload: async () => {},
                },
                storage: {
                    sync: {
                        get: async () => ({ bpbSettings: { units: 'imperial', theme } }),
                        set: async () => {},
                    },
                    onChanged: { addListener() {}, removeListener() {} },
                },
                runtime: {
                    sendMessage: async message => ['CAPTURE_START', 'CAPTURE_STATUS'].includes(message.type)
                        ? job
                        : { ok: true },
                    openOptionsPage: async () => {},
                },
            };
        }, {
            theme: variant.theme,
            job: {
                phase: 'error',
                provider: item.provider,
                error: { code: item.code, ...(item.retryAt ? { retryAt: item.retryAt } : {}) },
            },
        });
        await page.addScriptTag({ content: popupBundle });
        await page.waitForFunction(expected =>
            globalThis.document.querySelector('.state-title')?.textContent === expected, item.title);
        const layout = await page.evaluate(() => {
            const viewportWidth = globalThis.document.documentElement.clientWidth;
            const viewportHeight = globalThis.document.documentElement.clientHeight;
            const card = globalThis.document.querySelector('.state-card');
            const cardRect = card?.getBoundingClientRect();
            const buttons = [...globalThis.document.querySelectorAll('.state-card button')].map(button => {
                const rect = button.getBoundingClientRect();
                return { label: button.textContent, left: rect.left, right: rect.right };
            });
            return {
                viewportWidth,
                viewportHeight,
                documentWidth: globalThis.document.documentElement.scrollWidth,
                bodyWidth: globalThis.document.body.getBoundingClientRect().width,
                card: cardRect ? { left: cardRect.left, right: cardRect.right, bottom: cardRect.bottom } : null,
                buttons,
                background: globalThis.getComputedStyle(globalThis.document.body).backgroundColor,
            };
        });
        const expectedLabels = item.action ? [item.action] : [];
        const actualLabels = layout.buttons.map(button => button.label);
        if (JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels)) {
            throw new Error(`${browserName} ${variant.name} ${item.code} actions: ${JSON.stringify(actualLabels)}`);
        }
        const horizontallyContained = layout.documentWidth <= layout.viewportWidth + 1
            && layout.bodyWidth <= layout.viewportWidth + 1
            && layout.card?.left >= -1
            && layout.card?.right <= layout.viewportWidth + 1
            && layout.buttons.every(button => button.left >= -1 && button.right <= layout.viewportWidth + 1);
        if (!horizontallyContained) {
            throw new Error(`${browserName} ${variant.name} ${item.code} overflowed: ${JSON.stringify(layout)}`);
        }
        if (layout.card.bottom > layout.viewportHeight + 1) {
            throw new Error(`${browserName} ${variant.name} ${item.code} clipped vertically: ${JSON.stringify(layout)}`);
        }
        if (artifactDir) {
            await page.screenshot({
                path: path.join(artifactDir, `${browserName}-${variant.name}-${item.code}.png`
                    .replaceAll(/[^a-z0-9.-]+/gi, '-').toLowerCase()),
                fullPage: true,
            });
        }
        return {
            code: item.code,
            action: item.action,
            documentWidth: layout.documentWidth,
            bodyWidth: layout.bodyWidth,
            cardBottom: Math.round(layout.card.bottom * 10) / 10,
            background: layout.background,
        };
    } finally {
        await context.close();
    }
};

const verifyBrowser = async ({ name, engine, launch }) => {
    let browser = null;
    try {
        browser = await engine.launch({ headless: true, ...launch });
        const variants = {};
        for (const variant of VARIANTS) {
            variants[variant.name] = [];
            for (const item of CASES) {
                variants[variant.name].push(await renderCase(browser, name, item, variant));
            }
        }
        console.log(JSON.stringify({
            browser: name,
            version: browser.version(),
            hidden: true,
            cssViewport: '390x620',
            deviceScaleFactors: [1, 2],
            cases: CASES.length,
            variants,
            screenshots: artifactDir || 'disabled',
        }));
    } finally {
        await browser?.close();
    }
};

await verifyNativeSizing();
await verifyBrowser({ name: 'chrome', engine: chromium, launch: { channel: 'chromium' } });
await verifyBrowser({ name: 'firefox', engine: firefox, launch: {} });
