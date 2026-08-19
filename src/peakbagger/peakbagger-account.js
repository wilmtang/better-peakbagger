// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PEAKBAGGER_ORIGIN } from './peakbagger-origin.js';

export const ACCOUNT_LINK_PATHS = Object.freeze({
    'My Home Page': '/climber/climber.aspx',
    'Edit Account': '/climber/climberedit.aspx',
    'Add Ascent': '/climber/ascentedit.aspx',
    'My Ascents': '/climber/climblistc.aspx',
});

const canonicalAccountLink = (label, href) => {
    const expectedPath = ACCOUNT_LINK_PATHS[label];
    if (!expectedPath || typeof href !== 'string') return null;
    let url;
    try { url = new URL(href); }
    catch { return null; }
    const cidValues = url.searchParams.getAll('cid');
    if (url.origin !== PEAKBAGGER_ORIGIN || url.username || url.password || url.hash
        || url.pathname.toLowerCase() !== expectedPath.toLowerCase()
        || [...url.searchParams.keys()].length !== 1
        || cidValues.length !== 1
        || !/^[1-9]\d*$/.test(cidValues[0])) return null;
    return { cid: cidValues[0], href: url.href };
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
        const accountLink = canonicalAccountLink(link.label, link.href);
        if (!accountLink) return null;
        labels.add(link.label);
        cids.add(accountLink.cid);
    }
    const corroborated = labels.has('My Home Page')
        && (labels.has('Edit Account') || labels.has('Add Ascent') || labels.has('My Ascents'));
    return corroborated && cids.size === 1 ? [...cids][0] : null;
};

export const peakbaggerAccount = Object.freeze({
    linkPaths: ACCOUNT_LINK_PATHS,
    canonicalAccountLink,
    freshAccountCid,
});
