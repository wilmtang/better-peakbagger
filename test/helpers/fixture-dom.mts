/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A fixture document in a real browser window, for in-page browser tests
// (`*.browser.mts`). Each FixtureDom is a same-origin iframe with its own
// realm, like a separate page: the fixture markup is parsed with scripting
// disabled, so its inline scripts stay inert, and the test evaluates built
// bundles into it. Its URL is set with history.replaceState, so it must share
// the test page's origin; a file that needs another origin declares it with a
// `// @browser-origin https://host` header.

import { fixtureWindows } from '../dom/runtime/fixture-registry.mts';
import type { PageDocument, TestWindow } from './page-types.mts';

export interface FixtureDomOptions {
    url?: string;
    // 'text/html' (the default) or an XML type for an XML document.
    contentType?: string;
    // Inline scripts in the markup run only when this is 'dangerously'.
    runScripts?: 'outside-only' | 'dangerously';
    // A top-level page (a same-origin popup) instead of a frame, for owners
    // that check window.top, window.parent or frameElement.
    topLevel?: boolean;
    // The frame's layout viewport.
    width?: number;
    height?: number;
}

// Lookups in this repository's own fixture markup are typed as present (see
// page-types.mts): a missing node fails the test at the lookup. `chrome` is
// whatever stub the test installs.
export type FixtureWindow = Omit<TestWindow, 'document' | 'chrome'> & { document: PageDocument; chrome?: unknown };

// Matches the runner's CSP nonce (scripts/browser-tests.mts).
export const FIXTURE_SCRIPT_NONCE = 'bpb-fixture';

let stacking = 1;
let relaxedDomain = false;

// The registrable part of a fixture host, for document.domain relaxation.
const siteOf = (hostname: string) => hostname.split('.').slice(-2).join('.');

function createFrame(width: number, height: number) {
    const frame = document.createElement('iframe');
    frame.dataset.bpbFixture = String(stacking);
    frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;background:#fff;z-index:${stacking++}`;
    return frame;
}

export class FixtureDom {
    readonly window: FixtureWindow;
    readonly #frame: HTMLIFrameElement | null;
    #closePage: (() => void) | null = null;

    // A fixture on the test page's origin, ready synchronously.
    constructor(html = '', options: FixtureDomOptions = {}, frame?: HTMLIFrameElement) {
        const { url, width = 1000, height = 760 } = options;
        const target = url ? new URL(url, location.href) : null;
        if (!frame && target && target.origin !== location.origin) {
            throw new Error(`Fixture URL ${target.href} is not on the test page origin ${location.origin}; `
                + (options.topLevel
                    ? `declare // @browser-origin ${target.origin}`
                    : `use await FixtureDom.open() for a same-site host or declare // @browser-origin ${target.origin}`));
        }
        let opened: Window | null = null;
        if (options.topLevel) {
            // Firefox fixes an about:blank page's base URL from the page that
            // creates it, so open it at the fixture URL.
            withRunnerAt(target, () => { opened = window.open('', `bpb-fixture-${stacking++}`, `popup,width=${width},height=${height}`); });
            if (!opened) throw new Error('The browser refused to open a top-level fixture page.');
        } else if (!frame) {
            frame = createFrame(width, height);
            // Firefox fixes an about:blank frame's base URL from the page
            // that creates it, so create it at the fixture URL too.
            withRunnerAt(target, () => document.body.append(frame!));
        }
        const fixtureWindow = (opened ?? frame!.contentWindow) as FixtureWindow | null;
        if (!fixtureWindow) throw new Error('The fixture frame has no window.');
        this.#frame = frame ?? null;
        this.window = fixtureWindow;
        const window_ = fixtureWindow;
        populate(window_, html, options, !!frame?.src, target);
        // Chromium drops the fragment when document.open() copies the URL.
        if (target && window_.location.href !== target.href) window_.history.replaceState(null, '', target.href);
        // Like jsdom's window.close(): the test is done with this page.
        const closePage = opened ? (opened as Window).close.bind(opened) : null;
        this.#closePage = closePage;
        Object.defineProperty(window_, 'close', { configurable: true, value: () => this.close() });
        focusLikeActiveTab(window_);
        if (!options.topLevel) ignoreInitialResize(window_, width, height);
        // A tab's page has focus before its scripts run.
        if (!options.topLevel) window_.focus();
        fixtureWindows.add(window_ as unknown as Window, () => this.close());
    }

    // A fixture document the frame really navigated to: its URL, base URL and
    // CSP 'self' are the fixture's own, as for a loaded page. Any URL on the
    // test page's site works, for example peakbagger.com beside
    // www.peakbagger.com: for another origin both documents relax
    // document.domain to the site, so the test still reaches the fixture
    // synchronously once this resolves.
    static async open(html = '', options: FixtureDomOptions = {}): Promise<FixtureDom> {
        const target = options.url ? new URL(options.url, location.href) : null;
        if (!target || options.topLevel) return new FixtureDom(html, options);
        const site = siteOf(location.hostname);
        if (target.protocol !== location.protocol || siteOf(target.hostname) !== site) {
            throw new Error(`Fixture URL ${target.href} is not on the test page site ${site}; declare // @browser-origin ${target.origin}`);
        }
        // Relax document.domain only when opening a different origin on the
        // same site; keeping same-origin runs unrelaxed avoids breaking
        // same-origin child iframes inside synchronous FixtureDom windows.
        if (target.origin !== location.origin && !relaxedDomain) {
            document.domain = site;
            relaxedDomain = true;
            (globalThis as { __bpbRelaxedDomain?: boolean }).__bpbRelaxedDomain = true;
        }
        const frame = createFrame(options.width ?? 1000, options.height ?? 760);
        // The runner serves exactly the navigations FixtureDom announces and
        // reports any other fixture-frame navigation as page behavior.
        const expected = ((globalThis as { __bpbFixtureNavigations?: string[] }).__bpbFixtureNavigations ??= []);
        expected.push(target.href.split('#')[0]!);
        const loaded = new Promise<void>((resolve, reject) => {
            frame.addEventListener('load', () => resolve(), { once: true });
            frame.addEventListener('error', () => reject(new Error(`Unable to load fixture frame ${target.href}`)), { once: true });
        });
        frame.src = target.href;
        document.body.append(frame);
        await loaded;
        return new FixtureDom(html, options, frame);
    }

    serialize(): string {
        const doctype = this.window.document.doctype;
        return `${doctype ? `<!DOCTYPE ${doctype.name}>` : ''}${this.window.document.documentElement.outerHTML}`;
    }

    close() {
        fixtureWindows.delete(this.window as unknown as Window);
        this.#frame?.remove();
        const closePage = this.#closePage;
        this.#closePage = null;
        closePage?.();
    }
}

// A fixture stands in for the page in the user's focused tab: focusing one
// of its elements first gives its frame focus, which a browser otherwise
// withholds from a frame that was never focused.
function focusLikeActiveTab(target: FixtureWindow) {
    for (const prototype of [target.HTMLElement.prototype, target.SVGElement.prototype]) {
        const focus = prototype.focus;
        Object.defineProperty(prototype, 'focus', {
            configurable: true, writable: true,
            value(this: HTMLElement, options?: FocusOptions) {
                if (!target.document.hasFocus()) target.focus();
                return focus.call(this, options);
            },
        });
    }
}

// Chromium dispatches a resize when a new frame first takes its configured
// size; a tab's page never sees that. Stop that one browser event before page
// code listening for resize can treat it as the user resizing the window. It
// may arrive after a test has started, so a test's own synthetic resize
// passes through untouched.
function ignoreInitialResize(target: FixtureWindow, width: number, height: number) {
    const initial = (event: Event) => {
        if (!event.isTrusted) return;
        target.removeEventListener('resize', initial, true);
        if (target.innerWidth === width && target.innerHeight === height) event.stopImmediatePropagation();
    };
    target.addEventListener('resize', initial, true);
}

// document.open() gives a frame document the URL of the page calling it.
// Moving the test page to the fixture URL for that call gives the frame its
// URL and base URL natively; Firefox keeps an earlier base URL after
// history.replaceState in the frame.
function withRunnerAt(target: URL | null, work: () => void) {
    const runner = location.href;
    if (target && target.href !== runner) history.replaceState(history.state, '', target.href);
    try { work(); } finally {
        if (location.href !== runner) history.replaceState(history.state, '', runner);
    }
}

function openAt(document_: Document, target: URL | null, write: () => void) {
    withRunnerAt(target, () => {
        document_.open();
        write();
        document_.close();
    });
}

function populate(window: FixtureWindow, html: string, { contentType = 'text/html', runScripts = 'outside-only' }: FixtureDomOptions,
    loaded: boolean, target: URL | null) {
    const xml = /\bxml\b/.test(contentType);
    const parsed = new window.DOMParser().parseFromString(html, xml ? contentType as DOMParserSupportedType : 'text/html');
    const document_ = window.document;
    if (runScripts === 'dangerously' && !xml) {
        if (loaded) throw new Error('A same-site fixture cannot run inline scripts.');
        // The runner's CSP admits only scripts carrying its fixture nonce.
        const trusted = html.replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${FIXTURE_SCRIPT_NONCE}"`);
        openAt(document_, target, () => document_.write(trusted));
        return;
    }
    // A loaded same-site frame keeps its standards-mode document; an
    // about:blank frame is rewritten to match the source's rendering mode.
    if (!loaded) openAt(document_, target, () => document_.write(!xml && parsed.compatMode === 'CSS1Compat' ? '<!doctype html>' : ''));
    // Scripts parsed with scripting disabled are already started, so
    // adopting them into a live document does not run them.
    if (parsed.documentElement) document_.replaceChild(document_.adoptNode(parsed.documentElement), document_.documentElement);
}

export const fixtureDom = (html?: string, options?: FixtureDomOptions) => new FixtureDom(html, options);

// A fixture window is the global its bundles run against; this is the one
// place a test passes it where a browser global type is expected.
export const browserWindow = <W extends TestWindow = TestWindow>(window: FixtureWindow) => window as unknown as W;

// An https URL on the test page's origin that serves a checkout file, for
// fixtures that need a real resource to load (an image with real layout).
declare const __BPB_PROJECT_ROOT__: string;
export const checkoutFileUrl = (file: string) =>
    new URL(`/__bpb_fs__${`${__BPB_PROJECT_ROOT__}/${file}`.split('/').map(encodeURIComponent).join('/')}`, location.origin).href;

// Built extension files, as the test page's DOM tier route serves them.
export async function builtBundle(file: string): Promise<string> {
    const response = await fetch(`/dist/${file.split('/').map(encodeURIComponent).join('/')}`);
    if (!response.ok) throw new Error(`Missing built file dist/${file}: HTTP ${response.status}`);
    return response.text();
}

// Bundle a test harness entry (test/helpers/ or test/dom/runtime/) as a
// classic IIFE for FixtureDom evaluation without adding test-only exports to
// shipped bundles. Shipped code is tested through its dist/ bundle.
export async function iifeBundle(file: string, { globalName }: { globalName?: string } = {}): Promise<string> {
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    const query = globalName ? `?globalName=${encodeURIComponent(globalName)}` : '';
    const response = await fetch(`/__bpb_iife__/${encoded}${query}`);
    if (!response.ok) throw new Error(`Unable to bundle ${file}: HTTP ${response.status}`);
    return response.text();
}

// Evaluate built bundles into a fixture window, in order, as classic scripts.
// A page whose own CSP forbids eval (extension pages) loads the bundle as a
// same-origin script element instead, as the page itself does.
export async function evalBundle(target: { eval(source: string): unknown; document?: Document }, ...bundles: string[]): Promise<void> {
    for (const bundle of bundles) {
        const source = await builtBundle(bundle);
        try {
            target.eval(source);
        } catch (error) {
            if ((error as Error)?.name !== 'EvalError' || !target.document) throw error;
            await loadScript(target.document, bundle);
        }
    }
}

async function loadScript(document_: Document, bundle: string) {
    const script = document_.createElement('script');
    script.src = `/dist/${bundle.split('/').map(encodeURIComponent).join('/')}`;
    const view = document_.defaultView!;
    let thrown: unknown = null;
    const onError = (event: ErrorEvent) => { thrown ??= event.error ?? new Error(event.message); };
    view.addEventListener('error', onError);
    try {
        await new Promise<void>((resolve, reject) => {
            script.addEventListener('load', () => resolve(), { once: true });
            script.addEventListener('error', () => reject(new Error(`Unable to load dist/${bundle} in the fixture page`)), { once: true });
            (document_.head ?? document_.documentElement).append(script);
        });
    } finally {
        view.removeEventListener('error', onError);
        script.remove();
    }
    if (thrown) throw thrown;
}

// Real input through the DOM tier's browser automation, so the page sees
// trusted events. The runner raises the element's fixture frame first.
// ControlOrMeta is Command on macOS, where a Control-click is a secondary
// click that dispatches no click event, and Control elsewhere.
export type TrustedModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';
export type TrustedAction =
    | { type: 'click' | 'dblclick'; button?: 'left' | 'middle' | 'right'; modifiers?: TrustedModifier[] }
    | { type: 'hover' | 'focus' }
    // Raw mouse input in the fixture frame's client coordinates (fixture
    // frames sit at the page origin). 'down' without a point presses at the
    // target's center.
    | { type: 'mouse'; action: 'down' | 'move' | 'up'; x?: number; y?: number; steps?: number }
    // A key or chord in Playwright's syntax, for example 'Shift+Enter'.
    | { type: 'press'; key: string }
    | { type: 'type'; text: string }
    | { type: 'files'; files: { name: string; mimeType?: string; text: string; size?: number; lastModified?: number }[] };

declare global {
    interface Window {
        __bpbTrustedInput?(action: TrustedAction): Promise<void>;
        __bpbTrustedTarget?: Element | null;
    }
}

export async function trustedInput(element: Element, action: TrustedAction): Promise<void> {
    const bridge = window.__bpbTrustedInput;
    if (!bridge) throw new Error('Trusted input requires the DOM tier runner.');
    // A user can only reach a node on the page; a stale reference to a
    // re-rendered node would otherwise land on whatever is at its old place.
    if (!element.isConnected) throw new Error('Trusted input target is not connected to its document.');
    const frame = element.ownerDocument === document ? null
        : [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-bpb-fixture]')]
            .find(item => item.contentDocument === element.ownerDocument) ?? null;
    const popup = !frame && element.ownerDocument !== document && element.ownerDocument.defaultView?.opener === window;
    if (element.ownerDocument !== document && !frame && !popup) throw new Error('Trusted input target is not in a fixture frame or page.');
    // Raise the target's frame above later fixtures so the input reaches it.
    if (frame) frame.style.zIndex = String(stacking++);
    // The runner reads the target from this page global rather than a marker
    // attribute, which a page observer could see.
    window.__bpbTrustedTarget = element;
    try {
        await bridge(action);
    } finally {
        window.__bpbTrustedTarget = null;
    }
}
