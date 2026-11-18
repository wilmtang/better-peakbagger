// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PEAKBAGGER_ORIGIN, isPeakbaggerUrl } from './peakbagger-origin.js';

export type AccountLinkLabel = 'My Home Page' | 'Edit Account' | 'Add Ascent' | 'My Ascents';

export interface AccountLinkCandidate {
    label: string;
    href: string;
}

export interface ValidatedAccountLink {
    cid: string;
    href: string;
}

export interface AccountState {
    status: 'signed-in' | 'signed-out' | 'unverified';
    cid: string | null;
}

export interface AccountDocumentLike {
    URL?: string;
    querySelector?: (selectors: string) => Element | null;
    querySelectorAll?: (selectors: string) => Iterable<Element>;
}

export const ACCOUNT_LINK_PATHS: Readonly<Record<AccountLinkLabel, string>> = Object.freeze({
    'My Home Page': '/climber/climber.aspx',
    'Edit Account': '/climber/climberedit.aspx',
    'Add Ascent': '/climber/ascentedit.aspx',
    'My Ascents': '/climber/climblistc.aspx',
});

const INERT_TAGS = ['script', 'style', 'template'] as const;

const cleanText = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();

// Firefox's isolated-world Xrays can deny Symbol.iterator on the native
// keys() result. forEach crosses that boundary without an iterator object.
const queryKeys = (url: URL): string[] => {
    const keys: string[] = [];
    url.searchParams.forEach((_value, key) => keys.push(key));
    return keys;
};

const accountLink = (
    label: string,
    href: unknown,
    base = `${PEAKBAGGER_ORIGIN}/`,
): ValidatedAccountLink | null => {
    if (!Object.hasOwn(ACCOUNT_LINK_PATHS, label) || typeof href !== 'string') return null;
    const expectedPath = ACCOUNT_LINK_PATHS[label as AccountLinkLabel];
    let url: URL;
    try { url = new URL(href, base); }
    catch { return null; }
    const cidValues = url.searchParams.getAll('cid');
    const legacyProfileMode = url.pathname.toLowerCase() === '/climber/climberedit.aspx'
        && url.searchParams.getAll('mode').length === 1 && url.searchParams.get('mode') === 'profile';
    if (!isPeakbaggerUrl(url.href) || url.username || url.password || url.hash
        || url.pathname.toLowerCase() !== expectedPath.toLowerCase()
        || queryKeys(url).some(key => key !== 'cid' && !(legacyProfileMode && key === 'mode'))
        || cidValues.length !== 1
        || !/^[1-9]\d*$/.test(cidValues[0])
        || !Number.isSafeInteger(Number(cidValues[0]))) return null;
    return { cid: cidValues[0], href: url.href };
};

const canonicalAccountLink = (label: string, href: string): ValidatedAccountLink | null => {
    try {
        const url = new URL(href);
        if (url.origin !== PEAKBAGGER_ORIGIN) return null;
        return accountLink(label, href);
    } catch { return null; }
};

// Only native navigation before the page heading is account evidence. A link
// named "My Home Page" inside someone's report or biography is just content.
// A single link remains supported by legacy Buddy reports, but all supplied
// account links must be valid and agree. Missing evidence is not sign-out.
const stateFromLinks = (
    links: readonly AccountLinkCandidate[],
    { base, loginForm = false }: { base?: string; loginForm?: boolean } = {},
): AccountState => {
    if (!links.length) return { status: loginForm ? 'signed-out' : 'unverified', cid: null };
    const ids = new Set<string>();
    for (const { label, href } of links) {
        const link = accountLink(label, href, base);
        if (!link) return { status: 'unverified', cid: null };
        ids.add(link.cid);
    }
    return ids.size === 1 ? { status: 'signed-in', cid: [...ids][0] }
        : { status: 'unverified', cid: null };
};

const documentLinks = (doc: AccountDocumentLike | null | undefined): AccountLinkCandidate[] => {
    if (!doc?.querySelectorAll) return [];
    const heading = doc.querySelector?.('h1') ?? null;
    return [...doc.querySelectorAll('div')].filter(div =>
        /^Logged in:/i.test(cleanText(div.textContent))
        && (!heading || (div.compareDocumentPosition(heading) & 4)))
        .flatMap(div => [...div.querySelectorAll('a[href]')])
        .filter(anchor => Object.hasOwn(ACCOUNT_LINK_PATHS, cleanText(anchor.textContent)))
        .map(anchor => ({
            label: cleanText(anchor.textContent),
            href: anchor.getAttribute('href') ?? '',
        }));
};

const fromDocument = (doc: AccountDocumentLike | null | undefined): AccountState => stateFromLinks(documentLinks(doc), {
    base: isPeakbaggerUrl(doc?.URL) ? doc?.URL : `${PEAKBAGGER_ORIGIN}/`,
    loginForm: !!doc?.querySelector?.('#PasswordText, #LoginButton'),
});

// Single-pass entity decoder so literal `&amp;quot;` never double-unescapes to `"`.
export const decodeHtmlEntities = (value: string): string =>
    value.replace(/&(?:nbsp|#160|#x0*a0|amp|quot|#(?:39|x27));/gi, entity => {
        const lower = entity.toLowerCase();
        if (lower === '&amp;') return '&';
        if (lower === '&quot;') return '"';
        if (lower === '&#39;' || lower === '&#x27;') return "'";
        return ' ';
    });

const isTagBoundary = (text: string, index: number): boolean =>
    index >= text.length || /[\s/>]/.test(text[index]);

const findClosingTagEnd = (lower: string, tagName: string, from: number): number => {
    const marker = `</${tagName}`;
    let pos = from;
    while (pos < lower.length) {
        const closeStart = lower.indexOf(marker, pos);
        if (closeStart === -1) return -1;
        const afterName = closeStart + marker.length;
        if (isTagBoundary(lower, afterName)) {
            const closeEnd = lower.indexOf('>', afterName);
            return closeEnd === -1 ? -1 : closeEnd + 1;
        }
        pos = afterName;
    }
    return -1;
};

const stripCommentsAndInertBlocksPass = (input: string): string => {
    const lower = input.toLowerCase();
    let out = '';
    let pos = 0;
    while (pos < input.length) {
        const lt = lower.indexOf('<', pos);
        if (lt === -1) {
            out += input.slice(pos);
            break;
        }
        if (lower.startsWith('<!--', lt)) {
            out += input.slice(pos, lt);
            const end = lower.indexOf('-->', lt + 4);
            if (end === -1) break;
            pos = end + 3;
            continue;
        }
        const tag = INERT_TAGS.find(name =>
            lower.startsWith(`<${name}`, lt) && isTagBoundary(lower, lt + 1 + name.length));
        if (tag) {
            out += input.slice(pos, lt);
            const openEnd = lower.indexOf('>', lt + 1 + tag.length);
            if (openEnd === -1) break;
            const closeEnd = findClosingTagEnd(lower, tag, openEnd + 1);
            if (closeEnd === -1) break;
            pos = closeEnd;
            continue;
        }
        out += input.slice(pos, lt + 1);
        pos = lt + 1;
    }
    return out;
};

// Iterate while removals expose newly joined comments or inert blocks without using multi-character regex filters.
const stripCommentsAndInertBlocks = (input: string): string => {
    let current = input;
    for (;;) {
        const next = stripCommentsAndInertBlocksPass(current);
        if (next === current || next.length >= current.length) return next;
        current = next;
    }
};

const stripHtmlTags = (input: string): string => {
    let out = '';
    let pos = 0;
    while (pos < input.length) {
        const open = input.indexOf('<', pos);
        if (open === -1) {
            out += input.slice(pos);
            break;
        }
        out += input.slice(pos, open);
        const close = input.indexOf('>', open + 1);
        if (close === -1) break;
        pos = close + 1;
    }
    return out;
};

// Worker-safe adapter for the narrow native account bar; never execute or
// parse downloaded scripts. DOM and HTML adapters share the link policy.
const fromHtml = (html: unknown, base = `${PEAKBAGGER_ORIGIN}/`): AccountState => {
    const body = stripCommentsAndInertBlocks(String(html || ''));
    const navigation = body.split(/<h1\b/i, 1)[0];
    const links: AccountLinkCandidate[] = [];
    for (const match of navigation.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div\s*>/gi)) {
        if (!/^Logged in:/i.test(cleanText(decodeHtmlEntities(stripHtmlTags(match[1]))))) continue;
        for (const anchor of match[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
            const label = cleanText(decodeHtmlEntities(stripHtmlTags(anchor[2])));
            if (!Object.hasOwn(ACCOUNT_LINK_PATHS, label)) continue;
            const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(anchor[1]);
            links.push({ label, href: href ? decodeHtmlEntities(href[2]) : '' });
        }
    }
    return stateFromLinks(links, { base, loginForm: /\bid\s*=\s*["'](?:PasswordText|LoginButton)["']/i.test(body) });
};

const freshAccountCid = (evidence: unknown, expectedPageUrl: string): string | null => {
    if (!evidence || typeof evidence !== 'object'
        || Object.keys(evidence).some(key => key !== 'pageUrl' && key !== 'links')) return null;
    const record = evidence as { pageUrl?: unknown; links?: unknown };
    if (typeof record.pageUrl !== 'string'
        || !Array.isArray(record.links)
        || record.links.length < 2
        || record.links.length > Object.keys(ACCOUNT_LINK_PATHS).length) return null;
    try {
        const pageUrl = new URL(record.pageUrl);
        const expectedUrl = new URL(expectedPageUrl);
        if (pageUrl.href !== expectedUrl.href || pageUrl.origin !== PEAKBAGGER_ORIGIN
            || pageUrl.username || pageUrl.password) return null;
    } catch { return null; }
    const labels = new Set<string>();
    const cids = new Set<string>();
    for (const rawLink of record.links) {
        if (!rawLink || typeof rawLink !== 'object'
            || Object.keys(rawLink).some(key => key !== 'label' && key !== 'href')) return null;
        const link = rawLink as { label?: unknown; href?: unknown };
        if (typeof link.label !== 'string' || typeof link.href !== 'string'
            || labels.has(link.label)) return null;
        const validated = canonicalAccountLink(link.label, link.href);
        if (!validated) return null;
        labels.add(link.label);
        cids.add(validated.cid);
    }
    const corroborated = labels.has('My Home Page')
        && (labels.has('Edit Account') || labels.has('Add Ascent') || labels.has('My Ascents'));
    return corroborated && cids.size === 1 ? [...cids][0] : null;
};

export const peakbaggerAccount = Object.freeze({
    linkPaths: ACCOUNT_LINK_PATHS,
    canonicalAccountLink,
    freshAccountCid,
    documentLinks,
    fromDocument,
    fromHtml,
});
