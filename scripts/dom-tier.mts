/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-browser DOM tier: tests whose behavior depends on layout, scrolling,
// trusted input, focus or browser-specific DOM, which jsdom cannot establish.
// Tests live in test/dom/*.dom.mts, outside the `npm test` glob, and import
// their types from here; scripts/verify-dom.mts runs them through
// `npm run verify -- dom`.
//
// Each case runs in a fresh context of one headless browser per engine. Pages
// are served at their real HTTPS Peakbagger URL entirely through request
// routing (no server, certificate or live network); every other request is
// aborted. `chrome`/`browser` stubs are installed by init script, and built
// IIFE bundles come from dist/ (or a disposable copy passed with --dist).
// This tier does not load the extension: execution worlds, the manifest,
// worker and bridge remain `npm run verify -- browsers` territory.

import assert from 'node:assert/strict';
import { access, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, type Browser, type Page, type Route } from 'playwright';
import { retainBrowserFailure, watchFixtureRequests } from './browser-verification-evidence.mjs';
import { fixtureContentType, fixtureHost, projectRoot } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

export const DOM_ORIGIN = `https://${fixtureHost}`;
export const DOM_ENGINES = ['chrome', 'firefox'] as const;
export type DomEngine = typeof DOM_ENGINES[number];

export interface DomStubOptions {
    // Initial `bpbSettings` in stubbed sync storage.
    settings?: Record<string, unknown>;
    // Initial stubbed local storage.
    local?: Record<string, unknown>;
}

export interface DomContext {
    readonly page: Page;
    readonly engine: DomEngine;
    // Serves a fixture or built file at an absolute HTTPS Peakbagger URL path.
    route(pathname: string, body: string | Buffer, contentType?: string): Promise<void>;
    // Navigates to a routed path and waits for the load event.
    open(pathname: string): Promise<void>;
    // Evaluates built bundles (dist-relative) in the page, in the given order.
    inject(...bundles: string[]): Promise<void>;
    // Reads a built file from the selected build directory.
    built(file: string): Promise<Buffer>;
}

export interface DomCase {
    readonly name: string;
    readonly viewport?: { width: number; height: number };
    readonly stub?: DomStubOptions;
    run(context: DomContext): Promise<void>;
}

export interface DomSuite {
    readonly name: string;
    readonly cases: readonly DomCase[];
}

export const defineDomSuite = (suite: DomSuite): DomSuite => suite;

// Installed by init script before any page script runs. It must stay
// self-contained: Playwright serializes it into each engine's page.
function installExtensionStub({ settings, local }: { settings: Record<string, unknown>; local: Record<string, unknown> }) {
    type Values = Record<string, unknown>;
    type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;
    const listeners = new Set<Listener>();
    const messages: unknown[] = [];
    const area = (values: Values, name: string) => ({
        // Like the real API, a missing key is absent from the result.
        async get(keys?: string | string[] | Values | null) {
            if (keys == null) return { ...values };
            const present = (key: string) => Object.hasOwn(values, key);
            if (typeof keys === 'string') return present(keys) ? { [keys]: values[keys] } : {};
            if (Array.isArray(keys)) return Object.fromEntries(keys.filter(present).map(key => [key, values[key]]));
            return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, present(key) ? values[key] : fallback]));
        },
        async set(patch: Values) {
            const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
            for (const [key, value] of Object.entries(patch)) {
                changes[key] = { oldValue: values[key], newValue: value };
                values[key] = value;
            }
            for (const listener of listeners) listener(changes, name);
        },
        async remove(keys: string | string[]) {
            const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (!Object.hasOwn(values, key)) continue;
                changes[key] = { oldValue: values[key] };
                delete values[key];
            }
            if (Object.keys(changes).length) for (const listener of listeners) listener(changes, name);
        },
    });
    const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
    const sync: Values = { bpbSettings: { ...settings } }, stored: Values = { ...local };
    const syncArea = area(sync, 'sync');
    const api = {
        storage: {
            sync: syncArea, local: area(stored, 'local'), session: area({}, 'session'),
            onChanged: { addListener: (fn: Listener) => { listeners.add(fn); }, removeListener: (fn: Listener) => { listeners.delete(fn); } },
        },
        runtime: {
            id: 'dom-tier',
            getURL: (file: string) => new URL(`/dist/${file}`, location.origin).href,
            getManifest: () => ({ version: '0.0.0-dom' }),
            onMessage: event(),
            // Settings writes behave like the worker's queue for this page;
            // any other route answers empty, as an idle worker would.
            async sendMessage(message: { type?: string; patch?: Values }) {
                messages.push(structuredClone(message));
                if (message?.type === 'SETTINGS_PATCH') {
                    const next = { ...(sync.bpbSettings as Values), ...message.patch };
                    await syncArea.set({ bpbSettings: next });
                    return { ok: true, settings: next };
                }
                return {};
            },
        },
        permissions: {
            contains: async () => false, request: async () => false, remove: async () => true,
            onAdded: event(), onRemoved: event(),
        },
        tabs: { create: async () => ({}), query: async () => [], getCurrent: async () => undefined },
    };
    Object.defineProperty(globalThis, '__bpbDomTier', { value: { messages }, configurable: true });
    Object.defineProperty(globalThis, 'chrome', { value: api, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'browser', { value: api, configurable: true, writable: true });
}

export interface DomSelection { engines: DomEngine[]; filter: string | null; dist: string }

// Rejects unknown arguments rather than running a narrower set than asked.
export function domSelection(args: readonly string[], cwd = projectRoot): DomSelection {
    const engines: DomEngine[] = [];
    let filter: string | null = null, dist = path.join(cwd, 'dist');
    for (let index = 0; index < args.length; index++) {
        const value = args[index]!;
        if ((DOM_ENGINES as readonly string[]).includes(value)) {
            if (engines.includes(value as DomEngine)) throw new Error(`DOM tier engine ${value} was selected twice.`);
            engines.push(value as DomEngine);
        } else if ((value === '--case' || value === '--dist') && args[index + 1] && !args[index + 1]!.startsWith('--')) {
            if (value === '--case') {
                if (filter !== null) throw new Error('DOM tier --case was given twice.');
                filter = args[++index]!;
            } else dist = path.resolve(cwd, args[++index]!);
        } else throw new Error(`Unknown DOM tier argument: ${value}. Usage: verify -- dom [chrome] [firefox] [--case TEXT] [--dist DIR]`);
    }
    return { engines: engines.length ? engines : [...DOM_ENGINES], filter, dist };
}

export async function loadDomSuites(directory = path.join(projectRoot, 'test', 'dom')): Promise<DomSuite[]> {
    const files = (await readdir(directory)).filter(file => file.endsWith('.dom.mts')).sort();
    const suites: DomSuite[] = [];
    for (const file of files) {
        const module = await import(pathToFileURL(path.join(directory, file)).href) as { default?: DomSuite };
        assert.ok(module.default?.cases?.length, `${file} must default-export a suite with cases`);
        suites.push(module.default);
    }
    return suites;
}

// Serves files from the selected build directory only, after resolving
// symlinks, so a routed path cannot escape it.
const builtReader = async (dist: string) => {
    const base = await realpath(dist).catch(() => { throw new Error(`DOM tier build directory ${dist} does not exist; run npm run build.`); });
    await access(path.join(base, 'manifest.json')).catch(() => { throw new Error(`${dist} is not a built extension (no manifest.json).`); });
    return async (file: string) => {
        const resolved = await realpath(path.resolve(base, file));
        if (!resolved.startsWith(base + path.sep)) throw new Error(`Refusing a path outside the build directory: ${file}`);
        return readFile(resolved);
    };
};

type BuiltReader = Awaited<ReturnType<typeof builtReader>>;

const createContext = async (browser: Browser, engine: DomEngine, item: DomCase, built: BuiltReader) => {
    const context = await browser.newContext({ viewport: item.viewport ?? { width: 1000, height: 760 } });
    try {
        const routes = new Map<string, { body: string | Buffer; contentType: string }>();
        // Every request a case causes must be one it planned: a missing built
        // asset or a request leaving the fixture origin fails the case.
        const unexpected: string[] = [];
        await context.route('**/*', async (route: Route) => {
            const url = new URL(route.request().url());
            if (url.origin !== DOM_ORIGIN) {
                unexpected.push(`aborted ${url.origin}`);
                return route.abort();
            }
            const fixture = routes.get(url.pathname);
            if (fixture) return route.fulfill({ status: 200, body: fixture.body, contentType: fixture.contentType });
            if (url.pathname.startsWith('/dist/')) {
                try {
                    const file = decodeURIComponent(url.pathname.slice('/dist/'.length));
                    return await route.fulfill({ status: 200, body: await built(file), contentType: fixtureContentType(file) });
                }
                catch { unexpected.push(`missing ${url.pathname}`); return route.fulfill({ status: 404, body: 'Missing built file' }); }
            }
            unexpected.push(`unrouted ${url.pathname}`);
            return route.fulfill({ status: 404, body: 'Not a DOM tier fixture' });
        });
        const requests = watchFixtureRequests(context, DOM_ORIGIN);
        await context.addInitScript(installExtensionStub, { settings: item.stub?.settings ?? {}, local: item.stub?.local ?? {} });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const pageErrors: string[] = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        const domContext: DomContext = {
            page, engine, built,
            async route(pathname, body, contentType = 'text/html') { routes.set(pathname, { body, contentType }); },
            async open(pathname) { await page.goto(new URL(pathname, DOM_ORIGIN).href, { waitUntil: 'load' }); },
            async inject(...bundles) {
                for (const bundle of bundles) await page.addScriptTag({ content: (await built(bundle)).toString('utf8') });
            },
        };
        return { context, domContext, pageErrors, unexpected, requests };
    } catch (error) {
        await context.close().catch(() => {});
        throw error;
    }
};

export async function runDomTier(args: readonly string[], suites?: DomSuite[]): Promise<number> {
    const selection = domSelection(args);
    const loaded = suites ?? await loadDomSuites();
    const selected = loaded.flatMap(suite => suite.cases.map(item => ({ suite, item, label: `${suite.name}: ${item.name}` })))
        .filter(({ label }) => !selection.filter || label.includes(selection.filter));
    if (!selected.length) throw new Error(`No DOM tier case matches ${JSON.stringify(selection.filter)}.`);
    const built = await builtReader(selection.dist);
    const resources = createResourceStack();
    let failure: unknown = null, executed = 0;
    try {
        for (const engine of selection.engines) {
            if (engine === 'chrome') assertChromeLaunchAllowed();
            // Full Chrome for Testing in new headless mode, not the headless shell.
            const browser = await (engine === 'chrome'
                ? chromium.launch({ channel: 'chromium', headless: true })
                : firefox.launch({ headless: true }));
            resources.defer(`${engine} DOM tier browser`, () => browser.close());
            for (const { item, label } of selected) {
                const startedAt = performance.now();
                const { context, domContext, pageErrors, unexpected, requests } = await createContext(browser, engine, item, built);
                let caseError: unknown = null;
                try {
                    await item.run(domContext);
                    assert.deepEqual(pageErrors, [], `${label}: uncaught page errors`);
                    assert.deepEqual(unexpected, [], `${label}: unexpected requests`);
                    executed++;
                    console.log(JSON.stringify({ tier: 'dom', engine, version: browser.version(), hidden: true, case: label,
                        viewport: item.viewport ?? { width: 1000, height: 760 }, durationMs: Math.round(performance.now() - startedAt), result: 'passed' }));
                } catch (error) {
                    caseError = error;
                    await retainBrowserFailure({ context, fixtureOrigin: DOM_ORIGIN, requests } as unknown as Parameters<typeof retainBrowserFailure>[0]);
                    throw new Error(`${engine} ${label} failed: ${(error as Error).message}`, { cause: error });
                } finally {
                    // A close failure must not replace the case's own error.
                    await context.close().catch(error => { if (!caseError) throw error; });
                }
            }
            // Release this engine before launching the next.
            await browser.close();
        }
        // Retries are off: a case that passes only on re-run is a bug in the case.
        assert.equal(executed, selected.length * selection.engines.length, 'every selected DOM tier case must execute');
        console.log(JSON.stringify({ verification: 'dom', engines: selection.engines, executedCases: executed }));
    } catch (error) { failure = error; }
    await resources.dispose(failure as null);
    return executed;
}
