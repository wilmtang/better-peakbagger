// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure favorite-climber storage, parsing, and list logic.
// Browser surfaces pass Documents and storage values in explicitly so they all
// apply the same validation without coupling this module to extension APIs.

import { PEAKBAGGER_HOSTS } from '../peakbagger/peakbagger-origin.ts';

export type FavoriteSourceKind = 'buddy' | 'manual';

export interface FavoriteClimberEntry {
    cid: number;
    name: string;
    addedAt: number;
    source: FavoriteSourceKind;
}

export interface FavoriteClimbersList {
    schemaVersion: 1;
    entries: FavoriteClimberEntry[];
}

export interface FavoriteBackupPayload<T = string> extends FavoriteClimbersList {
    exportedAt: T;
}

export type ParseBackupResult =
    | { ok: false }
    | { ok: true; favorites: FavoriteClimbersList };

export interface MembershipChanges {
    added: number;
    removed: number;
}

export interface BuddyEntry {
    cid: number;
    name: string;
}

export interface BuddyCache {
    ownerCid: number;
    entries: BuddyEntry[];
    fetchedAt: number;
}

export type BuddyMutationAction = 'add' | 'remove';

export interface ClimberSortCandidate {
    cid?: unknown;
    name?: unknown;
    addedAt?: unknown;
}

export interface BuddyControlCandidate {
    id?: string;
    value?: string;
    textContent?: string | null;
    title?: string;
    form?: {
        id?: string;
        getAttribute?: (name: string) => string | null;
    } | null;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => Element | null;
}

const SCHEMA_VERSION = 1 as const;
const FAVORITES_KEY = 'bpbFavoriteClimbers';
const BUDDY_CACHE_KEY = 'bpbBuddyCache';
const BUDDY_PAGE_READ_TYPE = 'BUDDY_PAGE_READ';
const MUTATION_MESSAGE_TYPE = 'FAVORITES_MUTATE';
const BUDDY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 1500;
const NAME_LIMIT = 200;
const CLIMBER_BASE = 'https://www.peakbagger.com/climber/climber.aspx';
let collator: Intl.Collator | null = null;

const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const trim = (value: unknown): string => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const cleanName = (value: unknown): string => trim(value).slice(0, NAME_LIMIT);
const cleanCid = (value: unknown): number | null => {
    const text = typeof value === 'number' ? String(value) : trim(value);
    if (!/^\d+$/.test(text)) return null;
    const cid = Number(text);
    return Number.isSafeInteger(cid) && cid > 0 ? cid : null;
};

const cleanEntry = (value: unknown): FavoriteClimberEntry | null => {
    const item = record(value);
    if (!item) return null;
    const cid = cleanCid(item.cid);
    const name = cleanName(item.name);
    if (cid == null || !name
        || typeof item.addedAt !== 'number' || !Number.isFinite(item.addedAt) || item.addedAt < 0
        || (item.source !== 'buddy' && item.source !== 'manual')) return null;
    return {
        cid,
        name,
        addedAt: item.addedAt,
        source: item.source,
    };
};

const validEntry = (value: unknown): boolean => cleanEntry(value) !== null;

const cleanBuddyEntry = (value: unknown): BuddyEntry | null => {
    const item = record(value);
    if (!item) return null;
    const cid = cleanCid(item.cid);
    const name = cleanName(item.name);
    return cid != null && name ? { cid, name } : null;
};

const uniqueEntries = <T extends { cid: number }>(
    values: unknown,
    cleaner: (value: unknown) => T | null,
    limit = LIMIT,
): T[] => {
    const entries: T[] = [];
    const seen = new Set<number>();
    for (const value of Array.isArray(values) ? values : []) {
        const entry = cleaner(value);
        if (!entry || seen.has(entry.cid)) continue;
        seen.add(entry.cid);
        entries.push(entry);
        if (entries.length >= limit) break;
    }
    return entries;
};

const emptyFavorites = (): FavoriteClimbersList => ({ schemaVersion: SCHEMA_VERSION, entries: [] });

const cleanFavorites = (value: unknown): FavoriteClimbersList => {
    const item = record(value);
    if (!item || item.schemaVersion !== SCHEMA_VERSION) return emptyFavorites();
    return {
        schemaVersion: SCHEMA_VERSION,
        entries: uniqueEntries(item.entries, cleanEntry),
    };
};

const buildBackupPayload = <T = string>(favorites: unknown, { exportedAt }: { exportedAt: T }): FavoriteBackupPayload<T> => ({
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    entries: cleanFavorites(favorites).entries,
});

const serializeBackup = (payload: unknown): string => `${JSON.stringify(payload, null, 2)}\n`;

const parseBackup = (text: string): ParseBackupResult => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false };
    }
    const obj = record(parsed);
    if (!obj || obj.schemaVersion !== SCHEMA_VERSION || !Array.isArray(obj.entries)
        || obj.entries.length > LIMIT
        || cleanFavorites(obj).entries.length !== obj.entries.length) {
        return { ok: false };
    }
    return { ok: true, favorites: cleanFavorites(obj) };
};

// cleanEntry() fixes field order, so this is stable across a serialized backup
// round-trip and deliberately excludes exportedAt.
const backupSignature = (favorites: unknown): string => JSON.stringify(cleanFavorites(favorites).entries);

// How a whole-list replacement (mirror or restore) changes membership, by cid.
// The mirror action and the GitHub restore action each show this diff before
// asking to confirm, and they now live on different pages, so the arithmetic is
// here rather than in either controller.
const membershipChanges = (
    currentEntries: readonly { cid: number }[],
    nextEntries: readonly { cid: number }[],
): MembershipChanges => {
    const currentIds = new Set(currentEntries.map(entry => entry.cid));
    const nextIds = new Set(nextEntries.map(entry => entry.cid));
    return {
        added: nextEntries.filter(entry => !currentIds.has(entry.cid)).length,
        removed: currentEntries.filter(entry => !nextIds.has(entry.cid)).length,
    };
};

const cleanBuddyCache = (value: unknown): BuddyCache | null => {
    const item = record(value);
    if (!item) return null;
    const ownerCid = cleanCid(item.ownerCid);
    if (ownerCid == null || typeof item.fetchedAt !== 'number' || !Number.isFinite(item.fetchedAt) || item.fetchedAt < 0) return null;
    return {
        ownerCid,
        entries: uniqueEntries(item.entries, cleanBuddyEntry),
        fetchedAt: item.fetchedAt,
    };
};

const isFresh = (cache: unknown, now = Date.now()): boolean => {
    const cleaned = cleanBuddyCache(cache);
    return !!cleaned && Number.isFinite(now) && now - cleaned.fetchedAt <= BUDDY_TTL_MS;
};

const numericParam = (href: string, name: string, base = 'https://www.peakbagger.com/'): number | null => {
    try { return cleanCid(new URL(href, base).searchParams.get(name)); }
    catch { return null; }
};

const signedInBuddyListUrl = (origin = 'https://www.peakbagger.com'): string | null => {
    try {
        const url = new URL('/report/report.aspx', origin);
        url.search = '';
        url.searchParams.set('r', 'b');
        return url.toString();
    } catch { return null; }
};

const buddyListUrl = (ownCid: unknown, origin = 'https://www.peakbagger.com'): string | null => {
    const cid = cleanCid(ownCid);
    if (cid == null) return null;
    const directUrl = signedInBuddyListUrl(origin);
    if (!directUrl) return null;
    const url = new URL(directUrl);
    url.searchParams.set('cid', String(cid));
    return url.toString();
};

const parseBuddyDocument = (doc: Document | null | undefined): BuddyEntry[] => {
    if (!doc || !doc.querySelectorAll) return [];
    const entries: BuddyEntry[] = [];
    for (const row of doc.querySelectorAll<HTMLTableRowElement>('#RGridView tr')) {
        const cell = row.cells && row.cells[0];
        if (!cell) continue;
        const anchor = Array.from(cell.querySelectorAll<HTMLAnchorElement>('a[href]')).find(candidate => {
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

const parseClimberInput = (value: unknown): number | null => {
    const text = trim(value);
    const direct = cleanCid(text);
    if (direct != null) return direct;
    try {
        const url = new URL(text);
        // The shared host set, not a local copy of it. The protocol is
        // deliberately not constrained here: this only reads a cid out of
        // something the user pasted, and climberPageUrl rebuilds the address
        // from CLIMBER_BASE, so an old http bookmark still resolves.
        if (!PEAKBAGGER_HOSTS.has(url.hostname.toLowerCase())
            || !/\/climber\/climber\.aspx$/i.test(url.pathname)) return null;
        return cleanCid(url.searchParams.get('cid'));
    } catch { return null; }
};

const climberPageUrl = (cid: unknown): string | null => {
    const cleaned = cleanCid(cid);
    return cleaned == null ? null : `${CLIMBER_BASE}?cid=${cleaned}`;
};

const climberNameFromDocument = (doc: Document | null | undefined): string => {
    if (!doc || !doc.querySelector) return '';
    const heading = doc.querySelector('#TitleLabel h1');
    if (!heading) return '';
    return cleanName(trim(heading.textContent).replace(/^Peakbagging Page for\s+/i, ''));
};

const buddyEntries = (value: unknown): BuddyEntry[] => uniqueEntries(
    Array.isArray(value) ? value : record(value)?.entries,
    cleanBuddyEntry,
);

const mergeBuddies = (favorites: unknown, buddies: unknown, now = Date.now()): FavoriteClimbersList => {
    const result = cleanFavorites(favorites);
    const seen = new Set(result.entries.map(entry => entry.cid));
    for (const buddy of buddyEntries(buddies)) {
        if (seen.has(buddy.cid) || result.entries.length >= LIMIT) continue;
        seen.add(buddy.cid);
        result.entries.push({ ...buddy, addedAt: now, source: 'buddy' });
    }
    return result;
};

const mirrorBuddies = (buddies: unknown, now = Date.now()): FavoriteClimbersList => ({
    schemaVersion: SCHEMA_VERSION,
    entries: buddyEntries(buddies).map(entry => ({ ...entry, addedAt: now, source: 'buddy' })),
});

const favoriteSet = (mode: unknown, favorites: unknown, buddyCache: unknown): Set<number> => new Set(
    (mode === 'custom'
        ? cleanFavorites(favorites).entries
        : (cleanBuddyCache(buddyCache) || { entries: [] }).entries)
        .map(entry => entry.cid),
);

const buddyMutationAction = (value: unknown): BuddyMutationAction | null => {
    const label = trim(value)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLocaleLowerCase();
    if (!/\bbudd(?:y|ies)\b/.test(label)) return null;
    const add = /\badd(?:ed|ing)?\b/.test(label);
    const remove = /\b(?:remove|delete)(?:d|ing)?\b/.test(label);
    if (add === remove) return null;
    return add ? 'add' : 'remove';
};

const compareNames = (left: string, right: string): number => {
    if (!collator) collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    return collator.compare(left, right);
};
const byName = (left: ClimberSortCandidate | null | undefined, right: ClimberSortCandidate | null | undefined): number =>
    compareNames(cleanName(left && left.name), cleanName(right && right.name))
    || (cleanCid(left && left.cid) || 0) - (cleanCid(right && right.cid) || 0);
const byAddedAtDesc = (left: ClimberSortCandidate | null | undefined, right: ClimberSortCandidate | null | undefined): number =>
    (Number(right && right.addedAt) || 0) - (Number(left && left.addedAt) || 0)
    || byName(left, right);

const normalizeSearch = (value: unknown): string => trim(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();

const damerauLevenshtein = (left: string, right: string): number => {
    let beforePrevious: number[] | null = null;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        const current = new Array<number>(right.length + 1).fill(0);
        current[0] = i;
        for (let j = 1; j <= right.length; j++) {
            const substitution = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + substitution,
            );
            if (i > 1 && j > 1
                && beforePrevious
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

const tokenScore = (query: string, candidate: string): number | null => {
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

const fuzzyScore = (entry: ClimberSortCandidate | null | undefined, query: unknown): number | null => {
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
        let best: number | null = null;
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

const buddyControlAction = (control: BuddyControlCandidate | null | undefined): BuddyMutationAction | null => {
    if (!control || control.id?.startsWith('bpb-') || control.closest?.('.bpb-ignore-actions')) return null;
    const primary = [control.value, control.textContent, control.getAttribute?.('aria-label'),
        control.id, control.getAttribute?.('name'), control.form?.id, control.form?.getAttribute?.('name')]
        .filter(Boolean).join(' ');
    // An extension explanation in title must not change a native Add/Remove
    // action, especially after an in-place Buddy button replacement.
    return buddyMutationAction(primary) || buddyMutationAction(`${primary} ${control.title || ''}`);
};

export const favoriteClimbers = {
    BUDDY_CONTROL_SELECTOR: 'button, input[type="submit"], input[type="button"], input[type="image"], a[href]',
    buddyControlAction,
    SCHEMA_VERSION,
    FAVORITES_KEY,
    BUDDY_CACHE_KEY,
    BUDDY_PAGE_READ_TYPE,
    MUTATION_MESSAGE_TYPE,
    BUDDY_TTL_MS,
    LIMIT,
    NAME_LIMIT,
    validEntry,
    cleanFavorites,
    buildBackupPayload,
    serializeBackup,
    parseBackup,
    backupSignature,
    membershipChanges,
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
    byName,
    byAddedAtDesc,
    fuzzyScore,
};
