/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-page browser tests' page loader: a Peakbagger fixture in a real fixture
// frame (fixture-dom.mts) with the stubbed extension API (chrome-stub.mts),
// running the built content-script bundles from dist/, the same files the
// browser loads.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChromeStub, type PageChrome, type Values } from './chrome-stub.mts';
import { FixtureDom, evalBundle, trustedInput, type FixtureDomOptions, type TrustedAction } from './fixture-dom.mts';
import type { PageDocument, TestWindow } from './page-types.mts';

export { makeChromeStub, type PageChrome } from './chrome-stub.mts';
export { FixtureDom, evalBundle, trustedInput } from './fixture-dom.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(root, 'test', 'fixtures', 'peakascents');
export const PAGE_FIXTURES = path.join(root, 'test', 'fixtures', 'pages');

// A fixture page whose document lookups are typed as this repository's known
// fixture markup (see page-types.mts), plus the extension stub it runs with.
export type PageWindow = Omit<TestWindow, 'document' | 'chrome'> & { document: PageDocument; chrome: PageChrome };
export interface LoadedPage {
    readonly window: PageWindow;
    chrome: PageChrome;
    serialize(): string;
}

export interface LoadPageOptions extends Pick<FixtureDomOptions, 'width' | 'height'> {
    url?: string;
    settings?: Values;
    local?: Values;
    bundles?: string[];
    fixtures?: string;
    prepare?: ((dom: LoadedPage) => void) | null;
}

export const loadPage = async (fixture: string, {
    url, settings = {}, local = {}, bundles = ['content/ascent-filter.js'], fixtures = FIXTURES, prepare = null, width, height,
}: LoadPageOptions = {}): Promise<LoadedPage> => {
    const html = await readFile(path.join(fixtures, fixture), 'utf8');
    const fixtureDom = await FixtureDom.open(html, { url, width, height });
    const window = fixtureDom.window as unknown as PageWindow;
    const chrome = makeChromeStub({ bpbSettings: settings }, local, {
        getSender: () => ({ url: window.location.href, tab: { id: 1 } }),
    });
    const dom: LoadedPage = { window, chrome, serialize: () => fixtureDom.serialize() };
    (window as { chrome?: unknown }).chrome = chrome;
    if (prepare) prepare(dom);
    await evalBundle(window, ...bundles);
    return dom;
};

// Shorthand: load and wait for the filter bar to be injected.
export const loadPageWithBar = async (fixture: string, opts?: LoadPageOptions): Promise<LoadedPage> => {
    const dom = await loadPage(fixture, opts);
    await waitFor(dom, () => dom.window.document.getElementById('pbaf-bar'));
    return dom;
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

// Real automation input, so the page sees trusted events (a click unless
// another action is named).
export const fireTrustedEvent = (element: Element, action: TrustedAction = { type: 'click' }): Promise<void> =>
    trustedInput(element, action);
