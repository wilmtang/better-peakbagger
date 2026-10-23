// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PEAKBAGGER_ORIGIN, isPeakbaggerUrl } from './peakbagger-origin.js';

export const ACCOUNT_LINK_PATHS = Object.freeze({
    'My Home Page': '/climber/climber.aspx',
    'Edit Account': '/climber/climberedit.aspx',
    'Add Ascent': '/climber/ascentedit.aspx',
    'My Ascents': '/climber/climblistc.aspx',
});

const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
// Firefox's isolated-world Xrays can deny Symbol.iterator on the native
// keys() result. forEach crosses that boundary without an iterator object.
const queryKeys = url => {
    const keys = [];
    url.searchParams.forEach((_value, key) => keys.push(key));
    return keys;
};
const accountLink = (label, href, base = `${PEAKBAGGER_ORIGIN}/`) => {
    const expectedPath = ACCOUNT_LINK_PATHS[label];
    if (!expectedPath || typeof href !== 'string') return null;
    let url;
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

const canonicalAccountLink = (label, href) => {
    try {
        const url = new URL(href);
        if (url.origin !== PEAKBAGGER_ORIGIN || queryKeys(url).length !== 1) return null;
        return accountLink(label, href);
    } catch { return null; }
};

// Only native navigation before the page heading is account evidence. A link
// named "My Home Page" inside someone's report or biography is just content.
// A single link remains supported by legacy Buddy reports, but all supplied
// account links must be valid and agree. Missing evidence is not sign-out.
const stateFromLinks = (links, { base, loginForm = false } = {}) => {
    if (!links.length) return { status: loginForm ? 'signed-out' : 'unverified', cid: null };
    const ids = new Set();
    for (const { label, href } of links) {
        const link = accountLink(label, href, base);
        if (!link) return { status: 'unverified', cid: null };
        ids.add(link.cid);
    }
    return ids.size === 1 ? { status: 'signed-in', cid: [...ids][0] }
        : { status: 'unverified', cid: null };
};

const documentLinks = doc => {
    if (!doc?.querySelectorAll) return [];
    const heading = doc.querySelector('h1');
    return [...doc.querySelectorAll('div')].filter(div =>
        /^Logged in:/i.test(cleanText(div.textContent))
        && (!heading || (div.compareDocumentPosition(heading) & 4)))
        .flatMap(div => [...div.querySelectorAll('a[href]')])
        .filter(anchor => Object.hasOwn(ACCOUNT_LINK_PATHS, cleanText(anchor.textContent)))
        .map(anchor => ({ label: cleanText(anchor.textContent), href: anchor.getAttribute('href') }));
};

const fromDocument = doc => stateFromLinks(documentLinks(doc), {
    base: isPeakbaggerUrl(doc?.URL) ? doc.URL : `${PEAKBAGGER_ORIGIN}/`,
    loginForm: !!doc?.querySelector?.('#PasswordText, #LoginButton'),
});

// Worker-safe adapter for the narrow native account bar; never execute or
// parse downloaded scripts. DOM and HTML adapters share the link policy.
const decode = value => value.replace(/&(?:nbsp|#160|#x0*a0);/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'");
const fromHtml = (html, base = `${PEAKBAGGER_ORIGIN}/`) => {
    const body = String(html || '').replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const navigation = body.split(/<h1\b/i, 1)[0];
    const links = [];
    for (const match of navigation.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div\s*>/gi)) {
        if (!/^Logged in:/i.test(cleanText(decode(match[1].replace(/<[^>]*>/g, ''))))) continue;
        for (const anchor of match[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
            const label = cleanText(decode(anchor[2].replace(/<[^>]*>/g, '')));
            if (!Object.hasOwn(ACCOUNT_LINK_PATHS, label)) continue;
            const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(anchor[1]);
            links.push({ label, href: href ? decode(href[2]) : '' });
        }
    }
    return stateFromLinks(links, { base, loginForm: /\bid\s*=\s*["'](?:PasswordText|LoginButton)["']/i.test(body) });
};

const freshAccountCid = (evidence, expectedPageUrl) => {
    if (!evidence || typeof evidence !== 'object'
        || Object.keys(evidence).some(key => key !== 'pageUrl' && key !== 'links')
        || typeof evidence.pageUrl !== 'string'
        || !Array.isArray(evidence.links)
        || evidence.links.length < 2
        || evidence.links.length > Object.keys(ACCOUNT_LINK_PATHS).length) return null;
    try {
        const pageUrl = new URL(evidence.pageUrl);
        const expectedUrl = new URL(expectedPageUrl);
        if (pageUrl.href !== expectedUrl.href || pageUrl.origin !== PEAKBAGGER_ORIGIN
            || pageUrl.username || pageUrl.password) return null;
    } catch { return null; }
    const labels = new Set();
    const cids = new Set();
    for (const link of evidence.links) {
        if (!link || typeof link !== 'object'
            || Object.keys(link).some(key => key !== 'label' && key !== 'href')
            || typeof link.label !== 'string' || typeof link.href !== 'string'
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
