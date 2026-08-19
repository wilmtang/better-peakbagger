// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Injected on demand into a canonical Peakbagger tab's MAIN world. Cloudflare
// can distinguish an extension worker request from a request made by the
// signed-in site itself, so activity capture uses this page-owned transport
// without asking for cookie-reading permission. The API is deliberately not a
// general fetch bridge: it accepts only the login page and bounded summit-box
// endpoint that capture already uses.

import { PEAKBAGGER_ORIGIN } from './peakbagger-origin.js';
import { peakbaggerAccount as PeakbaggerAccount } from './peakbagger-account.js';
import { peakbaggerError as PeakbaggerError } from './peakbagger-error.js';
import { fetchPeakbaggerResource } from './peakbagger-request.js';

const VERSION = 2;
const REQUEST_ID = /^[a-z0-9-]{1,80}$/i;
const BOX_KEYS = Object.freeze(['miny', 'maxy', 'minx', 'maxx']);
const activeRequests = new Map();

const rejected = kind => {
    const error = PeakbaggerError.failure('invalid-request', { resource: kind });
    return {
        kind: 'wrong-content',
        requestedUrl: '',
        url: '',
        status: 0,
        redirected: false,
        error,
        reason: PeakbaggerError.message(error),
    };
};

const validBox = url => {
    if (url.pathname !== '/Async/pllbb2.aspx' || url.hash) return false;
    if ([...url.searchParams.keys()].length !== BOX_KEYS.length) return false;
    if (!BOX_KEYS.every(key => url.searchParams.getAll(key).length === 1)) return false;
    const values = Object.fromEntries(BOX_KEYS.map(key => [key, Number(url.searchParams.get(key))]));
    return Object.values(values).every(Number.isFinite)
        && values.miny >= -90 && values.maxy <= 90 && values.miny <= values.maxy
        && values.minx >= -180 && values.maxx <= 180 && values.minx <= values.maxx;
};

const validRequest = (urlValue, kind) => {
    if (globalThis.location?.origin !== PEAKBAGGER_ORIGIN) return false;
    let url;
    try { url = new URL(urlValue); }
    catch { return false; }
    if (url.origin !== PEAKBAGGER_ORIGIN || url.username || url.password) return false;
    if (kind === 'html') {
        return url.pathname === '/Default.aspx' && !url.search && !url.hash;
    }
    return kind === 'peaks' && validBox(url);
};

// A tab the worker just opened or waited for has already made a current,
// authenticated navigation. Return only the small, positive account evidence
// from Peakbagger's global navigation so the worker can verify that fresh page
// without downloading Default.aspx a second time. No hidden form fields,
// cookies, page text, or user-authored content cross the boundary.
const accountEvidence = () => {
    if (globalThis.location?.origin !== PEAKBAGGER_ORIGIN) return null;
    const links = [];
    const seen = new Set();
    for (const anchor of globalThis.document?.querySelectorAll?.('a[href]') || []) {
        const label = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (!PeakbaggerAccount.linkPaths[label]) continue;
        let url;
        try { url = new URL(anchor.getAttribute('href'), globalThis.location.href); }
        catch { continue; }
        const accountLink = PeakbaggerAccount.canonicalAccountLink(label, url.href);
        if (!accountLink) continue;
        const key = `${label}\n${accountLink.href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ label, href: accountLink.href });
        if (links.length === Object.keys(PeakbaggerAccount.linkPaths).length) break;
    }
    return { pageUrl: globalThis.location.href, links };
};

const request = async (requestId, url, kind) => {
    if (!REQUEST_ID.test(requestId || '') || activeRequests.has(requestId)
        || !validRequest(url, kind)) return rejected(kind);
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    try {
        return await fetchPeakbaggerResource(url, { kind, signal: controller.signal });
    } finally {
        if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
    }
};

const cancel = requestId => {
    const controller = activeRequests.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
};

const API = Object.freeze({ version: VERSION, accountEvidence, request, cancel });
export const peakbaggerPage = API;

// Deliberate page-world global: the worker can inject this bundle and then
// invoke only this frozen, allowlisted surface across the worker/page boundary.
globalThis.BPBPeakbaggerPage = API;
