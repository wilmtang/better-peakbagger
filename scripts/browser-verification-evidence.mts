/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, innerWidth, innerHeight */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PageState {
    readyState: DocumentReadyState;
    visibility: DocumentVisibilityState;
    viewport: { width: number; height: number };
    elements: number;
    frames: number;
    canvases: number;
    formFields: number;
    busy: number;
    alerts: number;
}

export interface FixtureRequestEntry {
    url: string;
    type: string;
}

export interface FixtureRequestSummary {
    pending: FixtureRequestEntry[];
    failed: FixtureRequestEntry[];
}

export interface FixtureRequestSource {
    url(): string;
    resourceType(): string;
}

export interface RequestEventEmitter {
    on(event: 'request', listener: (request: FixtureRequestSource) => void): unknown;
    on(event: 'requestfinished', listener: (request: FixtureRequestSource) => void): unknown;
    on(event: 'requestfailed', listener: (request: FixtureRequestSource) => void): unknown;
}

export interface EvidencePage<TLocator = unknown> {
    url(): string;
    evaluate<T>(pageFunction: () => T): Promise<T>;
    locator(selector: string): TLocator;
    screenshot(options: {
        path: string;
        fullPage: boolean;
        timeout: number;
        mask: TLocator[];
    }): Promise<unknown>;
}

export interface EvidenceContext<TLocator = unknown> {
    browser(): { version(): string } | null;
    pages(): EvidencePage<TLocator>[];
}

export interface EvidenceDriver {
    getCapabilities(): Promise<{ getBrowserVersion(): string | undefined }>;
    getCurrentUrl(): Promise<string>;
    executeScript<T>(script: () => T): Promise<T>;
}

export interface RetainBrowserFailureOptions<TLocator = unknown> {
    context?: EvidenceContext<TLocator> | null;
    driver?: EvidenceDriver | null;
    fixtureOrigin: string;
    extensionBaseUrl?: string | null;
    fixtureScreenshot?: (filePath: string) => Promise<unknown>;
    requests?: () => unknown;
    directory?: string | null;
    timeoutMs?: number;
}

interface EvidencePageEntry {
    url: string;
    state?: PageState;
    screenshot?: string;
    inaccessible?: boolean;
}

interface FailureEvidence {
    browser?: string;
    requests: unknown;
    pages: EvidencePageEntry[];
}

export function verificationScreenshots(mode: string = process.env.BPB_VERIFY_SCREENSHOTS || 'all'): (reference?: boolean) => boolean {
    if (!['all', 'references', 'failure'].includes(mode)) throw new Error(`Unknown verification screenshot mode: ${mode}`);
    return (reference = false) => mode === 'all' || mode === 'references' && reference;
}

// Evidence belongs only to isolated fixture checks. Never retain query strings,
// request bodies, storage, form values, or arbitrary pages in a live profile.
export function fixtureEvidenceUrl(
    value: string,
    fixtureOrigin: string,
    extensionBaseUrl: string | null = null,
): string | null {
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

function readPageState(): PageState {
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

async function bounded<T>(operation: () => T | Promise<T>, timeoutMs = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Evidence timeout')), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export function watchFixtureRequests(
    context: RequestEventEmitter,
    fixtureOrigin: string,
): () => FixtureRequestSummary {
    const pending = new Map<FixtureRequestSource, FixtureRequestEntry>();
    const failed: FixtureRequestEntry[] = [];
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

export async function retainBrowserFailure<TLocator = unknown>({
    context, driver, fixtureOrigin, extensionBaseUrl, fixtureScreenshot, requests = () => ({}),
    directory = process.env.BPB_VERIFY_ARTIFACTS,
    timeoutMs = 3000,
}: RetainBrowserFailureOptions<TLocator>): Promise<void> {
    if (!directory || (!context && !driver)) return;
    // Diagnostics cannot replace the original test error or prevent teardown.
    try {
        await mkdir(directory, { recursive: true });
        const evidence: FailureEvidence = { requests: requests(), pages: [] };
        if (context) {
            evidence.browser = context.browser()?.version() ?? 'unknown';
            for (const page of context.pages().filter(candidate =>
                fixtureEvidenceUrl(candidate.url(), fixtureOrigin, extensionBaseUrl)).slice(-3)) {
                const pageUrl = fixtureEvidenceUrl(page.url(), fixtureOrigin, extensionBaseUrl);
                if (!pageUrl) continue;
                const entry: EvidencePageEntry = { url: pageUrl };
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
        } else if (driver) {
            evidence.browser = (await bounded(() => driver.getCapabilities(), timeoutMs))
                .getBrowserVersion();
            const url = fixtureEvidenceUrl(await bounded(() => driver.getCurrentUrl(), timeoutMs),
                fixtureOrigin, extensionBaseUrl);
            if (url) {
                evidence.pages.push({ url, state: await bounded(() =>
                    driver.executeScript(readPageState), timeoutMs) });
                // Explicit fixture-only transports may retain their synthetic
                // page. Never invoke them for an extension or live origin.
                if (fixtureScreenshot && fixtureEvidenceUrl(url, fixtureOrigin)) {
                    await bounded(() => fixtureScreenshot(path.join(directory, 'failed-page.png')), timeoutMs);
                    evidence.pages[0].screenshot = 'failed-page.png';
                }
                // WebDriver cannot reliably mask form fields without changing
                // the failed document. Keep its bounded structural state only.
            }
        }
        await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    } catch {
        console.error('Browser failure evidence could not be retained; preserving the original failure.');
    }
}
