/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-page browser tests' loader for the Peakbagger ascent editor with the
// trip-report editor bundles, and helpers that edit through the editors' own
// transaction paths.

import { accelerateTimeout, loadPage, waitFor, PAGE_FIXTURES, type LoadedPage } from './fixture-page.mts';

export { waitFor };

export const FIXTURE = 'climber-ascentedit.html';
export const EDITOR_URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001';
export const DRAFT_KEY = 'bpbReportDraft:900001:new';
export const videoMarkup = (src: string, dimensions = '') => `[video src="${src}"${dimensions}`
    + ' controls preload="metadata" playsinline referrerpolicy="no-referrer"][/video]';
export const youtubeMarkup = (src: string, dimensions = '') => `[iframe src="${src}"${dimensions}`
    + ' title="YouTube video" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"'
    + ' allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen][/iframe]';
// The ascentedit page loads the theme bundle (which carries settings) and,
// after the Markdown vendor script, the ascent-editor bundle (draft filling +
// report markup + editor). Mirror that so report-editor.js sees its settings.
export const BUNDLES = [
    'content/theme.js',
    'vendor/marked.umd.js',
    'content/ascent-editor.js',
];

export interface EditorPage extends LoadedPage {
    autosaveDelays?: number[];
}

export interface LoadEditorOptions {
    settings?: Record<string, unknown>;
    report?: string;
    drafts?: Record<string, unknown>;
    url?: string;
    firefox?: boolean;
    browserAlias?: boolean;
    prepare?: ((dom: EditorPage) => void) | null;
    accelerateAutosave?: boolean;
}

export const loadEditor = async ({
    settings = {}, report = '', drafts = {}, url = EDITOR_URL, firefox = false,
    browserAlias = firefox, prepare = null, accelerateAutosave = false,
}: LoadEditorOptions = {}): Promise<EditorPage> => loadPage(FIXTURE, {
    url,
    settings,
    bundles: BUNDLES,
    fixtures: PAGE_FIXTURES,
    prepare: (page: EditorPage) => {
        if (accelerateAutosave) page.autosaveDelays = accelerateTimeout(page, 800);
        page.window.document.getElementById('JournalText').value = report;
        Object.assign(page.chrome._localStore, drafts);
        page.chrome.runtime.getURL = path =>
            `${firefox ? 'moz-extension' : 'chrome-extension'}://test-extension/${path}`;
        if (browserAlias) (page.window as { browser?: unknown }).browser = page.chrome;
        if (prepare) prepare(page);
    },
});

export const editorReady = async (dom: LoadedPage) => {
    await waitFor(dom, () => dom.window.document.getElementById('bpb-report-editor'));
    return dom.window.document.getElementById('bpb-report-editor');
};

// The live editor instances the report editor publishes on its root for tests.
export interface ReportEditors {
    rich: { commands: { setContent(html: string, options: { emitUpdate: boolean }): unknown }; [member: string]: unknown };
    markdown: { view: { state: { doc: { length: number; toString(): string } }; dispatch(transaction: unknown): void }; [member: string]: unknown };
    [member: string]: unknown;
}
export const editors = (dom: LoadedPage) =>
    (dom.window.document.getElementById('bpb-report-editor') as unknown as { _bpbEditors: ReportEditors })._bpbEditors;

// Replace the rich document as an *edit* (emitUpdate) so the dirty/sync path
// runs exactly as it does for typing.
export const typeRich = (dom: LoadedPage, html: string) => {
    editors(dom).rich.commands.setContent(html, { emitUpdate: true });
};

// Replace the markdown source through a CodeMirror transaction, the same
// dispatch typing goes through.
export const typeMarkdown = (dom: LoadedPage, text: string) => {
    const { view } = editors(dom).markdown;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};

export const modeButton = (doc: ParentNode, label: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>('.bpb-re-mode')].find(button => button.textContent === label);
