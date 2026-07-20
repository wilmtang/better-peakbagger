// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — TipTap document model for the rich trip-report surface.
//
// The schema is locked to the same allowlist src/report-markup.js serializes:
// a node or mark exists here only if the converter has a verified Peakbagger
// bracket equivalent for it. Anything typed, pasted, or dropped is normalized
// by this schema before it can enter the document, and report-editor.js still
// reads the document back out through domToBracket, so the converter's
// sanitizers remain the single authority on what reaches the form.
//
// This module owns no toolbar or popover DOM. report-editor.js drives the
// editor exclusively through richCommands/richState so the TipTap API surface
// stays contained in one file.

import { Editor, Extension, Mark, Node, ResizableNodeView, getStyleProperty, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import {
    MAX_REPORT_IMAGE_DIMENSION,
    sanitizeReportDimension,
    sanitizeVideoSrc,
    sanitizeYouTubeEmbedSrc
} from './report-markup.js';

// TipTap parses a raw hex token correctly, but its DOM serializer can still
// canonicalize the rendered style to rgb(). Carry the parsed token in an
// extension-owned data attribute so report-markup.js can revalidate and
// serialize the original accepted form after a Rich edit.
const ReportColor = Color.extend({
    addGlobalAttributes() {
        return [{
            types: this.options.types,
            attributes: {
                color: {
                    default: null,
                    parseHTML: element => {
                        const value = getStyleProperty(element, 'color') ?? element.style.color;
                        return value?.replace(/['"]+/g, '');
                    },
                    renderHTML: attributes => attributes.color ? {
                        style: `color: ${attributes.color}`,
                        'data-bpb-report-color': attributes.color
                    } : {}
                }
            }
        }];
    }
});

// Peakbagger renders [small] and [q]; TipTap has no stock mark for either.
const Small = Mark.create({
    name: 'small',
    parseHTML: () => [{ tag: 'small' }],
    renderHTML: () => ['small', 0]
});

const InlineQuote = Mark.create({
    name: 'inlineQuote',
    parseHTML: () => [{ tag: 'q' }],
    renderHTML: () => ['q', 0]
});

const MIN_RESIZED_IMAGE_WIDTH = 64;
const MIN_RESIZED_IMAGE_HEIGHT = 40;

// Keep existing width/height attributes, then render the image through
// TipTap's resizable node view. Resizes stay aspect-locked and within the same
// bound the converter accepts, so a drag cannot produce a dimension that is
// silently discarded when JournalText is serialized.
const ReportImage = Image.extend({
    addAttributes() {
        const dimension = name => ({
            default: null,
            parseHTML: element => sanitizeReportDimension(element.getAttribute(name)),
            renderHTML: attributes => (attributes[name] ? { [name]: attributes[name] } : {})
        });
        return { ...this.parent?.(), width: dimension('width'), height: dimension('height') };
    },

    addNodeView() {
        return ({ node, getPos, HTMLAttributes, editor }) => {
            let currentNode = node;
            const image = document.createElement('img');
            image.draggable = false;
            image.loading = 'lazy';
            image.referrerPolicy = 'no-referrer';

            const applyImageAttributes = updatedNode => {
                for (const name of ['src', 'alt', 'title']) {
                    const value = updatedNode.attrs[name];
                    if (value === null || value === undefined) image.removeAttribute(name);
                    else image.setAttribute(name, value);
                }
                image.style.width = updatedNode.attrs.width ? `${updatedNode.attrs.width}px` : '';
                image.style.height = updatedNode.attrs.height ? `${updatedNode.attrs.height}px` : '';
            };

            for (const [name, value] of Object.entries(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes))) {
                if (value !== null && value !== undefined && name !== 'width' && name !== 'height') {
                    image.setAttribute(name, value);
                }
            }

            const commitSize = (width, height) => {
                const pos = getPos();
                if (pos === undefined) return;
                editor.chain().setNodeSelection(pos).updateAttributes(this.name, {
                    width: Math.round(width),
                    height: Math.round(height)
                }).run();
            };

            const resizeByKeyboard = event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                event.stopPropagation();

                const width = image.offsetWidth || Number(currentNode.attrs.width) || image.naturalWidth;
                const height = image.offsetHeight || Number(currentNode.attrs.height) || image.naturalHeight;
                if (!width || !height) return;

                const step = event.shiftKey ? 50 : 10;
                const delta = event.key === 'ArrowRight' ? step : -step;
                let nextWidth = Math.min(MAX_REPORT_IMAGE_DIMENSION,
                    Math.max(MIN_RESIZED_IMAGE_WIDTH, width + delta));
                let nextHeight = Math.round(nextWidth * height / width);
                if (nextHeight > MAX_REPORT_IMAGE_DIMENSION) {
                    nextHeight = MAX_REPORT_IMAGE_DIMENSION;
                    nextWidth = Math.round(nextHeight * width / height);
                } else if (nextHeight < MIN_RESIZED_IMAGE_HEIGHT) {
                    nextHeight = MIN_RESIZED_IMAGE_HEIGHT;
                    nextWidth = Math.round(nextHeight * width / height);
                }
                commitSize(nextWidth, nextHeight);
            };

            const nodeView = new ResizableNodeView({
                element: image,
                editor,
                node,
                getPos,
                onResize: (width, height) => {
                    image.style.width = `${width}px`;
                    image.style.height = `${height}px`;
                },
                onCommit: commitSize,
                onUpdate: updatedNode => {
                    if (updatedNode.type !== currentNode.type) return false;
                    currentNode = updatedNode;
                    applyImageAttributes(updatedNode);
                    return true;
                },
                options: {
                    directions: ['bottom-right'],
                    min: { width: MIN_RESIZED_IMAGE_WIDTH, height: MIN_RESIZED_IMAGE_HEIGHT },
                    max: { width: MAX_REPORT_IMAGE_DIMENSION, height: MAX_REPORT_IMAGE_DIMENSION },
                    preserveAspectRatio: true,
                    className: {
                        container: 'bpb-re-image-resize',
                        wrapper: 'bpb-re-image-resize-frame',
                        handle: 'bpb-re-image-resize-handle',
                        resizing: 'bpb-re-image-resizing'
                    },
                    createCustomHandle: () => {
                        const handle = document.createElement('button');
                        handle.type = 'button';
                        handle.className = 'bpb-re-image-resize-handle';
                        handle.dataset.resizeHandle = 'bottom-right';
                        handle.title = 'Drag to resize image; use left and right arrows for precise sizing';
                        handle.setAttribute('aria-label', 'Resize image');
                        handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
                        handle.addEventListener('keydown', resizeByKeyboard);
                        return handle;
                    }
                }
            });

            return nodeView;
        };
    }
});

// Direct media URLs use a native video element. The only embed in the schema
// is a canonical YouTube player URL produced by report-markup.js; arbitrary
// iframe sources remain outside the schema.
const ReportVideo = Node.create({
    name: 'reportVideo',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: true,

    addAttributes() {
        const dimension = name => ({
            default: null,
            parseHTML: element => sanitizeReportDimension(element.getAttribute(name)),
            renderHTML: attributes => (attributes[name] ? { [name]: attributes[name] } : {})
        });
        return {
            src: {
                default: null,
                parseHTML: element => element.tagName === 'IFRAME'
                    ? sanitizeYouTubeEmbedSrc(element.getAttribute('src'))
                    : sanitizeVideoSrc(element.getAttribute('src')),
                renderHTML: attributes => attributes.src ? { src: attributes.src } : {}
            },
            provider: {
                default: 'file',
                parseHTML: element => element.tagName === 'IFRAME' ? 'youtube' : 'file',
                renderHTML: () => ({})
            },
            width: dimension('width'),
            height: dimension('height')
        };
    },

    parseHTML() {
        return [
            { tag: 'video[src]', getAttrs: element =>
                sanitizeVideoSrc(element.getAttribute('src')) ? null : false },
            { tag: 'iframe[src]', getAttrs: element =>
                sanitizeYouTubeEmbedSrc(element.getAttribute('src')) ? null : false }
        ];
    },

    renderHTML({ HTMLAttributes, node }) {
        if (node.attrs.provider === 'youtube') {
            return ['iframe', mergeAttributes({
                title: 'YouTube video', loading: 'lazy',
                referrerpolicy: 'strict-origin-when-cross-origin',
                allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture', allowfullscreen: ''
            }, HTMLAttributes)];
        }
        return ['video', mergeAttributes({
            controls: '', preload: 'metadata', playsinline: '', referrerpolicy: 'no-referrer'
        }, HTMLAttributes)];
    },

    addNodeView() {
        return ({ node, getPos, HTMLAttributes, editor }) => {
            let currentNode = node;
            const youtube = node.attrs.provider === 'youtube';
            const media = document.createElement(youtube ? 'iframe' : 'video');
            media.draggable = false;
            if (youtube) {
                media.loading = 'lazy';
                media.title = 'YouTube video';
                media.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                media.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture';
                media.allowFullscreen = true;
            } else {
                media.controls = true;
                media.preload = 'metadata';
                media.playsInline = true;
                media.referrerPolicy = 'no-referrer';
            }

            const applyMediaAttributes = updatedNode => {
                const src = updatedNode.attrs.src;
                if (src === null || src === undefined) media.removeAttribute('src');
                else media.setAttribute('src', src);
                media.style.width = updatedNode.attrs.width ? `${updatedNode.attrs.width}px` : '';
                media.style.height = updatedNode.attrs.height ? `${updatedNode.attrs.height}px` : '';
            };

            for (const [name, value] of Object.entries(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes))) {
                if (value !== null && value !== undefined && name !== 'width' && name !== 'height') {
                    media.setAttribute(name, value);
                }
            }

            const commitSize = (width, height) => {
                const pos = getPos();
                if (pos === undefined) return;
                editor.chain().setNodeSelection(pos).updateAttributes(this.name, {
                    width: Math.round(width),
                    height: Math.round(height)
                }).run();
            };

            const resizeByKeyboard = event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                event.stopPropagation();

                // Iframes include their default border in offset dimensions.
                // Once a size is serialized, it is the precise source of
                // truth for predictable keyboard increments.
                const width = Number(currentNode.attrs.width) || media.offsetWidth
                    || (youtube ? 0 : media.videoWidth);
                const height = Number(currentNode.attrs.height) || media.offsetHeight
                    || (youtube ? 0 : media.videoHeight);
                if (!width || !height) return;

                const step = event.shiftKey ? 50 : 10;
                const delta = event.key === 'ArrowRight' ? step : -step;
                let nextWidth = Math.min(MAX_REPORT_IMAGE_DIMENSION,
                    Math.max(MIN_RESIZED_IMAGE_WIDTH, width + delta));
                let nextHeight = Math.round(nextWidth * height / width);
                if (nextHeight > MAX_REPORT_IMAGE_DIMENSION) {
                    nextHeight = MAX_REPORT_IMAGE_DIMENSION;
                    nextWidth = Math.round(nextHeight * width / height);
                } else if (nextHeight < MIN_RESIZED_IMAGE_HEIGHT) {
                    nextHeight = MIN_RESIZED_IMAGE_HEIGHT;
                    nextWidth = Math.round(nextHeight * width / height);
                }
                commitSize(nextWidth, nextHeight);
            };

            return new ResizableNodeView({
                element: media,
                editor,
                node,
                getPos,
                onResize: (width, height) => {
                    media.style.width = `${width}px`;
                    media.style.height = `${height}px`;
                },
                onCommit: commitSize,
                onUpdate: updatedNode => {
                    if (updatedNode.type !== currentNode.type
                        || updatedNode.attrs.provider !== currentNode.attrs.provider) return false;
                    currentNode = updatedNode;
                    applyMediaAttributes(updatedNode);
                    return true;
                },
                options: {
                    directions: ['bottom-right'],
                    min: { width: MIN_RESIZED_IMAGE_WIDTH, height: MIN_RESIZED_IMAGE_HEIGHT },
                    max: { width: MAX_REPORT_IMAGE_DIMENSION, height: MAX_REPORT_IMAGE_DIMENSION },
                    preserveAspectRatio: true,
                    className: {
                        container: youtube ? 'bpb-re-youtube-resize' : 'bpb-re-video-resize',
                        wrapper: youtube ? 'bpb-re-youtube-resize-frame' : 'bpb-re-video-resize-frame',
                        handle: youtube ? 'bpb-re-youtube-resize-handle' : 'bpb-re-video-resize-handle',
                        resizing: youtube ? 'bpb-re-youtube-resizing' : 'bpb-re-video-resizing'
                    },
                    createCustomHandle: () => {
                        const handle = document.createElement('button');
                        handle.type = 'button';
                        handle.className = youtube ? 'bpb-re-youtube-resize-handle' : 'bpb-re-video-resize-handle';
                        handle.dataset.resizeHandle = 'bottom-right';
                        handle.title = `Drag to resize ${youtube ? 'YouTube video' : 'video'}; use left and right arrows for precise sizing`;
                        handle.setAttribute('aria-label', youtube ? 'Resize YouTube video' : 'Resize video');
                        handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
                        handle.addEventListener('keydown', resizeByKeyboard);
                        return handle;
                    }
                }
            });
        };
    }
});

const shortcutExtension = handlers => Extension.create({
    name: 'bpbShortcuts',
    addKeyboardShortcuts() {
        return Object.fromEntries(Object.entries(handlers)
            .map(([key, run]) => [key, () => { run(); return true; }]));
    }
});

export const createRichEditor = ({ element, placeholder, ariaLabel, onUpdate, onStateChange, shortcuts }) => {
    const editor = new Editor({
        element,
        extensions: [
            StarterKit.configure({
                heading: { levels: [1, 2, 3, 4, 5, 6] },
                link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }
            }),
            Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
            ReportImage.configure({ inline: true }),
            ReportVideo,
            Subscript, Superscript, Highlight,
            TextStyle, ReportColor,
            Small, InlineQuote,
            Placeholder.configure({ placeholder }),
            shortcutExtension(shortcuts)
        ],
        editorProps: {
            attributes: {
                class: 'bpb-re-surface',
                role: 'textbox',
                'aria-multiline': 'true',
                'aria-label': ariaLabel
            }
        }
    });
    editor.on('update', onUpdate);
    // Fires on every dispatched transaction, including selection-only moves —
    // exactly the cadence toolbar active states need.
    editor.on('transaction', onStateChange);
    return editor;
};

const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight',
    'subscript', 'superscript', 'small', 'inlineQuote'];

export const richCommands = {
    bold: editor => editor.chain().focus().toggleBold().run(),
    italic: editor => editor.chain().focus().toggleItalic().run(),
    underline: editor => editor.chain().focus().toggleUnderline().run(),
    strike: editor => editor.chain().focus().toggleStrike().run(),
    code: editor => editor.chain().focus().toggleCode().run(),
    highlight: editor => editor.chain().focus().toggleHighlight().run(),
    subscript: editor => editor.chain().focus().toggleSubscript().run(),
    superscript: editor => editor.chain().focus().toggleSuperscript().run(),
    small: editor => editor.chain().focus().toggleMark('small').run(),
    inlineQuote: editor => editor.chain().focus().toggleMark('inlineQuote').run(),
    bulletList: editor => editor.chain().focus().toggleBulletList().run(),
    orderedList: editor => editor.chain().focus().toggleOrderedList().run(),
    horizontalRule: editor => editor.chain().focus().setHorizontalRule().run(),
    undo: editor => editor.chain().focus().undo().run(),
    redo: editor => editor.chain().focus().redo().run(),
    insertTable: editor => editor.chain().focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    addRowAfter: editor => editor.chain().focus().addRowAfter().run(),
    addColumnAfter: editor => editor.chain().focus().addColumnAfter().run(),
    deleteRow: editor => editor.chain().focus().deleteRow().run(),
    deleteColumn: editor => editor.chain().focus().deleteColumn().run(),
    toggleHeaderRow: editor => editor.chain().focus().toggleHeaderRow().run(),
    deleteTable: editor => editor.chain().focus().deleteTable().run(),
    setColor: (editor, color) => editor.chain().focus().setColor(color).run(),
    unsetColor: (editor) => editor.chain().focus().unsetColor().run(),
    setLink: (editor, href) => editor.chain().focus().extendMarkRange('link').setLink({ href }).run(),
    unsetLink: editor => editor.chain().focus().extendMarkRange('link').unsetLink().run(),
    insertImage: (editor, attrs) => editor.chain().focus().setImage(attrs).run(),
    insertVideo: (editor, src) => editor.chain().focus().insertContent({
        type: 'reportVideo', attrs: { src }
    }).run(),
    insertYouTube: (editor, src) => editor.chain().focus().insertContent({
        type: 'reportVideo', attrs: { src, provider: 'youtube', width: 640, height: 360 }
    }).run(),
    // The block dropdown: a heading/code choice converts the current block; a
    // quote choice wraps a fresh paragraph; Paragraph unwraps an active quote.
    setBlock: (editor, value) => {
        const chain = editor.chain().focus();
        if (/^h[1-6]$/.test(value)) return chain.setHeading({ level: Number(value[1]) }).run();
        if (value === 'pre') return chain.setCodeBlock().run();
        if (value === 'blockquote') return chain.setParagraph().setBlockquote().run();
        return (editor.isActive('blockquote')
            ? chain.setParagraph().unsetBlockquote()
            : chain.setParagraph()).run();
    }
};

// One snapshot per transaction; report-editor.js paints the toolbar from this
// instead of querying TipTap from UI code.
export const richState = editor => {
    const headingLevel = [1, 2, 3, 4, 5, 6].find(level => editor.isActive('heading', { level }));
    return {
        block: editor.isActive('codeBlock') ? 'pre'
            : headingLevel ? `h${headingLevel}`
            : editor.isActive('blockquote') ? 'blockquote' : 'p',
        marks: Object.fromEntries(MARKS.map(name => [name, editor.isActive(name)])),
        bulletList: editor.isActive('bulletList'),
        orderedList: editor.isActive('orderedList'),
        inTable: editor.isActive('table'),
        linkActive: editor.isActive('link'),
        linkHref: editor.getAttributes('link').href || '',
        color: editor.getAttributes('textStyle').color || '',
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo()
    };
};
