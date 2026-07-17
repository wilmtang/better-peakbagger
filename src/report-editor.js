// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — trip-report editor for the ascent add/edit form.
//
// Replaces the bare JournalText textarea with a rich-text surface (or a
// markdown source view with preview), converting everything through
// src/report-markup.js into Peakbagger's square-bracket markup. The native
// textarea never leaves the form: it is the single submitted source of truth,
// kept in sync on every edit and flushed synchronously before any submit or
// postback, so Save, Cancel, GPS Preview, and ASP.NET autopostbacks always
// post exactly what the editor shows. 'Plain' mode is the untouched native
// textarea — the escape hatch, and where unsupported markup can be edited
// verbatim.
//
// Drafts autosave to extension-local storage keyed by climber/ascent identity.
// They never leave the device, expire after two weeks, and are offered back —
// never silently applied — when they differ from what the server rendered.
// Clicking either Save Ascent control clears the draft; the posted value
// itself still round-trips through the form if the save fails server-side.

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    const Settings = globalThis.BPBSettings;
    const Markup = globalThis.BPBReportMarkup;
    if (!ext || !ext.storage || !Settings || !Markup) return;

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
        mdTab: 'write',
        savedRange: null,    // rich-text selection kept across the link popover
        syncTimer: null,
        autosaveTimer: null
    };

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
    const toolButtons = {
        bold: button('bpb-re-tool', 'B', 'Bold (Ctrl+B)', '<b>B</b>'),
        italic: button('bpb-re-tool', 'I', 'Italic (Ctrl+I)', '<i>I</i>'),
        underline: button('bpb-re-tool', 'U', 'Underline (Ctrl+U)', '<u>U</u>'),
        link: button('bpb-re-tool', 'Link', 'Link (Ctrl+K)',
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M6.5 9.5l3-3M5.7 7.2L4 8.9a2.5 2.5 0 003.5 3.5l1.7-1.7M10.3 8.8L12 7.1a2.5 2.5 0 00-3.5-3.5L6.8 5.3"/></svg>'),
        insertUnorderedList: button('bpb-re-tool', 'Bulleted list', 'Bulleted list',
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="4" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="3" cy="12" r="1.3"/></g><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 4h6.5M6.5 8h6.5M6.5 12h6.5"/></g></svg>'),
        insertOrderedList: button('bpb-re-tool', 'Numbered list', 'Numbered list',
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="currentColor" font-size="5.5" font-family="Tahoma, sans-serif"><text x="1" y="6">1</text><text x="1" y="14">2</text></g><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 4h6.5M6.5 12h6.5"/></g></svg>')
    };
    tools.append(...Object.values(toolButtons));

    const mdTabs = el('div', 'bpb-re-mdtabs');
    const writeTab = button('bpb-re-tab', 'Write');
    const previewTab = button('bpb-re-tab', 'Preview');
    mdTabs.append(writeTab, previewTab);

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

    bar.append(tools, mdTabs, modes);

    const linkBox = el('div', 'bpb-re-linkbox');
    linkBox.hidden = true;
    const linkInput = el('input');
    linkInput.type = 'text';
    linkInput.placeholder = 'https://example.com/…';
    linkInput.setAttribute('aria-label', 'Link URL');
    const linkApply = button('bpb-re-linkapply', 'Add link');
    const linkRemove = button('bpb-re-linkremove', 'Remove link');
    linkBox.append(linkInput, linkApply, linkRemove);

    const surface = el('div', 'bpb-re-surface');
    surface.contentEditable = 'true';
    surface.setAttribute('role', 'textbox');
    surface.setAttribute('aria-multiline', 'true');
    surface.setAttribute('aria-label', 'Trip report');
    surface.dataset.placeholder = 'Write your trip report…';

    const mdArea = el('textarea', 'bpb-re-md');
    mdArea.rows = 12;
    mdArea.setAttribute('aria-label', 'Trip report in Markdown');
    mdArea.placeholder = 'Write your trip report in Markdown…';

    const preview = el('div', 'bpb-re-preview');
    preview.setAttribute('aria-label', 'Preview of the saved trip report');

    const foot = el('div', 'bpb-re-foot');
    const status = el('span', 'bpb-re-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const mdHint = el('span', 'bpb-re-hint', '**bold**  *italic*  [link](url)  - list · blank line starts a paragraph');
    foot.append(status, mdHint);

    ui.append(draftBar, bar, linkBox, surface, mdArea, preview, foot);

    // ---- Native textarea sync (the submitted source of truth) ---------------

    const updatePlaceholder = () => {
        const empty = !surface.textContent.trim() && !surface.querySelector('li, a');
        surface.classList.toggle('bpb-re-empty', empty);
    };

    const flushSync = () => {
        if (state.syncTimer !== null) {
            globalThis.clearTimeout(state.syncTimer);
            state.syncTimer = null;
        }
        if (state.mode === 'rich') {
            textarea.value = Markup.domToBracket(surface);
            state.mdSource = null;
            updatePlaceholder();
        } else if (state.mode === 'markdown') {
            state.mdSource = mdArea.value;
            textarea.value = Markup.markdownToBracket(mdArea.value);
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
    globalThis.addEventListener('pagehide', () => { flushSync(); void saveDraftNow(); });

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
            if (state.mode === 'markdown') record.source = mdArea.value;
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
        if (normalized(stored.text) === normalized(textarea.value)) {
            // Same content the server rendered — keep the markdown source so a
            // postback doesn't cost the user their original markdown.
            if (stored.mode === 'markdown' && typeof stored.source === 'string') {
                state.mdSource = stored.source;
            }
            return;
        }
        if (normalized(stored.text)) offerDraft(stored);
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

    // ---- Rich-text commands ---------------------------------------------------

    const exec = (command, value = null) => {
        surface.focus();
        if (document.execCommand) document.execCommand(command, false, value);
        scheduleSync();
    };

    const selectionAnchor = () => {
        const selection = globalThis.getSelection && globalThis.getSelection();
        if (!selection || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        return surface.contains(range.commonAncestorContainer) ? range : null;
    };

    const enclosingLink = range => {
        if (!range) return null;
        let node = range.commonAncestorContainer;
        while (node && node !== surface) {
            if (node.nodeType === 1 && node.tagName === 'A') return node;
            node = node.parentNode;
        }
        return null;
    };

    const closeLinkBox = () => {
        linkBox.hidden = true;
        state.savedRange = null;
    };

    const openLinkBox = () => {
        const range = selectionAnchor();
        if (!range) { surface.focus(); return; }
        state.savedRange = range.cloneRange();
        const link = enclosingLink(range);
        linkInput.value = link ? link.getAttribute('href') : '';
        linkRemove.hidden = !link;
        linkApply.textContent = link ? 'Update link' : 'Add link';
        linkBox.hidden = false;
        linkInput.focus();
        linkInput.select();
    };

    const restoreSelection = () => {
        const selection = globalThis.getSelection && globalThis.getSelection();
        if (!selection || !state.savedRange) return false;
        surface.focus();
        selection.removeAllRanges();
        selection.addRange(state.savedRange);
        return true;
    };

    const applyLink = () => {
        const href = Markup.resolveLinkTarget(linkInput.value);
        if (!href) {
            linkInput.classList.add('bpb-re-invalid');
            linkInput.focus();
            return;
        }
        linkInput.classList.remove('bpb-re-invalid');
        if (!restoreSelection()) { closeLinkBox(); return; }
        const range = selectionAnchor();
        const existing = enclosingLink(range);
        if (existing) {
            existing.setAttribute('href', href);
        } else if (range && range.collapsed) {
            const anchor = document.createElement('a');
            anchor.setAttribute('href', href);
            anchor.textContent = href;
            range.insertNode(anchor);
            range.setStartAfter(anchor);
            range.collapse(true);
        } else if (document.execCommand) {
            document.execCommand('createLink', false, href);
        }
        closeLinkBox();
        scheduleSync();
    };

    const removeLink = () => {
        if (!restoreSelection()) { closeLinkBox(); return; }
        const link = enclosingLink(selectionAnchor());
        if (link) {
            const selection = globalThis.getSelection();
            const range = document.createRange();
            range.selectNodeContents(link);
            selection.removeAllRanges();
            selection.addRange(range);
        }
        if (document.execCommand) document.execCommand('unlink', false, null);
        closeLinkBox();
        scheduleSync();
    };

    for (const [command, control] of Object.entries(toolButtons)) {
        // mousedown would steal the selection the command needs.
        control.addEventListener('mousedown', event => event.preventDefault());
        control.addEventListener('click', () => {
            if (command === 'link') openLinkBox();
            else exec(command);
        });
    }
    linkApply.addEventListener('click', applyLink);
    linkRemove.addEventListener('click', removeLink);
    linkInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
        if (event.key === 'Escape') { event.preventDefault(); closeLinkBox(); surface.focus(); }
    });

    surface.addEventListener('keydown', event => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'b') { event.preventDefault(); exec('bold'); }
        else if (key === 'i') { event.preventDefault(); exec('italic'); }
        else if (key === 'u') { event.preventDefault(); exec('underline'); }
        else if (key === 'k') { event.preventDefault(); openLinkBox(); }
    });

    surface.addEventListener('input', scheduleSync);

    // Paste lands as the canonical subset, so the editor never shows styling
    // that would silently vanish from the saved report.
    surface.addEventListener('paste', event => {
        const html = event.clipboardData && event.clipboardData.getData('text/html');
        if (!html || !document.execCommand) return;
        event.preventDefault();
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const bracket = Markup.domToBracket(parsed.body);
        const safe = Markup.bracketToPreviewHtml(bracket);
        if (safe) document.execCommand('insertHTML', false, safe);
        else {
            const plain = event.clipboardData.getData('text/plain');
            if (plain) document.execCommand('insertText', false, plain);
        }
        scheduleSync();
    });

    // ---- Markdown mode ---------------------------------------------------------

    const setMdTab = tab => {
        state.mdTab = tab;
        const showPreview = tab === 'preview';
        if (showPreview) {
            flushSync();
            preview.innerHTML = Markup.markdownToPreviewHtml(mdArea.value)
                || '<p class="bpb-re-preview-empty">Nothing to preview yet.</p>';
        }
        mdArea.hidden = showPreview;
        preview.hidden = !showPreview;
        writeTab.setAttribute('aria-pressed', String(!showPreview));
        previewTab.setAttribute('aria-pressed', String(showPreview));
        if (!showPreview && state.mode === 'markdown') mdArea.focus();
    };
    writeTab.addEventListener('click', () => setMdTab('write'));
    previewTab.addEventListener('click', () => setMdTab('preview'));
    mdArea.addEventListener('input', scheduleSync);

    // ---- Modes -------------------------------------------------------------------

    const showNative = visible => {
        textarea.classList.toggle('bpb-re-hidden', !visible);
        if (nativeBreak) nativeBreak.classList.toggle('bpb-re-hidden', !visible);
        if (nativeHints) nativeHints.classList.toggle('bpb-re-hidden', !visible);
    };

    const setMode = (mode, { persist = true, flush = true } = {}) => {
        if (flush) flushSync();   // capture the outgoing mode's content first
        else if (state.syncTimer !== null) {
            globalThis.clearTimeout(state.syncTimer);
            state.syncTimer = null;
        }
        closeLinkBox();
        state.mode = mode;
        ui.dataset.mode = mode;

        const rich = mode === 'rich';
        const markdown = mode === 'markdown';
        tools.hidden = !rich;
        mdTabs.hidden = !markdown;
        surface.hidden = !rich;
        mdArea.hidden = !markdown;
        preview.hidden = true;
        mdHint.hidden = !markdown;
        foot.hidden = mode === 'plain';
        showNative(mode === 'plain');

        for (const [name, control] of Object.entries(modeButtons)) {
            control.setAttribute('aria-pressed', String(name === mode));
        }

        if (rich) {
            surface.innerHTML = Markup.bracketToEditorHtml(textarea.value);
            updatePlaceholder();
        } else if (markdown) {
            mdArea.value = state.mdSource ?? Markup.bracketToMarkdown(textarea.value);
            state.mdSource = mdArea.value;
            setMdTab('write');
        }

        if (persist) {
            void Settings.set({ reportEditorMode: mode });
            (rich ? surface : markdown ? mdArea : textarea).focus();
        }
    };

    for (const [name, control] of Object.entries(modeButtons)) {
        control.addEventListener('click', () => { if (state.mode !== name) setMode(name); });
    }

    // ---- Boot ----------------------------------------------------------------------

    const initialize = async () => {
        const settings = await Settings.get();
        if (!settings.enableReportEditor) return;

        if (document.execCommand && document.queryCommandSupported
            && document.queryCommandSupported('defaultParagraphSeparator')) {
            document.execCommand('defaultParagraphSeparator', false, 'p');
        }

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
                ui.remove();
            }
        });
    };

    void initialize();
})();
