// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The trip-report editor's contract, exercised against the captured ascent
// editor page: the native JournalText textarea stays the submitted source of
// truth (synced live, flushed before any submit/postback), drafts autosave to
// extension-local storage and are offered — never silently applied — and
// 'plain' mode hands back the untouched native form. Formatting commands go
// through execCommand, which jsdom lacks; those are covered by the
// real-browser check in scripts/verify-extension.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, waitFor, PAGE_FIXTURES } from './helpers/load-page.mjs';

const FIXTURE = 'climber-ascentedit.html';
const URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001';
const DRAFT_KEY = 'bpbReportDraft:900001:new';
const SCRIPTS = [
    'src/settings-schema.js',
    'src/settings.js',
    'vendor/marked.umd.js',
    'src/report-markup.js',
    'src/report-editor.js'
];

const loadEditor = async ({ settings = {}, report = '', drafts = {}, url = URL } = {}) => {
    const dom = await loadPage(FIXTURE, {
        url,
        settings,
        scripts: SCRIPTS,
        fixtures: PAGE_FIXTURES,
        prepare: d => {
            d.window.document.getElementById('JournalText').value = report;
            Object.assign(d.chrome._localStore, drafts);
        }
    });
    return dom;
};

const editorReady = async dom => {
    await waitFor(dom, () => dom.window.document.getElementById('bpb-report-editor'));
    return dom.window.document.getElementById('bpb-report-editor');
};

const typeRich = (dom, html) => {
    const surface = dom.window.document.querySelector('.bpb-re-surface');
    surface.innerHTML = html;
    surface.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return surface;
};

test('the editor mounts on the ascent form and hides the native textarea', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    assert.equal(ui.dataset.mode, 'rich');
    const textarea = doc.getElementById('JournalText');
    assert.ok(textarea.classList.contains('bpb-re-hidden'), 'native textarea should be hidden');
    assert.ok(textarea.form, 'textarea must stay inside the form it submits with');

    // The site's bracket-syntax hint is superseded while the editor is active.
    const hints = [...doc.querySelectorAll('span')].find(s => /Hints:/.test(s.textContent));
    assert.ok(hints.classList.contains('bpb-re-hidden'), 'native hints should be hidden');

    const blockStyle = ui.querySelector('.bpb-re-format');
    assert.deepEqual([...blockStyle.options].map(option => option.textContent), [
        'Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4',
        'Heading 5', 'Heading 6', 'Quote', 'Preformatted'
    ]);
    assert.ok(ui.querySelector('[aria-label="Strikethrough"]'));
    assert.ok(ui.querySelector('[aria-label="Horizontal rule"]'));
});

test('rich edits sync into the hidden textarea as bracket markup', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p>Summit day was <b>windy</b> and <i>cold</i>.</p><ul><li>axe</li><li>rope</li></ul>');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[b]'));
    assert.equal(doc.getElementById('JournalText').value,
        'Summit day was [b]windy[/b] and [i]cold[/i].\n\n[ul][li]axe[/li][li]rope[/li][/ul]');
});

test('an existing bracket report renders into the rich editor', async () => {
    const dom = await loadEditor({ report: 'Went [b]up high[/b].\r\n\r\n- snow to 6k' });
    await editorReady(dom);
    const surface = dom.window.document.querySelector('.bpb-re-surface');
    assert.equal(surface.innerHTML, '<p>Went <b>up high</b>.</p><ul><li>snow to 6k</li></ul>');
});

test('a pending rich edit is flushed synchronously when any submit control is clicked', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    // Type and immediately click GPS Preview — inside the debounce window.
    typeRich(dom, '<p>typed right before preview</p>');
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value, 'typed right before preview');
});

test('markdown mode converts to bracket markup and its preview shows the final rendering', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    const markdownButton = [...doc.querySelectorAll('.bpb-re-mode')].find(b => b.textContent === 'Markdown');
    markdownButton.click();

    const mdArea = doc.querySelector('.bpb-re-md');
    assert.equal(mdArea.hidden, false);
    mdArea.value = '# Day 1\n\nWe went **up**.\n\n- tent\n- stove';
    mdArea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[h1]Day 1[/h1]'));
    assert.equal(doc.getElementById('JournalText').value,
        '[h1]Day 1[/h1]\n\nWe went [b]up[/b].\n\n[ul][li]tent[/li][li]stove[/li][/ul]');

    const previewButton = [...doc.querySelectorAll('.bpb-re-tab')].find(b => b.textContent === 'Preview');
    previewButton.click();
    const preview = doc.querySelector('.bpb-re-preview');
    assert.equal(preview.hidden, false);
    assert.match(preview.innerHTML, /<h1>Day 1<\/h1>/);
    assert.match(preview.innerHTML, /<li>tent<\/li>/);

    // The chosen mode is remembered for next time.
    assert.equal(dom.chrome._store.bpbSettings.reportEditorMode, 'markdown');
});

test('switching rich → markdown → rich keeps the content through the canonical form', async () => {
    const dom = await loadEditor({ report: 'A [b]bold[/b] start.' });
    await editorReady(dom);
    const doc = dom.window.document;
    const modeButton = label => [...doc.querySelectorAll('.bpb-re-mode')].find(b => b.textContent === label);

    modeButton('Markdown').click();
    assert.equal(doc.querySelector('.bpb-re-md').value, 'A **bold** start.');

    modeButton('Rich text').click();
    assert.equal(doc.querySelector('.bpb-re-surface').innerHTML, '<p>A <b>bold</b> start.</p>');
    assert.equal(doc.getElementById('JournalText').value, 'A [b]bold[/b] start.');
});

test('expanded rich DOM syncs headings, quotes, tables, code, rules, and images', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<h2>Route</h2><blockquote><p>Windy <s>retreat</s></p></blockquote>'
        + '<table><thead><tr><th>Peak</th></tr></thead><tbody><tr><td>Baker</td></tr></tbody></table>'
        + '<pre><code>two   spaces\nnew line</code></pre><hr>'
        + '<p><img src="https://example.com/map.jpg" alt="Topo" width="120"></p>');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[table'));
    assert.equal(doc.getElementById('JournalText').value, [
        '[h2]Route[/h2]',
        '',
        '[blockquote]Windy [s]retreat[/s][/blockquote]',
        '',
        '[table border="1"][tr][th]Peak[/th][/tr][tr][td]Baker[/td][/tr][/table]',
        '',
        '[pre]two   spaces\nnew line[/pre]',
        '',
        '[hr]',
        '',
        '[img src="https://example.com/map.jpg" alt="Topo" width="120"]'
    ].join('\n'));
});

test('plain mode is the untouched native textarea, hints restored', async () => {
    const dom = await loadEditor({ report: 'raw [whatever] text' });
    await editorReady(dom);
    const doc = dom.window.document;

    [...doc.querySelectorAll('.bpb-re-mode')].find(b => b.textContent === 'Plain').click();
    const textarea = doc.getElementById('JournalText');
    assert.equal(textarea.classList.contains('bpb-re-hidden'), false);
    assert.equal(textarea.value, 'raw [whatever] text');
    const hints = [...doc.querySelectorAll('span')].find(s => /Hints:/.test(s.textContent));
    assert.equal(hints.classList.contains('bpb-re-hidden'), false);
});

test('visiting Markdown mode does not rewrite an untouched server report', async () => {
    const report = '[iframe src="https://example.com"][/iframe]';
    const dom = await loadEditor({ report });
    await editorReady(dom);
    const doc = dom.window.document;
    const mode = label => [...doc.querySelectorAll('.bpb-re-mode')].find(button => button.textContent === label);

    mode('Markdown').click();
    mode('Plain').click();
    assert.equal(doc.getElementById('JournalText').value, report);
});

test('editing in rich mode neutralizes unsupported embed markup before submission', async () => {
    const dom = await loadEditor({ report: '[iframe src="https://example.com"][/iframe]' });
    await editorReady(dom);
    const doc = dom.window.document;
    const surface = doc.querySelector('.bpb-re-surface');
    surface.append(' edited');
    surface.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await waitFor(dom, () => /edited/.test(doc.getElementById('JournalText').value));
    const submitted = doc.getElementById('JournalText').value;
    assert.doesNotMatch(submitted, /\[iframe\b/i);
    assert.match(submitted, /&#91;iframe/);
});

test('edits autosave a local draft keyed to this climber and form', async () => {
    const dom = await loadEditor();
    await editorReady(dom);

    typeRich(dom, '<p>autosave me</p>');
    await waitFor(dom, () => dom.chrome._localStore[DRAFT_KEY]);
    const draft = dom.chrome._localStore[DRAFT_KEY];
    assert.equal(draft.text, 'autosave me');
    assert.equal(draft.mode, 'rich');
    assert.equal(typeof draft.savedAt, 'number');
    assert.match(dom.window.document.querySelector('.bpb-re-status').textContent,
        /Draft saved on this device/);
});

test('a differing stored draft is offered, and Restore applies it in its saved mode', async () => {
    const dom = await loadEditor({
        report: 'server copy',
        drafts: {
            [DRAFT_KEY]: {
                text: 'draft copy with **md**',
                source: 'draft copy with **md**',
                mode: 'markdown',
                savedAt: Date.now() - 60000
            }
        }
    });
    await editorReady(dom);
    const doc = dom.window.document;

    const draftBar = doc.querySelector('.bpb-re-draft');
    assert.equal(draftBar.hidden, false, 'the draft offer should be visible');

    [...draftBar.querySelectorAll('button')].find(b => b.textContent === 'Restore draft').click();
    assert.equal(doc.getElementById('bpb-report-editor').dataset.mode, 'markdown');
    assert.equal(doc.querySelector('.bpb-re-md').value, 'draft copy with **md**');
    assert.equal(doc.getElementById('JournalText').value, 'draft copy with **md**');
});

test('Delete draft removes it without touching the form content', async () => {
    const dom = await loadEditor({
        report: 'server copy',
        drafts: { [DRAFT_KEY]: { text: 'stale draft', mode: 'rich', savedAt: Date.now() - 1000 } }
    });
    await editorReady(dom);
    const doc = dom.window.document;

    const draftBar = doc.querySelector('.bpb-re-draft');
    [...draftBar.querySelectorAll('button')].find(b => b.textContent === 'Delete draft').click();
    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    assert.equal(draftBar.hidden, true);
    assert.equal(doc.getElementById('JournalText').value, 'server copy');
});

test('a draft equal to the server copy is not offered; its markdown source is adopted', async () => {
    const dom = await loadEditor({
        report: 'Same [b]content[/b].\r\n\r\n- item',   // server echo with CRLF
        drafts: {
            [DRAFT_KEY]: {
                text: 'Same [b]content[/b].\n\n- item',
                source: 'Same **content**.\n\n- item',
                mode: 'markdown',
                savedAt: Date.now() - 1000
            }
        }
    });
    await editorReady(dom);
    const doc = dom.window.document;
    assert.equal(doc.querySelector('.bpb-re-draft').hidden, true);

    [...doc.querySelectorAll('.bpb-re-mode')].find(b => b.textContent === 'Markdown').click();
    assert.equal(doc.querySelector('.bpb-re-md').value, 'Same **content**.\n\n- item');
});

test('clicking Save Ascent clears the draft', async () => {
    const dom = await loadEditor({
        drafts: { [DRAFT_KEY]: { text: 'about to be saved', mode: 'rich', savedAt: Date.now() } }
    });
    await editorReady(dom);
    dom.window.document.getElementById('SaveButton').click();
    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
});

test('expired and excess drafts are pruned, current key kept', async () => {
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const dom = await loadEditor({
        drafts: {
            'bpbReportDraft:900001:a1': { text: 'ancient', mode: 'rich', savedAt: old },
            'bpbReportDraft:900001:a2': { text: 'recent other', mode: 'rich', savedAt: Date.now() - 5000 }
        }
    });
    await editorReady(dom);
    await waitFor(dom, () => !dom.chrome._localStore['bpbReportDraft:900001:a1']);
    assert.ok(dom.chrome._localStore['bpbReportDraft:900001:a2'], 'fresh drafts must survive pruning');
});

test('the editor stays out of the way when disabled in settings', async () => {
    const dom = await loadEditor({ settings: { enableReportEditor: false } });
    await new Promise(resolve => setTimeout(resolve, 120));
    const doc = dom.window.document;
    assert.equal(doc.getElementById('bpb-report-editor'), null);
    assert.equal(doc.getElementById('JournalText').classList.contains('bpb-re-hidden'), false);
});

test('disabling the setting live hands the form back to the native textarea', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    const current = dom.chrome._store.bpbSettings || {};
    await dom.chrome.storage.sync.set({ bpbSettings: { ...current, enableReportEditor: false } });
    await waitFor(dom, () => !doc.getElementById('bpb-report-editor'));
    assert.equal(doc.getElementById('JournalText').classList.contains('bpb-re-hidden'), false);
});

test('draft keys distinguish editing an ascent from adding one', async () => {
    const dom = await loadEditor({
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?aid=123456&cid=900001'
    });
    await editorReady(dom);
    typeRich(dom, '<p>edit of an existing ascent</p>');
    await waitFor(dom, () => dom.chrome._localStore['bpbReportDraft:900001:a123456']);
});
