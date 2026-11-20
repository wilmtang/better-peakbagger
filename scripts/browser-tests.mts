/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-page browser tests: `test/**/*.browser.mts` files written against
// `node:test` and `node:assert/strict`, run inside a real page instead of a
// simulated DOM. Each file is bundled for the browser with small runtimes for
// the Node modules tests use (test/dom/runtime/), then runs in a fresh hidden
// page per engine on its HTTPS fixture origin (www.peakbagger.com unless the
// file declares `// @browser-origin https://host`). Requests are routed: built
// files under /dist/, read-only checkout files under /__bpb_fs__/, and nothing
// else. Fixture documents are same-origin iframes (test/helpers/fixture-dom.mts);
// trusted input is real automation input performed by this runner.
//
// Part of the DOM tier: `npm run verify -- dom` runs these after the
// orchestrated `test/dom/*.dom.mts` suites. `npm test` never globs them.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { chromium, firefox, type Browser, type BrowserContext, type ElementHandle, type Page } from 'playwright';
import { fixtureContentType, projectRoot } from './browser-verification-fixtures.mts';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';
import { createResourceStack } from './resource-stack.mts';
import type { DomEngine, DomSelection } from './dom-tier.mts';
import type { TrustedAction } from '../test/helpers/fixture-dom.mts';

const DEFAULT_ORIGIN = 'https://www.peakbagger.com';
const siteOf = (hostname: string) => hostname.split('.').slice(-2).join('.');
const RUNNER_PATH = '/__bpb_test__/';
const RUNNER_SCRIPT = '/__bpb_test__/test.js';
const RUN_TIMEOUT_MS = 10 * 60_000;
// Like jsdom's outside-only pages, fixture markup cannot run code: inline
// <script>, on* handler attributes and javascript: URLs are refused. The test
// and the bundles it evaluates still run (same-origin scripts and eval).
// About:blank fixture frames inherit this policy from the runner page.
// test/helpers/fixture-dom.mts adds it to inline scripts of runScripts: 'dangerously' fixtures.
const FIXTURE_NONCE = 'bpb-fixture';
const RUNNER_CSP = `script-src 'self' 'unsafe-eval' 'nonce-${FIXTURE_NONCE}'`;
const runnerHeaders = { 'Origin-Agent-Cluster': '?0', 'Content-Security-Policy': RUNNER_CSP };
const FILE_ROUTE = '/__bpb_fs__';
const runtime = (file: string) => path.join(projectRoot, 'test', 'dom', 'runtime', file);
const NODE_RUNTIMES: Record<string, string> = {
    'node:test': runtime('node-test.mts'),
    'node:assert': runtime('node-assert.mts'),
    'node:assert/strict': runtime('node-assert.mts'),
    'node:fs': runtime('node-fs.mts'),
    'node:fs/promises': runtime('node-fs.mts'),
    'node:path': runtime('node-path.mts'),
    'node:url': runtime('node-url.mts'),
    'node:timers/promises': runtime('node-timers-promises.mts'),
};

export interface BrowserTestFile {
    readonly file: string;
    readonly origin: string;
}

export async function findBrowserTests(directory = path.join(projectRoot, 'test')): Promise<BrowserTestFile[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.browser.mts'))
        .map(entry => path.relative(projectRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
    return Promise.all(files.map(async file => {
        const header = /^\/\/ @browser-origin (https:\/\/[^\s/]+)\s*$/m.exec(await readFile(path.join(projectRoot, file), 'utf8'));
        return { file, origin: header ? new URL(header[1]!).origin : DEFAULT_ORIGIN };
    }));
}

// Node built-ins resolve to the in-page runtimes; any other built-in, and
// jsdom, is an error rather than a silent stand-in.
const nodeRuntimes: Plugin = {
    name: 'node-runtimes',
    setup(builder) {
        builder.onResolve({ filter: /^(?:node:|jsdom$)/ }, ({ path: request, importer }) => {
            const resolved = NODE_RUNTIMES[request];
            if (resolved) return { path: resolved };
            return { errors: [{ text: `${request} is not available to browser tests (imported by ${path.relative(projectRoot, importer)})` }] };
        });
        // import.meta.url names each module's own file, as it does in Node.
        builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path: file }) => {
            if (file.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
            const source = await readFile(file, 'utf8');
            const contents = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href))
                .replaceAll('import.meta.dirname', JSON.stringify(path.dirname(file)))
                .replaceAll('import.meta.filename', JSON.stringify(file));
            const loader = /\.[cm]?ts$/.test(file) ? 'ts' : 'js';
            return { contents, loader };
        });
    },
};

export async function bundleBrowserTest(file: string): Promise<string> {
    const entry = path.join(projectRoot, file);
    const { outputFiles } = await build({
        stdin: {
            // Module evaluation order runs the test file, including any
            // top-level await, before publishing the runner entry point.
            contents: `import ${JSON.stringify(runtime('node-globals.mts'))};\n`
                + `import { runRegisteredTests } from ${JSON.stringify(runtime('node-test.mts'))};\n`
                + `import ${JSON.stringify(entry)};\nglobalThis.__bpbRunBrowserTests = runRegisteredTests;\n`,
            resolveDir: projectRoot, loader: 'ts', sourcefile: 'browser-test-entry.ts',
        },
        bundle: true, write: false, format: 'esm', platform: 'browser', target: ['chrome128', 'firefox152'],
        logLevel: 'silent', plugins: [nodeRuntimes],
        define: { 'process.env.NODE_ENV': '"test"', __BPB_PROJECT_ROOT__: JSON.stringify(projectRoot) },
    });
    assert.equal(outputFiles.length, 1, `${file} must bundle to one script`);
    return outputFiles[0]!.text;
}

interface BrowserTestRecord { name: string; result: 'passed' | 'failed' | 'skipped'; durationMs: number; error?: string }

// Serves checkout files read-only, after resolving symlinks, and the selected
// build directory in place of the checkout's dist/.
const fileServer = async (dist: string) => {
    const root = await realpath(projectRoot), built = await realpath(dist);
    return async (pathname: string) => {
        const requested = path.resolve('/', decodeURIComponent(pathname));
        const checkoutDist = path.join(root, 'dist') + path.sep;
        const mapped = requested.startsWith(checkoutDist) ? path.join(built, requested.slice(checkoutDist.length)) : requested;
        const resolved = await realpath(mapped).catch(() => null);
        if (!resolved || !(resolved.startsWith(root + path.sep) || resolved.startsWith(built + path.sep))) return null;
        return readFile(resolved).catch(() => null);
    };
};

type StagedFileInput = Extract<TrustedAction, { type: 'files' }>['files'];

async function performTrustedInput(page: Page, action: TrustedAction, stageFiles: (files: StagedFileInput) => Promise<string[]>) {
    // The target lives in the test page or one of its frames, or in a
    // top-level fixture page the test opened; act through the page that owns it.
    let owner = page;
    let handle = await page.evaluateHandle(() => window.__bpbTrustedTarget);
    for (const popup of page.context().pages()) {
        if (popup === page) continue;
        const candidate = await popup.evaluateHandle(() => {
            const target = (window.opener as Window | null)?.__bpbTrustedTarget;
            return target?.ownerDocument === document ? target : null;
        }).catch(() => null);
        if (candidate?.asElement()) { await handle.dispose(); handle = candidate; owner = popup; break; }
        await candidate?.dispose();
    }
    page = owner;
    const element = handle.asElement() as ElementHandle<Element> | null;
    if (!element) throw new Error('No trusted input target is set.');
    try {
        switch (action.type) {
        case 'click': await element.click({ button: action.button, modifiers: action.modifiers }); break;
        case 'dblclick': await element.dblclick({ button: action.button, modifiers: action.modifiers }); break;
        case 'hover': await element.hover(); break;
        case 'focus': await element.focus(); break;
        case 'mouse': {
            let { x, y } = action;
            if (x === undefined || y === undefined) {
                const box = await element.boundingBox();
                if (!box) throw new Error('The trusted mouse target has no box.');
                x ??= box.x + box.width / 2;
                y ??= box.y + box.height / 2;
            }
            if (action.action === 'down') { await page.mouse.move(x, y); await page.mouse.down(); }
            else if (action.action === 'move') await page.mouse.move(x, y, { steps: action.steps ?? 1 });
            else { await page.mouse.move(x, y); await page.mouse.up(); }
            break;
        }
        case 'press': await element.press(action.key); break;
        case 'type': await element.focus(); await page.keyboard.type(action.text); break;
        case 'files': {
            // Real paths drive Playwright through native browser file-chooser
            // IPC (DOM.setFileInputFiles / Page.setFileInputFiles) so the input
            // dispatches a real trusted `change` event; in-memory payloads would
            // fall back to a synthetic untrusted JS Event.
            const paths = action.files.length ? await stageFiles(action.files) : [];
            await element.setInputFiles(paths);
            break;
        }
        default: throw new Error(`Unknown trusted input ${JSON.stringify(action satisfies never)}`);
        }
    } finally {
        await handle.dispose();
    }
}

async function openTestPage(browser: Browser, test: BrowserTestFile, serve: Awaited<ReturnType<typeof fileServer>>, script: string) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
    let tempDir: string | null = null;
    let stagedBatch = 0;
    const cleanupFiles = async () => {
        const dir = tempDir;
        tempDir = null;
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    const stageFiles = async (files: StagedFileInput): Promise<string[]> => {
        tempDir ??= await mkdtemp(path.join(os.tmpdir(), 'bpb-browser-files-'));
        const batchDir = path.join(tempDir, String(stagedBatch++));
        await mkdir(batchDir, { recursive: true });
        const paths: string[] = [];
        for (const item of files) {
            if (!item.name || item.name === '.' || item.name === '..' || path.basename(item.name) !== item.name) {
                throw new Error(`Unsafe trusted file input name: ${JSON.stringify(item.name)}`);
            }
            const filePath = path.join(batchDir, item.name);
            await writeFile(filePath, item.text, 'utf8');
            if (item.size !== undefined) {
                if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > 128 * 1024 * 1024) {
                    throw new Error(`Invalid trusted file input size: ${item.size}`);
                }
                await truncate(filePath, item.size);
            }
            if (item.lastModified !== undefined) {
                const seconds = item.lastModified / 1000;
                await utimes(filePath, seconds, seconds);
            }
            paths.push(filePath);
        }
        return paths;
    };
    const unexpected: string[] = [];
    let runnerPage: Page | null = null;
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const request = route.request();
        const sameSite = url.protocol === new URL(test.origin).protocol && siteOf(url.hostname) === siteOf(new URL(test.origin).hostname);
        // Fixture frames (FixtureDom.open) and same-site child iframes navigate
        // to their URL and receive an empty document. Relax document.domain
        // only when crossing origins on the site or after the test page has
        // already relaxed it; setting document.domain on a same-origin child
        // frame while the parent stays unrelaxed makes the child cross-origin.
        const fixtureFrame = request.isNavigationRequest() && request.frame() !== request.frame().page().mainFrame() && sameSite
            && url.pathname !== RUNNER_PATH && !url.pathname.startsWith(`${FILE_ROUTE}/`) && !url.pathname.startsWith('/dist/');
        if (fixtureFrame) {
            // FixtureDom.open announces each navigation it starts; any other
            // fixture-frame navigation comes from the page under test.
            const state = await (runnerPage ?? request.frame().page()).mainFrame().evaluate(href => {
                const win = globalThis as { __bpbFixtureNavigations?: string[]; __bpbRelaxedDomain?: boolean };
                const list = win.__bpbFixtureNavigations ?? [];
                const index = list.indexOf(href);
                if (index >= 0) list.splice(index, 1);
                return { announced: index >= 0, relaxed: Boolean(win.__bpbRelaxedDomain) };
            }, url.href.split('#')[0]!).catch(() => ({ announced: false, relaxed: false }));
            if (!state.announced) unexpected.push(`navigated ${url.origin}${url.pathname}`);
            const relaxScript = url.origin !== test.origin || state.relaxed
                ? `<script nonce="${FIXTURE_NONCE}">document.domain = ${JSON.stringify(siteOf(url.hostname))};</script>`
                : '';
            return route.fulfill({ status: 200, contentType: 'text/html', headers: runnerHeaders,
                body: `<!doctype html>${relaxScript}` });
        }
        if (url.origin !== test.origin) {
            unexpected.push(`aborted ${url.origin}${url.pathname}`);
            return route.abort();
        }
        if (url.pathname === RUNNER_PATH) {
            // Origin-keyed agent clusters would disable document.domain.
            return route.fulfill({ status: 200, contentType: 'text/html', headers: runnerHeaders,
                body: '<!doctype html><meta charset="utf-8"><title>Browser test</title><body></body>' });
        }
        if (url.pathname === RUNNER_SCRIPT) return route.fulfill({ status: 200, contentType: 'text/javascript', body: script });
        const file = url.pathname.startsWith(`${FILE_ROUTE}/`) ? url.pathname.slice(FILE_ROUTE.length)
            : url.pathname.startsWith('/dist/') ? path.join(projectRoot, url.pathname) : null;
        const body = file && await serve(file);
        if (body) return route.fulfill({ status: 200, body, contentType: fixtureContentType(file!) });
        // A packaged page (options/options.html) loads its own assets from the
        // build, as in the extension; other documents get no such fallback.
        const requester = request.frame().url();
        const fromPackagedPage = !file && /\.html$/.test(new URL(requester, test.origin).pathname)
            && !!await serve(path.join(projectRoot, 'dist', decodeURIComponent(new URL(requester, test.origin).pathname)));
        const packaged = fromPackagedPage && await serve(path.join(projectRoot, 'dist', decodeURIComponent(url.pathname)));
        if (packaged) return route.fulfill({ status: 200, body: packaged, contentType: fixtureContentType(url.pathname) });
        unexpected.push(`missing ${url.pathname}`);
        return route.fulfill({ status: 404, body: 'Not a browser test file' });
    });
    const pageErrors: string[] = [];
    const attached = new WeakSet<Page>();
    const attachPageListeners = (target: Page) => {
        if (attached.has(target)) return;
        attached.add(target);
        target.setDefaultTimeout(10_000);
        target.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
        // A native dialog would block the page; tests stub alert/confirm, so any
        // that reaches the browser fails the file.
        target.on('dialog', dialog => {
            pageErrors.push(`unexpected ${dialog.type()} dialog: ${dialog.message()}`);
            void dialog.dismiss().catch(() => {});
        });
        // Set BPB_BROWSER_TEST_CONSOLE=1 to follow a test's console while debugging it.
        if (process.env.BPB_BROWSER_TEST_CONSOLE === '1') target.on('console', message => console.error(`[${test.file}] ${message.type()}: ${message.text()}`));
    };
    context.on('page', attachPageListeners);
    const page = await context.newPage();
    runnerPage = page;
    attachPageListeners(page);
    await page.exposeBinding('__bpbTrustedInput', (_source, action: TrustedAction) => performTrustedInput(page, action, stageFiles));
    try {
        await page.goto(new URL(RUNNER_PATH, test.origin).href, { waitUntil: 'load' });
        // A module script, so test files may use top-level await; it publishes
        // the runner entry point once every top-level statement has finished.
        // A test file that throws while loading reports a page error instead;
        // listen before the module can evaluate.
        const failed = new Promise<never>((_, reject) => page.once('pageerror', error => reject(new Error(`${test.file} failed to load: ${error.message}`, { cause: error }))));
        failed.catch(() => {});
        await Promise.race([page.addScriptTag({ url: RUNNER_SCRIPT, type: 'module' }), failed]);
        const loaded = page.waitForFunction(() => '__bpbRunBrowserTests' in globalThis, null, { timeout: 60_000 });
        await Promise.race([loaded, failed]);
        return { context, page, pageErrors, unexpected, cleanupFiles };
    } catch (error) {
        await context.close().catch(() => {});
        await cleanupFiles();
        throw error;
    }
}

export async function runBrowserTests(selection: DomSelection, report: (record: Record<string, unknown>) => void,
    files?: readonly BrowserTestFile[]): Promise<number> {
    const discovered = files ?? await findBrowserTests();
    const selected = discovered.filter(test => !selection.suite || test.file.includes(selection.suite));
    if (!selected.length) return 0;
    const serve = await fileServer(selection.dist);
    const scripts = new Map<string, string>();
    for (const test of selected) scripts.set(test.file, await bundleBrowserTest(test.file));
    const resources = createResourceStack();
    let failure: unknown = null, executed = 0;
    try {
        for (const engine of selection.engines as DomEngine[]) {
            if (engine === 'chrome') assertChromeLaunchAllowed();
            const browser = await (engine === 'chrome'
                ? chromium.launch({ channel: 'chromium', headless: true })
                : firefox.launch({ headless: true }));
            resources.defer(`${engine} browser test browser`, () => browser.close());
            for (const test of selected) {
                let context: BrowserContext | null = null;
                let cleanupFiles: (() => Promise<void>) | null = null;
                try {
                    const opened = await openTestPage(browser, test, serve, scripts.get(test.file)!);
                    context = opened.context;
                    cleanupFiles = opened.cleanupFiles;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const results = await Promise.race([opened.page.evaluate(filter =>
                        (globalThis as unknown as { __bpbRunBrowserTests(filter: string | null): Promise<BrowserTestRecord[]> })
                            .__bpbRunBrowserTests(filter), selection.filter),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${engine} ${test.file} did not finish in ${RUN_TIMEOUT_MS} ms`)), RUN_TIMEOUT_MS); }),
                    ]).finally(() => clearTimeout(timer));
                    for (const record of results) {
                        report({ tier: 'browser-test', engine, version: browser.version(), hidden: true, file: test.file,
                            case: record.name, viewport: { width: 1000, height: 760 }, durationMs: record.durationMs, result: record.result,
                            ...(record.error ? { error: record.error } : {}) });
                    }
                    // Requests no route served: fixture assets (images, page
                    // scripts) are expected; a missing built file is a broken run.
                    const violations = await opened.page.evaluate(() => (globalThis as { __bpbCspViolations?: string[] }).__bpbCspViolations ?? []);
                    if (opened.unexpected.length || violations.length) {
                        report({ tier: 'browser-test', engine, file: test.file, unservedRequests: [...new Set(opened.unexpected)],
                            blockedByFixtureCsp: [...new Set(violations)] });
                    }
                    assert.deepEqual(opened.unexpected.filter(entry => entry.startsWith('missing /dist/')), [], `${engine} ${test.file}: missing built files`);
                    const failed = results.filter(record => record.result === 'failed');
                    assert.deepEqual(failed.map(record => record.name), [], `${engine} ${test.file}: failing tests`);
                    assert.deepEqual(opened.pageErrors, [], `${engine} ${test.file}: uncaught page errors`);
                    if (selection.filter === null) assert.ok(results.some(record => record.result === 'passed'), `${engine} ${test.file}: no test passed`);
                    executed += results.filter(record => record.result === 'passed').length;
                } finally {
                    await context?.close().catch(() => {});
                    await cleanupFiles?.();
                }
            }
            await browser.close();
        }
    } catch (error) { failure = error; }
    await resources.dispose(failure as null);
    if (selection.filter === null) assert.ok(executed > 0, 'browser tests must execute at least one case');
    return executed;
}

// Runner self-checks: each file must make the run fail. They prove that a
// failing assertion, an error in a fixture frame's handler, an unhandled
// rejection, a load failure, a file without tests and a hung hook are not
// reported as passing.
// Each check names the run's rejection and, where a test failed, the
// failure that must have caused it, so an unrelated setup error cannot count.
export const NEGATIVE_CHECKS: (BrowserTestFile & { reason: RegExp; cause: RegExp | null })[] = ([
    ['failing-assertion', /failing tests/, /deepStrictEqual failed/], ['frame-handler-error', /failing tests/, /handler failure/],
    ['unhandled-rejection', /failing tests/, /unhandled/], ['load-failure', /failed to load: .*load failure/, null],
    ['no-tests', /no test passed/, null], ['timeout', /failing tests/, /after hook timed out after 200 ms/],
] as const).map(([name, reason, cause]) => ({ file: `test/dom/runtime/negative/${name}.mts`, origin: DEFAULT_ORIGIN, reason, cause }));

export async function runNegativeChecks(selection: DomSelection, report: (record: Record<string, unknown>) => void): Promise<number> {
    let detected = 0;
    for (const { reason, cause, ...check } of NEGATIVE_CHECKS) {
        for (const engine of selection.engines) {
            const records: Record<string, unknown>[] = [];
            await assert.rejects(runBrowserTests({ ...selection, engines: [engine], suite: null, filter: null }, record => records.push(record), [check]),
                reason, `${engine} must reject the runner self-check ${check.file}`);
            const errors = records.flatMap(record => typeof record.error === 'string' ? [record.error] : []);
            if (cause) assert.ok(errors.length === 1 && cause.test(errors[0]!), `${engine} ${check.file} failed for another reason: ${errors.join(' | ')}`);
            report({ tier: 'browser-test-self-check', engine, file: check.file, result: 'rejected as required',
                errors: errors.map(error => error.split('\n')[0]) });
            detected++;
        }
    }
    return detected;
}
