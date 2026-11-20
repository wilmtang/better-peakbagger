// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: load a Peakbagger fixture into jsdom, stub chrome.storage, and
// run the extension against it by evaluating the *built* content-script bundles
// (dist/…) — the same self-contained IIFE files the browser loads. Evaluating
// the shipped bundle keeps the harness faithful across the ES-module migration:
// bundle output is an IIFE whether the source modules are IIFEs or ES modules,
// so a test names the page's bundles rather than a hand-kept list of src files.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub, type PageChrome, type Values } from './chrome-stub.mts';
import type { PageDocument, TestWindow } from './page-types.mts';

export { makeChromeStub, type PageChrome } from './chrome-stub.mts';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(root, 'test', 'fixtures', 'peakascents');
export const PAGE_FIXTURES = path.join(root, 'test', 'fixtures', 'pages');
export const DIST = path.join(root, 'dist');

// A jsdom page whose document lookups are typed as this repository's known
// fixture markup (see page-types.mts), plus the extension stub it runs with.
export type PageWindow = Omit<TestWindow, 'document' | 'chrome'> & { document: PageDocument; chrome: PageChrome };
export interface LoadedPage extends Omit<JSDOM, 'window'> {
    readonly window: PageWindow;
    chrome: PageChrome;
}

// Anything with an `eval`, such as a jsdom window or a vm-style context.
interface EvalTarget { eval(source: string): unknown }

// Evaluate one or more built bundles (dist-relative paths) into a window or
// vm-style context, in order. `npm test` runs `npm run build` first,
// so dist/ is always current.
export const evalBundle = async (target: EvalTarget, ...bundles: string[]): Promise<void> => {
    for (const rel of bundles) {
        target.eval(await readFile(path.join(DIST, rel), 'utf8'));
    }
};

// jsdom's public dispatchEvent can only mint untrusted events, but the upload
// flow's swap guard keys on event.isTrusted (a user-initiated file pick). Fire
// a trusted event through jsdom's internal dispatch helper. These internals
// have no published types; this is the one local declaration of the parts used,
// pinned to the jsdom major in package-lock, so an upgrade that moves them
// fails here loudly rather than silently skipping the guard.
const JSDOM_INTERNALS_MAJOR = 30;
interface JsdomEventInternals {
    fireAnEvent(type: string, target: object, eventInterface: object | undefined, attributes: Record<string, unknown>): boolean;
}
interface JsdomWrapperInternals { implForWrapper(wrapper: object): object }
const jsdomInternal = <T, >(file: string): T => {
    const { version } = require(path.join(root, 'node_modules/jsdom/package.json')) as { version: string };
    if (Number.parseInt(version, 10) !== JSDOM_INTERNALS_MAJOR) {
        throw new Error(`fireTrustedEvent is declared against jsdom ${JSDOM_INTERNALS_MAJOR}, found ${version}.`);
    }
    return require(path.join(root, 'node_modules/jsdom/lib', file)) as T;
};

export const fireTrustedEvent = (element: EventTarget, type: string, attributes: Record<string, unknown> = { bubbles: true }): void => {
    const { fireAnEvent } = jsdomInternal<JsdomEventInternals>('jsdom/living/helpers/events.js');
    const { implForWrapper } = jsdomInternal<JsdomWrapperInternals>('generated/idl/utils.js');
    const eventInterface = /^(?:auxclick|click|dblclick|mousedown|mouseup|mousemove)$/.test(type)
        ? jsdomInternal<object>('generated/idl/MouseEvent.js')
        : /^(?:keydown|keyup)$/.test(type)
            ? jsdomInternal<object>('generated/idl/KeyboardEvent.js')
            : undefined;
    fireAnEvent(type, implForWrapper(element), eventInterface, attributes);
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

export interface LoadPageOptions {
    url?: string;
    settings?: Values;
    local?: Values;
    bundles?: string[];
    fixtures?: string;
    prepare?: ((dom: LoadedPage) => void) | null;
}

export const loadPage = async (fixture: string, {
    url,
    settings = {},
    local = {},
    bundles = ['content/ascent-filter.js'],
    fixtures = FIXTURES,
    prepare = null
}: LoadPageOptions = {}): Promise<LoadedPage> => {
    const html = await readFile(path.join(fixtures, fixture), 'utf8');
    // pretendToBeVisual provides requestAnimationFrame, which the bundled
    // editor libraries (ProseMirror, CodeMirror) schedule their work through.
    const jsdom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const dom = jsdom as unknown as LoadedPage;
    // The same libraries measure the DOM through layout APIs jsdom does not
    // implement; zero-size answers are fine because no test asserts geometry.
    const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
    jsdom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    jsdom.window.Range.prototype.getBoundingClientRect = zeroRect;
    if (!jsdom.window.document.elementFromPoint) {
        jsdom.window.document.elementFromPoint = () => null;
    }
    dom.chrome = makeChromeStub({ bpbSettings: settings }, local, {
        getSender: () => ({ url: jsdom.window.location.href, tab: { id: 1 } }),
    });
    (jsdom.window as { chrome?: unknown }).chrome = dom.chrome;
    if (prepare) prepare(dom);
    await evalBundle(jsdom.window, ...bundles);
    return dom;
};

// Shorthand: load and wait for the filter bar to be injected.
export const loadPageWithBar = async (fixture: string, opts?: LoadPageOptions): Promise<LoadedPage> => {
    const dom = await loadPage(fixture, opts);
    await waitFor(dom, () => dom.window.document.getElementById('pbaf-bar'));
    return dom;
};
