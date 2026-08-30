// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — trip-report editor for the ascent add/edit form.
//
// Replaces the bare JournalText textarea with a rich-text surface (TipTap,
// schema-locked in src/reports/report-rich-editor.js) or a Markdown source pane
// (CodeMirror, src/reports/report-md-editor.js) beside a live preview, converting
// everything through src/reports/report-markup.js into Peakbagger's square-bracket
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
// Save marks the draft pending but retains it until the worker confirms the
// matching Add/Edit success in this tab. Validation and navigation failures
// therefore keep the local recovery copy.

import { settings as Settings } from '../settings/settings.js';
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { reportMarkup as Markup } from './report-markup.js';
import { reportDrafts as ReportDrafts } from './report-drafts.js';
import { ascentSnapshot as AscentSnapshot } from '../ascent/ascent-snapshot.js';
import { ascentDeletion as AscentDeletion } from '../ascent/ascent-delete.js';
import { createRichEditor, richCommands, richState } from './report-rich-editor.js';
import { createMarkdownEditor } from './report-md-editor.js';
import { dom as Dom } from '../ui/dom.js';
import { runtimeMessage as RuntimeMessage } from '../ui/runtime-message.js';
import { trustedAction as TrustedAction } from '../ui/trusted-action.js';

// Kept as an IIFE for early-exit control flow (no editor form → nothing to do);
// dependencies are ES imports and no globals are published.
(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext || !ext.storage) return;

    const textarea = document.getElementById('JournalText');
    const form = textarea && textarea.form;
    if (!textarea || !form) return;

    const SYNC_DEBOUNCE_MS = 150;
    const AUTOSAVE_DEBOUNCE_MS = 800;
    const DRAFT_MANAGER_FEEDBACK_MS = 6000;
    const MODES = Schema.REPORT_EDITOR_MODES;
    const SAVE_BUTTON_IDS = new Set(['SaveButton', 'SaveButton2']);
    const STORE_URL = ext.runtime?.getURL?.('').startsWith('moz-extension://')
        ? 'https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/'
        : 'https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn';
    const REPORT_CREDIT = `[small][i]Created with [a href="${STORE_URL}" target="_blank"]Better Peakbagger[/a].[/i][/small]`;
    let trustedActionSequence = 0;
    const nextTrustedActionGeneration = action =>
        `report-${action}-${Date.now().toString(36)}-${++trustedActionSequence}`;

    // Drafts exist to recover user-authored content, not an empty editor or the
    // optional credit scaffold by itself. Compare the parser's canonical
    // bracket representation so surrounding whitespace and editor round trips
    // cannot make either case look substantive. The ignored document is
    // derived from REPORT_CREDIT itself; draft policy does not duplicate or
    // pattern-match the credit's wording, markup, or store URL.
    const canonicalDraftText = value => Markup.astToBracket(Markup.parseBracket(value));
    const creditOnlyDraftTexts = new Set();
    const rememberCreditOnlyDraftText = value => {
        try {
            const canonical = canonicalDraftText(value);
            if (canonical) creditOnlyDraftTexts.add(canonical);
        } catch (error) { /* an unavailable representation is simply not ignored */ }
    };
    rememberCreditOnlyDraftText(REPORT_CREDIT);
    rememberCreditOnlyDraftText(Markup.markdownToBracket(Markup.bracketToMarkdown(REPORT_CREDIT)));
    const hasRecoverableDraftContent = value => {
        if (!String(value ?? '').trim()) return false;
        try {
            const canonical = canonicalDraftText(value);
            return !!canonical && !creditOnlyDraftTexts.has(canonical);
        } catch (error) {
            // Parsing uncertainty must preserve the user's source rather than
            // risk deleting the only local recovery copy.
            return true;
        }
    };

    const params = new URLSearchParams(location.search);
    const draftKey = ReportDrafts.keyFor({
        cid: params.get('cid'),
        aid: params.get('aid'),
        pid: params.get('pid')
    });

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
        creditScaffold: false, // temporary blank writing space before a newly seeded credit
        syncTimer: null,
        autosaveTimer: null,
        pendingSave: null,
        saveIntentScheduled: false,
        conversionDiagnostics: [],
        conversionAccepted: true,
        conversionTarget: 'rich',
        terminalSubmission: false
    };
    let nextSaveAttempt = 0;

    let richEditor = null;   // created in initialize(), only when enabled
    let mdEditor = null;

    // ---- DOM ----------------------------------------------------------------

    const el = (tag, className, text) => Dom.element(tag, { class: className, text });

    const button = (className, label, title, content) => {
        const node = el('button', className);
        node.type = 'button';
        node.title = title || label;
        node.setAttribute('aria-label', title || label);
        if (content !== undefined) node.append(...(Array.isArray(content) ? content : [content]));
        else node.textContent = label;
        return node;
    };

    const ui = el('div', 'bpb-re');
    ui.id = 'bpb-report-editor';

    const draftBar = el('div', 'bpb-re-draft');
    draftBar.setAttribute('role', 'status');
    draftBar.hidden = true;

    const conversionBar = el('div', 'bpb-re-conversion');
    conversionBar.setAttribute('role', 'status');
    conversionBar.setAttribute('aria-live', 'polite');
    conversionBar.hidden = true;
    const conversionText = el('span', 'bpb-re-conversion-text');
    const convertAnyway = button('bpb-re-convert', 'Convert anyway');
    conversionBar.append(conversionText, convertAnyway);

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

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svgElement = (tag, attributes = {}, children = []) => {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        node.append(...(Array.isArray(children) ? children : [children]));
        return node;
    };
    const svg = (...children) => svgElement('svg', {
        viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': 'true'
    }, children);
    const formattedLabel = (tag, text) => el(tag, null, text);
    const toolButtons = {
        bold: button('bpb-re-tool', 'B', 'Bold (Ctrl/Cmd+B)', formattedLabel('b', 'B')),
        italic: button('bpb-re-tool', 'I', 'Italic (Ctrl/Cmd+I)', formattedLabel('i', 'I')),
        underline: button('bpb-re-tool', 'U', 'Underline (Ctrl/Cmd+U)', formattedLabel('u', 'U')),
        strike: button('bpb-re-tool', 'S', 'Strikethrough', formattedLabel('s', 'S')),
        more: button('bpb-re-tool', 'Aa', 'More formats'),
        link: button('bpb-re-tool', 'Link', 'Link (Ctrl/Cmd+K)',
            svg(svgElement('path', {
                fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round',
                d: 'M6.5 9.5l3-3M5.7 7.2L4 8.9a2.5 2.5 0 003.5 3.5l1.7-1.7M10.3 8.8L12 7.1a2.5 2.5 0 00-3.5-3.5L6.8 5.3'
            }))),
        image: button('bpb-re-tool', 'Image', 'Insert image',
            svg(
                svgElement('rect', {
                    x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5',
                    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4'
                }),
                svgElement('circle', { cx: '5.2', cy: '6', r: '1.2', fill: 'currentColor' }),
                svgElement('path', {
                    d: 'M3 12.5l3.2-3.4 2.2 2.2 2.6-3 2.5 4.2', fill: 'none',
                    stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round'
                })
            )),
        video: button('bpb-re-tool', 'Video', 'Insert video',
            svg(
                svgElement('rect', {
                    x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5',
                    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4'
                }),
                svgElement('path', { d: 'M6.5 5.2v5.6L11 8 6.5 5.2z', fill: 'currentColor' })
            )),
        insertTable: button('bpb-re-tool', 'Table', 'Insert table',
            svg(
                svgElement('rect', {
                    x: '1.5', y: '2.5', width: '13', height: '11', rx: '1',
                    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4'
                }),
                svgElement('path', {
                    d: 'M1.5 6.5h13M6 2.5v11M10.5 2.5v11', fill: 'none',
                    stroke: 'currentColor', 'stroke-width': '1.2'
                })
            )),
        bulletList: button('bpb-re-tool', 'Bulleted list', 'Bulleted list',
            svg(
                svgElement('g', { fill: 'currentColor' }, [
                    svgElement('circle', { cx: '3', cy: '4', r: '1.3' }),
                    svgElement('circle', { cx: '3', cy: '8', r: '1.3' }),
                    svgElement('circle', { cx: '3', cy: '12', r: '1.3' })
                ]),
                svgElement('g', {
                    stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round'
                }, svgElement('path', { d: 'M6.5 4h6.5M6.5 8h6.5M6.5 12h6.5' }))
            )),
        orderedList: button('bpb-re-tool', 'Numbered list', 'Numbered list',
            svg(
                svgElement('g', {
                    fill: 'currentColor', 'font-size': '5.5', 'font-family': 'Tahoma, sans-serif'
                }, [
                    svgElement('text', { x: '1', y: '6' }, '1'),
                    svgElement('text', { x: '1', y: '14' }, '2')
                ]),
                svgElement('g', {
                    stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round'
                }, svgElement('path', { d: 'M6.5 4h6.5M6.5 12h6.5' }))
            )),
        horizontalRule: button('bpb-re-tool', 'Rule', 'Horizontal rule',
            svg(svgElement('path', {
                d: 'M2 8h12', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round'
            }))),
        undo: button('bpb-re-tool', 'Undo', 'Undo (Ctrl/Cmd+Z)',
            svg(
                svgElement('path', {
                    d: 'M6.5 3.5L3 7l3.5 3.5', fill: 'none', stroke: 'currentColor',
                    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
                }),
                svgElement('path', {
                    d: 'M3.5 7H9a3.5 3.5 0 010 7H7.5', fill: 'none', stroke: 'currentColor',
                    'stroke-width': '1.5', 'stroke-linecap': 'round'
                })
            )),
        redo: button('bpb-re-tool', 'Redo', 'Redo (Ctrl/Cmd+Shift+Z)',
            svg(
                svgElement('path', {
                    d: 'M9.5 3.5L13 7l-3.5 3.5', fill: 'none', stroke: 'currentColor',
                    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
                }),
                svgElement('path', {
                    d: 'M12.5 7H7a3.5 3.5 0 000 7h1.5', fill: 'none', stroke: 'currentColor',
                    'stroke-width': '1.5', 'stroke-linecap': 'round'
                })
            ))
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

    const plainHint = el('div', 'bpb-re-mode-hint bpb-re-plain-hint',
        'Peakbagger’s original text editor — use Peakbagger’s [bracket] syntax.');
    plainHint.title = plainHint.textContent;
    plainHint.hidden = true;

    const markdownHint = el('div', 'bpb-re-mode-hint bpb-re-markdown-hint');
    const syntaxExample = value => el('code', 'bpb-re-markdown-example', value);
    const labelledExample = (label, value) => {
        const group = el('span', 'bpb-re-markdown-example-group', `${label}: `);
        group.append(syntaxExample(value));
        return group;
    };
    markdownHint.append(
        'Image sizing: ', syntaxExample('![Photo|500](url)'),
        ' or ', syntaxExample('![Photo|500x600](url)'),
        ' ', labelledExample('· Video', '![Video|500x281](url)'),
        ' ', labelledExample('· YouTube', '![YouTube|560x315](url)')
    );
    markdownHint.hidden = true;

    bar.append(tools, plainHint, markdownHint, modes);

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
    // One way in, not two. "Upload and edit…" beside "Choose from library…" read
    // as two different features when they are one page with two tabs, and
    // neither name said that the library is this browser's own record.
    const imageActions = el('div', 'bpb-re-image-actions');
    const imageEdit = button('bpb-re-photo-launch', 'Upload a photo…');
    imageActions.append(imageEdit);
    const imageLaunchStatus = el('div', 'bpb-re-image-status');
    imageLaunchStatus.setAttribute('role', 'status');
    imageLaunchStatus.setAttribute('aria-live', 'polite');
    const externalLink = (label, href) => {
        const link = el('a', null, label);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    };
    const imageEditHint = el('div', 'bpb-re-image-hosting',
        'Mark the route on it, upload with your own ImgBB key, and reuse photos you have '
        + 'uploaded before. ');
    // Packaged-page URL resolution is not guaranteed in every embedding, and a
    // link with nowhere to go is worse than no link.
    const guideUrl = ext.runtime?.getURL?.('photos/guide.html');
    if (guideUrl) imageEditHint.append(externalLink('How it works', guideUrl));
    const imageDivider = el('div', 'bpb-re-image-divider', 'Or paste a link to an image');
    // The two ways a pasted link fails are worth naming: a viewer page rather
    // than the file, and a host that refuses to be embedded elsewhere. Google
    // Photos and Drive links fail both and are the most common attempt.
    const imageHostingHint = el('div', 'bpb-re-image-hosting',
        'It must point at the image file itself and come from a host that lets other sites '
        + 'show it — Google Photos, Drive, iCloud, and Dropbox links do not. ');
    imageHostingHint.append(
        externalLink('Peakbagger Photos', 'https://www.peakbagger.com/climber/photo.aspx'),
        ', ',
        externalLink('Imgur', 'https://imgur.com/upload'),
        ', and ImgBB work. To resize, select the image and drag its lower-right handle.'
    );
    imageBox.append(
        imageActions,
        imageEditHint,
        imageLaunchStatus,
        imageDivider,
        imageSrcInput,
        imageAltInput,
        imageApply,
        imageHostingHint
    );

    const videoBox = el('div', 'bpb-re-box bpb-re-videobox');
    videoBox.hidden = true;
    const videoSrcInput = el('input');
    videoSrcInput.type = 'text';
    videoSrcInput.placeholder = 'https://example.com/clip.mp4 or https://youtu.be/...';
    videoSrcInput.setAttribute('aria-label', 'Video file or YouTube URL');
    const videoApply = button('bpb-re-linkapply', 'Add video');
    const videoHint = el('div', 'bpb-re-video-hint',
        'Use a direct HTTPS video file URL or a YouTube watch/share URL. Other embeds are not supported.');
    videoBox.append(videoSrcInput, videoApply, videoHint);

    // Less-frequent inline formats live one click away instead of widening the
    // main bar: code, highlight, sub/sup, small, inline quote, and text color.
    const moreBox = el('div', 'bpb-re-box bpb-re-morebox');
    moreBox.hidden = true;
    const moreButtons = {
        code: button('bpb-re-tool', 'Code', 'Inline code (Ctrl/Cmd+E)', formattedLabel('code', '</>')),
        highlight: button('bpb-re-tool', 'Highlight', 'Highlight (Ctrl/Cmd+Shift+H)', formattedLabel('mark', 'ab')),
        subscript: button('bpb-re-tool', 'Subscript', 'Subscript', ['x', formattedLabel('sub', '2')]),
        superscript: button('bpb-re-tool', 'Superscript', 'Superscript', ['x', formattedLabel('sup', '2')]),
        small: button('bpb-re-tool', 'Small text', 'Small text', formattedLabel('small', 'Aa')),
        inlineQuote: button('bpb-re-tool', 'Inline quote', 'Inline quote', formattedLabel('q', 'ab'))
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
    const saveRecovery = el('div', 'bpb-re-save-recovery');
    saveRecovery.hidden = true;
    const saveRecoveryText = el('span', null,
        'This draft isn’t saved. Keep this page open until saving works.');
    const saveRecoveryCopy = button('bpb-re-save-copy', 'Copy Markdown');
    const saveRecoveryFeedback = el('span', 'bpb-re-save-feedback');
    saveRecoveryFeedback.setAttribute('role', 'status');
    const saveRecoveryManual = el('textarea', 'bpb-re-save-manual');
    saveRecoveryManual.readOnly = true;
    saveRecoveryManual.rows = 3;
    saveRecoveryManual.setAttribute('aria-label', 'Unsaved trip report Markdown');
    saveRecoveryManual.hidden = true;
    saveRecovery.append(saveRecoveryText, saveRecoveryCopy, saveRecoveryFeedback, saveRecoveryManual);
    let draftPersistenceStatus = '';
    let draftManagerBusy = false;
    let draftManagerStatus = '';
    let draftManagerStatusTimer = null;
    const renderStatus = () => { status.textContent = draftManagerStatus || draftPersistenceStatus; };
    const setDraftPersistenceStatus = (message, { recovery = false, cleanup = false } = {}) => {
        draftPersistenceStatus = message;
        saveRecovery.hidden = !recovery;
        saveRecoveryText.textContent = cleanup
            ? 'The older saved copy is still on this device. Keep this page open and try editing again.'
            : 'This draft isn’t saved. Keep this page open until saving works.';
        if (!recovery) {
            saveRecoveryFeedback.textContent = '';
            saveRecoveryManual.hidden = true;
            saveRecoveryManual.value = '';
        }
        renderStatus();
    };
    const setDraftManagerStatus = message => {
        if (draftManagerStatusTimer != null) globalThis.clearTimeout(draftManagerStatusTimer);
        draftManagerStatus = message;
        draftManagerStatusTimer = null;
        renderStatus();
        if (!message) return;
        draftManagerStatusTimer = globalThis.setTimeout(() => {
            draftManagerStatus = '';
            draftManagerStatusTimer = null;
            renderStatus();
        }, DRAFT_MANAGER_FEEDBACK_MS);
    };
    const openDraftsManager = async event => {
        if (draftManagerBusy) return;
        const generation = nextTrustedActionGeneration('drafts');
        const activation = await TrustedAction.issue(ext, event, 'draft-manager', generation);
        if (!activation) return;
        draftManagerBusy = true;
        setDraftManagerStatus('');
        const controls = ui.querySelectorAll('.bpb-re-manage, .bpb-re-draft-manage');
        for (const control of controls) {
            control.disabled = true;
            control.setAttribute('aria-busy', 'true');
        }
        try {
            const response = await RuntimeMessage.send(ext, {
                type: 'OPEN_DRAFTS_MANAGER',
                generation,
                activationToken: activation.token,
            });
            if (!response?.ok) setDraftManagerStatus('Couldn’t open report drafts. Try again.');
        } finally {
            draftManagerBusy = false;
            for (const control of controls) {
                control.disabled = false;
                control.removeAttribute('aria-busy');
            }
        }
    };
    const manageDrafts = button('bpb-re-manage', 'Manage TR drafts');
    manageDrafts.addEventListener('click', openDraftsManager);
    foot.append(status, manageDrafts);

    // Contextual controls sit above the entire toolbar region, including a
    // visible draft-recovery bar. They must not become normal-flow rows or
    // cover either recovery actions or the writing surface.
    const toolbar = el('div', 'bpb-re-toolbar');
    const contextual = el('div', 'bpb-re-contextual');
    contextual.append(tableBar, linkBox, imageBox, videoBox, moreBox);
    toolbar.append(conversionBar, draftBar, bar, contextual);
    ui.append(toolbar, richWrap, mdSplit, saveRecovery, foot);

    const boxes = [tableBar, linkBox, imageBox, videoBox, moreBox];
    const manualBoxes = [linkBox, imageBox, videoBox, moreBox];
    const closeBoxes = () => { for (const box of boxes) box.hidden = true; };
    const openManualBox = () => manualBoxes.find(box => !box.hidden) || null;

    // The contextual layer floats over whatever sits above the report field —
    // on the ascent form that is Peakbagger's own date calendar — so an open
    // popover can cover controls the user still needs. Re-clicking the tool
    // that opened it is not a discoverable way out, and the popover the photo
    // actions live in is the tallest of them. Every manually opened popover
    // therefore carries a visible dismiss control; Escape and a click outside
    // the editor close it too.
    for (const box of manualBoxes) {
        const dismiss = button('bpb-re-boxclose', 'Close', 'Close (Esc)', '×');
        dismiss.addEventListener('mousedown', event => event.preventDefault());
        dismiss.addEventListener('click', () => closeBoxAndRestoreEditor());
        box.append(dismiss);
    }
    const toggleBox = box => {
        const wasOpen = !box.hidden;
        closeBoxes();
        box.hidden = wasOpen;
        if (wasOpen) {
            richEditor?.commands.focus();
            refreshToolbar();
        }
    };

    // ---- Native textarea sync (the submitted source of truth) ---------------

    // The TipTap view DOM carries editor scaffolding (trailing breaks, gap
    // cursors), so serialization reads the schema's clean HTML instead, parsed
    // detached and folded through the same domToBracket path as pasted DOM.
    const richBracket = () => {
        const parsed = new DOMParser().parseFromString(richEditor.getHTML(), 'text/html');
        return Markup.domToBracket(parsed.body);
    };

    // Markup owns the allowlist and escaping. This named boundary performs the
    // one HTML parse only after that sanitizer has produced the complete
    // preview document, then adopts its nodes without assigning innerHTML.
    const renderSanitizedPreviewHtml = html => {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        preview.replaceChildren(...parsed.body.childNodes);
    };

    const diagnosticLabel = diagnostic => {
        const tag = `[${diagnostic.tag}]`;
        if (diagnostic.code === 'unsupported-attribute') {
            return `${diagnostic.attribute} on ${tag}`;
        }
        if (diagnostic.code === 'unsafe-attribute') return `${tag} source or attributes`;
        if (diagnostic.code === 'unsupported-nesting') return `${tag} nesting`;
        return tag;
    };

    const summarizeDiagnostics = diagnostics => {
        const labels = [...new Set(diagnostics.map(diagnosticLabel))];
        const visible = labels.slice(0, 3);
        const remainder = labels.length - visible.length;
        if (remainder) visible.push(`${remainder} more`);
        if (visible.length < 2) return visible[0] || 'unsupported markup';
        return `${visible.slice(0, -1).join(', ')} and ${visible.at(-1)}`;
    };

    const configureConversionGuard = (source, preferredMode = state.conversionTarget) => {
        const { diagnostics } = Markup.parseBracketWithDiagnostics(source);
        state.conversionDiagnostics = diagnostics;
        state.conversionAccepted = diagnostics.length === 0;
        if (preferredMode === 'rich' || preferredMode === 'markdown') {
            state.conversionTarget = preferredMode;
        }
        conversionBar.hidden = diagnostics.length === 0;
        if (diagnostics.length) {
            conversionText.textContent = 'This report uses markup Rich text and Markdown can’t preserve: '
                + `${summarizeDiagnostics(diagnostics)}. Continue in Plain, or convert anyway.`;
        }
        return diagnostics.length > 0;
    };
    const renderPreview = () => {
        const html = Markup.markdownToPreviewHtml(mdEditor.getValue());
        if (html) renderSanitizedPreviewHtml(html);
        else preview.replaceChildren(el('p', 'bpb-re-preview-empty', 'Nothing to preview yet.'));
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
        if (state.mode === 'plain') {
            state.mdSource = null;
            state.creditScaffold = false;
            configureConversionGuard(textarea.value);
        }
    });
    globalThis.addEventListener('pagehide', () => {
        flushSync();
        if (!state.terminalSubmission) void saveDraftNow();
    });

    // The source pane drives the preview's scroll position, proportionally.
    const syncPreviewScroll = () => {
        const scroller = mdEditor.view.scrollDOM;
        const sourceMax = scroller.scrollHeight - scroller.clientHeight;
        const ratio = sourceMax > 0 ? scroller.scrollTop / sourceMax : 0;
        preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
    };

    // ---- Local drafts ---------------------------------------------------------

    const localStore = ext.storage.local;
    const mutateDraft = message => RuntimeMessage.send(ext, { ...message, draftKey });
    let draftEditRevision = 0;

    saveRecoveryCopy.addEventListener('click', async () => {
        flushSync();
        const markdown = state.mode === 'markdown' && typeof state.mdSource === 'string'
            ? state.mdSource : Markup.bracketToMarkdown(textarea.value);
        saveRecoveryFeedback.textContent = '';
        saveRecoveryManual.hidden = true;
        try {
            if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') {
                throw new Error('clipboard unavailable');
            }
            await globalThis.navigator.clipboard.writeText(markdown);
            saveRecoveryFeedback.textContent = 'Markdown copied';
        } catch (error) {
            saveRecoveryManual.value = markdown;
            saveRecoveryManual.hidden = false;
            saveRecoveryFeedback.textContent = 'Clipboard unavailable. Copy the selected Markdown below.';
            saveRecoveryManual.focus();
            saveRecoveryManual.select();
        }
    });

    const createSaveAttemptId = () => {
        try {
            if (typeof globalThis.crypto?.randomUUID === 'function') {
                return globalThis.crypto.randomUUID();
            }
        } catch (error) { /* fall through to a non-authorizing uniqueness token */ }
        nextSaveAttempt++;
        return `fallback-${Date.now()}-${nextSaveAttempt}-${Math.random().toString(36).slice(2)}`;
    };

    const timeLabel = stamp => {
        const then = new Date(stamp);
        const now = new Date();
        return then.toDateString() === now.toDateString()
            ? then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
            : then.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const saveDraftNow = async () => {
        if (state.autosaveTimer !== null) {
            globalThis.clearTimeout(state.autosaveTimer);
            state.autosaveTimer = null;
        }
        if (state.terminalSubmission) return;
        if (!['rich', 'markdown'].includes(state.mode)) return; // uninitialized/Plain: native behavior, native risks
        flushSync();
        const revision = draftEditRevision;
        let removing = false;
        if (revision === draftEditRevision) setDraftPersistenceStatus('Saving…');
        try {
            if (!hasRecoverableDraftContent(textarea.value)) {
                removing = true;
                const removal = await mutateDraft({ type: 'REPORT_DRAFT_REMOVE' });
                if (!removal?.ok) throw new Error('draft removal failed');
                if (revision === draftEditRevision) setDraftPersistenceStatus('');
                return;
            }
            const record = { text: textarea.value, mode: state.mode, savedAt: Date.now() };
            if (state.mode === 'markdown') record.source = mdEditor.getValue();
            if (state.pendingSave) record.pendingSave = state.pendingSave;
            try {
                const label = AscentSnapshot.label({ form, params });
                if (Object.keys(label).length) record.label = label;
            } catch (error) { /* optional display metadata must never block autosave */ }
            const write = await mutateDraft({ type: 'REPORT_DRAFT_WRITE', record });
            if (!write?.ok) throw new Error('draft write failed');
            if (!write.written) throw new Error('draft write superseded');
            // A worker-confirmed Save or confirmed Delete can arrive while an
            // earlier storage write is already in flight. The completing
            // writer must honor that terminal result so it cannot resurrect
            // the consumed recovery copy.
            if (state.terminalSubmission) {
                await mutateDraft({ type: 'REPORT_DRAFT_REMOVE' });
                setDraftPersistenceStatus('');
                return;
            }
            if (revision !== draftEditRevision) return;
            setDraftPersistenceStatus(`Draft saved on this device · ${timeLabel(record.savedAt)}`);
        } catch (error) {
            if (state.terminalSubmission || revision !== draftEditRevision) return;
            setDraftPersistenceStatus(
                removing
                    ? 'Older saved draft couldn’t be removed'
                    : 'Draft not saved — keep this page open',
                { recovery: true, cleanup: removing },
            );
        }
    };

    const scheduleAutosave = () => {
        if (state.terminalSubmission) return;
        draftEditRevision++;
        setDraftPersistenceStatus('Unsaved changes');
        if (state.autosaveTimer !== null) globalThis.clearTimeout(state.autosaveTimer);
        state.autosaveTimer = globalThis.setTimeout(() => { void saveDraftNow(); }, AUTOSAVE_DEBOUNCE_MS);
    };

    const clearDraft = () => {
        if (state.autosaveTimer !== null) {
            globalThis.clearTimeout(state.autosaveTimer);
            state.autosaveTimer = null;
        }
        state.pendingSave = null;
        void RuntimeMessage.send(ext, {
            type: 'REPORT_DRAFT_SAVE_CANCEL',
            draftKey,
        });
        void mutateDraft({ type: 'REPORT_DRAFT_REMOVE' }).then(result => {
            if (!result?.ok) throw new Error('draft removal failed');
        }).catch(() => {
            if (!state.terminalSubmission) {
                setDraftPersistenceStatus('Older saved draft couldn’t be removed', {
                    recovery: true,
                    cleanup: true,
                });
            }
        });
    };

    // A confirmed Delete submit has already established the worker-owned
    // transaction. Treat it as terminal before navigation so pagehide cannot
    // recreate the local report draft that this deletion just removed.
    document.addEventListener(AscentDeletion.SUBMITTING_EVENT, () => {
        state.terminalSubmission = true;
        clearDraft();
    });

    // ---- GitHub backup snapshot ------------------------------------------------
    //
    // When GitHub backup is enabled, capture the submitted ascent form plus the
    // exact Markdown-source sidecar at Save and hand it to the background worker,
    // which keeps it (identity + source-tab keyed, 30-minute expiry) in
    // storage.session for the saved ascent page to back up. Best-effort and
    // gated: it never blocks or alters the Peakbagger save, and no snapshot is
    // sent when the feature is off.
    let backupEnabled = false;
    Settings.get().then(next => { backupEnabled = !!next.enableGithubBackup; }).catch(() => {});
    Settings.subscribe(next => { backupEnabled = !!next.enableGithubBackup; });

    // Resolve the report to a Markdown body here, where the DOM and the Markdown
    // parser exist: the exact Markdown-source sidecar when the user authored in
    // Markdown, otherwise the submitted bracket markup converted to Markdown.
    const reportMarkdownBody = () =>
        (state.mode === 'markdown' && typeof state.mdSource === 'string')
            ? state.mdSource
            : Markup.bracketToMarkdown(textarea.value);

    const captureBackupSnapshot = () => {
        if (!backupEnabled) return;
        try {
            const version = ext.runtime.getManifest ? ext.runtime.getManifest().version : '';
            const { key, identity, snapshot } = AscentSnapshot.build({
                form,
                params,
                report: { markdown: reportMarkdownBody() },
                extensionVersion: version,
            });
            ext.runtime.sendMessage({ type: 'GITHUB_BACKUP_SNAPSHOT', key, identity, snapshot });
        } catch (error) { /* backup is best-effort; never disrupt the save */ }
    };

    const beginPendingSave = () => {
        if (state.terminalSubmission) return;
        if (state.saveIntentScheduled) return;
        state.saveIntentScheduled = true;
        queueMicrotask(() => { state.saveIntentScheduled = false; });
        flushSync();
        const identity = {
            cid: params.get('cid') || '0',
            aid: params.get('aid'),
            pid: params.get('pid'),
        };
        state.pendingSave = {
            attemptId: createSaveAttemptId(),
            requestedAt: Date.now(),
            identity,
        };
        captureBackupSnapshot();
        void saveDraftNow();
        void RuntimeMessage.send(ext, {
            type: 'REPORT_DRAFT_SAVE_PENDING',
            draftKey,
            identity,
            attemptId: state.pendingSave.attemptId,
        });
    };

    // Enter-to-submit does not click a Save button. A submit with no submitter
    // is the browser's valid implicit-save path; named non-Save submitters
    // (Cancel, Delete, GPS Preview) retain their existing behavior.
    form.addEventListener('submit', event => {
        const submitter = event.submitter;
        if (submitter && !SAVE_BUTTON_IDS.has(submitter.id)) return;
        beginPendingSave();
    }, true);

    // Mark both native Save controls pending at click time as well. This
    // covers Peakbagger postback handlers that navigate without a submit event,
    // while beginPendingSave() keeps the ordinary click + submit path
    // idempotent.
    for (const id of SAVE_BUTTON_IDS) {
        const save = document.getElementById(id);
        if (save) save.addEventListener('click', beginPendingSave, true);
    }

    // An async UpdatePanel success can leave this editor instance alive until
    // pagehide. Only the worker-confirmed event may make that old instance
    // terminal; otherwise it could recreate the draft after the worker removed
    // it on the successful response.
    document.addEventListener(ReportDrafts.SAVED_EVENT, event => {
        if (event.detail?.draftKey !== draftKey) return;
        state.terminalSubmission = true;
        state.pendingSave = null;
        if (state.autosaveTimer !== null) {
            globalThis.clearTimeout(state.autosaveTimer);
            state.autosaveTimer = null;
        }
        setDraftPersistenceStatus('');
    });

    const offerDraft = stored => {
        draftBar.textContent = '';
        const label = el('span', 'bpb-re-draft-text',
            `A locally saved draft of this report (${timeLabel(stored.savedAt)}) differs from what’s shown.`);
        const restore = button('bpb-re-draft-restore', 'Restore draft');
        const discard = button('bpb-re-draft-discard', 'Delete draft');
        const manage = button('bpb-re-draft-manage', 'Manage drafts');
        restore.addEventListener('click', () => {
            textarea.value = stored.text;
            state.creditScaffold = false;
            state.mdSource = stored.mode === 'markdown' && typeof stored.source === 'string'
                ? stored.source
                : null;
            draftBar.hidden = true;
            // flush: false — the restored textarea value must not be clobbered
            // by a serialization of the outgoing (pre-restore) content.
            const restoredMode = MODES.includes(stored.mode) ? stored.mode : state.mode;
            const guarded = configureConversionGuard(stored.text, restoredMode);
            setMode(guarded ? 'plain' : restoredMode, { persist: false, flush: false });
            setDraftManagerStatus('Draft restored');
        });
        discard.addEventListener('click', () => {
            clearDraft();
            draftBar.hidden = true;
        });
        manage.addEventListener('click', openDraftsManager);
        draftBar.append(label, restore, discard, manage);
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
        if (stored.pendingSave && typeof stored.pendingSave === 'object') {
            // Reaching the editor again means the previous Save did not reach
            // the success surface in this document. Retain the recovery copy,
            // but detach it from that old attempt so a late confirmation cannot
            // consume newer edits or a same-key draft from another tab.
            const retained = { ...stored };
            delete retained.pendingSave;
            stored = retained;
            void RuntimeMessage.send(ext, {
                type: 'REPORT_DRAFT_SAVE_CANCEL',
                draftKey,
            });
            void mutateDraft({ type: 'REPORT_DRAFT_WRITE', record: retained }).catch(() => {});
        }
        if (Date.now() - stored.savedAt > ReportDrafts.TTL_MS) { clearDraft(); return; }
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
            await RuntimeMessage.send(ext, { type: 'REPORT_DRAFT_PRUNE', keepKey: draftKey });
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
        tableBar.hidden = !snapshot.inTable || manualBoxes.some(box => !box.hidden);
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

    const closeBoxAndRestoreEditor = () => {
        closeBoxes();
        richEditor?.commands.focus();
        refreshToolbar();
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
        refreshToolbar();
    };

    const removeLink = () => {
        richCommands.unsetLink(richEditor);
        closeBoxes();
        refreshToolbar();
    };

    const openImageBox = () => {
        closeBoxes();
        imageSrcInput.value = '';
        imageAltInput.value = '';
        imageSrcInput.classList.remove('bpb-re-invalid');
        imageLaunchStatus.textContent = '';
        imageBox.hidden = false;
        imageEdit.focus();
    };

    let photoLaunchBusy = false;
    const launchPhotoEditor = async event => {
        if (photoLaunchBusy) return;
        const generation = nextTrustedActionGeneration('photos');
        const activation = await TrustedAction.issue(ext, event, 'photo-editor', generation);
        if (!activation) return;
        photoLaunchBusy = true;
        imageLaunchStatus.textContent = '';
        imageEdit.disabled = true;
        imageEdit.setAttribute('aria-busy', 'true');
        try {
            const response = await RuntimeMessage.send(ext, {
                type: 'PHOTO_EDITOR_OPEN',
                mode: 'edit',
                generation,
                activationToken: activation.token,
                identity: {
                    cid: params.get('cid'),
                    aid: params.get('aid'),
                    pid: params.get('pid')
                }
            });
            if (!response?.ok) {
                imageLaunchStatus.textContent = 'Couldn’t open the photo editor. Try again.';
            }
        } finally {
            photoLaunchBusy = false;
            imageEdit.disabled = false;
            imageEdit.removeAttribute('aria-busy');
        }
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
        refreshToolbar();
    };

    const openVideoBox = () => {
        closeBoxes();
        videoSrcInput.value = '';
        videoSrcInput.classList.remove('bpb-re-invalid');
        videoBox.hidden = false;
        videoSrcInput.focus();
    };

    const applyVideo = () => {
        const source = videoSrcInput.value.trim();
        const youtubeSrc = Markup.sanitizeYouTubeEmbedSrc(source);
        const src = youtubeSrc || Markup.sanitizeVideoSrc(source);
        if (!src) {
            videoSrcInput.classList.add('bpb-re-invalid');
            videoSrcInput.focus();
            return;
        }
        videoSrcInput.classList.remove('bpb-re-invalid');
        if (youtubeSrc) richCommands.insertYouTube(richEditor, youtubeSrc);
        else richCommands.insertVideo(richEditor, src);
        closeBoxes();
        refreshToolbar();
    };

    for (const [name, control] of Object.entries({ ...toolButtons, ...moreButtons, ...tableButtons })) {
        // mousedown would steal the selection the command needs.
        control.addEventListener('mousedown', event => event.preventDefault());
        control.addEventListener('click', () => {
            if (name === 'more') return toggleBox(moreBox);
            if (name === 'link') return linkBox.hidden ? openLinkBox() : closeBoxAndRestoreEditor();
            if (name === 'image') return imageBox.hidden ? openImageBox() : closeBoxAndRestoreEditor();
            if (name === 'video') return videoBox.hidden ? openVideoBox() : closeBoxAndRestoreEditor();
            closeBoxes();
            richCommands[name](richEditor);
        });
    }
    for (const control of swatchButtons) {
        control.addEventListener('mousedown', event => event.preventDefault());
        control.addEventListener('click', () => {
            closeBoxes();
            richCommands.setColor(richEditor, control.dataset.color);
        });
    }
    swatchClear.addEventListener('mousedown', event => event.preventDefault());
    swatchClear.addEventListener('click', () => {
        closeBoxes();
        richCommands.unsetColor(richEditor);
    });

    blockFormat.addEventListener('change', () => {
        closeBoxes();
        richCommands.setBlock(richEditor, blockFormat.value);
    });

    linkApply.addEventListener('click', applyLink);
    linkRemove.addEventListener('click', removeLink);
    linkInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
        if (event.key === 'Escape') { event.preventDefault(); closeBoxAndRestoreEditor(); }
    });
    imageEdit.addEventListener('click', event => { void launchPhotoEditor(event); });
    imageApply.addEventListener('click', applyImage);
    for (const input of [imageSrcInput, imageAltInput]) {
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); applyImage(); }
            if (event.key === 'Escape') { event.preventDefault(); closeBoxAndRestoreEditor(); }
        });
    }
    videoApply.addEventListener('click', applyVideo);
    videoSrcInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); applyVideo(); }
        if (event.key === 'Escape') { event.preventDefault(); closeBoxAndRestoreEditor(); }
    });

    // Escape works from the writing surface and the popover's own buttons, not
    // only from its text fields. The per-input handlers above close first, so
    // this sees an already-closed layer and does nothing.
    ui.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !openManualBox()) return;
        event.preventDefault();
        closeBoxAndRestoreEditor();
    });

    // A press anywhere outside the editor dismisses the popover instead of
    // being swallowed by it, so the covered form is one click away. Focus
    // follows the press; do not pull it back into the editor here.
    const dismissOnOutsidePointer = event => {
        if (!openManualBox()) return;
        const target = event.target;
        if (target instanceof Node && ui.contains(target)) return;
        closeBoxes();
        refreshToolbar();
    };
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true);

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
            onUpdate: () => { state.richDirty = true; state.creditScaffold = false; scheduleSync(); },
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
        markdownHint.hidden = !markdown;
        foot.hidden = mode === 'plain';
        plainHint.hidden = mode !== 'plain';
        if (mode === 'plain' && state.creditScaffold && !textarea.value.startsWith('\n\n')) {
            textarea.value = `\n\n${textarea.value}`;
            textarea.setSelectionRange(0, 0);
        }
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
            const editorHtml = Markup.bracketToEditorHtml(textarea.value);
            const initialContent = richEditor.chain()
                .setMeta('addToHistory', false)
                .setContent(state.creditScaffold ? `<p></p>${editorHtml}` : editorHtml, { emitUpdate: false });
            if (state.creditScaffold) initialContent.setTextSelection(1);
            initialContent.run();
            if (state.creditScaffold) rememberCreditOnlyDraftText(richBracket());
            state.richDirty = false;
            refreshToolbar();
        } else if (markdown) {
            const markdownSource = state.mdSource ?? Markup.bracketToMarkdown(textarea.value);
            mdEditor.setValue(state.creditScaffold && !markdownSource.startsWith('\n\n')
                ? `\n\n${markdownSource}`
                : markdownSource);
            state.mdSource = mdEditor.getValue();
            if (state.creditScaffold) {
                rememberCreditOnlyDraftText(Markup.markdownToBracket(state.mdSource));
            }
            state.mdDirty = false;
            renderPreview();
        }

        if (persist) {
            void Settings.set({ reportEditorMode: mode }).catch(() => {
                setDraftManagerStatus('Editor preference couldn’t be saved');
            });
            if (rich || markdown) scheduleAutosave();
            if (rich) richEditor.commands.focus();
            else if (markdown) mdEditor.focus();
            else textarea.focus();
        }
    };

    for (const [name, control] of Object.entries(modeButtons)) {
        control.addEventListener('click', () => {
            if (state.mode === name) return;
            if (name !== 'plain' && state.conversionDiagnostics.length && !state.conversionAccepted) {
                state.conversionTarget = name;
                convertAnyway.focus();
                return;
            }
            setMode(name);
        });
    }
    convertAnyway.addEventListener('click', () => {
        state.conversionAccepted = true;
        conversionBar.hidden = true;
        setMode(state.conversionTarget);
    });

    // Same bound the photo library and its page input enforce
    // (photoLibrary.ALT_LIMIT). The catalog model itself stays out of this
    // Peakbagger content script, so the number is repeated here and pinned by
    // "an inserted photo keeps the full description the library allows".
    const PHOTO_ALT_LIMIT = 500;
    const handledPhotoReturnTokens = new Set();
    const rememberPhotoReturnToken = token => {
        handledPhotoReturnTokens.add(token);
        if (handledPhotoReturnTokens.size > 50) {
            handledPhotoReturnTokens.delete(handledPhotoReturnTokens.values().next().value);
        }
    };

    const cleanPhotoInsertion = message => {
        if (!message || message.type !== 'PHOTO_INSERT_RESULT') return null;
        const localPhotoId = typeof message.localPhotoId === 'string'
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(message.localPhotoId)
            ? message.localPhotoId
            : null;
        const alt = String(message.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, PHOTO_ALT_LIMIT);
        let src = null;
        try {
            const candidate = new URL(message.url);
            if (candidate.protocol === 'https:' && !candidate.username && !candidate.password) {
                src = Markup.sanitizeImageSrc(candidate.toString());
            }
        } catch { /* malformed result */ }
        const displayWidth = Markup.sanitizeReportDimension(message.displayWidth);
        // Matches the popover's own image path, which has always accepted an
        // empty description; only the id and sanitized source are required.
        return localPhotoId && src ? {
            src,
            alt,
            ...(displayWidth ? { width: displayWidth } : {}),
        } : null;
    };

    const samePhotoReturnContext = message => {
        const expected = message?.expectedIdentity;
        if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
        const identityKeys = ['cid', 'aid', 'pid'];
        const sameIdentity = identityKeys.every(key => {
            const current = params.get(key);
            const wanted = expected[key];
            return wanted == null ? current == null : current === String(wanted);
        });
        if (!sameIdentity || typeof message.expectedUrl !== 'string') return false;
        try {
            const current = new URL(location.href);
            current.hash = '';
            return current.toString() === message.expectedUrl;
        } catch { return false; }
    };

    const handlePhotoInsertion = (message, sender, sendResponse) => {
        if (message?.type !== 'PHOTO_INSERT_RESULT') return undefined;
        const insertion = cleanPhotoInsertion(message);
        const trustedSender = sender?.id === ext.runtime.id;
        const returnToken = typeof message.returnToken === 'string' && message.returnToken
            ? message.returnToken
            : null;
        if (!trustedSender || !insertion) {
            sendResponse?.({ ok: false, error: { code: 'invalid-result' } });
            return false;
        }
        if (!samePhotoReturnContext(message)) {
            sendResponse?.({ ok: false, error: { code: 'wrong-report' } });
            return false;
        }
        if (returnToken && handledPhotoReturnTokens.has(returnToken)) {
            sendResponse?.({ ok: true });
            return false;
        }
        if (state.mode !== 'rich' || !richEditor || !ui.isConnected) {
            sendResponse?.({ ok: false, error: { code: 'editor-unavailable' } });
            return false;
        }
        richCommands.insertImage(richEditor, insertion);
        flushSync();
        if (returnToken) rememberPhotoReturnToken(returnToken);
        closeBoxes();
        refreshToolbar();
        setDraftManagerStatus('Photo inserted');
        void saveDraftNow();
        sendResponse?.({ ok: true });
        return false;
    };

    // ---- Boot ----------------------------------------------------------------------

    const initialize = async () => {
        const settings = await Settings.get();
        if (settings.addReportCredit && !textarea.value.trim()) {
            textarea.value = REPORT_CREDIT;
            state.creditScaffold = true;
        }
        if (!settings.enableReportEditor) {
            if (state.creditScaffold) {
                textarea.value = `\n\n${textarea.value}`;
                textarea.setSelectionRange(0, 0);
            }
            return;
        }

        mdEditor = createMarkdownEditor({
            parent: mdPane,
            placeholder: 'Write your trip report in Markdown…',
            ariaLabel: 'Trip report in Markdown',
            onDocChanged: () => { state.mdDirty = true; state.creditScaffold = false; scheduleSync(); }
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
        const guarded = configureConversionGuard(textarea.value, settings.reportEditorMode);
        setMode(guarded ? 'plain' : settings.reportEditorMode, { persist: false });
        ext.runtime.onMessage.addListener(handlePhotoInsertion);
        void pruneDrafts();

        // If the feature is turned off in the options while this page is open,
        // hand the form back to the native textarea.
        Settings.subscribe(next => {
            if (!next.enableReportEditor && ui.isConnected) {
                flushSync();
                showNative(true);
                if (richEditor) richEditor.destroy();
                mdEditor.destroy();
                ext.runtime.onMessage.removeListener(handlePhotoInsertion);
                document.removeEventListener('pointerdown', dismissOnOutsidePointer, true);
                ui.remove();
            }
        });
    };

    void initialize();
})();
