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
// is parsed through a detached, sanitized DOM, and editor DOM is read back into
// the same AST.
//
// Supported blocks: paragraphs/line breaks, h1-h6, block quotes, nested ul/ol,
// tables, preformatted code, and horizontal rules. Supported inline content:
// b/strong, i/em, u, s/strike/del, small, mark, sub, sup, code, q, safe links,
// HTTPS images, and color-only span/font markup. P/div/br are accepted on
// import but normalized to Peakbagger's newline convention.
//
// This module never accepts arbitrary HTML. Unsupported tags, raw Markdown
// HTML, unsafe URLs, event attributes, and non-color styles become visible
// text, and their tag delimiters are entity-escaped before submission. Plain
// mode in report-editor.js remains the explicit verbatim escape hatch.
// Idempotent: safe to inject more than once into the same global.


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
        'ul', 'ol', 'li', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'th', 'td', 'pre'
    ]);
    const VOID_TAGS = new Set(['br', 'hr', 'img']);
    const DOM_BLOCKS = new Set([
        'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
        'UL', 'OL', 'TABLE', 'PRE', 'HR'
    ]);
    const DROP_DOM = new Set([
        'SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT',
        'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'
    ]);
    const BREAK = Object.freeze({ t: 'br' });

    const text = value => ({ t: 'text', text: String(value ?? '') });

    const cleanUrlText = raw => {
        if (typeof raw !== 'string') return null;
        const value = raw.trim();
        if (!value || /[\u0000-\u0020"'<>\[\]\\]/.test(value)) return null;
        return value;
    };

    // Links can be web/mail links, root-relative Peakbagger links, or a local
    // fragment. Protocol-relative URLs are rejected so the scheme is explicit.
    const sanitizeHref = raw => {
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
    const resolveLinkTarget = raw => {
        const direct = sanitizeHref(raw);
        if (direct) return direct;
        const href = cleanUrlText(String(raw || ''));
        return href && /^[\w-]+(?:\.[\w-]+)+(?:[/?#].*)?$/.test(href)
            ? `https://${href}`
            : null;
    };

    // Images are more restrictive than links: no HTTP mixed content, data
    // URLs, protocol-relative hosts, or filesystem/browser schemes.
    const sanitizeImageSrc = raw => {
        const src = cleanUrlText(raw);
        if (!src) return null;
        if (/^\/(?!\/)[^\s]*$/.test(src)) return src;
        try { return new URL(src).protocol === 'https:' ? src : null; }
        catch (error) { return null; }
    };

    const sanitizeColor = raw => {
        if (typeof raw !== 'string') return null;
        const color = raw.trim().toLowerCase();
        const named = /^[a-z]{3,}$/.test(color) && color.length <= 20;
        return /^(?:#[0-9a-f]{3,8})$/.test(color) || named ? color : null;
    };

    const sanitizeDimension = raw => {
        if (raw === null || raw === undefined || raw === '') return null;
        const value = Number(raw);
        return Number.isInteger(value) && value >= 1 && value <= 1600 ? value : null;
    };

    const escapeHtml = value => String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const escapeAttribute = value => escapeHtml(value)
        .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');

    // JournalText becomes HTML on Peakbagger. Encode ordinary text as HTML,
    // and additionally neutralize square-bracket strings that look like tags.
    const escapeBracketText = value => String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\[(\/?[a-z][a-z0-9]*(?:\s[^\]\r\n]*)?)\]/gi, '&#91;$1&#93;');

    const readAttr = (attrs, name) => {
        const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i');
        const hit = pattern.exec(attrs || '');
        return hit ? (hit[1] ?? hit[2] ?? hit[3]) : null;
    };

    const normalizedTag = name => {
        const lower = String(name || '').toLowerCase();
        if (INLINE_TAGS.has(lower)) return INLINE_TAGS.get(lower);
        if (lower === 'font') return 'span';
        if (BLOCK_TAGS.has(lower) || VOID_TAGS.has(lower) || lower === 'a' || lower === 'span') return lower;
        return null;
    };

    // Build one safe HTML opening tag. Returning null means the source token
    // must remain text. The closing token is converted only when paired with a
    // successfully validated opening token.
    const safeOpening = (name, attrs) => {
        const sourceName = String(name || '').toLowerCase();
        const tag = normalizedTag(sourceName);
        if (!tag) return null;

        if (INLINE_TAGS.has(sourceName)) return { tag, html: `<${tag}>`, self: false };
        if (BLOCK_TAGS.has(sourceName)) return { tag, html: `<${tag}>`, self: false };
        if (tag === 'br' || tag === 'hr') return { tag, html: `<${tag}>`, self: true };
        if (tag === 'a') {
            const href = sanitizeHref(readAttr(attrs, 'href'));
            if (!href) return null;
            const blank = readAttr(attrs, 'target') === '_blank';
            return {
                tag,
                html: `<a href="${escapeAttribute(href)}"${blank ? ' target="_blank" rel="noopener noreferrer"' : ''}>`,
                self: false
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
                self: true
            };
        }
        if (tag === 'span') {
            const styleColor = /^\s*color\s*:\s*([^;]+)\s*;?\s*$/i.exec(readAttr(attrs, 'style') || '');
            const color = sanitizeColor(sourceName === 'font'
                ? readAttr(attrs, 'color')
                : styleColor && styleColor[1]);
            if (!color) return null;
            return { tag, html: `<span style="color:${escapeAttribute(color)}">`, self: false };
        }
        return null;
    };

    const TAG_TOKEN = /\[(\/?)([a-z][a-z0-9]*)([^\]\r\n]*)\]|<(\/?)([a-z][a-z0-9]*)([^>\r\n]*)>/gi;

    // Convert only balanced, validated allowlisted tags to detached HTML. Raw
    // source newlines become <br>, exactly as Peakbagger renders them.
    const bracketSourceToSafeHtml = (source, { inlineOnly = false } = {}) => {
        const input = String(source ?? '').replace(/\r\n?/g, '\n');
        const tokens = [];
        for (let hit = TAG_TOKEN.exec(input); hit; hit = TAG_TOKEN.exec(input)) {
            const bracket = hit[1] !== undefined;
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
                paired: false
            });
        }

        const stack = [];
        for (const token of tokens) {
            if (!token.closing) {
                const safe = safeOpening(token.name, token.attrs);
                if (!safe || (inlineOnly && (BLOCK_TAGS.has(token.name) || safe.tag === 'hr'))) continue;
                token.safe = safe;
                if (safe.self) token.paired = true;
                else stack.push(token);
                continue;
            }
            if (token.attrs.trim()) continue;
            const closeTag = normalizedTag(token.name);
            const open = stack[stack.length - 1];
            if (open && closeTag && open.safe.tag === closeTag) {
                stack.pop();
                open.paired = true;
                token.safe = { tag: closeTag, html: `</${closeTag}>`, self: false };
                token.paired = true;
            }
        }

        const appendText = value => value
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

    const getParserDocument = html => {
        if (typeof DOMParser === 'undefined') {
            throw new Error('BPBReportMarkup requires DOMParser');
        }
        return new DOMParser().parseFromString(`<body><div id="bpb-report-root">${html}</div></body>`, 'text/html');
    };

    // ---- DOM -> AST --------------------------------------------------------

    const compactInlines = nodes => {
        const out = [];
        for (const node of nodes.flat()) {
            if (!node) continue;
            if (node.t === 'text' && !node.text) continue;
            const last = out[out.length - 1];
            if (node.t === 'text' && last && last.t === 'text') last.text += node.text;
            else out.push(node);
        }
        return out;
    };

    const trimInlines = nodes => {
        const out = compactInlines(nodes).slice();
        while (out[0] === BREAK) out.shift();
        while (out[out.length - 1] === BREAK) out.pop();
        if (out[0]?.t === 'text') out[0] = text(out[0].text.replace(/^ +/, ''));
        if (out[out.length - 1]?.t === 'text') {
            out[out.length - 1] = text(out[out.length - 1].text.replace(/ +$/, ''));
        }
        return out.filter(node => node.t !== 'text' || node.text);
    };

    const colorFromElement = element => {
        const raw = element.tagName === 'FONT'
            ? element.getAttribute('color')
            : element.style && element.style.color;
        return sanitizeColor(raw);
    };

    const styleWraps = element => {
        const style = element.style;
        const wraps = [];
        if (style && /^(bold|bolder|[6-9]00)$/.test(style.fontWeight)) wraps.push('b');
        if (style && style.fontStyle === 'italic') wraps.push('i');
        const decoration = style && (style.textDecorationLine || style.textDecoration || '');
        if (/underline/.test(decoration)) wraps.push('u');
        if (/line-through/.test(decoration)) wraps.push('s');
        return wraps;
    };

    const inlineFromNode = node => {
        if (node.nodeType === 3) {
            const value = node.nodeValue.replace(/[\t\n\f\r \u00a0]+/g, ' ');
            return value ? [text(value)] : [];
        }
        if (node.nodeType !== 1) return [];
        const tag = node.tagName;
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

    const inlinesFrom = element => compactInlines([...element.childNodes].flatMap(inlineFromNode));

    // Two consecutive <br> elements are Peakbagger's paragraph separator. A
    // single <br> stays in the paragraph. Empty editor scaffolding is dropped.
    const looseInlinesToParagraphs = stream => {
        const blocks = [];
        let current = [];
        const flush = () => {
            const kids = trimInlines(current);
            if (kids.length) blocks.push({ type: 'p', kids });
            current = [];
        };
        for (const node of compactInlines(stream)) {
            if (node === BREAK) {
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

    const preformattedText = element => {
        let value = '';
        const visit = node => {
            if (node.nodeType === 3) value += node.nodeValue.replace(/\u00a0/g, ' ');
            else if (node.nodeType === 1 && node.tagName === 'BR') value += '\n';
            else if (node.nodeType === 1 && !DROP_DOM.has(node.tagName)) [...node.childNodes].forEach(visit);
        };
        [...element.childNodes].forEach(visit);
        return value.replace(/^\n|\n$/g, '');
    };

    const tableRows = table => {
        const rows = [];
        const addRow = row => {
            const cells = [...row.children].filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD');
            if (!cells.length) return;
            rows.push({
                header: cells.every(cell => cell.tagName === 'TH'),
                cells: cells.map(cell => trimInlines(inlinesFrom(cell)))
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

    const blockFromElement = element => {
        const tag = element.tagName;
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

    function domChildrenToBlocks(root) {
        const blocks = [];
        let pending = [];
        const flush = () => {
            blocks.push(...looseInlinesToParagraphs(pending));
            pending = [];
        };
        for (const child of root.childNodes) {
            if (child.nodeType === 1 && DOM_BLOCKS.has(child.tagName)) {
                flush();
                blocks.push(...blockFromElement(child));
            } else if (child.nodeType === 3 && !child.nodeValue.trim() && !pending.length) {
                continue;
            } else pending.push(...inlineFromNode(child));
        }
        flush();
        return blocks;
    }

    const domToAst = root => domChildrenToBlocks(root);

    // The first editor release serialized visual lists as literal "- "/"1. "
    // lines. Continue recognizing those reports on import while emitting real
    // Peakbagger list tags from now on.
    const upgradeLegacyLists = blocks => blocks.map(block => {
        if (block.type === 'blockquote') return { ...block, blocks: upgradeLegacyLists(block.blocks) };
        if (block.type === 'list') {
            return { ...block, items: block.items.map(item => upgradeLegacyLists(item)) };
        }
        if (block.type !== 'p') return block;
        const lines = [[]];
        for (const node of block.kids) {
            if (node === BREAK) lines.push([]);
            else lines[lines.length - 1].push(node);
        }
        if (!lines.length || lines.some(line => !line.length || line[0].t !== 'text')) return block;
        const matches = lines.map(line => /^(?:([-*+•])|(\d{1,3})[.)])\s+/.exec(line[0].text));
        if (matches.some(match => !match)) return block;
        const ordered = !!matches[0][2];
        if (matches.some(match => !!match[2] !== ordered)) return block;
        const items = lines.map((line, index) => {
            const kids = line.slice();
            kids[0] = text(kids[0].text.slice(matches[index][0].length));
            return [{ type: 'p', kids: trimInlines(kids) }];
        });
        return { type: 'list', ordered, items };
    });

    const parseBracket = source => {
        const doc = getParserDocument(bracketSourceToSafeHtml(source));
        return upgradeLegacyLists(domToAst(doc.getElementById('bpb-report-root')));
    };

    const parseBracketInline = source => {
        const doc = getParserDocument(bracketSourceToSafeHtml(source, { inlineOnly: true }));
        // Do not trim here: Marked splits "text **bold** text" into three
        // tokens, and the spaces live at the edges of the two text tokens.
        return compactInlines(inlinesFrom(doc.getElementById('bpb-report-root')));
    };

    // ---- Marked tokens -> AST ---------------------------------------------

    const textWithBreaks = value => compactInlines(String(value ?? '').split('\n')
        .flatMap((part, index) => index ? [BREAK, ...parseBracketInline(part)] : parseBracketInline(part)));

    const markedInlines = tokens => compactInlines((tokens || []).flatMap(token => {
        if (!token || typeof token !== 'object') return [];
        if (token.type === 'text' || token.type === 'escape') {
            return token.tokens && token.tokens !== tokens
                ? markedInlines(token.tokens)
                : textWithBreaks(token.text);
        }
        if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
            const type = token.type === 'strong' ? 'b' : token.type === 'em' ? 'i' : 's';
            const kids = markedInlines(token.tokens);
            return kids.length ? [{ t: type, kids }] : [];
        }
        if (token.type === 'codespan') return [{ t: 'code', kids: [text(token.text)] }];
        if (token.type === 'br') return [BREAK];
        if (token.type === 'link') {
            const href = resolveLinkTarget(token.href);
            const kids = markedInlines(token.tokens);
            return href && kids.length ? [{ t: 'a', href, blank: false, kids }] : textWithBreaks(token.raw);
        }
        if (token.type === 'image') {
            const src = sanitizeImageSrc(token.href);
            return src ? [{ t: 'img', src, alt: token.text || '', width: null, height: null }]
                : textWithBreaks(token.raw);
        }
        // Marked deliberately does not sanitize raw HTML. Keep it visible and
        // inert instead of passing it to either innerHTML or Peakbagger.
        if (token.type === 'html') return [text(token.raw || token.text || '')];
        return token.tokens ? markedInlines(token.tokens) : textWithBreaks(token.raw || token.text || '');
    }));

    const markedBlocks = tokens => (tokens || []).flatMap(token => {
        if (!token || typeof token !== 'object' || token.type === 'space' || token.type === 'def') return [];
        if (token.type === 'paragraph' || token.type === 'text') {
            const kids = trimInlines(markedInlines(token.tokens || [{ type: 'text', text: token.text || token.raw }]));
            return kids.length ? [{ type: 'p', kids }] : [];
        }
        if (token.type === 'heading') {
            const kids = trimInlines(markedInlines(token.tokens));
            return kids.length ? [{ type: 'heading', level: Math.min(6, Math.max(1, token.depth)), kids }] : [];
        }
        if (token.type === 'blockquote') {
            const blocks = markedBlocks(token.tokens);
            return blocks.length ? [{ type: 'blockquote', blocks }] : [];
        }
        if (token.type === 'list') {
            const items = token.items.map(item => {
                const blocks = markedBlocks(item.tokens);
                if (item.task) {
                    const marker = text(item.checked ? '☑ ' : '☐ ');
                    if (blocks[0]?.type === 'p') blocks[0].kids.unshift(marker);
                    else blocks.unshift({ type: 'p', kids: [marker] });
                }
                return blocks;
            }).filter(item => item.length);
            return items.length ? [{ type: 'list', ordered: !!token.ordered, items }] : [];
        }
        if (token.type === 'table') {
            const rows = [
                { header: true, cells: token.header.map(cell => trimInlines(markedInlines(cell.tokens))) },
                ...token.rows.map(row => ({
                    header: false,
                    cells: row.map(cell => trimInlines(markedInlines(cell.tokens)))
                }))
            ];
            return [{ type: 'table', rows }];
        }
        if (token.type === 'code') return [{ type: 'pre', text: token.text || '' }];
        if (token.type === 'hr') return [{ type: 'hr' }];
        if (token.type === 'html') return [{ type: 'p', kids: [text(token.raw || token.text || '')] }];
        const fallback = String(token.raw || token.text || '');
        return fallback ? [{ type: 'p', kids: [text(fallback)] }] : [];
    });

    const parseMarkdown = source => {
        const parser = globalThis.marked;
        const lexer = parser && (parser.lexer || parser.marked?.lexer);
        if (typeof lexer !== 'function') throw new Error('Vendored Marked parser is not loaded');
        return markedBlocks(lexer(String(source ?? ''), { gfm: true, breaks: false }));
    };

    // ---- AST -> Peakbagger bracket markup ---------------------------------

    const inlinesToBracket = kids => (kids || []).map(node => {
        if (node.t === 'text') return escapeBracketText(node.text);
        if (node.t === 'br') return '\n';
        if (node.t === 'img') {
            return `[img src="${escapeAttribute(node.src)}"${node.alt ? ` alt="${escapeAttribute(node.alt)}"` : ''}${
                node.width ? ` width="${node.width}"` : ''}${node.height ? ` height="${node.height}"` : ''}]`;
        }
        const inner = inlinesToBracket(node.kids);
        if (node.t === 'a') {
            return `[a href="${escapeAttribute(node.href)}"${node.blank ? ' target="_blank"' : ''}]${inner}[/a]`;
        }
        if (node.t === 'color') return `[span style="color:${node.color}"]${inner}[/span]`;
        return `[${node.t}]${inner}[/${node.t}]`;
    }).join('');

    const blocksToBracket = blocks => (blocks || []).map(block => {
        if (block.type === 'p') return inlinesToBracket(block.kids);
        if (block.type === 'heading') return `[h${block.level}]${inlinesToBracket(block.kids)}[/h${block.level}]`;
        if (block.type === 'blockquote') return `[blockquote]${blocksToBracket(block.blocks)}[/blockquote]`;
        if (block.type === 'list') {
            const tag = block.ordered ? 'ol' : 'ul';
            return `[${tag}]${block.items.map(item => {
                let contents = '';
                item.forEach((child, index) => {
                    if (index && child.type === 'p' && item[index - 1].type === 'p') contents += '\n\n';
                    contents += blocksToBracket([child]);
                });
                return `[li]${contents}[/li]`;
            }).join('')}[/${tag}]`;
        }
        if (block.type === 'table') {
            return `[table border="1"]${block.rows.map(row => `[tr]${row.cells.map(cell => {
                const tag = row.header ? 'th' : 'td';
                return `[${tag}]${inlinesToBracket(cell)}[/${tag}]`;
            }).join('')}[/tr]`).join('')}[/table]`;
        }
        if (block.type === 'pre') return `[pre]${escapeBracketText(block.text)}[/pre]`;
        if (block.type === 'hr') return '[hr]';
        return '';
    }).filter(rendered => rendered.trim()).join('\n\n');

    const astToBracket = blocksToBracket;

    // ---- AST -> safe editor/preview HTML ----------------------------------

    const inlinesToHtml = kids => (kids || []).map(node => {
        if (node.t === 'text') return escapeHtml(node.text);
        if (node.t === 'br') return '<br>';
        if (node.t === 'img') {
            return `<img src="${escapeAttribute(node.src)}" alt="${escapeAttribute(node.alt || '')}"${
                node.width ? ` width="${node.width}"` : ''}${node.height ? ` height="${node.height}"` : ''
            } loading="lazy" referrerpolicy="no-referrer">`;
        }
        const inner = inlinesToHtml(node.kids);
        if (node.t === 'a') return `<a href="${escapeAttribute(node.href)}"${
            node.blank ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`;
        if (node.t === 'color') return `<span style="color:${escapeAttribute(node.color)}">${inner}</span>`;
        return `<${node.t}>${inner}</${node.t}>`;
    }).join('');

    const blockToHtml = block => {
        if (block.type === 'p') return `<p>${inlinesToHtml(block.kids)}</p>`;
        if (block.type === 'heading') return `<h${block.level}>${inlinesToHtml(block.kids)}</h${block.level}>`;
        if (block.type === 'blockquote') return `<blockquote>${blocksToHtml(block.blocks)}</blockquote>`;
        if (block.type === 'list') {
            const tag = block.ordered ? 'ol' : 'ul';
            return `<${tag}>${block.items.map(item => {
                const contents = item.length === 1 && item[0].type === 'p'
                    ? inlinesToHtml(item[0].kids)
                    : blocksToHtml(item);
                return `<li>${contents}</li>`;
            }).join('')}</${tag}>`;
        }
        if (block.type === 'table') {
            const headRows = block.rows.filter(row => row.header);
            const bodyRows = block.rows.filter(row => !row.header);
            const rowsHtml = rows => rows.map(row => `<tr>${row.cells.map(cell => `<${row.header ? 'th' : 'td'}>${
                inlinesToHtml(cell)}</${row.header ? 'th' : 'td'}>`).join('')}</tr>`).join('');
            return `<table>${headRows.length ? `<thead>${rowsHtml(headRows)}</thead>` : ''}${
                bodyRows.length ? `<tbody>${rowsHtml(bodyRows)}</tbody>` : ''}</table>`;
        }
        if (block.type === 'pre') return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        if (block.type === 'hr') return '<hr>';
        return '';
    };

    function blocksToHtml(blocks) { return (blocks || []).map(blockToHtml).join(''); }

    const astToHtml = (blocks, { editor = false } = {}) => {
        const html = blocksToHtml(blocks);
        return html || (editor ? '<p><br></p>' : '');
    };

    // ---- AST -> Markdown --------------------------------------------------

    const escapeMarkdownText = value => String(value)
        .replace(/\\/g, '\\\\')
        .replace(/([`*_\[\]<>])/g, '\\$1');

    const codeSpan = value => {
        const longest = Math.max(0, ...(String(value).match(/`+/g) || []).map(run => run.length));
        const fence = '`'.repeat(longest + 1);
        return `${fence}${value}${fence}`;
    };

    const inlinesToMarkdown = kids => (kids || []).map(node => {
        if (node.t === 'text') return escapeMarkdownText(node.text);
        if (node.t === 'br') return '\n';
        if (node.t === 'img') {
            if (node.width || node.height) return inlinesToBracket([node]);
            return `![${escapeMarkdownText(node.alt || '')}](${node.src})`;
        }
        const inner = inlinesToMarkdown(node.kids);
        if (node.t === 'b') return `**${inner}**`;
        if (node.t === 'i') return `*${inner}*`;
        if (node.t === 's') return `~~${inner}~~`;
        if (node.t === 'code') return codeSpan((node.kids || []).map(kid => kid.text || '').join(''));
        if (node.t === 'a') {
            return node.blank ? inlinesToBracket([node]) : `[${inner}](${node.href})`;
        }
        if (node.t === 'color') return `[span style="color:${node.color}"]${inner}[/span]`;
        return `[${node.t}]${inner}[/${node.t}]`;
    }).join('');

    const tableToMarkdown = block => {
        const sourceRows = block.rows.slice();
        if (!sourceRows.length) return '';
        const first = sourceRows[0];
        const header = first.header ? first : { header: true, cells: first.cells.map(() => []) };
        const body = first.header ? sourceRows.slice(1) : sourceRows;
        const row = cells => `| ${cells.map(cell => inlinesToMarkdown(cell).replace(/\|/g, '\\|')).join(' | ')} |`;
        return [row(header.cells), `| ${header.cells.map(() => '---').join(' | ')} |`,
            ...body.map(item => row(item.cells))].join('\n');
    };

    const listToMarkdown = block => block.items.map((item, index) => {
        const rendered = blocksToMarkdown(item);
        const lines = rendered.split('\n');
        const marker = block.ordered ? `${index + 1}. ` : '- ';
        const indent = ' '.repeat(marker.length);
        return marker + lines.map((line, lineIndex) => lineIndex ? indent + line : line).join('\n');
    }).join('\n');

    function blocksToMarkdown(blocks) {
        return (blocks || []).map(block => {
            if (block.type === 'p') return inlinesToMarkdown(block.kids);
            if (block.type === 'heading') return `${'#'.repeat(block.level)} ${inlinesToMarkdown(block.kids)}`;
            if (block.type === 'blockquote') {
                return blocksToMarkdown(block.blocks).split('\n').map(line => `> ${line}`).join('\n');
            }
            if (block.type === 'list') return listToMarkdown(block);
            if (block.type === 'table') return tableToMarkdown(block);
            if (block.type === 'pre') {
                const longest = Math.max(2, ...(block.text.match(/`+/g) || []).map(run => run.length));
                const fence = '`'.repeat(longest + 1);
                return `${fence}\n${block.text}\n${fence}`;
            }
            if (block.type === 'hr') return '---';
            return '';
        }).filter(rendered => rendered.trim()).join('\n\n');
    }

    const astToMarkdown = blocksToMarkdown;

    // ---- Public surface ---------------------------------------------------

    const API = {
        sanitizeHref,
        resolveLinkTarget,
        sanitizeImageSrc,
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

    export const reportMarkup = API;

