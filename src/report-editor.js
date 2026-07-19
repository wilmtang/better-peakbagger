// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — trip-report editor for the ascent add/edit form.
//
// Replaces the bare JournalText textarea with a rich-text surface (TipTap,
// schema-locked in src/report-rich-editor.js) or a Markdown source pane
// (CodeMirror, src/report-md-editor.js) beside a live preview, converting
// everything through src/report-markup.js into Peakbagger's square-bracket
// markup. The native textarea never leaves the form: it is the single
// submitted source of truth, kept in sync on every edit and flushed
// synchronously before any submit or postback, so Save, Cancel, GPS Preview,
// and ASP.NET autopostbacks always post exactly what the editor shows.
// 'Plain' mode is the untouched native textarea — the escape hatch, and where
// unsupported markup can be edited verbatim.
//
// Drafts autosave to extension-local storage keyed by climber/ascent identity.
// They never leave the device, expire after two weeks, and are offered back —
// never silently applied — when they differ from what the server rendered.
// Clicking either Save Ascent control clears the draft; the posted value
// itself still round-trips through the form if the save fails server-side.

import { settings as Settings } from './settings.js';
import { reportMarkup as Markup } from './report-markup.js';
import { createRichEditor, richCommands, richState } from './report-rich-editor.js';
import { createMarkdownEditor } from './report-md-editor.js';

// Kept as an IIFE for early-exit control flow (no editor form → nothing to do);
// dependencies are ES imports and no globals are published.
(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext || !ext.storage) return;

    const textarea = document.getElementById('JournalText');
    const form = textarea && textarea.form;
    if (!textarea || !form) return;

    const DRAFT_PREFIX = 'bpbReportDraft:';
    const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
    const DRAFT_LIMIT = 30;
    const SYNC_DEBOUNCE_MS = 150;
    const AUTOSAVE_DEBOUNCE_MS = 800;
    const MODES = ['rich', 'markdown', 'plain'];

    const params = new URLSearchParams(location.search);
    const draftKey = `${DRAFT_PREFIX}${params.get('cid') || '0'}:${
        params.get('aid') ? `a${params.get('aid')}` : params.get('pid') ? `p${params.get('pid')}` : 'new'}`;

    // The site's own hint row about bracket tags — superseded by the editor,
    // shown again in Plain mode where it applies verbatim.
    const cell = textarea.closest('td');
    const nativeHints = cell
        ? [...cell.querySelectorAll('span')].find(span => /Hints:/.test(span.textContent || ''))
        : null;
    const nativeBreak = textarea.nextElementSibling && textarea.nextElementSibling.tagName === 'BR'
        ? textarea.nextElementSibling
        : null;

    const state = {
        mode: null,
        mdSource: null,      // authoritative markdown text while in markdown mode
        mdDirty: false,      // do not normalize an untouched server report
        richDirty: false,    // preserve untouched unsupported server markup verbatim
        syncTimer: null,
        autosaveTimer: null
    };

    let richEditor = null;   // created in initialize(), only when enabled
    let mdEditor = null;

    // ---- DOM ----------------------------------------------------------------

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    const button = (className, label, title, html) => {
        const node = el('button', className);
        node.type = 'button';
        node.title = title || label;
        node.setAttribute('aria-label', title || label);
        if (html !== undefined) node.innerHTML = html;
        else node.textContent = label;
        return node;
    };

    const ui = el('div', 'bpb-re');
    ui.id = 'bpb-report-editor';

    const draftBar = el('div', 'bpb-re-draft');
    draftBar.setAttribute('role', 'status');
    draftBar.hidden = true;

    const bar = el('div', 'bpb-re-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Trip report formatting');

    const tools = el('div', 'bpb-re-tools');
    const blockFormat = el('select', 'bpb-re-format');
    blockFormat.setAttribute('aria-label', 'Block style');
    blockFormat.title = 'Block style';
    for (const [value, label] of [
        ['p', 'Paragraph'],
        ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'],
        ['h4', 'Heading 4'], ['h5', 'Heading 5'], ['h6', 'Heading 6'],
        ['blockquote', 'Quote'], ['pre', 'Preformatted']
    ]) {
        const option = el('option', null, label);
        option.value = value;
        blockFormat.append(option);
    }

    const svg = paths => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${paths}</svg>`;
    const toolButtons = {
        bold: button('bpb-re-tool', 'B', 'Bold (Ctrl+B)', '<b>B</b>'),
        italic: button('bpb-re-tool', 'I', 'Italic (Ctrl+I)', '<i>I</i>'),
        underline: button('bpb-re-tool', 'U', 'Underline (Ctrl+U)', '<u>U</u>'),
        strike: button('bpb-re-tool', 'S', 'Strikethrough', '<s>S</s>'),
        more: button('bpb-re-tool', 'Aa', 'More formats'),
        link: button('bpb-re-tool', 'Link', 'Link (Ctrl+K)',
            svg('<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M6.5 9.5l3-3M5.7 7.2L4 8.9a2.5 2.5 0 003.5 3.5l1.7-1.7M10.3 8.8L12 7.1a2.5 2.5 0 00-3.5-3.5L6.8 5.3"/>')),
        image: button('bpb-re-tool', 'Image', 'Insert image',
            svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.2" cy="6" r="1.2" fill="currentColor"/><path d="M3 12.5l3.2-3.4 2.2 2.2 2.6-3 2.5 4.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>')),
        insertTable: button('bpb-re-tool', 'Table', 'Insert table',
            svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 6.5h13M6 2.5v11M10.5 2.5v11" fill="none" stroke="currentColor" stroke-width="1.2"/>')),
        bulletList: button('bpb-re-tool', 'Bulleted list', 'Bulleted list',
            svg('<g fill="currentColor"><circle cx="3" cy="4" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="3" cy="12" r="1.3"/></g><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 4h6.5M6.5 8h6.5M6.5 12h6.5"/></g>')),
        orderedList: button('bpb-re-tool', 'Numbered list', 'Numbered list',
            svg('<g fill="currentColor" font-size="5.5" font-family="Tahoma, sans-serif"><text x="1" y="6">1</text><text x="1" y="14">2</text></g><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 4h6.5M6.5 12h6.5"/></g>')),
        horizontalRule: button('bpb-re-tool', 'Rule', 'Horizontal rule',
            svg('<path d="M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>')),
        undo: button('bpb-re-tool', 'Undo', 'Undo (Ctrl+Z)',
            svg('<path d="M6.5 3.5L3 7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 7H9a3.5 3.5 0 010 7H7.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>')),
        redo: button('bpb-re-tool', 'Redo', 'Redo (Ctrl+Shift+Z)',
            svg('<path d="M9.5 3.5L13 7l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 7H7a3.5 3.5 0 000 7h1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'))
    };
    tools.append(blockFormat, ...Object.values(toolButtons));

    const modes = el('div', 'bpb-re-modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Editor mode');
    const modeButtons = {
        rich: button('bpb-re-mode', 'Rich text'),
        markdown: button('bpb-re-mode', 'Markdown'),
        plain: button('bpb-re-mode', 'Plain')
    };
    modeButtons.plain.title = 'Edit Peakbagger’s bracket markup directly';
    modes.append(...Object.values(modeButtons));

    bar.append(tools, modes);

    // Contextual table controls, shown only while the caret is inside a table.
    const tableBar = el('div', 'bpb-re-box bpb-re-tablebar');
    tableBar.setAttribute('role', 'toolbar');
    tableBar.setAttribute('aria-label', 'Table editing');
    tableBar.hidden = true;
    const tableButtons = {
        addRowAfter: button('bpb-re-tablebtn', '+ Row', 'Add row below'),
        addColumnAfter: button('bpb-re-tablebtn', '+ Column', 'Add column right'),
        deleteRow: button('bpb-re-tablebtn', '− Row', 'Delete row'),
        deleteColumn: button('bpb-re-tablebtn', '− Column', 'Delete column'),
        toggleHeaderRow: button('bpb-re-tablebtn', 'Header row', 'Toggle header row'),
        deleteTable: button('bpb-re-tablebtn', 'Remove table', 'Remove table')
    };
    tableBar.append(...Object.values(tableButtons));

    const linkBox = el('div', 'bpb-re-box bpb-re-linkbox');
    linkBox.hidden = true;
    const linkInput = el('input');
    linkInput.type = 'text';
    linkInput.placeholder = 'https://example.com/…';
    linkInput.setAttribute('aria-label', 'Link URL');
    const linkApply = button('bpb-re-linkapply', 'Add link');
    const linkRemove = button('bpb-re-linkremove', 'Remove link');
    linkBox.append(linkInput, linkApply, linkRemove);

    const imageBox = el('div', 'bpb-re-box bpb-re-imagebox');
    imageBox.hidden = true;
    const imageSrcInput = el('input');
    imageSrcInput.type = 'text';
    imageSrcInput.placeholder = 'https://example.com/photo.jpg';
    imageSrcInput.setAttribute('aria-label', 'Image URL (HTTPS)');
    const imageAltInput = el('input');
    imageAltInput.type = 'text';
    imageAltInput.placeholder = 'Description (alt text)';
    imageAltInput.setAttribute('aria-label', 'Image description');
    const imageApply = button('bpb-re-linkapply', 'Add image');
    imageBox.append(imageSrcInput, imageAltInput, imageApply);

    // Less-frequent inline formats live one click away instead of widening the
    // main bar: code, highlight, sub/sup, small, inline quote, and text color.
    const moreBox = el('div', 'bpb-re-box bpb-re-morebox');
    moreBox.hidden = true;
    const moreButtons = {
        code: button('bpb-re-tool', 'Code', 'Inline code (Ctrl+E)', '<code>&lt;/&gt;</code>'),
        highlight: button('bpb-re-tool', 'Highlight', 'Highlight (Ctrl+Shift+H)', '<mark>ab</mark>'),
        subscript: button('bpb-re-tool', 'Subscript', 'Subscript', 'x<sub>2</sub>'),
        superscript: button('bpb-re-tool', 'Superscript', 'Superscript', 'x<sup>2</sup>'),
        small: button('bpb-re-tool', 'Small text', 'Small text', '<small>Aa</small>'),
        inlineQuote: button('bpb-re-tool', 'Inline quote', 'Inline quote', '<q>ab</q>')
    };
    // A curated named palette keeps this secondary control compact. Existing
    // three- and six-digit hex colors still survive every editor round trip.
    const PALETTE = [
        ['firebrick', 'Red'], ['chocolate', 'Orange'], ['olive', 'Olive'],
        ['seagreen', 'Green'], ['steelblue', 'Blue'], ['rebeccapurple', 'Purple'], ['gray', 'Gray']
    ];
    const swatches = el('span', 'bpb-re-swatches');
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', 'Text color');
    const swatchButtons = PALETTE.map(([color, label]) => {
        const control = button('bpb-re-swatch', label, `Text color: ${label}`);
        control.textContent = '';
        control.dataset.color = color;
        control.style.background = color;
        return control;
    });
    const swatchClear = button('bpb-re-tool', 'Auto', 'Default text color');
    swatches.append(...swatchButtons, swatchClear);
    moreBox.append(...Object.values(moreButtons), swatches);

    const richWrap = el('div', 'bpb-re-richwrap');

    const mdSplit = el('div', 'bpb-re-mdsplit');
    const mdPane = el('div', 'bpb-re-mdpane');
    const preview = el('div', 'bpb-re-preview');
    preview.setAttribute('aria-label', 'Live preview of the saved trip report');
    mdSplit.append(mdPane, preview);

    const foot = el('div', 'bpb-re-foot');
    const status = el('span', 'bpb-re-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const imageSizeHint = 'Image size: ![Photo|500](url) for width, or ![Photo|500x600](url) for width × height';
    const mdHint = el('span', 'bpb-re-hint', imageSizeHint);
    mdHint.title = imageSizeHint;
    foot.append(status, mdHint);

    ui.append(draftBar, bar, tableBar, linkBox, imageBox, moreBox, richWrap, mdSplit, foot);

    const boxes = [linkBox, imageBox, moreBox];
    const closeBoxes = () => { for (const box of boxes) box.hidden = true; };
    const toggleBox = box => {
        const wasOpen = !box.hidden;
        closeBoxes();
        box.hidden = wasOpen;
    };

    // ---- Native textarea sync (the submitted source of truth) ---------------

    // The TipTap view DOM carries editor scaffolding (trailing breaks, gap
    // cursors), so serialization reads the schema's clean HTML instead, parsed
    // detached and folded through the same domToBracket path as pasted DOM.
    const richBracket = () => {
        const parsed = new DOMParser().parseFromString(richEditor.getHTML(), 'text/html');
        return Markup.domToBracket(parsed.body);
    };

    const renderPreview = () => {
        preview.innerHTML = Markup.markdownToPreviewHtml(mdEditor.getValue())
            || '<p class="bpb-re-preview-empty">Nothing to preview yet.</p>';
    };

    const flushSync = () => {
        if (state.syncTimer !== null) {
            globalThis.clearTimeout(state.syncTimer);
            state.syncTimer = null;
        }
        if (state.mode === 'rich' && state.richDirty) {
            textarea.value = richBracket();
            state.mdSource = null;
            state.richDirty = false;
        } else if (state.mode === 'markdown' && state.mdDirty) {
            state.mdSource = mdEditor.getValue();
            textarea.value = Markup.markdownToBracket(state.mdSource);
            state.mdDirty = false;
            renderPreview();
        }
        // plain mode: the textarea IS the editor; nothing to do.
    };

    const scheduleSync = () => {
        if (state.syncTimer !== null) globalThis.clearTimeout(state.syncTimer);
        state.syncTimer = globalThis.setTimeout(flushSync, SYNC_DEBOUNCE_MS);
        scheduleAutosave();
    };

    // Submits, button postbacks, and dropdown autopostbacks (__doPostBack does
    // not fire a submit event) must never post a stale textarea. Capture-phase
    // listeners on the form run before the page's inline handlers.
    form.addEventListener('submit', flushSync, true);
    form.addEventListener('click', flushSync, true);
    form.addEventListener('change', flushSync, true);
    textarea.addEventListener('input', () => {
        if (state.mode === 'plain') state.mdSource = null;
    });
    globalThis.addEventListener('pagehide', () => { flushSync(); void saveDraftNow(); });

    // The source pane drives the preview's scroll position, proportionally.
    const syncPreviewScroll = () => {
        const scroller = mdEditor.view.scrollDOM;
        const sourceMax = scroller.scrollHeight - scroller.clientHeight;
        const ratio = sourceMax > 0 ? scroller.scrollTop / sourceMax : 0;
        preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
    };

    // ---- Local drafts ---------------------------------------------------------

    const localStore = ext.storage.local;

    const timeLabel = stamp => {
        const then = new Date(stamp);
        const now = new Date();
        return then.toDateString() === now.toDateString()
            ? then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : then.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const saveDraftNow = async () => {
        if (state.autosaveTimer !== null) {
            globalThis.clearTimeout(state.autosaveTimer);
            state.autosaveTimer = null;
        }
        if (state.mode === 'plain') return;   // native behavior, native risks
        flushSync();
        try {
            if (!textarea.value.trim()) {
                await localStore.remove(draftKey);
                status.textContent = '';
                return;
            }
            const record = { text: textarea.value, mode: state.mode, savedAt: Date.now() };
            if (state.mode === 'markdown') record.source = mdEditor.getValue();
            await localStore.set({ [draftKey]: record });
            status.textContent = `Draft saved on this device · ${timeLabel(record.savedAt)}`;
        } catch (error) { /* storage unavailable — the form value is still live */ }
    };

    const scheduleAutosave = () => {
        if (state.autosaveTimer !== null) globalThis.clearTimeout(state.autosaveTimer);
        state.autosaveTimer = globalThis.setTimeout(() => { void saveDraftNow(); }, AUTOSAVE_DEBOUNCE_MS);
    };

    const clearDraft = () => {
        if (state.autosaveTimer !== null) {
            globalThis.clearTimeout(state.autosaveTimer);
            state.autosaveTimer = null;
        }
        void localStore.remove(draftKey).catch(() => {});
    };

    // Saving the ascent is the moment the draft has served its purpose. If the
    // save fails server-side, the value still round-trips in the form post.
    for (const id of ['SaveButton', 'SaveButton2']) {
        const save = document.getElementById(id);
        if (save) save.addEventListener('click', () => { flushSync(); clearDraft(); }, true);
    }

    const offerDraft = stored => {
        draftBar.textContent = '';
        const label = el('span', 'bpb-re-draft-text',
            `A locally saved draft of this report (${timeLabel(stored.savedAt)}) differs from what’s shown.`);
        const restore = button('bpb-re-draft-restore', 'Restore draft');
        const discard = button('bpb-re-draft-discard', 'Delete draft');
        restore.addEventListener('click', () => {
            textarea.value = stored.text;
            state.mdSource = stored.mode === 'markdown' && typeof stored.source === 'string'
                ? stored.source
                : null;
            draftBar.hidden = true;
            // flush: false — the restored textarea value must not be clobbered
            // by a serialization of the outgoing (pre-restore) content.
            setMode(MODES.includes(stored.mode) ? stored.mode : state.mode, { persist: false, flush: false });
            status.textContent = 'Draft restored';
        });
        discard.addEventListener('click', () => {
            clearDraft();
            draftBar.hidden = true;
        });
        draftBar.append(label, restore, discard);
        draftBar.hidden = false;
    };

    // The browser posts textarea content as \r\n, so the server's echo of a
    // saved report differs byte-wise from the \n draft; compare normalized.
    const normalized = value => String(value).replace(/\r\n?/g, '\n').trim();

    const checkDraft = async () => {
        let stored;
        try {
            stored = (await localStore.get(draftKey))[draftKey];
        } catch (error) { return; }
        if (!stored || typeof stored.text !== 'string' || typeof stored.savedAt !== 'number') return;
        if (Date.now() - stored.savedAt > DRAFT_TTL_MS) { clearDraft(); return; }
        const storedText = normalized(stored.text);
        if (!storedText) { clearDraft(); return; }
        if (storedText === normalized(textarea.value)) {
            // Same content the server rendered — keep the markdown source so a
            // postback doesn't cost the user their original markdown.
            if (stored.mode === 'markdown' && typeof stored.source === 'string') {
                state.mdSource = stored.source;
            }
            return;
        }
        offerDraft(stored);
    };

    // Expired or excess drafts (other ascents included) are pruned here so the
    // store cannot grow without bound.
    const pruneDrafts = async () => {
        try {
            const everything = await localStore.get(null);
            const drafts = Object.entries(everything || {})
                .filter(([key, value]) => key.startsWith(DRAFT_PREFIX) && value && typeof value.savedAt === 'number');
            const expired = drafts.filter(([, value]) => Date.now() - value.savedAt > DRAFT_TTL_MS);
            const fresh = drafts.filter(([, value]) => Date.now() - value.savedAt <= DRAFT_TTL_MS)
                .sort((a, b) => b[1].savedAt - a[1].savedAt);
            const excess = fresh.slice(DRAFT_LIMIT);
            const doomed = [...expired, ...excess].map(([key]) => key).filter(key => key !== draftKey);
            if (doomed.length) await localStore.remove(doomed);
        } catch (error) { /* best effort */ }
    };

    // ---- Rich toolbar ---------------------------------------------------------

    // Painted from a richState snapshot on every editor transaction, so active
    // states, the block dropdown, undo/redo, and the table bar always reflect
    // the caret position.
    const refreshToolbar = () => {
        if (state.mode !== 'rich' || !richEditor) return;
        const snapshot = richState(richEditor);
        blockFormat.value = snapshot.block;
        for (const name of ['bold', 'italic', 'underline', 'strike']) {
            toolButtons[name].setAttribute('aria-pressed', String(snapshot.marks[name]));
        }
        for (const [name, control] of Object.entries(moreButtons)) {
            control.setAttribute('aria-pressed', String(snapshot.marks[name]));
        }
        toolButtons.bulletList.setAttribute('aria-pressed', String(snapshot.bulletList));
        toolButtons.orderedList.setAttribute('aria-pressed', String(snapshot.orderedList));
        toolButtons.link.setAttribute('aria-pressed', String(snapshot.linkActive));
        toolButtons.undo.disabled = !snapshot.canUndo;
        toolButtons.redo.disabled = !snapshot.canRedo;
        for (const control of swatchButtons) {
            control.setAttribute('aria-pressed', String(snapshot.color === control.dataset.color));
        }
        tableBar.hidden = !snapshot.inTable;
    };

    const openLinkBox = () => {
        if (state.mode !== 'rich' || !richEditor) return;
        const snapshot = richState(richEditor);
        closeBoxes();
        linkInput.value = snapshot.linkHref;
        linkRemove.hidden = !snapshot.linkActive;
        linkApply.textContent = snapshot.linkActive ? 'Update link' : 'Add link';
        linkBox.hidden = false;
        linkInput.focus();
        linkInput.select();
    };

    const applyLink = () => {
        const href = Markup.resolveLinkTarget(linkInput.value);
        if (!href) {
            linkInput.classList.add('bpb-re-invalid');
            linkInput.focus();
            return;
        }
        linkInput.classList.remove('bpb-re-invalid');
        // With nothing selected and no link under the caret, insert the URL as
        // its own linked text rather than silently doing nothing.
        if (richEditor.state.selection.empty && !richEditor.isActive('link')) {
            richEditor.chain().focus()
                .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
                .run();
        } else {
            richCommands.setLink(richEditor, href);
        }
        closeBoxes();
    };

    const removeLink = () => {
        richCommands.unsetLink(richEditor);
        closeBoxes();
    };

    const openImageBox = () => {
        closeBoxes();
        imageSrcInput.value = '';
        imageAltInput.value = '';
        imageSrcInput.classList.remove('bpb-re-invalid');
        imageBox.hidden = false;
        imageSrcInput.focus();
    };

    const applyImage = () => {
        const src = Markup.sanitizeImageSrc(imageSrcInput.value.trim());
        if (!src) {
            imageSrcInput.classList.add('bpb-re-invalid');
            imageSrcInput.focus();
            return;
        }
        imageSrcInput.classList.remove('bpb-re-invalid');
        richCommands.insertImage(richEditor, { src, alt: imageAltInput.value.trim() });
        closeBoxes();
    };

    for (const [name, control] of Object.entries({ ...toolButtons, ...moreButtons, ...tableButtons })) {
        // mousedown would steal the selection the command needs.
        control.addEventListener('mousedown', event => event.preventDefault());
        control.addEventListener('click', () => {
            if (name === 'more') return toggleBox(moreBox);
            if (name === 'link') return openLinkBox();
            if (name === 'image') return openImageBox();
            richCommands[name](richEditor);
        });
    }
    for (const control of swatchButtons) {
        control.addEventListener('mousedown', event => event.preventDefault());
        control.addEventListener('click', () => richCommands.setColor(richEditor, control.dataset.color));
    }
    swatchClear.addEventListener('mousedown', event => event.preventDefault());
    swatchClear.addEventListener('click', () => richCommands.unsetColor(richEditor));

    blockFormat.addEventListener('change', () => richCommands.setBlock(richEditor, blockFormat.value));

    linkApply.addEventListener('click', applyLink);
    linkRemove.addEventListener('click', removeLink);
    linkInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
        if (event.key === 'Escape') { event.preventDefault(); closeBoxes(); richEditor.commands.focus(); }
    });
    imageApply.addEventListener('click', applyImage);
    for (const input of [imageSrcInput, imageAltInput]) {
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); applyImage(); }
            if (event.key === 'Escape') { event.preventDefault(); closeBoxes(); richEditor.commands.focus(); }
        });
    }

    // ---- Modes -------------------------------------------------------------------

    const showNative = visible => {
        textarea.classList.toggle('bpb-re-hidden', !visible);
        if (nativeBreak) nativeBreak.classList.toggle('bpb-re-hidden', !visible);
        if (nativeHints) nativeHints.classList.toggle('bpb-re-hidden', !visible);
    };

    const mountRichEditor = () => {
        if (richEditor) richEditor.destroy();
        richEditor = createRichEditor({
            element: richWrap,
            placeholder: 'Write your trip report…',
            ariaLabel: 'Trip report',
            onUpdate: () => { state.richDirty = true; scheduleSync(); },
            onStateChange: () => refreshToolbar(),
            shortcuts: { 'Mod-k': openLinkBox }
        });
    };

    const setMode = (mode, { persist = true, flush = true } = {}) => {
        if (flush) flushSync();   // capture the outgoing mode's content first
        else if (state.syncTimer !== null) {
            globalThis.clearTimeout(state.syncTimer);
            state.syncTimer = null;
        }
        closeBoxes();
        state.mode = mode;
        ui.dataset.mode = mode;

        const rich = mode === 'rich';
        const markdown = mode === 'markdown';
        tools.hidden = !rich;
        richWrap.hidden = !rich;
        mdSplit.hidden = !markdown;
        tableBar.hidden = true;
        mdHint.hidden = !markdown;
        foot.hidden = mode === 'plain';
        showNative(mode === 'plain');

        for (const [name, control] of Object.entries(modeButtons)) {
            control.setAttribute('aria-pressed', String(name === mode));
        }

        if (rich) {
            // A fresh editor per rich-mode entry: undo must never cross a mode
            // switch and resurrect a pre-switch document into the form, and
            // ProseMirror's history cannot be trusted to drop rebased steps
            // over a whole-document replace. The markdown pane resets its
            // history the same way (setValue builds a fresh state).
            mountRichEditor();
            // On this fresh history, addToHistory: false keeps the initial
            // fill unrecorded, so undo starts empty instead of offering to
            // blank the document.
            richEditor.chain()
                .setMeta('addToHistory', false)
                .setContent(Markup.bracketToEditorHtml(textarea.value), { emitUpdate: false })
                .run();
            state.richDirty = false;
            refreshToolbar();
        } else if (markdown) {
            mdEditor.setValue(state.mdSource ?? Markup.bracketToMarkdown(textarea.value));
            state.mdSource = mdEditor.getValue();
            state.mdDirty = false;
            renderPreview();
        }

        if (persist) {
            void Settings.set({ reportEditorMode: mode });
            if (rich) richEditor.commands.focus();
            else if (markdown) mdEditor.focus();
            else textarea.focus();
        }
    };

    for (const [name, control] of Object.entries(modeButtons)) {
        control.addEventListener('click', () => { if (state.mode !== name) setMode(name); });
    }

    // ---- Boot ----------------------------------------------------------------------

    const initialize = async () => {
        const settings = await Settings.get();
        if (!settings.enableReportEditor) return;

        mdEditor = createMarkdownEditor({
            parent: mdPane,
            placeholder: 'Write your trip report in Markdown…',
            ariaLabel: 'Trip report in Markdown',
            onDocChanged: () => { state.mdDirty = true; scheduleSync(); }
        });
        mdEditor.view.scrollDOM.addEventListener('scroll', syncPreviewScroll);

        // Test-only handle. Content scripts run in an isolated world, so page
        // scripts on Peakbagger can never observe this expando; the jsdom
        // harness (one shared world) drives the editors through it instead of
        // synthesizing keystrokes. `rich` is a getter because rich-mode entry
        // rebuilds its editor.
        ui._bpbEditors = { get rich() { return richEditor; }, markdown: mdEditor };

        textarea.before(ui);
        await checkDraft();               // may adopt a markdown source pre-render
        setMode(settings.reportEditorMode, { persist: false });
        void pruneDrafts();

        // If the feature is turned off in the options while this page is open,
        // hand the form back to the native textarea.
        Settings.subscribe(next => {
            if (!next.enableReportEditor && ui.isConnected) {
                flushSync();
                showNative(true);
                if (richEditor) richEditor.destroy();
                mdEditor.destroy();
                ui.remove();
            }
        });
    };

    void initialize();
})();
