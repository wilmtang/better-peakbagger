// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure trip-report markup conversions.
//
// Peakbagger's ascent editor accepts HTML tags written with square brackets
// ([b]Bolded[/b]) because ASP.NET request validation rejects raw "<" in the
// form post; the server converts brackets to angle brackets and every newline
// to <br> when rendering (verified against archived rendered reports). Its own
// hint says a paragraph is "Enter twice" and to avoid [p] and [br]. So the
// canonical output this module produces is:
//
//   * paragraphs separated by one blank line, single newlines inside them;
//   * inline formatting limited to [b], [i], [u], and [a href="…"];
//   * never [p] or [br]; lists as literal "- " / "1. " lines (safe rendering).
//
// Everything converts through one small AST so the rich editor, the markdown
// mode, its preview, and the saved bracket markup can never disagree:
//
//   block  := { type:'p', lines: Inline[][] }
//           | { type:'list', ordered: boolean, items: Inline[][] }
//   Inline := { t:'text', text } | { t:'b'|'i'|'u', kids } | { t:'a', href, kids }
//
// Imports are conservative: only the tags above are recognized (both [b] and
// <b> forms, since a saved report may round-trip through the server in either
// shape); anything else — unknown tags, unclosed tags, unsafe link targets —
// stays literal text, so a report this module cannot represent survives
// untouched rather than being mangled.
//
// This file intentionally has no DOM construction, extension-API, or storage
// dependency (domToAst only *reads* a DOM subtree handed to it), so it loads
// in content scripts and in jsdom tests alike.
// Idempotent: safe to inject more than once into the same global.

(() => {
    'use strict';

    if (globalThis.BPBReportMarkup) return;

    const FORMAT_TAGS = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u' };

    // Links may only point somewhere a reader could safely follow.
    const sanitizeHref = raw => {
        if (typeof raw !== 'string') return null;
        const href = raw.trim();
        if (/^https?:\/\/\S+$/i.test(href)) return href;
        if (/^mailto:\S+@\S+$/i.test(href)) return href;
        return null;
    };

    // Scheme-less markdown link targets ("example.com/photos") get https://.
    const resolveLinkTarget = raw => {
        const direct = sanitizeHref(raw);
        if (direct) return direct;
        const href = String(raw || '').trim();
        return /^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/.test(href) ? `https://${href}` : null;
    };

    const text = value => ({ t: 'text', text: value });

    // ---- Inline parsing ---------------------------------------------------

    // Match an opening [tag]/<tag> at `from` and locate its close, honoring
    // nested same-name tags. Returns null when this is not a well-formed tag
    // the module supports — the caller then keeps the character literal.
    const matchTag = (line, from) => {
        const open = /^([[<])\s*([a-z]+)((?:\s[^\]>]*)?)([\]>])/i.exec(line.slice(from));
        if (!open) return null;
        if ((open[1] === '[') !== (open[4] === ']')) return null;
        const name = open[2].toLowerCase();
        const isLink = name === 'a';
        if (!isLink && !FORMAT_TAGS[name]) return null;

        let href = null;
        if (isLink) {
            const attr = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]>]+))/i.exec(open[3] || '');
            href = sanitizeHref(attr && (attr[1] ?? attr[2] ?? attr[3]));
            if (!href) return null;
        }

        const innerStart = from + open[0].length;
        const tagToken = new RegExp(`[[<]\\s*(/?)\\s*${name}(?:\\s[^\\]>]*)?[\\]>]`, 'gi');
        tagToken.lastIndex = innerStart;
        let depth = 1;
        for (let hit = tagToken.exec(line); hit; hit = tagToken.exec(line)) {
            depth += hit[1] ? -1 : 1;
            if (depth === 0) {
                return {
                    name: isLink ? 'a' : FORMAT_TAGS[name],
                    href,
                    inner: line.slice(innerStart, hit.index),
                    end: hit.index + hit[0].length
                };
            }
        }
        return null;
    };

    // Match a markdown emphasis span delimited by `delim` at `from`.
    const matchDelim = (line, from, delim) => {
        const start = from + delim.length;
        const close = line.indexOf(delim, start);
        if (close < 0) return null;
        const inner = line.slice(start, close);
        if (!inner.trim() || /^\s|\s$/.test(inner)) return null;
        return { inner, end: close + delim.length };
    };

    const wordish = ch => ch !== undefined && /[\w]/.test(ch);

    const AUTOLINK = /^https?:\/\/[^\s<>[\]]+/i;
    // Trailing punctuation belongs to the sentence, not the URL; a trailing
    // ")" is kept only while the URL has a matching "(" (Wikipedia-style).
    const trimAutolink = url => {
        let out = url;
        for (;;) {
            if (/[.,;:!?'"]$/.test(out)) { out = out.slice(0, -1); continue; }
            if (out.endsWith(')')
                && (out.match(/\)/g) || []).length > (out.match(/\(/g) || []).length) {
                out = out.slice(0, -1);
                continue;
            }
            return out;
        }
    };

    const parseInline = (line, markdown) => {
        const out = [];
        let plain = '';
        const flush = () => {
            if (plain) { out.push(text(plain)); plain = ''; }
        };
        let i = 0;
        while (i < line.length) {
            const ch = line[i];

            if (ch === '[' || ch === '<') {
                const tag = matchTag(line, i);
                if (tag) {
                    flush();
                    const kids = parseInline(tag.inner, markdown);
                    out.push(tag.name === 'a' ? { t: 'a', href: tag.href, kids } : { t: tag.name, kids });
                    i = tag.end;
                    continue;
                }
            }

            if (markdown) {
                if (ch === '[') {
                    const link = /^\[([^\]]*)\]\(\s*([^\s)]+)\s*\)/.exec(line.slice(i));
                    const href = link && resolveLinkTarget(link[2]);
                    if (href) {
                        flush();
                        const label = link[1].trim() ? parseInline(link[1], markdown) : [text(href)];
                        out.push({ t: 'a', href, kids: label });
                        i += link[0].length;
                        continue;
                    }
                }
                let hit = null;
                if (line.startsWith('**', i) && (hit = matchDelim(line, i, '**'))) {
                    flush(); out.push({ t: 'b', kids: parseInline(hit.inner, markdown) }); i = hit.end; continue;
                }
                if (line.startsWith('__', i) && !wordish(line[i - 1]) && (hit = matchDelim(line, i, '__'))) {
                    flush(); out.push({ t: 'b', kids: parseInline(hit.inner, markdown) }); i = hit.end; continue;
                }
                if (ch === '*' && (hit = matchDelim(line, i, '*'))) {
                    flush(); out.push({ t: 'i', kids: parseInline(hit.inner, markdown) }); i = hit.end; continue;
                }
                if (ch === '_' && !wordish(line[i - 1]) && (hit = matchDelim(line, i, '_'))
                    && !wordish(line[hit.end])) {
                    flush(); out.push({ t: 'i', kids: parseInline(hit.inner, markdown) }); i = hit.end; continue;
                }
                const auto = AUTOLINK.exec(line.slice(i));
                if (auto && !wordish(line[i - 1])) {
                    const url = trimAutolink(auto[0]);
                    if (sanitizeHref(url)) {
                        flush();
                        out.push({ t: 'a', href: url, kids: [text(url)] });
                        i += url.length;
                        continue;
                    }
                }
            }

            plain += ch;
            i += 1;
        }
        flush();
        return out;
    };

    // ---- Block parsing ------------------------------------------------------

    const LIST_ITEM = /^\s{0,3}([-*+•])\s+(.*)$/;
    const ORDERED_ITEM = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
    const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;

    const parseLines = (lines, markdown) => {
        const blocks = [];
        let para = null;
        const flushPara = () => { if (para && para.lines.length) blocks.push(para); para = null; };

        for (const rawLine of lines) {
            const line = rawLine.trim();
            const unordered = LIST_ITEM.exec(line);
            const ordered = unordered ? null : ORDERED_ITEM.exec(line);
            if (unordered || ordered) {
                flushPara();
                const isOrdered = !!ordered;
                const last = blocks[blocks.length - 1];
                const item = parseInline((unordered || ordered)[2], markdown);
                if (last && last.type === 'list' && last.ordered === isOrdered) last.items.push(item);
                else blocks.push({ type: 'list', ordered: isOrdered, items: [item] });
                continue;
            }
            const heading = markdown ? HEADING.exec(line) : null;
            if (heading) {
                flushPara();
                blocks.push({ type: 'p', lines: [[{ t: 'b', kids: parseInline(heading[1], markdown) }]] });
                continue;
            }
            para = para || { type: 'p', lines: [] };
            para.lines.push(parseInline(line, markdown));
        }
        flushPara();
        return blocks;
    };

    const splitBlocks = source =>
        String(source ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);

    const parseBracket = source => splitBlocks(source)
        .flatMap(chunk => parseLines(chunk.split('\n'), false));

    const parseMarkdown = source => splitBlocks(source)
        .flatMap(chunk => parseLines(chunk.split('\n'), true));

    // ---- Serializers --------------------------------------------------------

    const inlinesToBracket = kids => kids.map(node => {
        if (node.t === 'text') return node.text;
        const inner = inlinesToBracket(node.kids);
        if (node.t === 'a') return `[a href="${node.href}"]${inner}[/a]`;
        return `[${node.t}]${inner}[/${node.t}]`;
    }).join('');

    const astToBracket = blocks => blocks.map(block => {
        if (block.type === 'list') {
            return block.items
                .map((item, index) => `${block.ordered ? `${index + 1}. ` : '- '}${inlinesToBracket(item)}`)
                .join('\n');
        }
        return block.lines.map(inlinesToBracket).join('\n');
    }).filter(rendered => rendered.trim()).join('\n\n');

    const escapeHtml = value => value
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const inlinesToHtml = kids => kids.map(node => {
        if (node.t === 'text') return escapeHtml(node.text);
        const inner = inlinesToHtml(node.kids);
        if (node.t === 'a') return `<a href="${escapeHtml(node.href)}">${inner}</a>`;
        return `<${node.t}>${inner}</${node.t}>`;
    }).join('');

    // `editor: true` produces contenteditable-friendly HTML (empty paragraphs
    // become <p><br></p> so the caret has somewhere to live).
    const astToHtml = (blocks, { editor = false } = {}) => {
        const html = blocks.map(block => {
            if (block.type === 'list') {
                const tag = block.ordered ? 'ol' : 'ul';
                return `<${tag}>${block.items.map(item => `<li>${inlinesToHtml(item)}</li>`).join('')}</${tag}>`;
            }
            const lines = block.lines.map(inlinesToHtml);
            if (!lines.join('')) return editor ? '<p><br></p>' : '';
            return `<p>${lines.join('<br>')}</p>`;
        }).filter(Boolean).join('');
        return html || (editor ? '<p><br></p>' : '');
    };

    const inlinesToMarkdown = kids => kids.map(node => {
        if (node.t === 'text') return node.text;
        const inner = inlinesToMarkdown(node.kids);
        if (node.t === 'a') return `[${inner}](${node.href})`;
        if (node.t === 'b') return `**${inner}**`;
        if (node.t === 'i') return `*${inner}*`;
        return `[u]${inner}[/u]`; // markdown has no underline; keep the bracket form
    }).join('');

    const astToMarkdown = blocks => blocks.map(block => {
        if (block.type === 'list') {
            return block.items
                .map((item, index) => `${block.ordered ? `${index + 1}. ` : '- '}${inlinesToMarkdown(item)}`)
                .join('\n');
        }
        return block.lines.map(inlinesToMarkdown).join('\n');
    }).filter(rendered => rendered.trim()).join('\n\n');

    // ---- Editor-DOM import --------------------------------------------------

    const BLOCKISH = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'LI', 'TR']);
    const BREAK = { t: 'br' };

    const styleWraps = el => {
        const style = el.style;
        const wraps = [];
        const tag = el.tagName;
        if (tag === 'B' || tag === 'STRONG' || (style && /^(bold|bolder|[6-9]00)$/.test(style.fontWeight))) wraps.push('b');
        if (tag === 'I' || tag === 'EM' || (style && style.fontStyle === 'italic')) wraps.push('i');
        if (tag === 'U' || (style && /underline/.test(style.textDecorationLine || style.textDecoration || ''))) wraps.push('u');
        return wraps;
    };

    // Flatten a subtree to inline nodes plus BREAK sentinels at <br> and at
    // nested block boundaries. Unknown wrappers contribute only their children.
    const collectInline = node => {
        const out = [];
        for (const child of node.childNodes) {
            if (child.nodeType === 3) {
                const value = child.nodeValue.replace(/[\s\u00a0]+/g, ' ');
                if (value) out.push(text(value));
                continue;
            }
            if (child.nodeType !== 1) continue;
            const tag = child.tagName;
            if (tag === 'BR') { out.push(BREAK); continue; }
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') continue;

            const nestedBlock = BLOCKISH.has(tag) || tag === 'UL' || tag === 'OL' || tag === 'TABLE';
            if (nestedBlock && out.length && out[out.length - 1] !== BREAK) out.push(BREAK);

            let kids = collectInline(child);
            if (tag === 'A') {
                const href = sanitizeHref(child.getAttribute('href'));
                if (href && kids.length) kids = [{ t: 'a', href, kids }];
            }
            for (const wrap of styleWraps(child).reverse()) {
                if (kids.length) kids = [{ t: wrap, kids }];
            }
            out.push(...kids);
            if (nestedBlock && out.length && out[out.length - 1] !== BREAK) out.push(BREAK);
        }
        return out;
    };

    // Split a BREAK-sentinel inline stream into trimmed lines.
    const toLines = stream => {
        const lines = [[]];
        for (const node of stream) {
            if (node === BREAK) lines.push([]);
            else lines[lines.length - 1].push(node);
        }
        const trimLine = kids => {
            const first = kids[0];
            if (first && first.t === 'text') first.text = first.text.replace(/^ +/, '');
            const last = kids[kids.length - 1];
            if (last && last.t === 'text') last.text = last.text.replace(/ +$/, '');
            return kids.filter(node => node.t !== 'text' || node.text);
        };
        return lines.map(trimLine);
    };

    const isEmptyLine = kids => !kids.length;

    const domToAst = root => {
        const blocks = [];
        let pending = [];
        const flushPending = () => {
            if (!pending.length) return;
            let lines = toLines(pending);
            while (lines.length && isEmptyLine(lines[0])) lines.shift();
            while (lines.length && isEmptyLine(lines[lines.length - 1])) lines.pop();
            if (lines.length) blocks.push({ type: 'p', lines });
            pending = [];
        };

        for (const child of root.childNodes) {
            const tag = child.nodeType === 1 ? child.tagName : null;
            if (tag === 'UL' || tag === 'OL') {
                flushPending();
                const items = [...child.children]
                    .filter(li => li.tagName === 'LI')
                    .map(li => toLines(collectInline(li)).filter(line => !isEmptyLine(line))
                        .flatMap((line, index) => index ? [text(' '), ...line] : line));
                const kept = items.filter(item => item.length);
                if (kept.length) blocks.push({ type: 'list', ordered: tag === 'OL', items: kept });
                continue;
            }
            if (tag && BLOCKISH.has(tag)) {
                flushPending();
                const heading = /^H[1-6]$/.test(tag);
                let lines = toLines(collectInline(child));
                while (lines.length && isEmptyLine(lines[0])) lines.shift();
                while (lines.length && isEmptyLine(lines[lines.length - 1])) lines.pop();
                if (heading) lines = lines.map(kids => (kids.length ? [{ t: 'b', kids }] : kids));
                blocks.push({ type: 'p', lines: lines.length ? lines : [[]] });
                continue;
            }
            // Loose inline content (text nodes, <b>…, <br>) between blocks.
            pending.push(...collectInline({ childNodes: [child] }));
        }
        flushPending();
        return blocks;
    };

    // ---- Public surface -----------------------------------------------------

    const API = {
        sanitizeHref,
        resolveLinkTarget,
        parseBracket,
        parseMarkdown,
        domToAst,
        astToBracket,
        astToHtml,
        astToMarkdown,
        bracketToEditorHtml: source => astToHtml(parseBracket(source), { editor: true }),
        bracketToPreviewHtml: source => astToHtml(parseBracket(source)),
        bracketToMarkdown: source => astToMarkdown(parseBracket(source)),
        markdownToBracket: source => astToBracket(parseMarkdown(source)),
        markdownToPreviewHtml: source => astToHtml(parseMarkdown(source)),
        domToBracket: root => astToBracket(domToAst(root))
    };

    globalThis.BPBReportMarkup = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
