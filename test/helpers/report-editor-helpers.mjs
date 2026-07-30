// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { accelerateTimeout, loadPage, waitFor, PAGE_FIXTURES } from './load-page.mjs';

const FIXTURE = 'climber-ascentedit.html';
const EDITOR_URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001';
const DRAFT_KEY = 'bpbReportDraft:900001:new';
const videoMarkup = (src, dimensions = '') => `[video src="${src}"${dimensions}`
    + ' controls preload="metadata" playsinline referrerpolicy="no-referrer"][/video]';
const youtubeMarkup = (src, dimensions = '') => `[iframe src="${src}"${dimensions}`
    + ' title="YouTube video" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"'
    + ' allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen][/iframe]';
// The ascentedit page loads the theme bundle (which carries settings) and,
// after the Markdown vendor script, the ascent-editor bundle (draft filling +
// report markup + editor). Mirror that so report-editor.js sees its settings.
const BUNDLES = [
    'content/theme.js',
    'vendor/marked.umd.js',
    'content/ascent-editor.js'
];

const loadEditor = async ({
    settings = {}, report = '', drafts = {}, url = EDITOR_URL, firefox = false,
    browserAlias = firefox, prepare = null, accelerateAutosave = false
} = {}) => {
    const dom = await loadPage(FIXTURE, {
        url,
        settings,
        bundles: BUNDLES,
        fixtures: PAGE_FIXTURES,
        prepare: d => {
            if (accelerateAutosave) d.autosaveDelays = accelerateTimeout(d, 800);
            d.window.document.getElementById('JournalText').value = report;
            Object.assign(d.chrome._localStore, drafts);
            d.chrome.runtime.getURL = path =>
                `${firefox ? 'moz-extension' : 'chrome-extension'}://test-extension/${path}`;
            if (browserAlias) d.window.browser = d.chrome;
            if (prepare) prepare(d);
        }
    });
    return dom;
};

const editorReady = async dom => {
    await waitFor(dom, () => dom.window.document.getElementById('bpb-report-editor'));
    return dom.window.document.getElementById('bpb-report-editor');
};

const editors = dom => dom.window.document.getElementById('bpb-report-editor')._bpbEditors;

// Replace the rich document as an *edit* (emitUpdate) so the dirty/sync path
// runs exactly as it does for typing.
const typeRich = (dom, html) => {
    editors(dom).rich.commands.setContent(html, { emitUpdate: true });
};

// Replace the markdown source through a CodeMirror transaction, the same
// dispatch typing goes through.
const typeMarkdown = (dom, text) => {
    const { view } = editors(dom).markdown;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};

const modeButton = (doc, label) =>
    [...doc.querySelectorAll('.bpb-re-mode')].find(button => button.textContent === label);

export {
    FIXTURE, EDITOR_URL, DRAFT_KEY, videoMarkup, youtubeMarkup, BUNDLES,
    loadEditor, editorReady, editors, typeRich, typeMarkdown, modeButton, waitFor
};
