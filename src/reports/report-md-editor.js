// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — CodeMirror source pane for the Markdown trip-report mode.
//
// CodeMirror is only the input surface: GFM syntax highlighting, list
// continuation on Enter, undo history, and line wrapping. It renders nothing.
// The live preview beside it is produced by report-editor.js from
// report-markup.js's own allowlisted pipeline, so what the preview shows is
// exactly what will be saved — CodeMirror never parses Markdown into HTML.
//
// Highlighting uses CSS classes (bpb-md-*) styled in report-editor.css, so the
// source pane follows the extension's light/dark theme like every other
// surface.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const mdHighlight = HighlightStyle.define([
    { tag: tags.heading, class: 'bpb-md-heading' },
    { tag: tags.strong, class: 'bpb-md-strong' },
    { tag: tags.emphasis, class: 'bpb-md-em' },
    { tag: tags.strikethrough, class: 'bpb-md-strike' },
    { tag: tags.monospace, class: 'bpb-md-code' },
    { tag: tags.quote, class: 'bpb-md-quote' },
    { tag: tags.link, class: 'bpb-md-link' },
    { tag: tags.url, class: 'bpb-md-url' },
    { tag: tags.meta, class: 'bpb-md-marker' },
    { tag: tags.processingInstruction, class: 'bpb-md-marker' },
    { tag: tags.contentSeparator, class: 'bpb-md-marker' }
]);

export const createMarkdownEditor = ({ parent, placeholder: placeholderText, ariaLabel, onDocChanged }) => {
    const makeState = doc => EditorState.create({
        doc,
        extensions: [
            history(),
            EditorView.lineWrapping,
            placeholder(placeholderText),
            markdown({ base: markdownLanguage }),
            syntaxHighlighting(mdHighlight),
            // markdownKeymap first so Enter continues lists/quotes before the
            // default newline binding sees it.
            keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of(update => { if (update.docChanged) onDocChanged(); }),
            EditorView.contentAttributes.of({ 'aria-label': ariaLabel })
        ]
    });
    const view = new EditorView({ state: makeState(''), parent });
    return {
        view,
        getValue: () => view.state.doc.toString(),
        // Mode switches and draft restores replace the document wholesale; a
        // fresh state keeps the previous content out of the undo history.
        setValue: value => view.setState(makeState(value)),
        focus: () => view.focus(),
        destroy: () => view.destroy()
    };
};
