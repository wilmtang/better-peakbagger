// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the one definition of "this is Peakbagger".
//
// Four modules used to answer that question with four hand-written checks of
// different strictness: an https-only host set at the fetch boundary, a
// subdomain-tolerant regex for runtime-message senders, and a byte-identical
// pair of postMessage-origin regexes that also accepted plain http. Each of
// those is a trust boundary, and a boundary that drifts is invisible until it
// ships — the same reason src/settings/settings-schema.js owns every settings
// bound and src/gpx/gpx-metrics.js owns the shared geometry.
//
// The three predicates below are deliberately not identical. They answer three
// different questions, and each states why its answer differs. Add a caller to
// one of them rather than writing a fourth check.
//
// Pure by construction: no DOM, no extension APIs, no imports. That is what
// lets the background worker, both content-script worlds, and the
// extension-owned terrain frame all bundle it.

// Both hosts are accepted because Peakbagger serves both. Extension-generated
// navigation and backup links use the www origin below so users and exported
// artifacts see one stable canonical form; accepting the bare host remains a
// compatibility boundary, not a second output policy.
export const PEAKBAGGER_ORIGIN = 'https://www.peakbagger.com';
export const PEAKBAGGER_HOSTS = new Set(['peakbagger.com', 'www.peakbagger.com']);

// "May the extension fetch this URL with the user's Peakbagger cookies?"
// The strictest of the three: an authenticated read is only ever aimed at the
// two canonical hosts, and only over https. A port is irrelevant here — it is
// carried by the URL the caller already chose, not supplied by a page.
export const isPeakbaggerUrl = value => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && PEAKBAGGER_HOSTS.has(url.hostname.toLowerCase());
    } catch { return false; }
};

// "Did this runtime message come from one of our own content scripts?"
// Exact https hosts match manifest.json. A future host must be granted in the
// manifest and added to PEAKBAGGER_HOSTS before its messages become trusted.
// This does not authorize a fetch or a credential — the routes behind it apply
// their own page, identity, and feature gates.
export const isPeakbaggerSenderUrl = value => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && PEAKBAGGER_HOSTS.has(url.hostname.toLowerCase());
    }
    catch { return false; }
};

// "Is this postMessage MessageEvent.origin a Peakbagger page?"
// Exact hosts and https only, like the fetch boundary. A non-default port is
// allowed because the browser verifiers serve their fixtures from an ephemeral
// port on a real Peakbagger hostname (AGENTS.md requires exactly that, and
// scripts/verify-firefox-terrain.mjs uses https://www.peakbagger.com:<port>/).
// Plain http is not allowed: no fixture is permitted to use it, and the fetch
// boundary would refuse such a page's requests anyway.
export const isPeakbaggerPageOrigin = origin => {
    if (typeof origin !== 'string' || !origin) return false;
    try {
        const url = new URL(origin);
        return url.protocol === 'https:'
            && PEAKBAGGER_HOSTS.has(url.hostname.toLowerCase())
            && url.pathname === '/'
            && !url.search && !url.hash;
    } catch { return false; }
};

export const peakbaggerOrigin = {
    PEAKBAGGER_ORIGIN,
    PEAKBAGGER_HOSTS,
    isPeakbaggerUrl,
    isPeakbaggerSenderUrl,
    isPeakbaggerPageOrigin,
};
