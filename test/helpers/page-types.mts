/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Structural types for tests that drive packaged pages in jsdom. The pages'
// markup is owned by this repository, so a lookup is typed as the union of the
// form and action elements the tests read; a test that needs one element's
// own API asks for it with `byId<T>()` instead of relying on the intersection.
// HTMLButtonElement is left out: its `type` conflicts with a select's and the
// intersection would collapse to never; buttons need nothing beyond these.

export type TestWindow = Window & typeof globalThis;

type ElementBase = HTMLElement & HTMLInputElement & HTMLSelectElement & HTMLDialogElement & HTMLAnchorElement;
// Lookups from a page element stay page elements. Like the document's, they
// are typed as present: a missing node fails the test at the lookup.
export interface PageElement extends Omit<ElementBase, 'querySelector' | 'querySelectorAll' | 'closest' | 'parentElement'> {
    querySelector(selectors: string): PageElement;
    querySelectorAll(selectors: string): NodeListOf<PageElement>;
    closest(selectors: string): PageElement | null;
    readonly parentElement: PageElement | null;
}

export interface PageDocument extends Omit<Document, 'getElementById' | 'querySelector' | 'querySelectorAll' | 'activeElement'> {
    getElementById(id: string): PageElement;
    querySelector(selectors: string): PageElement;
    querySelectorAll(selectors: string): NodeListOf<PageElement>;
    // A loaded page always has a focused element, the body at least.
    readonly activeElement: PageElement;
}

export interface PageDom {
    window: Omit<TestWindow, 'document'> & { document: PageDocument };
    chrome: ChromeStub;
}

// What a test's stubbed extension API receives. Fields beyond the route name
// are read as each test expects them, so they stay unknown until narrowed.
export interface StubMessage {
    type?: string;
    action?: string;
    key?: string;
    [field: string]: unknown;
}

export interface StubArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
}

// A record a test reads back from stub storage. The fields are the ones these
// tests assert on; a record without them fails the assertion, not the types.
export interface StoredRecord {
    text: string;
    entries: { cid: number; [field: string]: unknown }[];
    settings: Record<string, unknown>;
    deletedGeneration: string;
    storageGeneration: string;
    [field: string]: unknown;
}

export interface ChromeStub {
    runtime: {
        id?: string;
        sendMessage: (message: StubMessage, ...rest: unknown[]) => unknown;
        [member: string]: unknown;
    };
    permissions?: {
        contains?: (request: object) => unknown;
        request?: (request: object) => unknown;
        remove?: (request: object) => unknown;
        [member: string]: unknown;
    };
    storage: { local: StubArea; sync: StubArea; session?: StubArea; [member: string]: unknown };
    tabs?: Record<string, unknown>;
    _localStore: Record<string, StoredRecord>;
    _store: Record<string, StoredRecord>;
    [member: string]: unknown;
}

export const byId = <T extends HTMLElement = HTMLElement>(doc: Pick<Document, 'getElementById'>, id: string) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`#${id} is missing`);
    return element as T;
};

// The JavaScript helpers infer their option bags from defaults; these are
// the contracts the TypeScript tests rely on.
export interface PageLoadOptions {
    prepareChrome?: (chrome: ChromeStub) => void;
    prepare?: (dom: PageDom) => void;
    local?: Record<string, unknown>;
    [option: string]: unknown;
}
export type LoadPage = (settings?: Record<string, unknown>, options?: PageLoadOptions) => Promise<PageDom>;
export type WaitFor = (dom: { window: unknown }, condition: () => unknown, timeoutMs?: number) => Promise<void>;
