// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure favorite-climber storage, parsing, and list logic.
// Browser surfaces pass Documents and storage values in explicitly so they all
// apply the same validation without coupling this module to extension APIs.

const SCHEMA_VERSION = 1;
const FAVORITES_KEY = 'bpbFavoriteClimbers';
const BUDDY_CACHE_KEY = 'bpbBuddyCache';
const BUDDY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 1500;
const NAME_LIMIT = 200;
const CLIMBER_BASE = 'https://www.peakbagger.com/climber/climber.aspx';
let collator = null;

const trim = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const cleanName = value => trim(value).slice(0, NAME_LIMIT);
const cleanCid = value => {
    const text = typeof value === 'number' ? String(value) : trim(value);
    if (!/^\d+$/.test(text)) return null;
    const cid = Number(text);
    return Number.isSafeInteger(cid) && cid > 0 ? cid : null;
};

const validEntry = value => !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && cleanCid(value.cid) != null
    && cleanName(value.name).length > 0
    && Number.isFinite(value.addedAt)
    && value.addedAt >= 0
    && (value.source === 'buddy' || value.source === 'manual');

const cleanEntry = value => validEntry(value) ? {
    cid: cleanCid(value.cid),
    name: cleanName(value.name),
    addedAt: value.addedAt,
    source: value.source,
} : null;

const cleanBuddyEntry = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const cid = cleanCid(value.cid);
    const name = cleanName(value.name);
    return cid != null && name ? { cid, name } : null;
};

const uniqueEntries = (values, cleaner, limit = LIMIT) => {
    const entries = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const entry = cleaner(value);
        if (!entry || seen.has(entry.cid)) continue;
        seen.add(entry.cid);
        entries.push(entry);
        if (entries.length >= limit) break;
    }
    return entries;
};

const emptyFavorites = () => ({ schemaVersion: SCHEMA_VERSION, entries: [] });

const cleanFavorites = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schemaVersion !== SCHEMA_VERSION) return emptyFavorites();
    return {
        schemaVersion: SCHEMA_VERSION,
        entries: uniqueEntries(value.entries, cleanEntry),
    };
};

const cleanBuddyCache = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const ownerCid = cleanCid(value.ownerCid);
    if (ownerCid == null || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0) return null;
    return {
        ownerCid,
        entries: uniqueEntries(value.entries, cleanBuddyEntry),
        fetchedAt: value.fetchedAt,
    };
};

const isFresh = (cache, now = Date.now()) => {
    const cleaned = cleanBuddyCache(cache);
    return !!cleaned && Number.isFinite(now) && now - cleaned.fetchedAt <= BUDDY_TTL_MS;
};

const numericParam = (href, name, base = 'https://www.peakbagger.com/') => {
    try { return cleanCid(new URL(href, base).searchParams.get(name)); }
    catch { return null; }
};

const signedInBuddyListUrl = (origin = 'https://www.peakbagger.com') => {
    try {
        const url = new URL('/report/report.aspx', origin);
        url.search = '';
        url.searchParams.set('r', 'b');
        return url.toString();
    } catch { return null; }
};

const buddyListUrl = (ownCid, origin = 'https://www.peakbagger.com') => {
    const cid = cleanCid(ownCid);
    if (cid == null) return null;
    const directUrl = signedInBuddyListUrl(origin);
    if (!directUrl) return null;
    const url = new URL(directUrl);
    url.searchParams.set('cid', String(cid));
    return url.toString();
};

const parseBuddyDocument = doc => {
    if (!doc || !doc.querySelectorAll) return [];
    const entries = [];
    for (const row of doc.querySelectorAll('#RGridView tr')) {
        const cell = row.cells && row.cells[0];
        if (!cell) continue;
        const anchor = Array.from(cell.querySelectorAll('a[href]')).find(candidate => {
            try { return /\/climber\/climber\.aspx$/i.test(new URL(candidate.href, doc.baseURI).pathname); }
            catch { return false; }
        });
        if (!anchor) continue;
        const cid = numericParam(anchor.href, 'cid', doc.baseURI);
        const name = cleanName(anchor.textContent);
        if (cid != null && name) entries.push({ cid, name });
    }
    return uniqueEntries(entries, cleanBuddyEntry);
};

const parseClimberInput = value => {
    const text = trim(value);
    const direct = cleanCid(text);
    if (direct != null) return direct;
    try {
        const url = new URL(text);
        if (!/^(?:www\.)?peakbagger\.com$/i.test(url.hostname)
            || !/\/climber\/climber\.aspx$/i.test(url.pathname)) return null;
        return cleanCid(url.searchParams.get('cid'));
    } catch { return null; }
};

const climberPageUrl = cid => {
    const cleaned = cleanCid(cid);
    return cleaned == null ? null : `${CLIMBER_BASE}?cid=${cleaned}`;
};

const climberNameFromDocument = doc => {
    if (!doc || !doc.querySelector) return '';
    const heading = doc.querySelector('#TitleLabel h1');
    if (!heading) return '';
    return cleanName(trim(heading.textContent).replace(/^Peakbagging Page for\s+/i, ''));
};

const buddyEntries = value => uniqueEntries(
    Array.isArray(value) ? value : value && value.entries,
    cleanBuddyEntry,
);

const mergeBuddies = (favorites, buddies, now = Date.now()) => {
    const result = cleanFavorites(favorites);
    const seen = new Set(result.entries.map(entry => entry.cid));
    for (const buddy of buddyEntries(buddies)) {
        if (seen.has(buddy.cid) || result.entries.length >= LIMIT) continue;
        seen.add(buddy.cid);
        result.entries.push({ ...buddy, addedAt: now, source: 'buddy' });
    }
    return result;
};

const mirrorBuddies = (buddies, now = Date.now()) => ({
    schemaVersion: SCHEMA_VERSION,
    entries: buddyEntries(buddies).map(entry => ({ ...entry, addedAt: now, source: 'buddy' })),
});

const favoriteSet = (mode, favorites, buddyCache) => new Set(
    (mode === 'custom'
        ? cleanFavorites(favorites).entries
        : (cleanBuddyCache(buddyCache) || { entries: [] }).entries)
        .map(entry => entry.cid),
);

const buddyMutationAction = value => {
    const label = trim(value)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLocaleLowerCase();
    if (!/\bbudd(?:y|ies)\b/.test(label)) return null;
    const add = /\badd(?:ed|ing)?\b/.test(label);
    const remove = /\b(?:remove|delete)(?:d|ing)?\b/.test(label);
    if (add === remove) return null;
    return add ? 'add' : 'remove';
};

const applyBuddyMutationToFavorites = (
    favorites,
    buddy,
    action,
    { removeFavorite = false, now = Date.now() } = {},
) => {
    const current = cleanFavorites(favorites);
    const entry = cleanBuddyEntry(buddy);
    if (!entry || (action !== 'add' && action !== 'remove')) return current;
    const exists = current.entries.some(candidate => candidate.cid === entry.cid);
    if (action === 'add') {
        if (exists || current.entries.length >= LIMIT) return current;
        return {
            schemaVersion: SCHEMA_VERSION,
            entries: [{ ...entry, addedAt: now, source: 'buddy' }, ...current.entries],
        };
    }
    if (!removeFavorite || !exists) return current;
    return {
        schemaVersion: SCHEMA_VERSION,
        entries: current.entries.filter(candidate => candidate.cid !== entry.cid),
    };
};

const compareNames = (left, right) => {
    if (!collator) collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    return collator.compare(left, right);
};
const byName = (left, right) => compareNames(cleanName(left && left.name), cleanName(right && right.name))
    || (cleanCid(left && left.cid) || 0) - (cleanCid(right && right.cid) || 0);
const byAddedAtDesc = (left, right) => (Number(right && right.addedAt) || 0) - (Number(left && left.addedAt) || 0)
    || byName(left, right);

const normalizeSearch = value => trim(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();

const damerauLevenshtein = (left, right) => {
    let beforePrevious = null;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        const current = new Array(right.length + 1).fill(0);
        current[0] = i;
        for (let j = 1; j <= right.length; j++) {
            const substitution = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + substitution,
            );
            if (i > 1 && j > 1
                && left[i - 1] === right[j - 2]
                && left[i - 2] === right[j - 1]) {
                current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
            }
        }
        beforePrevious = previous;
        previous = current;
    }
    return previous[right.length];
};

const tokenScore = (query, candidate) => {
    if (!query || !candidate) return null;
    if (candidate === query) return 0;
    if (candidate.startsWith(query)) return 2 + (candidate.length - query.length) / 100;
    const containedAt = candidate.indexOf(query);
    if (containedAt >= 0) return 8 + containedAt + (candidate.length - query.length) / 100;

    if (query.length >= 2) {
        let previous = -1;
        let gaps = 0;
        for (const char of query) {
            const index = candidate.indexOf(char, previous + 1);
            if (index < 0) {
                previous = -1;
                break;
            }
            if (previous >= 0) gaps += index - previous - 1;
            previous = index;
        }
        if (previous >= 0) return 16 + gaps + (candidate.length - query.length) / 100;
    }

    const typoAllowance = query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
    if (!typoAllowance || Math.abs(candidate.length - query.length) > typoAllowance) return null;
    const distance = damerauLevenshtein(query, candidate);
    return distance <= typoAllowance ? 28 + distance * 4 : null;
};

const fuzzyScore = (entry, query) => {
    const normalizedQuery = normalizeSearch(query).slice(0, NAME_LIMIT);
    if (!normalizedQuery) return 0;
    const name = normalizeSearch(entry && entry.name);
    const cid = cleanCid(entry && entry.cid);
    if (!name || cid == null) return null;

    const combined = `${name} ${cid}`;
    const phraseAt = combined.indexOf(normalizedQuery);
    if (phraseAt >= 0) return phraseAt;

    const nameTokens = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const initials = nameTokens.map(token => token[0]).join('');
    const candidates = [...nameTokens, initials];
    const cidText = String(cid);
    let total = 0;
    for (const queryToken of normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        let best = null;
        const numericQuery = /^\d+$/.test(queryToken);
        for (const candidate of candidates) {
            const candidateAt = numericQuery ? candidate.indexOf(queryToken) : -1;
            const score = numericQuery
                ? (candidateAt < 0 ? null : candidateAt === 0 ? 2 : 8 + candidateAt)
                : tokenScore(queryToken, candidate);
            if (score != null && (best == null || score < best)) best = score;
        }
        const cidAt = cidText.indexOf(queryToken);
        if (cidAt >= 0) {
            const cidScore = cidAt === 0 ? 2 + (cidText.length - queryToken.length) / 100 : 8 + cidAt;
            if (best == null || cidScore < best) best = cidScore;
        }
        if (best == null) return null;
        total += best;
    }
    return total;
};

export const favoriteClimbers = {
    SCHEMA_VERSION,
    FAVORITES_KEY,
    BUDDY_CACHE_KEY,
    BUDDY_TTL_MS,
    LIMIT,
    NAME_LIMIT,
    validEntry,
    cleanFavorites,
    cleanBuddyCache,
    isFresh,
    signedInBuddyListUrl,
    buddyListUrl,
    parseBuddyDocument,
    parseClimberInput,
    climberPageUrl,
    climberNameFromDocument,
    mergeBuddies,
    mirrorBuddies,
    favoriteSet,
    buddyMutationAction,
    applyBuddyMutationToFavorites,
    byName,
    byAddedAtDesc,
    fuzzyScore,
};
