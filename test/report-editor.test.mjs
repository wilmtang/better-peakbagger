// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The trip-report editor's contract, exercised against the captured ascent
// editor page: the native JournalText textarea stays the submitted source of
// truth (synced live, flushed before any submit/postback), drafts autosave to
// extension-local storage and are offered — never silently applied — and
// 'plain' mode hands back the untouched native form. The rich surface is a
// TipTap editor and the Markdown pane is CodeMirror beside a live preview;
// jsdom drives both through the editor instances on the mount's _bpbEditors
// handle (real typing and keyboard shortcuts are covered by the real-browser
// check in scripts/verify-extension.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, waitFor, PAGE_FIXTURES } from './helpers/load-page.mjs';

const FIXTURE = 'climber-ascentedit.html';
const URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001';
const DRAFT_KEY = 'bpbReportDraft:900001:new';
const videoMarkup = (src, dimensions = '') => `[video src="${src}"${dimensions}`
    + ' controls preload="metadata" playsinline referrerpolicy="no-referrer"][/video]';
const youtubeMarkup = (src, dimensions = '') => `[iframe src="${src}"${dimensions}`
    + ' title="YouTube video" loading="lazy" referrerpolicy="no-referrer"'
    + ' allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen][/iframe]';
// The ascentedit page loads the theme bundle (which carries settings) and,
// after the Markdown vendor script, the ascent-editor bundle (draft filling +
// report markup + editor). Mirror that so report-editor.js sees its settings.
const BUNDLES = [
    'content/theme.js',
    'vendor/marked.umd.js',
    'content/ascent-editor.js'
];

const loadEditor = async ({ settings = {}, report = '', drafts = {}, url = URL, firefox = false, prepare = null } = {}) => {
    const dom = await loadPage(FIXTURE, {
        url,
        settings,
        bundles: BUNDLES,
        fixtures: PAGE_FIXTURES,
        prepare: d => {
            d.window.document.getElementById('JournalText').value = report;
            Object.assign(d.chrome._localStore, drafts);
            if (firefox) d.window.browser = d.chrome;
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
    for (const label of ['Strikethrough', 'Horizontal rule', 'Insert table', 'Insert image', 'Insert video',
        'More formats', 'Undo (Ctrl+Z)', 'Redo (Ctrl+Shift+Z)']) {
        assert.ok(ui.querySelector(`[aria-label="${label}"]`), `missing toolbar control: ${label}`);
    }
    assert.equal(ui.querySelector('.bpb-re-contextual')?.parentElement,
        ui.querySelector('.bpb-re-toolbar'),
        'contextual controls must stay in the toolbar layer, not in the writing surface flow');
    assert.equal(ui.querySelector('.bpb-re-draft')?.parentElement,
        ui.querySelector('.bpb-re-toolbar'),
        'the overlay boundary must include the draft-recovery bar');
    assert.ok(ui.querySelector('.bpb-re-surface'), 'the rich surface should be mounted');
    assert.equal(editors(dom).rich.getHTML(), '<p></p>',
        'an empty report must not become a hard break');
    const emptyParagraph = ui.querySelector('.bpb-re-surface p.is-editor-empty');
    assert.equal(emptyParagraph?.dataset.placeholder, 'Write your trip report…',
        'TipTap should recognize the empty document and expose its placeholder');
    assert.equal(ui.querySelector('[aria-label="Undo (Ctrl+Z)"]').disabled, true,
        'undo starts disabled with an empty history');
});

test('opt-in credit leaves blank writing space and links to the Chrome store', async () => {
    const dom = await loadEditor({ settings: { addReportCredit: true } });
    const ui = await editorReady(dom);
    const textarea = dom.window.document.getElementById('JournalText');
    const paragraphs = ui.querySelectorAll('.bpb-re-surface p');
    const credit = paragraphs[1];
    const link = credit.querySelector('a');

    assert.equal(paragraphs[0].textContent, '', 'the report should start with editable writing space');
    assert.equal(editors(dom).rich.state.selection.from, 1, 'the caret should begin before the credit');
    assert.ok(credit.querySelector('small'), 'the credit should read as a quiet footnote');
    assert.ok(credit.querySelector('em'), 'the credit should stay visually secondary');
    assert.equal(link.textContent, 'Better Peakbagger');
    assert.equal(link.href,
        'https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn');
    assert.equal(textarea.value,
        '[small][i]Created with [a href="https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn" target="_blank"]Better Peakbagger[/a].[/i][/small]');

    editors(dom).rich.commands.insertContent('Summit day.');
    await waitFor(dom, () => textarea.value.startsWith('Summit day.'));
    assert.match(textarea.value, /^Summit day\.\n\n.*Created with /s,
        'typing at the initial caret should keep the credit as a separate footnote');
    assert.match(textarea.value, /\[small\].*Better Peakbagger.*\[\/small\]/s);
});

test('opt-in credit links Firefox reports to Firefox Add-ons', async () => {
    const dom = await loadEditor({ settings: { addReportCredit: true }, firefox: true });
    const ui = await editorReady(dom);
    const link = ui.querySelector('.bpb-re-surface a');

    assert.equal(link.href, 'https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/');
});

test('opt-in credit starts after the caret in Markdown and Plain modes', async () => {
    const markdownDom = await loadEditor({
        settings: { addReportCredit: true, reportEditorMode: 'markdown' }
    });
    await editorReady(markdownDom);
    assert.ok(editors(markdownDom).markdown.getValue().startsWith('\n\n'));
    assert.match(editors(markdownDom).markdown.getValue(),
        /<small>\*Created with <a href="[^"]+" target="_blank">Better Peakbagger<\/a>\.\*<\/small>$/,
        'Markdown mode should expose portable HTML instead of Peakbagger bracket tags');
    assert.doesNotMatch(editors(markdownDom).markdown.getValue(), /\[(?:small|a)\b/i);
    assert.equal(editors(markdownDom).markdown.view.state.selection.main.head, 0);

    const plainDom = await loadEditor({
        settings: { addReportCredit: true, reportEditorMode: 'plain' }
    });
    await editorReady(plainDom);
    const textarea = plainDom.window.document.getElementById('JournalText');
    assert.ok(textarea.value.startsWith('\n\n'));
    assert.equal(textarea.selectionStart, 0);
});

test('opt-in credit never modifies a non-empty report', async () => {
    const dom = await loadEditor({
        settings: { addReportCredit: true },
        report: 'Existing trip report.'
    });
    await editorReady(dom);

    assert.equal(dom.window.document.getElementById('JournalText').value, 'Existing trip report.');
    assert.equal(editors(dom).rich.getHTML(), '<p>Existing trip report.</p>');
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
    // TipTap canonical form: strong for bold, list items wrap a paragraph,
    // and the trailing-node extension keeps a final empty paragraph so there
    // is always somewhere to click below block content (the converter drops
    // it on serialization).
    assert.equal(editors(dom).rich.getHTML(),
        '<p>Went <strong>up high</strong>.</p><ul><li><p>snow to 6k</p></li></ul><p></p>');
});

test('a pending rich edit is flushed synchronously when any submit control is clicked', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    // Edit and immediately click GPS Preview — inside the debounce window.
    typeRich(dom, '<p>typed right before preview</p>');
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value, 'typed right before preview');
});

test('backup snapshots are captured only for Save or implicit form submissions', async () => {
    const messages = [];
    const dom = await loadEditor({
        settings: { enableGithubBackup: true },
        prepare: d => {
            d.chrome.runtime.getManifest = () => ({ version: '1.2.3' });
            d.chrome.runtime.sendMessage = async message => { messages.push(message); };
        }
    });
    await editorReady(dom);
    const doc = dom.window.document;
    const form = doc.getElementById('JournalText').form;

    doc.getElementById('GPXPreview').click();
    assert.equal(messages.filter(message => message.type === 'GITHUB_BACKUP_SNAPSHOT').length, 0,
        'GPS Preview must not snapshot a form state that was never saved');

    doc.getElementById('SaveButton').click();
    assert.ok(messages.some(message => message.type === 'GITHUB_BACKUP_SNAPSHOT'),
        'clicking Save must capture a backup snapshot');

    messages.length = 0;
    form.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
    assert.equal(messages.filter(message => message.type === 'GITHUB_BACKUP_SNAPSHOT').length, 1,
        'an implicit submission must capture a backup snapshot');
});

test('markdown mode converts to bracket markup and the live preview shows the final rendering', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(doc.querySelector('.bpb-re-mdsplit').hidden, false,
        'the split pane should be visible in markdown mode');

    typeMarkdown(dom, '# Day 1\n\nWe went **up**.\n\n- tent\n- stove');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[h1]Day 1[/h1]'));
    assert.equal(doc.getElementById('JournalText').value,
        '[h1]Day 1[/h1]\n\nWe went [b]up[/b].\n\n[ul][li]tent[/li][li]stove[/li][/ul]');

    const imageSizeHint = doc.querySelector('.bpb-re-hint');
    assert.match(imageSizeHint.textContent, /!\[Photo\|500\]\(url\) for width/);
    assert.match(imageSizeHint.textContent, /!\[Photo\|500x600\]\(url\) for width × height/);
    assert.equal(imageSizeHint.title, imageSizeHint.textContent,
        'the full sizing help should remain available if the footer is visually truncated');

    // No tab to click: the preview pane re-renders beside the source.
    const preview = doc.querySelector('.bpb-re-preview');
    assert.match(preview.innerHTML, /<h1>Day 1<\/h1>/);
    assert.match(preview.innerHTML, /<li>tent<\/li>/);

    // The chosen mode is remembered for next time.
    assert.equal(dom.chrome._store.bpbSettings.reportEditorMode, 'markdown');
});

test('Markdown direct video links save as video markup and render native controls', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    typeMarkdown(dom, 'Summit video:\n\n![](https://media.example.com/summit.mp4)');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[video src='));
    assert.equal(doc.getElementById('JournalText').value,
        `Summit video:\n\n${videoMarkup('https://media.example.com/summit.mp4')}`);
    const video = doc.querySelector('.bpb-re-preview video');
    assert.equal(video?.getAttribute('src'), 'https://media.example.com/summit.mp4');
    assert.equal(video?.hasAttribute('controls'), true);
    assert.equal(video?.hasAttribute('autoplay'), false);
});

test('switching rich → markdown → rich keeps the content through the canonical form', async () => {
    const dom = await loadEditor({ report: 'A [b]bold[/b] start.' });
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'A **bold** start.');

    modeButton(doc, 'Rich text').click();
    assert.equal(editors(dom).rich.getHTML(), '<p>A <strong>bold</strong> start.</p>');
    assert.equal(doc.getElementById('JournalText').value, 'A [b]bold[/b] start.');
});

test('undo cannot cross a mode switch and resurrect the pre-switch document', async () => {
    const dom = await loadEditor({ report: 'first version' });
    await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p>second version</p>');
    await waitFor(dom, () => doc.getElementById('JournalText').value === 'second version');

    modeButton(doc, 'Markdown').click();
    modeButton(doc, 'Rich text').click();
    const rich = editors(dom).rich;
    assert.equal(rich.can().undo(), false, 're-entering rich mode must start a fresh history');
    rich.chain().focus().undo().run();
    doc.getElementById('GPXPreview').click();   // flush anything a rogue undo produced
    assert.equal(doc.getElementById('JournalText').value, 'second version');
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

test('pasted rich media dimensions are bounded before node views apply them', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p><img src="https://example.com/map.jpg" alt="Topo" width="999999" height="888888">'
        + '<video src="https://media.example.com/summit.mp4" width="999999" height="888888"></video></p>');

    const image = ui.querySelector('.bpb-re-image-resize img');
    const video = ui.querySelector('.bpb-re-video-resize video');
    assert.deepEqual([image?.style.width, image?.style.height], ['', '']);
    assert.deepEqual([video?.style.width, video?.style.height], ['', ''],
        'untrusted dimensions must not become enormous inline styles before save');

    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[video src='));
    assert.equal(doc.getElementById('JournalText').value,
        `[img src="https://example.com/map.jpg" alt="Topo"]${videoMarkup(
            'https://media.example.com/summit.mp4')}`);
});

test('the toolbar reflects the caret: active marks, block style, and table controls', async () => {
    const dom = await loadEditor({ report: '[h2]Route[/h2]\n\n[b]bold text[/b]' });
    const ui = await editorReady(dom);
    const rich = editors(dom).rich;

    const posOf = needle => {
        let hit = null;
        rich.state.doc.descendants((node, pos) => {
            if (hit === null && node.isText && node.text.includes(needle)) hit = pos + 1;
            return hit === null;
        });
        return hit;
    };

    rich.chain().focus().setTextSelection(posOf('Route')).run();
    assert.equal(ui.querySelector('.bpb-re-format').value, 'h2');
    assert.equal(ui.querySelector('[aria-label="Bold (Ctrl+B)"]').getAttribute('aria-pressed'), 'false');

    rich.chain().focus().setTextSelection(posOf('bold text')).run();
    assert.equal(ui.querySelector('.bpb-re-format').value, 'p');
    assert.equal(ui.querySelector('[aria-label="Bold (Ctrl+B)"]').getAttribute('aria-pressed'), 'true');

    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, true);
    ui.querySelector('[aria-label="Insert table"]').click();
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, false,
        'table controls should appear while the caret is inside a table');

    ui.querySelector('[aria-label="Insert image"]').click();
    assert.equal(ui.querySelector('.bpb-re-imagebox').hidden, false);
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, true,
        'the automatic table row must not open behind another contextual panel');
    ui.querySelector('[aria-label="Insert image"]').click();
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, false,
        'dismissing a contextual panel should restore the applicable table row');

    ui.querySelector('[aria-label="More formats"]').click();
    ui.querySelector('[aria-label="More formats"]').click();
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, false,
        'toggling More closed should restore the applicable table row');
    await waitFor(dom, () => dom.window.document.getElementById('JournalText').value.includes('[table border="1"]'));
});

test('more formats and named text colors serialize through the allowlist', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p>peak</p>');
    editors(dom).rich.chain().focus().selectAll().run();

    ui.querySelector('[aria-label="More formats"]').click();
    assert.equal(ui.querySelector('.bpb-re-morebox').hidden, false);
    ui.querySelector('[aria-label="Highlight (Ctrl+Shift+H)"]').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[mark]'));

    editors(dom).rich.chain().focus().selectAll().run();
    ui.querySelector('[aria-label="More formats"]').click();
    ui.querySelector('[aria-label="Text color: Blue"]').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('color:steelblue'));
    assert.equal(doc.getElementById('JournalText').value,
        '[span style="color:steelblue"][mark]peak[/mark][/span]');
});

test('an unrelated rich edit preserves an existing hex text color', async () => {
    const source = 'Under [span style="color:#2471a3"]blue[/span] skies.';
    const dom = await loadEditor({ report: source });
    await editorReady(dom);
    const rich = editors(dom).rich;
    const colored = rich.view.dom.querySelector('span[style]');
    assert.equal(colored?.getAttribute('data-bpb-report-color'), '#2471a3');

    rich.chain().focus('end').insertContent(' Clear weather.').run();
    await waitFor(dom, () => dom.window.document.getElementById('JournalText').value.endsWith('Clear weather.'));
    assert.equal(dom.window.document.getElementById('JournalText').value,
        `${source} Clear weather.`);
});

test('an unrelated Markdown edit preserves hex color in source, form, and preview', async () => {
    const bracket = 'Under [span style="color:#2471a3"]blue[/span] skies.';
    const markdown = 'Under <span style="color:#2471a3">blue</span> skies.';
    const dom = await loadEditor({ report: bracket });
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), markdown);
    typeMarkdown(dom, `${markdown} Clear weather.`);
    await waitFor(dom, () => doc.getElementById('JournalText').value.endsWith('Clear weather.'));
    assert.equal(doc.getElementById('JournalText').value, `${bracket} Clear weather.`);
    assert.equal(ui.querySelector('.bpb-re-preview span')?.getAttribute('style'), 'color:#2471a3');
});

test('the image popover validates the source and inserts alt text', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    ui.querySelector('[aria-label="Insert image"]').click();
    assert.equal(ui.querySelector('.bpb-re-imagebox').hidden, false);
    const src = ui.querySelector('[aria-label="Image URL (HTTPS)"]');
    const alt = ui.querySelector('[aria-label="Image description"]');
    const hostingHint = ui.querySelector('.bpb-re-image-hosting');
    assert.match(hostingHint.textContent, /Free plans, limits, and terms vary\./);
    assert.deepEqual([...hostingHint.querySelectorAll('a')].map(link => ({
        label: link.textContent,
        href: link.href,
        target: link.target,
        rel: link.rel
    })), [
        {
            label: 'Peakbagger Photos',
            href: 'https://www.peakbagger.com/climber/photo.aspx',
            target: '_blank',
            rel: 'noopener noreferrer'
        },
        {
            label: 'Imgur',
            href: 'https://imgur.com/upload',
            target: '_blank',
            rel: 'noopener noreferrer'
        },
        {
            label: 'ImgBB',
            href: 'https://imgbb.com/',
            target: '_blank',
            rel: 'noopener noreferrer'
        }
    ]);

    src.value = 'javascript:alert(1)';
    ui.querySelector('.bpb-re-imagebox .bpb-re-linkapply').click();
    assert.ok(src.classList.contains('bpb-re-invalid'), 'an unsafe URL must be rejected');
    assert.equal(doc.getElementById('JournalText').value, '');

    src.value = 'https://example.com/topo.jpg';
    alt.value = 'Topo';
    ui.querySelector('.bpb-re-imagebox .bpb-re-linkapply').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[img'));
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://example.com/topo.jpg" alt="Topo"]');
});

test('link and media popovers toggle closed, share the toolbar layer, and insert safe video', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const layer = ui.querySelector('.bpb-re-contextual');
    const linkTool = ui.querySelector('[aria-label="Link (Ctrl+K)"]');
    const imageTool = ui.querySelector('[aria-label="Insert image"]');
    const videoTool = ui.querySelector('[aria-label="Insert video"]');
    const imageBox = ui.querySelector('.bpb-re-imagebox');
    const videoBox = ui.querySelector('.bpb-re-videobox');

    linkTool.click();
    assert.equal(ui.querySelector('.bpb-re-linkbox').hidden, false);
    linkTool.click();
    assert.equal(ui.querySelector('.bpb-re-linkbox').hidden, true,
        'clicking Link again should dismiss its panel');

    imageTool.click();
    assert.equal(imageBox.hidden, false);
    assert.equal(imageBox.parentElement, layer);
    imageTool.click();
    assert.equal(imageBox.hidden, true, 'clicking Image again should dismiss its panel');

    videoTool.click();
    assert.equal(videoBox.hidden, false);
    assert.equal(videoBox.parentElement, layer);
    const videoSrc = ui.querySelector('[aria-label="Video file or YouTube URL"]');
    videoSrc.value = 'http://example.com/clip.mp4';
    ui.querySelector('.bpb-re-videobox .bpb-re-linkapply').click();
    assert.ok(videoSrc.classList.contains('bpb-re-invalid'), 'mixed-content video URLs must be rejected');

    videoSrc.value = 'https://media.example.com/clip.mp4';
    ui.querySelector('.bpb-re-videobox .bpb-re-linkapply').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[video src='));
    assert.equal(doc.getElementById('JournalText').value,
        videoMarkup('https://media.example.com/clip.mp4'));
    assert.equal(ui.querySelector('.bpb-re-surface video')?.getAttribute('controls'), '');
});

test('the video tool inserts a canonical, resizable YouTube iframe', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const videoTool = ui.querySelector('[aria-label="Insert video"]');
    const videoSrc = ui.querySelector('[aria-label="Video file or YouTube URL"]');

    videoTool.click();
    assert.match(ui.querySelector('.bpb-re-video-hint').textContent,
        /direct HTTPS video file URL or a YouTube watch\/share URL/i);
    videoSrc.value = 'https://youtu.be/aqz-KE-bpKQ?si=share-token';
    ui.querySelector('.bpb-re-videobox .bpb-re-linkapply').click();

    const source = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="640" height="360"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === source);
    const iframe = ui.querySelector('.bpb-re-youtube-resize iframe');
    assert.equal(iframe?.getAttribute('src'), 'https://www.youtube.com/embed/aqz-KE-bpKQ');
    assert.equal(iframe?.getAttribute('title'), 'YouTube video');
    assert.equal(iframe?.getAttribute('allowfullscreen'), '');
    assert.equal(ui.querySelector('[aria-label="Resize YouTube video"]')?.tagName, 'BUTTON');
});

test('a Rich video resize stays proportional and persists its dimensions', async () => {
    const source = videoMarkup('https://media.example.com/summit.mp4', ' width="800" height="450"');
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const video = ui.querySelector('.bpb-re-video-resize video');
    const handle = ui.querySelector('[aria-label="Resize video"]');

    assert.ok(video, 'Rich videos should use the resizable node view');
    assert.equal(handle?.tagName, 'BUTTON');
    assert.equal(handle?.type, 'button', 'the resize handle must never submit the ascent form');
    assert.equal(handle?.getAttribute('aria-keyshortcuts'), 'ArrowLeft ArrowRight');

    Object.defineProperties(video, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(video.style.width) || 800 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(video.style.height) || 450 }
    });

    handle.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true, clientX: 800, clientY: 450, button: 0
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mousemove', {
        bubbles: true, clientX: 600, clientY: 338, buttons: 1
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true, clientX: 600, clientY: 338, button: 0
    }));

    const resized = videoMarkup('https://media.example.com/summit.mp4', ' width="600" height="338"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(video.style.width, '600px');
    assert.equal(video.style.height, '338px');

    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowLeft', shiftKey: true
    }));
    const keyboardResized = videoMarkup('https://media.example.com/summit.mp4',
        ' width="550" height="310"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === keyboardResized);

    editors(dom).rich.chain().focus().undo().run();
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value, source,
        'the grouped video resize interaction should be undoable');
});

test('a Rich YouTube iframe resize stays proportional and persists its dimensions', async () => {
    const source = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="800" height="450"');
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const iframe = ui.querySelector('.bpb-re-youtube-resize iframe');
    const handle = ui.querySelector('[aria-label="Resize YouTube video"]');

    assert.ok(iframe, 'Rich YouTube embeds should use the resizable node view');
    assert.equal(handle?.tagName, 'BUTTON');
    assert.equal(handle?.type, 'button', 'the resize handle must never submit the ascent form');
    assert.equal(handle?.getAttribute('aria-keyshortcuts'), 'ArrowLeft ArrowRight');

    Object.defineProperties(iframe, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(iframe.style.width) || 800 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(iframe.style.height) || 450 }
    });

    handle.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true, clientX: 800, clientY: 450, button: 0
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mousemove', {
        bubbles: true, clientX: 600, clientY: 338, buttons: 1
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true, clientX: 600, clientY: 338, button: 0
    }));

    const resized = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="600" height="338"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(iframe.style.width, '600px');
    assert.equal(iframe.style.height, '338px');

    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowLeft', shiftKey: true
    }));
    const keyboardResized = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="550" height="310"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === keyboardResized);
});

test('a Rich image resize stays proportional and persists its dimensions', async () => {
    const source = '[img src="https://example.com/topo.jpg" alt="Topo" width="800" height="600"]';
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const image = ui.querySelector('.bpb-re-image-resize img');
    const handle = ui.querySelector('[aria-label="Resize image"]');

    assert.ok(image, 'Rich images should use the resizable node view');
    assert.equal(handle?.tagName, 'BUTTON');
    assert.equal(handle?.type, 'button', 'the resize handle must never submit the ascent form');
    assert.equal(handle?.getAttribute('aria-keyshortcuts'), 'ArrowLeft ArrowRight');

    Object.defineProperties(image, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(image.style.width) || 800 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(image.style.height) || 600 }
    });

    handle.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true, clientX: 800, clientY: 600, button: 0
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mousemove', {
        bubbles: true, clientX: 600, clientY: 450, buttons: 1
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true, clientX: 600, clientY: 450, button: 0
    }));

    const resized = '[img src="https://example.com/topo.jpg" alt="Topo" width="600" height="450"]';
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(image.style.width, '600px');
    assert.equal(image.style.height, '450px');

    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowLeft', shiftKey: true
    }));
    const keyboardResized = '[img src="https://example.com/topo.jpg" alt="Topo" width="550" height="413"]';
    await waitFor(dom, () => doc.getElementById('JournalText').value === keyboardResized);

    editors(dom).rich.chain().focus().undo().run();
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value, source,
        'the grouped resize interaction should be undoable');
    assert.equal(image.style.width, '800px', 'the node view should repaint dimensions after undo');
    assert.equal(image.style.height, '600px');
});

test('keyboard image resizing stops at the serialized dimension ceiling', async () => {
    const source = '[img src="https://example.com/panorama.jpg" alt="Panorama" width="1590" height="954"]';
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const image = ui.querySelector('.bpb-re-image-resize img');
    const handle = ui.querySelector('[aria-label="Resize image"]');

    Object.defineProperties(image, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(image.style.width) || 1590 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(image.style.height) || 954 }
    });
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowRight', shiftKey: true
    }));

    await waitFor(dom, () => /width="1600" height="960"/.test(doc.getElementById('JournalText').value));
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowRight', shiftKey: true
    }));
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://example.com/panorama.jpg" alt="Panorama" width="1600" height="960"]');
});

test('plain mode is the untouched native textarea, hints restored', async () => {
    const dom = await loadEditor({ report: 'raw [whatever] text' });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const plainHint = ui.querySelector('.bpb-re-plain-hint');

    assert.equal(plainHint.hidden, true);
    assert.equal(plainHint.parentElement, ui.querySelector('.bpb-re-bar'),
        'the Plain hint should reuse the shared toolbar row');

    modeButton(doc, 'Plain').click();
    const textarea = doc.getElementById('JournalText');
    assert.equal(textarea.classList.contains('bpb-re-hidden'), false);
    assert.equal(textarea.value, 'raw [whatever] text');
    assert.equal(plainHint.hidden, false);
    assert.equal(plainHint.textContent,
        'Peakbagger’s original text editor — use Peakbagger’s [bracket] syntax.');
    const hints = [...doc.querySelectorAll('span')].find(s => /Hints:/.test(s.textContent));
    assert.equal(hints.classList.contains('bpb-re-hidden'), false);

    modeButton(doc, 'Rich text').click();
    assert.equal(plainHint.hidden, true);
});

test('editing Plain invalidates the exact Markdown sidecar', async () => {
    const dom = await loadEditor({ report: 'Original [b]report[/b].' });
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'Original **report**.');

    modeButton(doc, 'Plain').click();
    const textarea = doc.getElementById('JournalText');
    textarea.value = 'Replacement [i]source[/i].';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'Replacement *source*.');
});

test('visiting Markdown mode does not rewrite an untouched server report', async () => {
    const report = '[iframe src="https://example.com"][/iframe]';
    const dom = await loadEditor({ report });
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    modeButton(doc, 'Plain').click();
    assert.equal(doc.getElementById('JournalText').value, report);
});

test('editing in rich mode neutralizes unsupported embed markup before submission', async () => {
    const dom = await loadEditor({ report: '[iframe src="https://example.com"][/iframe]' });
    await editorReady(dom);
    const doc = dom.window.document;

    editors(dom).rich.chain().focus('end').insertContent(' edited').run();
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
        /Draft saved on this device · \d{1,2}:\d{2}:\d{2}(?:\s[AP]M)?$/);
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
    assert.equal(editors(dom).markdown.getValue(), 'draft copy with **md**');
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

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'Same **content**.\n\n- item');
});

test('a whitespace-only stored draft is deleted instead of silently retained', async () => {
    const dom = await loadEditor({
        drafts: { [DRAFT_KEY]: { text: ' \r\n\t ', mode: 'rich', savedAt: Date.now() - 1000 } }
    });
    await editorReady(dom);

    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    assert.equal(dom.window.document.querySelector('.bpb-re-draft').hidden, true);
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
