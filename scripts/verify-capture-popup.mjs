// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hidden browser layout gate for capture failure and recovery states. It uses
// the shipped popup bundle and styles with a narrow browser-API mock. This
// verifies content layout, not native popup chrome, dismissal, or focus.

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

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
    // A 390x620 physical popup at 200% has a 195x310 effective CSS viewport.
    { name: 'zoom-200', theme: 'light', viewport: { width: 195, height: 310 }, deviceScaleFactor: 2 },
]);

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
            physicalViewport: '390x620',
            effectiveZoomViewport: '195x310 CSS pixels at 2x device scale',
            cases: CASES.length,
            variants,
            screenshots: artifactDir || 'disabled',
        }));
    } finally {
        await browser?.close();
    }
};

await verifyBrowser({ name: 'chrome', engine: chromium, launch: { channel: 'chromium' } });
await verifyBrowser({ name: 'firefox', engine: firefox, launch: {} });
