// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, innerWidth, innerHeight */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Evidence belongs only to isolated fixture checks. Never retain query strings,
// request bodies, storage, form values, or arbitrary pages in a live profile.
export function fixtureEvidenceUrl(value, fixtureOrigin, extensionBaseUrl = null) {
    try {
        const url = new URL(value);
        if (url.origin === fixtureOrigin) return `${url.origin}${url.pathname}`;
        if (!extensionBaseUrl) return null;
        const extension = new URL(extensionBaseUrl);
        if (!['moz-extension:', 'chrome-extension:'].includes(extension.protocol)
            || url.protocol !== extension.protocol || url.host !== extension.host) return null;
        // Node reports extension URL origins as null; compare protocol and host
        // explicitly and keep only the registered isolated extension's path.
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return null;
    }
}

function readPageState() {
    return {
        readyState: document.readyState,
        visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight },
        elements: document.querySelectorAll('*').length,
        frames: document.querySelectorAll('iframe').length,
        canvases: document.querySelectorAll('canvas').length,
        formFields: document.querySelectorAll('input,textarea,[contenteditable]').length,
        busy: document.querySelectorAll('[aria-busy="true"]').length,
        alerts: document.querySelectorAll('[role="alert"]').length,
    };
}

async function bounded(operation, timeoutMs = 3000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Evidence timeout')), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export function watchFixtureRequests(context, fixtureOrigin) {
    const pending = new Map();
    const failed = [];
    context.on('request', request => {
        const url = fixtureEvidenceUrl(request.url(), fixtureOrigin);
        if (url && pending.size < 64) pending.set(request, { url, type: request.resourceType() });
    });
    context.on('requestfinished', request => pending.delete(request));
    context.on('requestfailed', request => {
        const value = pending.get(request);
        if (value && failed.length < 32) failed.push(value);
        pending.delete(request);
    });
    return () => ({ pending: [...pending.values()], failed: [...failed] });
}

export async function retainBrowserFailure({
    context, driver, fixtureOrigin, extensionBaseUrl, requests = () => ({}),
    directory = process.env.BPB_VERIFY_ARTIFACTS,
    timeoutMs = 3000,
}) {
    if (!directory || (!context && !driver)) return;
    // Diagnostics cannot replace the original test error or prevent teardown.
    try {
        await mkdir(directory, { recursive: true });
        const evidence = { requests: requests(), pages: [] };
        if (context) {
            evidence.browser = context.browser()?.version() ?? 'unknown';
            for (const page of context.pages().filter(page =>
                fixtureEvidenceUrl(page.url(), fixtureOrigin, extensionBaseUrl)).slice(-3)) {
                const entry = { url: fixtureEvidenceUrl(page.url(), fixtureOrigin, extensionBaseUrl) };
                try {
                    entry.state = await bounded(() => page.evaluate(readPageState), timeoutMs);
                    // Extension lists may contain stored labels outside form
                    // fields. Retain only their structural state, without images.
                    if (fixtureEvidenceUrl(page.url(), fixtureOrigin)) {
                        const screenshot = `page-${evidence.pages.length + 1}.png`;
                        await page.screenshot({
                            path: path.join(directory, screenshot),
                            fullPage: false,
                            timeout: timeoutMs,
                            mask: [page.locator('input,textarea,[contenteditable]')],
                        });
                        entry.screenshot = screenshot;
                    }
                } catch {
                    entry.inaccessible = true;
                }
                evidence.pages.push(entry);
            }
        } else {
            evidence.browser = (await bounded(() => driver.getCapabilities(), timeoutMs))
                .getBrowserVersion();
            const url = fixtureEvidenceUrl(await bounded(() => driver.getCurrentUrl(), timeoutMs),
                fixtureOrigin, extensionBaseUrl);
            if (url) {
                evidence.pages.push({ url, state: await bounded(() =>
                    driver.executeScript(readPageState), timeoutMs) });
                // WebDriver cannot reliably mask form fields without changing
                // the failed document. Keep its bounded structural state only.
            }
        }
        await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    } catch {
        console.error('Browser failure evidence could not be retained; preserving the original failure.');
    }
}
