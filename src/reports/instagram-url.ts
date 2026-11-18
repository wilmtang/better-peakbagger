// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ParagraphChildLike {
    readonly nodeType: number;
    readonly nodeName: string;
    readonly nodeValue: string | null;
    readonly textContent: string | null;
    readonly childNodes: Iterable<ParagraphChildLike>;
    getAttribute?(name: string): string | null;
}

export interface ParagraphElementLike {
    readonly tagName?: string;
    readonly childNodes: Iterable<ParagraphChildLike>;
}

export interface ReportKidBase {
    readonly t: string;
}

export interface ReportBreakKid {
    t: 'br';
}

export interface ReportBlockBase {
    readonly type: string;
}

export interface ReportInstagramBlock {
    type: 'instagram';
    url: string;
}

export interface ReportParagraphOutputBlock<TKid> {
    type: 'p';
    kids: TKid[];
}

export type ReportParagraphKidOf<TBlock> =
    [Extract<TBlock, { readonly type: 'p' }>] extends [never]
        ? ReportKidBase
        : Extract<TBlock, { readonly type: 'p' }> extends { readonly kids?: readonly (infer TKid extends ReportKidBase)[] }
            ? TKid
            : ReportKidBase;

export type InstagramBlocksOutput<TBlock> =
    | TBlock
    | ReportParagraphOutputBlock<ReportParagraphKidOf<TBlock> | ReportBreakKid>
    | ReportInstagramBlock;

interface ReportLinkLike extends ReportKidBase {
    readonly t: 'a';
    readonly href?: unknown;
    readonly kids: readonly ReportKidBase[];
}

export function canonicalInstagramUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    const input = raw.trim();
    if (/[\s\\<>"'\u0000-\u001f]/.test(input)
        || !/^https:\/\/(?:www\.)?instagram\.com(?::443)?\//i.test(input)) return null;
    try {
        const url = new URL(input);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return null;
        const rawPath = input.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
        if (url.pathname !== rawPath) return null;
        const path = /^\/(p|reel)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
        return path ? `https://www.instagram.com/${path[1]}/${path[2]}/` : null;
    } catch { return null; }
}

// A bounded tag/attribute scanner, not an HTML renderer or sanitizer. Nothing
// is attached to a DOM or fetched. Only a validated post identity survives.
export function instagramPasteUrl(raw: unknown): string | null {
    const direct = canonicalInstagramUrl(raw);
    if (direct) return direct;
    if (typeof raw !== 'string' || raw.length > 65536) return null;
    const input = raw.trim();
    if (!/^<blockquote\b/i.test(input)) return null;
    let at = 0, depth = 0, blocks = 0, recognized = false;
    const posts = new Set<string>();
    while (at < input.length) {
        if (input[at] !== '<') {
            const next = input.indexOf('<', at);
            const end = next < 0 ? input.length : next;
            if (!depth && input.slice(at, end).trim()) return null;
            at = end; continue;
        }
        const start = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)/i.exec(input.slice(at));
        if (!start?.[2]) return null;
        const closing = !!start[1], tag = start[2].toLowerCase();
        at += start[0].length;
        const attrs = new Map<string, string>();
        let ended = false;
        while (at < input.length) {
            while (/\s/.test(input[at] || '') && at < input.length) at++;
            if (input[at] === '>') { at++; ended = true; break; }
            if (input.slice(at, at + 2) === '/>') { at += 2; ended = true; break; }
            const name = /^[a-z_:][a-z0-9_.:-]*/i.exec(input.slice(at));
            if (!name) return null;
            at += name[0].length;
            while (/\s/.test(input[at] || '') && at < input.length) at++;
            let value = '';
            if (input[at] === '=') {
                at++; while (/\s/.test(input[at] || '') && at < input.length) at++;
                const quote = input[at];
                if (quote === '"' || quote === "'") {
                    const end = input.indexOf(quote, ++at); if (end < 0) return null;
                    value = input.slice(at, end); at = end + 1;
                } else {
                    const unquoted = /^[^\s<>]+/.exec(input.slice(at)); if (!unquoted) return null;
                    value = unquoted[0]; at += value.length;
                }
            }
            const key = name[0].toLowerCase(); if (attrs.has(key)) return null; attrs.set(key, value);
        }
        if (!ended) return null;
        if (tag === 'script' && !closing) {
            const end = /<\/script\s*>/ig; end.lastIndex = at; const close = end.exec(input); if (!close) return null;
            at = end.lastIndex; continue;
        }
        if (tag === 'blockquote') {
            depth += closing ? -1 : 1;
            if (depth < 0 || depth > 1) return null;
            if (!closing) {
                blocks++; const url = canonicalInstagramUrl(attrs.get('data-instgrm-permalink'));
                if (!url || !attrs.get('class')?.split(/\s+/).includes('instagram-media')) return null;
                recognized = true; posts.add(url);
            }
        } else if (!depth) return null;
        if (tag === 'a' && !closing) { const url = canonicalInstagramUrl(attrs.get('href')); if (url) posts.add(url); }
    }
    return recognized && blocks === 1 && depth === 0 && posts.size === 1 ? ([...posts][0] ?? null) : null;
}

// Peakbagger reports commonly display a post link as just its hostname. Keep
// those native labels equivalent to a full permalink, but leave custom captions
// (including Rich's "Instagram post" ordinary-link fallback) as ordinary links.
const instagramLinkUrl = (href: unknown, label: unknown): string | null => {
    const url = canonicalInstagramUrl(href), display = String(label ?? '').trim();
    return url && (canonicalInstagramUrl(display) === url || /^(?:www\.)?instagram\.com$/i.test(display)) ? url : null;
};

export function instagramParagraphUrl(element: ParagraphElementLike | null | undefined): string | null {
    if (element?.tagName !== 'P') return null;
    const nodes = [...element.childNodes].filter(node => node.nodeType !== 3 || Boolean(node.nodeValue?.trim()));
    if (nodes.length !== 1) return null;
    const node = nodes[0];
    if (!node) return null;
    if (node.nodeType === 3) return canonicalInstagramUrl(node.nodeValue);
    if (node.nodeName !== 'A' || [...node.childNodes].some(child => child.nodeType !== 3)) return null;
    return instagramLinkUrl(node.getAttribute?.('href'), node.textContent);
}

const isParagraphBlock = (
    block: ReportBlockBase,
): block is { readonly type: 'p'; readonly kids: readonly ReportKidBase[] } =>
    block.type === 'p' && 'kids' in block && Array.isArray(block.kids);

const isLinkKid = (kid: ReportKidBase): kid is ReportLinkLike =>
    kid.t === 'a' && 'kids' in kid && Array.isArray(kid.kids);

const kidText = (kid: ReportKidBase): unknown =>
    'text' in kid ? kid.text : undefined;

export function instagramBlocks<TBlock extends ReportBlockBase>(
    blocks: readonly TBlock[],
): InstagramBlocksOutput<TBlock>[] {
    type OutputKid = ReportParagraphKidOf<TBlock> | ReportBreakKid;
    type OutputBlock = InstagramBlocksOutput<TBlock>;
    return blocks.flatMap((block): OutputBlock[] => {
        if (!isParagraphBlock(block)) return [block];
        let current: OutputKid[] = [];
        const lines: OutputKid[][] = [current];
        for (const kid of block.kids as readonly OutputKid[]) {
            if (kid.t === 'br') { current = []; lines.push(current); }
            else current.push(kid);
        }
        const urlFor = (kids: readonly OutputKid[]): string | null => {
            if (kids.length !== 1) return null;
            const first = kids[0];
            if (!first) return null;
            if (first.t === 'text') return canonicalInstagramUrl(kidText(first));
            if (!isLinkKid(first) || first.kids.some(kid => kid?.t !== 'text')) return null;
            const href = 'href' in first ? first.href : undefined;
            return instagramLinkUrl(href, first.kids.map(kid => String(kidText(kid) ?? '')).join(''));
        };
        if (!lines.some(line => urlFor(line))) return [block];
        const output: OutputBlock[] = [];
        let pending: OutputKid[] = [];
        const flush = () => { if (pending.length) output.push({ type: 'p', kids: pending }); pending = []; };
        for (const line of lines) {
            const url = urlFor(line);
            if (url) { flush(); output.push({ type: 'instagram', url }); }
            else { if (pending.length) pending.push({ t: 'br' }); pending.push(...line); }
        }
        flush(); return output;
    });
}
