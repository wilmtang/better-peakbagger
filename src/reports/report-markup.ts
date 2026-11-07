// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — trip-report markup conversions.
//
// Peakbagger turns square-bracket HTML into real HTML when it displays an
// ascent report, and turns every remaining newline into <br>. Rich text,
// Markdown, preview HTML, and the native JournalText field therefore share a
// small allowlisted AST. Markdown is tokenized by the vendored Marked parser;
// Marked's HTML renderer is deliberately never used. Existing bracket markup
// and allowlisted HTML embedded in Markdown are parsed through a detached,
// sanitized DOM, and editor DOM is read back into the same AST.
//
// Supported blocks: paragraphs/line breaks, h1-h6, block quotes, nested ul/ol,
// tables, preformatted code, and horizontal rules. Supported inline content:
// b/strong, i/em, u, s/strike/del, small, mark, sub, sup, code, q, safe links,
// HTTPS images and direct videos, canonical YouTube embeds, and color-only
// span/font markup. P/div/br are accepted on import but normalized to
// Peakbagger's newline convention.
//
// This module never accepts arbitrary HTML. Unsupported tags, unsafe URLs,
// event attributes, and non-color styles become visible text, and their tag
// delimiters are entity-escaped before submission. Plain mode in
// report-editor.js remains the explicit verbatim escape hatch.
// Idempotent: safe to inject more than once into the same global.


import { instagramBlocks, instagramPasteUrl } from './instagram-url.js';

// The allowlisted AST. Node kinds share one shape because the converters walk
// them generically; each reader knows which fields its `t` or `type` carries.
export interface InlineNode { t: string; text?: string; kids?: InlineNode[]; href?: string; blank?: boolean; src?: string; alt?: string; width?: number | null; height?: number | null; color?: string; media?: InlineNode; caption?: InlineNode[] }
export interface TableRow { header: boolean; cells: BlockNode[][] }
export interface BlockNode { type: string; kids?: InlineNode[]; level?: number; blocks?: BlockNode[]; ordered?: boolean; items?: BlockNode[][]; rows?: TableRow[]; text?: string; url?: string }
export interface ConversionDiagnostic { action: string; code: string; tag: string; attribute?: string; parent?: string | null; count?: number }
interface SafeTag { tag: string; html: string; self: boolean; ast?: InlineNode | null }
interface SourceToken { start: number; end: number; raw: string; bracket?: boolean; closing: boolean; name: string; attrs: string; safe: SafeTag | null; paired: boolean; pair?: number | null; rejectedOpening?: boolean; rejectedPair?: boolean }
interface ExtensionNode extends InlineNode { raw: string; closing: boolean; self: boolean; pair: number | null; tag?: string; safe: SafeTag | null }
interface OpenExtension extends ExtensionNode { kids: InlineNode[] }
interface MarkdownExtensions { source: string; markers: Omit<ExtensionNode, 't'>[]; markerPattern: RegExp }
interface MarkedToken { type?: string; raw?: string; text?: string; tokens?: MarkedToken[]; href?: string; depth?: number; items?: MarkedToken[]; ordered?: boolean; task?: boolean; checked?: boolean; header?: MarkedToken[]; rows?: MarkedToken[][] }
type MarkedLexer = (source: string, options: { gfm: boolean; breaks: boolean }) => MarkedToken[];
type LooseInlines = (InlineNode | InlineNode[] | null | undefined)[];

const INLINE_TAGS = new Map([
    ['b', 'b'], ['strong', 'b'],
    ['i', 'i'], ['em', 'i'],
    ['u', 'u'],
    ['s', 's'], ['strike', 's'], ['del', 's'],
    ['small', 'small'], ['mark', 'mark'],
    ['sub', 'sub'], ['sup', 'sup'], ['code', 'code'], ['q', 'q']
]);
const BLOCK_TAGS = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
    'ul', 'ol', 'li', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'th', 'td', 'pre',
    'figure', 'figcaption'
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const DOM_BLOCKS = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'UL', 'OL', 'TABLE', 'PRE', 'HR', 'FIGURE'
]);
const DROP_DOM = new Set([
    'SCRIPT', 'STYLE', 'TEMPLATE', 'AUDIO', 'OBJECT',
    'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'
]);
const BREAK: InlineNode = Object.freeze({ t: 'br' });

const text = (value: unknown): InlineNode => ({ t: 'text', text: String(value ?? '') });

const cleanUrlText = (raw: unknown) => {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || /[\u0000-\u0020"'<>\[\]\\]/.test(value)) return null;
    return value;
};

// Links can be web/mail links, root-relative Peakbagger links, or a local
// fragment. Protocol-relative URLs are rejected so the scheme is explicit.
const sanitizeHref = (raw: unknown) => {
    const href = cleanUrlText(raw);
    if (!href) return null;
    if (/^\/(?!\/)[^\s]*$/.test(href) || /^#[^\s]*$/.test(href)) return href;
    if (/^mailto:[^\s@]+@[^\s@]+$/i.test(href)) return href;
    try {
        const parsed = new URL(href);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? href : null;
    } catch (error) { return null; }
};

// Scheme-less Markdown link targets ("example.com/photos") get HTTPS.
const resolveLinkTarget = (raw: unknown) => {
    const direct = sanitizeHref(raw);
    if (direct) return direct;
    const href = cleanUrlText(String(raw || ''));
    return href && /^[\w-]+(?:\.[\w-]+)+(?:[/?#].*)?$/.test(href)
        ? `https://${href}`
        : null;
};

// Images are more restrictive than links: no HTTP mixed content, data
// URLs, protocol-relative hosts, or filesystem/browser schemes.
const sanitizeImageSrc = (raw: unknown) => {
    const src = cleanUrlText(raw);
    if (!src) return null;
    if (/^\/(?!\/)[^\s]*$/.test(src)) return src;
    try { return new URL(src).protocol === 'https:' ? src : null; }
    catch (error) { return null; }
};

// Videos use the same source boundary as images. The extension never
// embeds a third-party page: this is only for a direct media resource the
// browser can play in its native, non-autoplaying control.
export const sanitizeVideoSrc = sanitizeImageSrc;

const VIDEO_FILE = /\.(?:m3u8|mp4|og[gv]|webm)(?:[?#]|$)/i;
const isDirectVideoSrc = (src: string) => VIDEO_FILE.test(src);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

// This is deliberately not a general iframe sanitizer. The one allowed
// embed is a canonical YouTube player, derived from a recognized YouTube
// URL and stripped of user-controlled player options.
export const sanitizeYouTubeEmbedSrc = (raw: unknown) => {
    const source = cleanUrlText(raw);
    if (!source) return null;
    try {
        const url = new URL(source);
        if (url.protocol !== 'https:') return null;
        const host = url.hostname.toLowerCase().replace(/\.$/, '');
        let id: string | null = null;
        if (host === 'youtu.be' || host === 'www.youtu.be') {
            const [candidate, ...rest] = url.pathname.split('/').filter(Boolean);
            if (!rest.length) id = candidate;
        } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
            const segments = url.pathname.split('/').filter(Boolean);
            if (url.pathname === '/watch') id = url.searchParams.get('v');
            else if (['embed', 'shorts', 'live'].includes(segments[0])) id = segments[1];
        }
        return id && YOUTUBE_ID.test(id) ? `https://www.youtube.com/embed/${id}` : null;
    } catch (error) { return null; }
};

const youtubeWatchUrl = (embed: string) => {
    const id = /^https:\/\/www\.youtube\.com\/embed\/([A-Za-z0-9_-]{11})$/.exec(embed)?.[1];
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
};

const sanitizeColor = (raw: unknown) => {
    if (typeof raw !== 'string') return null;
    const color = raw.trim().toLowerCase();
    const named = /^[a-z]{3,}$/.test(color) && color.length <= 20;
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(color) || named ? color : null;
};

export const MAX_REPORT_IMAGE_DIMENSION = 1600;

// These fixed attributes are part of the saved markup, not just the local
// preview. Peakbagger turns bracket tags into HTML without adding native
// media behavior, so omitting `controls` would publish an inert video.
// Keeping the strings shared also prevents the preview from promising
// privacy or playback behavior that the submitted report does not have.
const VIDEO_RUNTIME_ATTRIBUTES =
        ' controls preload="metadata" playsinline referrerpolicy="no-referrer"';
// YouTube rejects player requests without client identification (error
// 153). Its recommended cross-origin policy sends only Peakbagger's origin,
// never the ascent path or query string.
const YOUTUBE_RUNTIME_ATTRIBUTES =
        ' title="YouTube video" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"'
        + ' allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen';

export const sanitizeReportDimension = (raw: unknown) => {
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= MAX_REPORT_IMAGE_DIMENSION ? value : null;
};
const sanitizeDimension = sanitizeReportDimension;

const escapeHtml = (value: unknown) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const escapeAttribute = (value: unknown) => escapeHtml(value)
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');

// JournalText becomes HTML on Peakbagger. Encode ordinary text as HTML,
// and additionally neutralize square-bracket strings that look like tags.
const escapeBracketText = (value: unknown) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[(\/?[a-z][a-z0-9]*(?:\s[^\]\r\n]*)?)\]/gi, '&#91;$1&#93;');

const readAttr = (attrs: string | null | undefined, name: string) => {
    const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i');
    const hit = pattern.exec(attrs || '');
    return hit ? (hit[1] ?? hit[2] ?? hit[3]) : null;
};

const normalizedTag = (name: unknown): string | null => {
    const lower = String(name || '').toLowerCase();
    if (INLINE_TAGS.has(lower)) return INLINE_TAGS.get(lower) as string;
    if (lower === 'font') return 'span';
    if (BLOCK_TAGS.has(lower) || VOID_TAGS.has(lower) || lower === 'a' || lower === 'span'
            || lower === 'video' || lower === 'iframe') return lower;
    return null;
};

// Build one safe HTML opening tag. Returning null means the source token
// must remain text. The closing token is converted only when paired with a
// successfully validated opening token.
const safeOpening = (name: string, attrs: string): SafeTag | null => {
    const sourceName = String(name || '').toLowerCase();
    const tag = normalizedTag(sourceName);
    if (!tag) return null;

    if (INLINE_TAGS.has(sourceName)) {
        return { tag, html: `<${tag}>`, self: false, ast: { t: tag } };
    }
    if (BLOCK_TAGS.has(sourceName)) return {
        tag, html: `<${tag}>`, self: false,
        ...(['figure', 'figcaption'].includes(tag) ? { ast: { t: tag } } : {})
    };
    if (tag === 'br' || tag === 'hr') {
        return { tag, html: `<${tag}>`, self: true, ast: tag === 'br' ? BREAK : null };
    }
    if (tag === 'a') {
        const href = sanitizeHref(readAttr(attrs, 'href'));
        if (!href) return null;
        const blank = readAttr(attrs, 'target') === '_blank';
        return {
            tag,
            html: `<a href="${escapeAttribute(href)}"${blank ? ' target="_blank" rel="noopener noreferrer"' : ''}>`,
            self: false,
            ast: { t: 'a', href, blank }
        };
    }
    if (tag === 'img') {
        const src = sanitizeImageSrc(readAttr(attrs, 'src'));
        if (!src) return null;
        const alt = readAttr(attrs, 'alt');
        const width = sanitizeDimension(readAttr(attrs, 'width'));
        const height = sanitizeDimension(readAttr(attrs, 'height'));
        return {
            tag,
            html: `<img src="${escapeAttribute(src)}"${alt !== null ? ` alt="${escapeAttribute(alt)}"` : ''}${
                width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`,
            self: true,
            ast: { t: 'img', src, alt: alt || '', width, height }
        };
    }
    if (tag === 'video') {
        const src = sanitizeVideoSrc(readAttr(attrs, 'src'));
        const width = sanitizeDimension(readAttr(attrs, 'width'));
        const height = sanitizeDimension(readAttr(attrs, 'height'));
        return src ? {
            tag,
            html: `<video src="${escapeAttribute(src)}"${width ? ` width="${width}"` : ''}${
                height ? ` height="${height}"` : ''}${VIDEO_RUNTIME_ATTRIBUTES}>`,
            self: false
        } : null;
    }
    if (tag === 'iframe') {
        const src = sanitizeYouTubeEmbedSrc(readAttr(attrs, 'src'));
        const width = sanitizeDimension(readAttr(attrs, 'width'));
        const height = sanitizeDimension(readAttr(attrs, 'height'));
        return src ? {
            tag,
            html: `<iframe src="${escapeAttribute(src)}"${width ? ` width="${width}"` : ''}${
                height ? ` height="${height}"` : ''}${YOUTUBE_RUNTIME_ATTRIBUTES}>`,
            self: false
        } : null;
    }
    if (tag === 'span') {
        const styleColor = /^\s*color\s*:\s*([^;]+)\s*;?\s*$/i.exec(readAttr(attrs, 'style') || '');
        const color = sanitizeColor(sourceName === 'font'
            ? readAttr(attrs, 'color')
            : styleColor && styleColor[1]);
        if (!color) return null;
        return {
            tag,
            html: `<span style="color:${escapeAttribute(color)}">`,
            self: false,
            ast: { t: 'color', color }
        };
    }
    return null;
};

const TAG_TOKEN = /\[(\/?)([a-z][a-z0-9]*)([^\]\r\n]*)\]|<(\/?)([a-z][a-z0-9]*)([^>\r\n]*)>/gi;

const attributeEntries = (raw: unknown) => {
    const source = String(raw || '').replace(/\/\s*$/, '').trim();
    if (!source) return [];
    const entries: { name: string; value: string | null }[] = [];
    const pattern = /([a-z][a-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/gi;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        entries.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? null });
    }
    return entries;
};

const acceptedAttributeNames = (tag: string) => {
    if (INLINE_TAGS.has(tag)) return new Set();
    if (tag === 'a') return new Set(['href', 'target']);
    if (tag === 'img') return new Set(['src', 'alt', 'width', 'height']);
    if (tag === 'video') {
        return new Set(['src', 'width', 'height', 'controls', 'preload', 'playsinline', 'referrerpolicy']);
    }
    if (tag === 'iframe') {
        return new Set(['src', 'width', 'height', 'title', 'loading', 'referrerpolicy', 'allow', 'allowfullscreen']);
    }
    if (tag === 'font') return new Set(['color']);
    if (tag === 'span') return new Set(['style']);
    if (tag === 'table') return new Set(['border']);
    return new Set();
};

const droppedAttributes = (tag: string, attrs: string) => {
    const entries = attributeEntries(attrs);
    const accepted = acceptedAttributeNames(tag);
    const dropped = entries.filter(entry => !accepted.has(entry.name));
    const byName = (name: string) => entries.find(entry => entry.name === name);
    const dropIf = (name: string, invalid: (value: string | null) => boolean) => {
        const entry = byName(name);
        if (entry && invalid(entry.value)) dropped.push(entry);
    };
    dropIf('target', value => value !== '_blank');
    for (const name of ['width', 'height']) {
        dropIf(name, value => sanitizeDimension(value) === null);
    }
    dropIf('border', value => value !== '1');
    if (tag === 'video') {
        dropIf('controls', value => value !== null);
        dropIf('preload', value => value !== 'metadata');
        dropIf('playsinline', value => value !== null);
        dropIf('referrerpolicy', value => value !== 'no-referrer');
    }
    if (tag === 'iframe') {
        dropIf('title', value => value !== 'YouTube video');
        dropIf('loading', value => value !== 'lazy');
        dropIf('referrerpolicy', value => value !== 'strict-origin-when-cross-origin');
        dropIf('allow', value => value !== 'accelerometer; encrypted-media; gyroscope; picture-in-picture');
        dropIf('allowfullscreen', value => value !== null);
    }
    return [...new Map(dropped.map(entry => [entry.name, entry])).values()];
};

// A caption is one line of formatted text. Media, nested figures and block
// structure never belong inside it.
const CAPTION_WRAPPERS = new Set([...INLINE_TAGS.values(), 'a', 'color']);
const CAPTION_SOURCE_TAGS = new Set([...INLINE_TAGS.values(), 'a', 'span']);

const invalidStructuralParent = (tag: string, ancestors: string[]) => {
    const parent = ancestors.at(-1) || null;
    if (tag === 'figcaption') return parent !== 'figure';
    if (ancestors.includes('figcaption') && !CAPTION_SOURCE_TAGS.has(tag)) return true;
    if (tag === 'figure' && ancestors.some(ancestor => ['figure', 'a'].includes(ancestor))) return true;
    if (tag === 'li') return parent !== 'ul' && parent !== 'ol';
    if (tag === 'tr') return !['table', 'thead', 'tbody', 'tfoot'].includes(parent as string);
    if (tag === 'th' || tag === 'td') return parent !== 'tr';
    if (['thead', 'tbody', 'tfoot'].includes(tag)) return parent !== 'table';
    if (tag === 'a') return ancestors.includes('a');
    return BLOCK_TAGS.has(tag) && ancestors.includes('p');
};

const addDiagnostic = (diagnostics: ConversionDiagnostic[] | null, diagnostic: ConversionDiagnostic) => {
    if (!diagnostics) return;
    diagnostics.push(diagnostic);
};

// Convert only balanced, validated allowlisted tags to detached HTML. Raw
// source newlines become <br>, exactly as Peakbagger renders them.
const bracketSourceToSafeHtml = (source: unknown, { inlineOnly = false, diagnostics = null as ConversionDiagnostic[] | null } = {}) => {
    const input = String(source ?? '').replace(/\r\n?/g, '\n');
    const tokens: SourceToken[] = [];
    for (let hit = TAG_TOKEN.exec(input); hit; hit = TAG_TOKEN.exec(input)) {
        const bracket = hit[1] !== undefined;
        const closing = (bracket ? hit[1] : hit[4]) === '/';
        const name = (bracket ? hit[2] : hit[5]).toLowerCase();
        const attrs = bracket ? hit[3] : hit[6];
        tokens.push({
            start: hit.index,
            end: hit.index + hit[0].length,
            raw: hit[0],
            bracket,
            closing,
            name,
            attrs,
            safe: null,
            paired: false
        });
    }

    const closingNames = new Set(tokens.filter(token => token.closing).map(token => token.name));
    let tagDocument: Document | undefined;
    const literalBracketWord = (token: SourceToken) => {
        if (!token.bracket || token.attrs.trim() || closingNames.has(token.name)
            || token.name === 'svg' || token.name === 'math') return false;
        // A bare unknown word such as [this] is prose, not a markup feature
        // being lost. Real HTML tags, attributes and paired custom tags still
        // need the conversion guard. This never changes the rendering allowlist:
        // the rejected token remains escaped literal text below.
        tagDocument ||= getParserDocument('');
        return tagDocument.createElement(token.name).constructor.name === 'HTMLUnknownElement';
    };
    const stack: SourceToken[] = [];
    for (const token of tokens) {
        if (!token.closing) {
            const safe = safeOpening(token.name, token.attrs);
            if (!safe || (inlineOnly && (BLOCK_TAGS.has(token.name) || safe.tag === 'hr'))) {
                if (!inlineOnly && (normalizedTag(token.name) || !literalBracketWord(token))) addDiagnostic(diagnostics, {
                    action: 'neutralize',
                    code: normalizedTag(token.name) ? 'unsafe-attribute' : 'unsupported-tag',
                    tag: token.name,
                });
                token.rejectedOpening = !!normalizedTag(token.name);
                continue;
            }
            token.safe = safe;
            if (!inlineOnly) {
                for (const attribute of droppedAttributes(token.name, token.attrs)) {
                    addDiagnostic(diagnostics, {
                        action: 'drop', code: 'unsupported-attribute', tag: token.name,
                        attribute: attribute.name,
                    });
                }
            }
            if (safe.self) token.paired = true;
            else stack.push(token);
            continue;
        }
        if (token.attrs.trim()) continue;
        const closeTag = normalizedTag(token.name);
        const open = stack[stack.length - 1];
        if (open && closeTag && open.safe!.tag === closeTag) {
            stack.pop();
            open.paired = true;
            token.safe = { tag: closeTag, html: `</${closeTag}>`, self: false };
            token.paired = true;
        }
    }

    if (!inlineOnly) {
        const rejectedStack: string[] = [];
        for (const token of tokens) {
            if (!token.closing && token.rejectedOpening
                && !['br', 'hr', 'img'].includes(normalizedTag(token.name) as string)) {
                rejectedStack.push(token.name);
            } else if (token.closing && !token.paired
                && rejectedStack[rejectedStack.length - 1] === token.name) {
                rejectedStack.pop();
                token.rejectedPair = true;
            }
        }
        const structuralStack: SourceToken[] = [];
        for (const token of tokens) {
            if (!token.safe || !token.paired || token.safe.self) continue;
            if (!token.closing) {
                const ancestors = structuralStack.map(item => item.safe!.tag);
                const parent = ancestors.at(-1) || null;
                if (invalidStructuralParent(token.safe.tag, ancestors)) {
                    addDiagnostic(diagnostics, {
                        action: 'unwrap', code: 'unsupported-nesting', tag: token.name,
                        parent,
                    });
                }
                structuralStack.push(token);
            } else {
                structuralStack.pop();
            }
        }
        for (const token of tokens) {
            const unsupportedOpen = !token.closing && !token.paired && token.safe;
            const unsupportedClose = token.closing && !token.paired
                && !token.rejectedPair && normalizedTag(token.name);
            if (!unsupportedOpen && !unsupportedClose) continue;
            addDiagnostic(diagnostics, {
                action: 'neutralize', code: 'unsupported-nesting', tag: token.name,
            });
        }
    }

    const appendText = (value: string) => value
        .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    let html = '';
    let at = 0;
    for (const token of tokens) {
        html += appendText(input.slice(at, token.start));
        html += token.paired && token.safe ? token.safe.html : escapeHtml(token.raw);
        at = token.end;
    }
    return html + appendText(input.slice(at));
};

const getParserDocument = (html: string) => {
    if (typeof DOMParser === 'undefined') {
        throw new Error('BPBReportMarkup requires DOMParser');
    }
    return new DOMParser().parseFromString(`<body><div id="bpb-report-root">${html}</div></body>`, 'text/html');
};

// ---- DOM -> AST --------------------------------------------------------

const compactInlines = (nodes: LooseInlines) => {
    const out: InlineNode[] = [];
    for (const node of nodes.flat()) {
        if (!node) continue;
        if (node.t === 'text' && !node.text) continue;
        const last = out[out.length - 1];
        if (node.t === 'text' && last && last.t === 'text') last.text! += node.text;
        else out.push(node);
    }
    return out;
};

const trimInlines = (nodes: LooseInlines) => {
    const out = compactInlines(nodes).slice();
    while (out[0] === BREAK) out.shift();
    while (out[out.length - 1] === BREAK) out.pop();
    if (out[0]?.t === 'text') out[0] = text(out[0].text!.replace(/^ +/, ''));
    if (out[out.length - 1]?.t === 'text') {
        out[out.length - 1] = text(out[out.length - 1].text!.replace(/ +$/, ''));
    }
    return out.filter(node => node.t !== 'text' || node.text);
};

// Preserve an accepted color token instead of reading it through CSSOM,
// which canonicalizes hex into rgb(). This is intentionally not a general
// style parser: sanitizeColor rejects every value form that could contain
// a declaration separator, function, quote, escape, or comment.
const rawInlineColor = (element: Element) => {
    const style = element.getAttribute('style');
    if (!style) return null;
    const declarations = style.split(';');
    for (let index = declarations.length - 1; index >= 0; index -= 1) {
        const declaration = declarations[index];
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        if (declaration.slice(0, colon).trim().toLowerCase() === 'color') {
            return declaration.slice(colon + 1).trim();
        }
    }
    return null;
};

const colorFromElement = (element: Element) => {
    const preserved = element.getAttribute('data-bpb-report-color');
    const raw = element.tagName === 'FONT'
        ? element.getAttribute('color')
        : preserved !== null ? preserved : rawInlineColor(element);
    return sanitizeColor(raw);
};

const styleWraps = (element: HTMLElement) => {
    const style = element.style;
    const wraps = [];
    if (style && /^(bold|bolder|[6-9]00)$/.test(style.fontWeight)) wraps.push('b');
    if (style && style.fontStyle === 'italic') wraps.push('i');
    const decoration = style && (style.textDecorationLine || style.textDecoration || '');
    if (/underline/.test(decoration)) wraps.push('u');
    if (/line-through/.test(decoration)) wraps.push('s');
    return wraps;
};

const inlineFromNode = (source: Node): InlineNode[] => {
    if (source.nodeType === 3) {
        const value = source.nodeValue!.replace(/[\t\n\f\r \u00a0]+/g, ' ');
        return value ? [text(value)] : [];
    }
    if (source.nodeType !== 1) return [];
    const node = source as HTMLElement;
    const tag = node.tagName;
    if (tag === 'FIGURE') {
        const figure = figureFromElement(node);
        return figure ? [figure] : [...node.childNodes].flatMap(inlineFromNode);
    }
    if (tag === 'BR') return [BREAK];
    if (DROP_DOM.has(tag)) return [];
    if (tag === 'IMG') {
        const src = sanitizeImageSrc(node.getAttribute('src'));
        if (!src) return [];
        return [{
            t: 'img', src,
            alt: node.getAttribute('alt') || '',
            width: sanitizeDimension(node.getAttribute('width')),
            height: sanitizeDimension(node.getAttribute('height'))
        }];
    }
    if (tag === 'VIDEO') {
        const src = sanitizeVideoSrc(node.getAttribute('src'));
        return src ? [{
            t: 'video', src,
            width: sanitizeDimension(node.getAttribute('width')),
            height: sanitizeDimension(node.getAttribute('height'))
        }] : [];
    }
    if (tag === 'IFRAME') {
        const src = sanitizeYouTubeEmbedSrc(node.getAttribute('src'));
        return src ? [{
            t: 'youtube', src,
            width: sanitizeDimension(node.getAttribute('width')),
            height: sanitizeDimension(node.getAttribute('height'))
        }] : [];
    }

    let kids = compactInlines([...node.childNodes].flatMap(inlineFromNode));
    if (!kids.length) return [];

    if (tag === 'A') {
        const href = sanitizeHref(node.getAttribute('href'));
        if (href) kids = [{
            t: 'a', href, blank: node.getAttribute('target') === '_blank', kids
        }];
    } else {
        const semantic = INLINE_TAGS.get(tag.toLowerCase());
        if (semantic) kids = [{ t: semantic, kids }];
        const color = (tag === 'SPAN' || tag === 'FONT') && colorFromElement(node);
        if (color) kids = [{ t: 'color', color, kids }];
        for (const wrap of styleWraps(node).reverse()) kids = [{ t: wrap, kids }];
    }
    return kids;
};

const inlinesFrom = (element: Element) => compactInlines([...element.childNodes].flatMap(inlineFromNode));

const trimCaptionEdge = (nodes: InlineNode[], start: boolean) => {
    while (nodes.length) {
        const index = start ? 0 : nodes.length - 1;
        const node = nodes[index];
        if (node.t === 'text') {
            const value = start ? node.text!.replace(/^ +/, '') : node.text!.replace(/ +$/, '');
            if (value) { nodes[index] = text(value); return; }
        } else {
            trimCaptionEdge(node.kids!, start);
            if (node.kids!.length) return;
        }
        nodes.splice(index, 1);
    }
};

// Returns the caption's normalized inline content, or null when it contains
// anything other than formatted text. Line breaks become spaces, and formatting
// around only whitespace disappears, so an empty result means "no caption".
const captionInlines = (nodes: InlineNode[]) => {
    const copy = (list: InlineNode[]): InlineNode[] | null => {
        const out: InlineNode[] = [];
        for (const node of list) {
            if (node === BREAK || node.t === 'br') out.push(text(' '));
            else if (node.t === 'text') out.push(text(node.text!.replace(/[\t\n\f\r \u00a0]+/g, ' ')));
            else {
                if (!CAPTION_WRAPPERS.has(node.t)) return null;
                const kids = copy(node.kids || []);
                if (!kids) return null;
                out.push({ ...node, kids });
            }
        }
        return compactInlines(out);
    };
    const kids = copy(nodes);
    if (!kids) return null;
    trimCaptionEdge(kids, true);
    trimCaptionEdge(kids, false);
    return kids;
};

// Only explicit figures carry captions. Never infer them from adjacent prose.
export const figureFromElement = (element: Element): InlineNode | null => {
    const children = [...element.childNodes].filter(node =>
        node.nodeName !== 'BR' && !(node.nodeType === 3 && !node.nodeValue!.trim()));
    if (children.length !== 2 || children[1].nodeName !== 'FIGCAPTION') return null;
    let media = children[0] as Element;
    const caption = children[1];
    // Rich HTML has a schema-owned media block. Revalidate its image/link as
    // usual; the marker never grants access to additional tags or attributes.
    if (media.nodeName === 'DIV' && media.hasAttribute('data-bpb-figure-media') && media.childNodes.length === 1) {
        media = media.firstChild as Element;
    }
    const captionKids = captionInlines(inlinesFrom(caption as Element));
    if (!captionKids) return null;
    const linked = media.nodeName === 'A';
    const image = linked && media.childNodes.length === 1 ? media.firstChild : media;
    if (image?.nodeName !== 'IMG') return null;
    const kids = inlineFromNode(media);
    if (kids.length !== 1 || (linked && kids[0].t !== 'a') || (!linked && kids[0].t !== 'img')) return null;
    return captionKids.length ? { t: 'figure', media: kids[0], caption: captionKids } : kids[0];
};

// Two consecutive <br> elements are Peakbagger's paragraph separator. A
// single <br> stays in the paragraph. Empty editor scaffolding is dropped.
const looseInlinesToParagraphs = (stream: LooseInlines) => {
    const blocks: BlockNode[] = [];
    let current: InlineNode[] = [];
    const flush = () => {
        const kids = trimInlines(current);
        if (kids.length) blocks.push({ type: 'p', kids });
        current = [];
    };
    for (const node of compactInlines(stream)) {
        if (node.t === 'figure') {
            flush();
            blocks.push({ type: 'p', kids: [node] });
        } else if (node === BREAK) {
            if (!current.length) continue;
            if (current[current.length - 1] === BREAK) {
                current.pop();
                flush();
            } else current.push(BREAK);
        } else current.push(node);
    }
    flush();
    return blocks;
};

const preformattedText = (element: Element) => {
    let value = '';
    const visit = (node: Node) => {
        if (node.nodeType === 3) value += node.nodeValue!.replace(/\u00a0/g, ' ');
        else if (node.nodeType === 1 && (node as Element).tagName === 'BR') value += '\n';
        else if (node.nodeType === 1 && !DROP_DOM.has((node as Element).tagName)) [...node.childNodes].forEach(visit);
    };
    [...element.childNodes].forEach(visit);
    return value.replace(/^\n|\n$/g, '');
};

const tableRows = (table: Element) => {
    const rows: TableRow[] = [];
    const addRow = (row: Element) => {
        const cells = [...row.children].filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD');
        if (!cells.length) return;
        rows.push({
            header: cells.every(cell => cell.tagName === 'TH'),
            cells: cells.map(cell => domChildrenToBlocks(cell))
        });
    };
    for (const child of table.children) {
        if (child.tagName === 'TR') addRow(child);
        else if (['THEAD', 'TBODY', 'TFOOT'].includes(child.tagName)) {
            [...child.children].filter(row => row.tagName === 'TR').forEach(addRow);
        }
    }
    return rows;
};

const blockFromElement = (element: Element): BlockNode[] => {
    const tag = element.tagName;
    if (tag === 'FIGURE') return looseInlinesToParagraphs(inlineFromNode(element));
    if (tag === 'P' || tag === 'DIV') return looseInlinesToParagraphs(inlinesFrom(element));
    if (/^H[1-6]$/.test(tag)) {
        const kids = trimInlines(inlinesFrom(element));
        return kids.length ? [{ type: 'heading', level: Number(tag[1]), kids }] : [];
    }
    if (tag === 'BLOCKQUOTE') {
        const blocks = domChildrenToBlocks(element);
        return blocks.length ? [{ type: 'blockquote', blocks }] : [];
    }
    if (tag === 'UL' || tag === 'OL') {
        const items = [...element.children]
            .filter(child => child.tagName === 'LI')
            .map(item => domChildrenToBlocks(item))
            .filter(blocks => blocks.length);
        return items.length ? [{ type: 'list', ordered: tag === 'OL', items }] : [];
    }
    if (tag === 'TABLE') {
        const rows = tableRows(element);
        return rows.length ? [{ type: 'table', rows }] : [];
    }
    if (tag === 'PRE') return [{ type: 'pre', text: preformattedText(element) }];
    if (tag === 'HR') return [{ type: 'hr' }];
    return looseInlinesToParagraphs(inlinesFrom(element));
};

function domChildrenToBlocks(root: Element): BlockNode[] {
    const blocks: BlockNode[] = [];
    let pending: InlineNode[] = [];
    const flush = () => {
        blocks.push(...looseInlinesToParagraphs(pending));
        pending = [];
    };
    for (const child of root.childNodes) {
        if (child.nodeType === 1 && DOM_BLOCKS.has((child as Element).tagName)) {
            flush();
            blocks.push(...blockFromElement(child as Element));
        } else if (child.nodeType === 3 && !child.nodeValue!.trim() && !pending.length) {
            continue;
        } else pending.push(...inlineFromNode(child));
    }
    flush();
    return blocks;
}

const domToAst = (root: Element) => instagramBlocks(domChildrenToBlocks(root)) as BlockNode[];

// The first editor release serialized visual lists as literal "- "/"1. "
// lines. Continue recognizing those reports on import while emitting real
// Peakbagger list tags from now on.
const upgradeLegacyLists = (blocks: BlockNode[]): BlockNode[] => blocks.map(block => {
    if (block.type === 'blockquote') return { ...block, blocks: upgradeLegacyLists(block.blocks!) };
    if (block.type === 'list') {
        return { ...block, items: block.items!.map(item => upgradeLegacyLists(item)) };
    }
    if (block.type !== 'p') return block;
    const lines: InlineNode[][] = [[]];
    for (const node of block.kids!) {
        if (node === BREAK) lines.push([]);
        else lines[lines.length - 1].push(node);
    }
    if (!lines.length || lines.some(line => !line.length || line[0].t !== 'text')) return block;
    const matches = lines.map(line => /^(?:([-*+•])|(\d{1,3})[.)])\s+/.exec(line[0].text!));
    if (matches.some(match => !match)) return block;
    const ordered = !!matches[0]![2];
    if (matches.some(match => !!match![2] !== ordered)) return block;
    const items = lines.map((line, index) => {
        const kids = line.slice();
        kids[0] = text(kids[0].text!.slice(matches[index]![0].length));
        return [{ type: 'p', kids: trimInlines(kids) }];
    });
    return { type: 'list', ordered, items };
});

const parseBracketWithDiagnostics = (source: unknown) => {
    const diagnostics: ConversionDiagnostic[] = [];
    const doc = getParserDocument(bracketSourceToSafeHtml(source, { diagnostics }));
    for (const element of doc.querySelectorAll('figure')) {
        if (!figureFromElement(element)) addDiagnostic(diagnostics, {
            action: 'unwrap', code: 'unsupported-nesting', tag: 'figure'
        });
    }
    const ast = upgradeLegacyLists(domToAst(doc.getElementById('bpb-report-root')!));
    const unique = new Map<string, ConversionDiagnostic & { count: number }>();
    for (const diagnostic of diagnostics) {
        const key = [diagnostic.action, diagnostic.code, diagnostic.tag,
            diagnostic.attribute || '', diagnostic.parent || ''].join(':');
        const existing = unique.get(key);
        if (existing) existing.count++;
        else unique.set(key, { ...diagnostic, count: 1 });
    }
    return { ast, diagnostics: [...unique.values()] };
};

const parseBracket = (source: unknown) => parseBracketWithDiagnostics(source).ast;

const parseBracketInline = (source: unknown) => {
    const doc = getParserDocument(bracketSourceToSafeHtml(source, { inlineOnly: true }));
    // Do not trim here: Marked splits "text **bold** text" into three
    // tokens, and the spaces live at the edges of the two text tokens.
    return compactInlines(inlinesFrom(doc.getElementById('bpb-report-root')!));
};

// ---- Marked tokens -> AST ---------------------------------------------

// Marked understands angle-bracket HTML boundaries and must see them while
// lexing so adjacent Markdown delimiters keep their CommonMark context.
// Peakbagger's bracket extensions are not Markdown, so protect only those
// before lexing and fold both token forms into the same allowlisted AST.
const protectMarkdownExtensions = (source: unknown): MarkdownExtensions => {
    const input = String(source ?? '');
    let markerPrefix = '\uE000BPB';
    while (input.includes(markerPrefix)) markerPrefix += '_';

    TAG_TOKEN.lastIndex = 0;
    const tokens: SourceToken[] = [];
    for (let hit = TAG_TOKEN.exec(input); hit; hit = TAG_TOKEN.exec(input)) {
        const bracket = hit[1] !== undefined;
        if (!bracket) continue;
        const closing = (bracket ? hit[1] : hit[4]) === '/';
        const name = (bracket ? hit[2] : hit[5]).toLowerCase();
        const attrs = bracket ? hit[3] : hit[6];
        tokens.push({
            start: hit.index,
            end: hit.index + hit[0].length,
            raw: hit[0],
            closing,
            name,
            attrs,
            safe: null,
            paired: false,
            pair: null
        });
    }

    const stack: SourceToken[] = [];
    let pair = 0;
    for (const token of tokens) {
        if (!token.closing) {
            const safe = safeOpening(token.name, token.attrs);
            if (!safe?.ast) continue;
            token.safe = safe;
            if (safe.self) {
                token.paired = true;
                token.pair = pair++;
            } else stack.push(token);
            continue;
        }
        if (token.attrs.trim()) continue;
        const closeTag = normalizedTag(token.name);
        const open = stack[stack.length - 1];
        if (open && closeTag && open.safe!.tag === closeTag) {
            stack.pop();
            open.paired = true;
            token.paired = true;
            open.pair = pair;
            token.pair = pair++;
            token.safe = open.safe;
        }
    }

    const markers: MarkdownExtensions['markers'] = [];
    let protectedSource = '';
    let at = 0;
    for (const token of tokens) {
        protectedSource += input.slice(at, token.start);
        if (token.paired && token.safe) {
            const index = markers.length;
            markers.push({
                raw: token.raw,
                closing: token.closing,
                self: token.safe.self,
                pair: token.pair!,
                safe: token.safe
            });
            protectedSource += `${markerPrefix}${index}\uE001`;
        } else protectedSource += token.raw;
        at = token.end;
    }
    protectedSource += input.slice(at);

    return {
        source: protectedSource,
        markers,
        markerPattern: new RegExp(`${markerPrefix}(\\d+)\\uE001`, 'g')
    };
};

const makeMarkdownExtensionNode = (safe: SafeTag, kids: InlineNode[] = []): InlineNode | null => {
    if (safe.ast === BREAK) return BREAK;
    if (safe.ast!.t === 'img') return { ...safe.ast! };
    if (safe.ast!.t === 'figcaption') return { t: 'figcaption', kids };
    if (safe.ast!.t === 'figure') {
        const meaningful = kids.filter(kid => kid !== BREAK && !(kid.t === 'text' && !kid.text!.trim()));
        const [media, caption] = meaningful;
        if (meaningful.length !== 2 || caption.t !== 'figcaption'
            || !(media.t === 'img' || (media.t === 'a' && media.kids!.length === 1 && media.kids![0].t === 'img'))
        ) return null;
        const captionKids = captionInlines(caption.kids!);
        if (!captionKids) return null;
        return captionKids.length ? { t: 'figure', media, caption: captionKids } : media;
    }
    return kids.length ? { ...safe.ast!, kids } : null;
};

// Marked emits an inline HTML wrapper and its Markdown children as
// separate tokens. Convert only a single validated tag token here; block
// HTML and unsupported/unsafe tags continue through the inert text path.
const markdownHtmlExtension = (raw: string): ExtensionNode | null => {
    const match = /^<(\/?)\s*([a-z][a-z0-9]*)([^>\r\n]*)>$/i.exec(String(raw || ''));
    if (!match) return null;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const attrs = match[3];
    if (closing) {
        if (attrs.trim()) return null;
        const tag = normalizedTag(name);
        return tag ? {
            t: 'markdown-extension', raw, closing: true, self: false,
            pair: null, tag, safe: null
        } : null;
    }
    const safe = safeOpening(name, attrs);
    return safe?.ast ? {
        t: 'markdown-extension', raw, closing: false, self: safe.self,
        pair: null, tag: safe.tag, safe
    } : null;
};

const foldMarkdownExtensions = (nodes: InlineNode[]) => {
    const root: InlineNode[] = [];
    const stack: OpenExtension[] = [];
    const append = (node: InlineNode | null) => {
        if (!node) return;
        (stack[stack.length - 1]?.kids || root).push(node);
    };

    for (const candidate of nodes) {
        if (candidate.t !== 'markdown-extension') {
            append(candidate);
            continue;
        }
        const node = candidate as ExtensionNode;
        if (node.self) {
            append(makeMarkdownExtensionNode(node.safe!));
            continue;
        }
        if (!node.closing) {
            stack.push({ ...node, kids: [] });
            continue;
        }
        const open = stack[stack.length - 1];
        const pairedMarkers = open?.pair !== null || node.pair !== null;
        const matches = pairedMarkers
            ? open?.pair === node.pair
            : open?.tag === node.tag;
        if (!open || !matches) {
            append(text(node.raw));
            continue;
        }
        stack.pop();
        const folded = makeMarkdownExtensionNode(open.safe!, compactInlines(open.kids));
        if (folded) append(folded);
        else if (open.safe!.ast!.t === 'figure') {
            append(text(open.raw));
            open.kids.forEach(append);
            append(text(node.raw));
        }
    }

    while (stack.length) {
        const open = stack.pop()!;
        const target = stack[stack.length - 1]?.kids || root;
        target.push(text(open.raw), ...open.kids);
    }
    return compactInlines(root);
};

const markdownText = (value: unknown, extensions: MarkdownExtensions) => {
    const input = String(value ?? '');
    const nodes: InlineNode[] = [];
    let at = 0;
    extensions.markerPattern.lastIndex = 0;
    for (let hit = extensions.markerPattern.exec(input); hit; hit = extensions.markerPattern.exec(input)) {
        nodes.push(...parseBracketInline(input.slice(at, hit.index)));
        nodes.push({ t: 'markdown-extension', ...extensions.markers[Number(hit[1])] } as ExtensionNode);
        at = hit.index + hit[0].length;
    }
    nodes.push(...parseBracketInline(input.slice(at)));
    return nodes;
};

const textWithBreaks = (value: unknown, extensions: MarkdownExtensions) => compactInlines(String(value ?? '').split('\n')
    .flatMap((part, index) => index
        ? [BREAK, ...markdownText(part, extensions)]
        : markdownText(part, extensions)));

// Obsidian encodes image dimensions as the final segment of the alt text:
// ![alt|width](url) or ![alt|widthxheight](url). Treat the suffix as size
// metadata only when every supplied dimension passes the same bounds as
// bracket markup; otherwise it remains ordinary alt text.
const markdownImageAttributes = (token: MarkedToken) => {
    const rawAlt = String(token.text || '');
    const sized = /^(.*)\|(\d+)(?:x(\d+))?$/i.exec(rawAlt);
    if (!sized) return { alt: rawAlt, width: null, height: null };
    const width = sanitizeDimension(sized[2]);
    const height = sized[3] === undefined ? null : sanitizeDimension(sized[3]);
    return width && (sized[3] === undefined || height)
        ? { alt: sized[1], width, height }
        : { alt: rawAlt, width: null, height: null };
};

// `|xheight` exists only to preserve already-supported height-only video
// and iframe markup. Do not reinterpret an ordinary image alt suffix.
const markdownMediaAttributes = (token: MarkedToken) => {
    const rawAlt = String(token.text || '');
    const heightOnly = /^(.*)\|x(\d+)$/i.exec(rawAlt);
    if (!heightOnly) return markdownImageAttributes(token);
    const height = sanitizeDimension(heightOnly[2]);
    return height
        ? { alt: heightOnly[1], width: null, height }
        : { alt: rawAlt, width: null, height: null };
};

// Marked's ordinary `(destination)` form closes on an unmatched `)` in a
// signed media URL. Its angle-delimited destination preserves every URL
// character accepted by cleanUrlText (which already excludes `<`/`>`).
const markdownMediaDestination = (src: string) => /[()]/.test(src) ? `<${src}>` : src;

const markedInlines = (tokens: MarkedToken[] | undefined, extensions: MarkdownExtensions): InlineNode[] => foldMarkdownExtensions((tokens || []).flatMap((token): InlineNode[] => {
    if (!token || typeof token !== 'object') return [];
    if (token.type === 'text' || token.type === 'escape') {
        return token.tokens && token.tokens !== tokens
            ? markedInlines(token.tokens, extensions)
            : textWithBreaks(token.text, extensions);
    }
    if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
        const type = token.type === 'strong' ? 'b' : token.type === 'em' ? 'i' : 's';
        const kids = markedInlines(token.tokens, extensions);
        return kids.length ? [{ t: type, kids }] : [];
    }
    if (token.type === 'codespan') return [{ t: 'code', kids: [text(token.text)] }];
    if (token.type === 'br') return [BREAK];
    if (token.type === 'link') {
        const href = resolveLinkTarget(token.href);
        const kids = markedInlines(token.tokens, extensions);
        return href && kids.length ? [{ t: 'a', href, blank: false, kids }]
            : textWithBreaks(token.raw, extensions);
    }
    if (token.type === 'image') {
        const videoSrc = sanitizeVideoSrc(token.href);
        const mediaAttributes = markdownMediaAttributes(token);
        const youtubeSrc = sanitizeYouTubeEmbedSrc(token.href);
        if (youtubeSrc) {
            return [{
                t: 'youtube', src: youtubeSrc,
                width: mediaAttributes.width, height: mediaAttributes.height
            }];
        }
        const videoMarker = mediaAttributes.alt.trim().toLowerCase() === 'video';
        if (videoSrc && (isDirectVideoSrc(videoSrc) || videoMarker)) {
            return [{
                t: 'video', src: videoSrc,
                width: mediaAttributes.width, height: mediaAttributes.height
            }];
        }
        const src = sanitizeImageSrc(token.href);
        return src ? [{ t: 'img', src, ...markdownImageAttributes(token) }]
            : textWithBreaks(token.raw, extensions);
    }
    // Marked deliberately does not sanitize raw HTML. Convert only the
    // allowlisted single-tag tokens above; keep everything else visible
    // and inert instead of passing it to either innerHTML or Peakbagger.
    if (token.type === 'html') {
        const raw = token.raw || token.text || '';
        return [markdownHtmlExtension(raw) || text(raw)];
    }
    return token.tokens ? markedInlines(token.tokens, extensions)
        : textWithBreaks(token.raw || token.text || '', extensions);
}));

const markedBlocks = (tokens: MarkedToken[] | undefined, extensions: MarkdownExtensions): BlockNode[] => (tokens || []).flatMap((token): BlockNode[] => {
    if (!token || typeof token !== 'object' || token.type === 'space' || token.type === 'def') return [];
    if (token.type === 'paragraph' || token.type === 'text') {
        const kids = trimInlines(markedInlines(
            token.tokens || [{ type: 'text', text: token.text || token.raw }], extensions));
        return looseInlinesToParagraphs(kids);
    }
    if (token.type === 'heading') {
        const kids = trimInlines(markedInlines(token.tokens, extensions));
        return kids.length ? [{ type: 'heading', level: Math.min(6, Math.max(1, token.depth!)), kids }] : [];
    }
    if (token.type === 'blockquote') {
        const blocks = markedBlocks(token.tokens, extensions);
        return blocks.length ? [{ type: 'blockquote', blocks }] : [];
    }
    if (token.type === 'list') {
        const items = token.items!.map(item => {
            const blocks = markedBlocks(item.tokens, extensions);
            if (item.task) {
                const marker = text(item.checked ? '☑ ' : '☐ ');
                if (blocks[0]?.type === 'p') blocks[0].kids!.unshift(marker);
                else blocks.unshift({ type: 'p', kids: [marker] });
            }
            return blocks;
        }).filter(item => item.length);
        return items.length ? [{ type: 'list', ordered: !!token.ordered, items }] : [];
    }
    if (token.type === 'table') {
        const rows = [
            {
                header: true,
                cells: token.header!.map(cell => looseInlinesToParagraphs(markedInlines(cell.tokens, extensions)))
            },
            ...token.rows!.map(row => ({
                header: false,
                cells: row.map(cell => looseInlinesToParagraphs(markedInlines(cell.tokens, extensions)))
            }))
        ];
        return [{ type: 'table', rows }];
    }
    if (token.type === 'code') return [{ type: 'pre', text: token.text || '' }];
    if (token.type === 'hr') return [{ type: 'hr' }];
    if (token.type === 'html') {
        const raw = token.raw || token.text || '';
        const instagram = instagramPasteUrl(raw);
        if (instagram) return [{type:'instagram',url:instagram}];
        if (/^\s*<table[\s>]/i.test(raw) && /<\/table>\s*$/i.test(raw)) {
            const parsed = parseBracketWithDiagnostics(raw);
            if (!parsed.diagnostics.length && parsed.ast.length === 1
                && parsed.ast[0].type === 'table') return parsed.ast;
        }
        if (/^\s*<figure[\s>]/i.test(raw) && /<\/figure>\s*$/i.test(raw)) {
            const parsed = parseBracketWithDiagnostics(raw);
            if (!parsed.diagnostics.length && parsed.ast.length === 1
                && parsed.ast[0].kids?.length === 1
                && ['figure', 'img', 'a'].includes(parsed.ast[0].kids[0].t)) return parsed.ast;
        }
        return [{ type: 'p', kids: [text(raw)] }];
    }
    const fallback = String(token.raw || token.text || '');
    return fallback ? [{ type: 'p', kids: [text(fallback)] }] : [];
});

const parseMarkdown = (source: unknown) => {
    const parser = (globalThis as unknown as { marked?: { lexer?: MarkedLexer; marked?: { lexer?: MarkedLexer } } }).marked;
    const lexer = parser && (parser.lexer || parser.marked?.lexer);
    if (typeof lexer !== 'function') throw new Error('Vendored Marked parser is not loaded');
    // Marked recognizes the URL in a bracket video tag as an ordinary
    // link before our extension parser can see it. Normalize only the
    // validated paired form into the explicit Markdown video marker.
    const input = String(source ?? '').replace(
        /\[iframe\b([^\]\r\n]*)\]\s*\[\/iframe\]/gi,
        (raw, attributes) => {
            const src = sanitizeYouTubeEmbedSrc(readAttr(attributes, 'src'));
            const width = sanitizeDimension(readAttr(attributes, 'width'));
            const height = sanitizeDimension(readAttr(attributes, 'height'));
            const watch = src && youtubeWatchUrl(src);
            const size = width ? `|${width}${height ? `x${height}` : ''}`
                : height ? `|x${height}` : '';
            return watch ? `![YouTube${size}](${watch})` : raw;
        }
    ).replace(
        /\[video\b([^\]\r\n]*)\]\s*\[\/video\]/gi,
        (raw, attributes) => {
            const src = sanitizeVideoSrc(readAttr(attributes, 'src'));
            const width = sanitizeDimension(readAttr(attributes, 'width'));
            const height = sanitizeDimension(readAttr(attributes, 'height'));
            const size = width ? `|${width}${height ? `x${height}` : ''}`
                : height ? `|x${height}` : '';
            return src ? `![Video${size}](${markdownMediaDestination(src)})` : raw;
        }
    );
    const extensions = protectMarkdownExtensions(input);
    return instagramBlocks(markedBlocks(lexer(extensions.source, { gfm: true, breaks: false }), extensions)) as BlockNode[];
};

// ---- AST -> Peakbagger bracket markup ---------------------------------

const inlinesToBracket = (kids: InlineNode[] | undefined): string => (kids || []).map(node => {
    if (node.t === 'figure') return `[figure]${inlinesToBracket([node.media!])}[figcaption]${
        inlinesToBracket(node.caption)}[/figcaption][/figure]`;
    if (node.t === 'text') return escapeBracketText(node.text);
    if (node.t === 'br') return '\n';
    if (node.t === 'img') {
        return `[img src="${escapeAttribute(node.src)}"${node.alt ? ` alt="${escapeAttribute(node.alt)}"` : ''}${
            node.width ? ` width="${node.width}"` : ''}${node.height ? ` height="${node.height}"` : ''}]`;
    }
    if (node.t === 'video') {
        return `[video src="${escapeAttribute(node.src)}"${node.width ? ` width="${node.width}"` : ''}${
            node.height ? ` height="${node.height}"` : ''}${VIDEO_RUNTIME_ATTRIBUTES}][/video]`;
    }
    if (node.t === 'youtube') {
        return `[iframe src="${escapeAttribute(node.src)}"${node.width ? ` width="${node.width}"` : ''}${
            node.height ? ` height="${node.height}"` : ''}${YOUTUBE_RUNTIME_ATTRIBUTES}][/iframe]`;
    }
    const inner = inlinesToBracket(node.kids);
    if (node.t === 'a') {
        return `[a href="${escapeAttribute(node.href)}"${node.blank ? ' target="_blank"' : ''}]${inner}[/a]`;
    }
    if (node.t === 'color') return `[span style="color:${node.color}"]${inner}[/span]`;
    return `[${node.t}]${inner}[/${node.t}]`;
}).join('');

const blocksToBracket = (blocks: BlockNode[] | undefined): string => (blocks || []).map(block => {
    if (block.type === 'instagram') return `[a href="${escapeAttribute(block.url)}"]${escapeBracketText(block.url)}[/a]`;
    if (block.type === 'p') return inlinesToBracket(block.kids);
    if (block.type === 'heading') return `[h${block.level}]${inlinesToBracket(block.kids)}[/h${block.level}]`;
    if (block.type === 'blockquote') return `[blockquote]${blocksToBracket(block.blocks)}[/blockquote]`;
    if (block.type === 'list') {
        const tag = block.ordered ? 'ol' : 'ul';
        return `[${tag}]${block.items!.map(item => {
            let contents = '';
            item.forEach((child, index) => {
                if (index && child.type === 'p' && item[index - 1].type === 'p') contents += '\n\n';
                contents += blocksToBracket([child]);
            });
            return `[li]${contents}[/li]`;
        }).join('')}[/${tag}]`;
    }
    if (block.type === 'table') {
        return `[table border="1"]${block.rows!.map(row => `[tr]${row.cells.map(cell => {
            const tag = row.header ? 'th' : 'td';
            return `[${tag}]${blocksToBracket(cell)}[/${tag}]`;
        }).join('')}[/tr]`).join('')}[/table]`;
    }
    if (block.type === 'pre') return `[pre]${escapeBracketText(block.text)}[/pre]`;
    if (block.type === 'hr') return '[hr]';
    return '';
}).filter(rendered => rendered.trim()).join('\n\n');

const astToBracket = blocksToBracket;

// ---- AST -> safe editor/preview HTML ----------------------------------

const inlinesToHtml = (kids: InlineNode[] | undefined): string => (kids || []).map(node => {
    if (node.t === 'figure') return `<figure>${inlinesToHtml([node.media!])}<figcaption>${
        inlinesToHtml(node.caption)}</figcaption></figure>`;
    if (node.t === 'text') return escapeHtml(node.text);
    if (node.t === 'br') return '<br>';
    if (node.t === 'img') {
        return `<img src="${escapeAttribute(node.src)}" alt="${escapeAttribute(node.alt || '')}"${
            node.width ? ` width="${node.width}"` : ''}${node.height ? ` height="${node.height}"` : ''
        } loading="lazy" referrerpolicy="no-referrer">`;
    }
    if (node.t === 'video') {
        return `<video src="${escapeAttribute(node.src)}"${node.width ? ` width="${node.width}"` : ''}${
            node.height ? ` height="${node.height}"` : ''}${VIDEO_RUNTIME_ATTRIBUTES}></video>`;
    }
    if (node.t === 'youtube') {
        return `<iframe src="${escapeAttribute(node.src)}"${node.width ? ` width="${node.width}"` : ''}${
            node.height ? ` height="${node.height}"` : ''}${YOUTUBE_RUNTIME_ATTRIBUTES}></iframe>`;
    }
    const inner = inlinesToHtml(node.kids);
    if (node.t === 'a') return `<a href="${escapeAttribute(node.href)}"${
        node.blank ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`;
    if (node.t === 'color') return `<span style="color:${escapeAttribute(node.color)}">${inner}</span>`;
    return `<${node.t}>${inner}</${node.t}>`;
}).join('');

const blockToHtml = (block: BlockNode): string => {
    if (block.type === 'instagram') return `<p><a href="${escapeAttribute(block.url)}">${escapeHtml(block.url)}</a></p>`;
    if (block.type === 'p' && block.kids!.length === 1 && block.kids![0].t === 'figure') {
        return inlinesToHtml(block.kids);
    }
    if (block.type === 'p') return `<p>${inlinesToHtml(block.kids)}</p>`;
    if (block.type === 'heading') return `<h${block.level}>${inlinesToHtml(block.kids)}</h${block.level}>`;
    if (block.type === 'blockquote') return `<blockquote>${blocksToHtml(block.blocks)}</blockquote>`;
    if (block.type === 'list') {
        const tag = block.ordered ? 'ol' : 'ul';
        return `<${tag}>${block.items!.map(item => {
            const contents = item.length === 1 && item[0].type === 'p'
                ? inlinesToHtml(item[0].kids)
                : blocksToHtml(item);
            return `<li>${contents}</li>`;
        }).join('')}</${tag}>`;
    }
    if (block.type === 'table') {
        const headRows = block.rows!.filter(row => row.header);
        const bodyRows = block.rows!.filter(row => !row.header);
        const rowsHtml = (rows: TableRow[]) => rows.map(row => `<tr>${row.cells.map(cell => `<${row.header ? 'th' : 'td'}>${
            cell.length === 1 && cell[0].type === 'p' ? inlinesToHtml(cell[0].kids)
                : blocksToHtml(cell)}</${row.header ? 'th' : 'td'}>`).join('')}</tr>`).join('');
        return `<table>${headRows.length ? `<thead>${rowsHtml(headRows)}</thead>` : ''}${
            bodyRows.length ? `<tbody>${rowsHtml(bodyRows)}</tbody>` : ''}</table>`;
    }
    if (block.type === 'pre') return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    if (block.type === 'hr') return '<hr>';
    return '';
};

function blocksToHtml(blocks: BlockNode[] | undefined): string { return (blocks || []).map(blockToHtml).join(''); }

const astToHtml = (blocks: BlockNode[] | undefined, { editor = false } = {}) => {
    const html = blocksToHtml(blocks);
    return html || (editor ? '<p></p>' : '');
};

// ---- AST -> Markdown --------------------------------------------------

const escapeMarkdownText = (value: unknown) => String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_\[\]<>])/g, '\\$1');

const codeSpan = (value: unknown) => {
    const longest = Math.max(0, ...(String(value).match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${value}${fence}`;
};

// Captions stay in the narrow figure HTML even when formatted. Text keeps its
// Markdown delimiters and table pipes literal through entities.
const captionToMarkdown = (kids: InlineNode[] | undefined): string => (kids || []).map(node => {
    if (node.t === 'text') return escapeAttribute(node.text).replace(/[*_`|]/g,
        character => `&#${character.charCodeAt(0)};`);
    const inner = captionToMarkdown(node.kids);
    if (node.t === 'a') return `<a href="${escapeAttribute(node.href)}"${node.blank ? ' target="_blank"' : ''}>${inner}</a>`;
    if (node.t === 'color') return `<span style="color:${escapeAttribute(node.color)}">${inner}</span>`;
    return `<${node.t}>${inner}</${node.t}>`;
}).join('');

const inlinesToMarkdown = (kids: InlineNode[] | undefined): string => (kids || []).map(node => {
    if (node.t === 'figure') {
        const media = inlinesToBracket([node.media!]).replace(/\[([^\]]+)\]/g, '<$1>');
        return `<figure>${media}<figcaption>${captionToMarkdown(node.caption)}</figcaption></figure>`;
    }
    if (node.t === 'text') return escapeMarkdownText(node.text);
    if (node.t === 'br') return '\n';
    if (node.t === 'img') {
        if (node.width) {
            const size = `${node.width}${node.height ? `x${node.height}` : ''}`;
            return `![${escapeMarkdownText(node.alt || '')}|${size}](${node.src})`;
        }
        if (node.height) {
            return `<img src="${escapeAttribute(node.src)}" alt="${escapeAttribute(node.alt || '')}" height="${node.height}">`;
        }
        return `![${escapeMarkdownText(node.alt || '')}](${node.src})`;
    }
    if (node.t === 'video') {
        const size = node.width ? `|${node.width}${node.height ? `x${node.height}` : ''}`
            : node.height ? `|x${node.height}` : '';
        return `![Video${size}](${markdownMediaDestination(node.src!)})`;
    }
    if (node.t === 'youtube') {
        const watch = youtubeWatchUrl(node.src!);
        if (!watch) return '';
        const size = node.width ? `|${node.width}${node.height ? `x${node.height}` : ''}`
            : node.height ? `|x${node.height}` : '';
        return `![YouTube${size}](${watch})`;
    }
    const inner = inlinesToMarkdown(node.kids);
    if (node.t === 'b') return `**${inner}**`;
    if (node.t === 'i') return `*${inner}*`;
    if (node.t === 's') return `~~${inner}~~`;
    if (node.t === 'code') return codeSpan((node.kids || []).map(kid => kid.text || '').join(''));
    if (node.t === 'a') {
        return node.blank
            ? `<a href="${escapeAttribute(node.href)}" target="_blank">${inner}</a>`
            : `[${inner}](${node.href})`;
    }
    if (node.t === 'color') return `<span style="color:${escapeAttribute(node.color)}">${inner}</span>`;
    return `<${node.t}>${inner}</${node.t}>`;
}).join('');

const tableToMarkdown = (block: BlockNode) => {
    const sourceRows = block.rows!.slice();
    if (!sourceRows.length) return '';
    // GFM pipe cells contain inlines only. Preserve lists and other block
    // content as one allowlisted HTML table instead of flattening the cells.
    // Use saved attributes (not preview-only media attributes), and explicit
    // breaks so blank lines cannot split Marked's HTML token mid-table.
    if (sourceRows.some(row => row.cells.some(cell => cell.length > 1 || cell.some(child => child.type !== 'p')))) {
        return blocksToBracket([block])
            .replace(TAG_TOKEN, (raw: string, closing: string, tag: string, attrs: string) => tag ? `<${closing}${tag}${attrs}>` : raw)
            .replace(/\n/g, '<br>');
    }
    const first = sourceRows[0];
    const header = first.header ? first : { header: true, cells: first.cells.map(() => []) };
    const body = first.header ? sourceRows.slice(1) : sourceRows;
    const row = (cells: BlockNode[][]) => `| ${cells.map(cell => inlinesToMarkdown(cell[0]?.kids)
        .replace(/\n/g, '<br>')
        .replace(/\|/g, '\\|')).join(' | ')} |`;
    return [row(header.cells), `| ${header.cells.map(() => '---').join(' | ')} |`,
        ...body.map(item => row(item.cells))].join('\n');
};

const listToMarkdown = (block: BlockNode) => block.items!.map((item, index) => {
    const rendered = blocksToMarkdown(item);
    const lines = rendered.split('\n');
    const marker = block.ordered ? `${index + 1}. ` : '- ';
    const indent = ' '.repeat(marker.length);
    return marker + lines.map((line, lineIndex) => lineIndex ? indent + line : line).join('\n');
}).join('\n');

function blocksToMarkdown(blocks: BlockNode[] | undefined): string {
    return (blocks || []).map(block => {
        if (block.type === 'instagram') return block.url;
        if (block.type === 'p') return inlinesToMarkdown(block.kids);
        if (block.type === 'heading') return `${'#'.repeat(block.level!)} ${inlinesToMarkdown(block.kids)}`;
        if (block.type === 'blockquote') {
            return blocksToMarkdown(block.blocks).split('\n').map(line => `> ${line}`).join('\n');
        }
        if (block.type === 'list') return listToMarkdown(block);
        if (block.type === 'table') return tableToMarkdown(block);
        if (block.type === 'pre') {
            const longest = Math.max(2, ...(block.text!.match(/`+/g) || []).map(run => run.length));
            const fence = '`'.repeat(longest + 1);
            return `${fence}\n${block.text}\n${fence}`;
        }
        if (block.type === 'hr') return '---';
        return '';
    }).filter(rendered => rendered!.trim()).join('\n\n');
}

const astToMarkdown = blocksToMarkdown;

// Peakbagger may return rendered line breaks to its edit form as explicit
// bracket/HTML break tags. In the native textarea those tags are semantically
// identical to newlines but make the report appear as one long source line.
// Keep this deliberately narrower than the AST normalizer: Plain mode must
// preserve every other spelling, including break-shaped tags with attributes.
const breakTagsToNewlines = (source: unknown) => {
    const input = String(source ?? '');
    let output = '';
    let at = 0;
    TAG_TOKEN.lastIndex = 0;
    for (let hit = TAG_TOKEN.exec(input); hit; hit = TAG_TOKEN.exec(input)) {
        const bracket = hit[1] !== undefined;
        const closing = (bracket ? hit[1] : hit[4]) === '/';
        const name = (bracket ? hit[2] : hit[5]).toLowerCase();
        const attrs = bracket ? hit[3] : hit[6];
        if (closing || name !== 'br' || !/^\s*\/?\s*$/.test(attrs)) continue;
        output += input.slice(at, hit.index) + '\n';
        at = hit.index + hit[0].length;
    }
    return output + input.slice(at);
};

// ---- Public surface ---------------------------------------------------

const API = {
    resolveLinkTarget,
    sanitizeImageSrc,
    sanitizeVideoSrc,
    sanitizeYouTubeEmbedSrc,
    sanitizeReportDimension,
    parseBracket,
    parseBracketWithDiagnostics,
    astToBracket,
    astToHtml,
    breakTagsToNewlines,
    bracketToEditorHtml: (source: unknown) => astToHtml(parseBracket(source), { editor: true }),
    bracketToPreviewHtml: (source: unknown) => astToHtml(parseBracket(source)),
    bracketToMarkdown: (source: unknown) => astToMarkdown(parseBracket(source)),
    markdownToBracket: (source: unknown) => astToBracket(parseMarkdown(source)),
    markdownToPreviewHtml: (source: unknown) => astToHtml(parseMarkdown(source)),
    domToBracket: (root: Element) => astToBracket(domToAst(root))
};

export const reportMarkup = API;
