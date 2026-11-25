// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.ts';

export interface IgnoredClimberEntry {
    cid: number;
    name: string;
    addedAt: number;
}

export interface IgnoredClimbersList {
    schemaVersion: 1;
    revision: number;
    entries: IgnoredClimberEntry[];
}

export interface PeakReportPreference {
    schemaVersion: 1;
    favoritesOnly: boolean;
}

export interface IgnoredMembershipChanges {
    added: number;
    removed: number;
}

export type MergeChoice = 'device' | 'github';

export interface MergeConflict {
    cid: number;
    base: IgnoredClimberEntry | null;
    device: IgnoredClimberEntry | null;
    github: IgnoredClimberEntry | null;
}

export interface MergeListsResult {
    entries: IgnoredClimberEntry[];
    conflicts: MergeConflict[];
    overLimit: boolean;
}

export interface VisibilityResult<T> {
    visible: T[];
    ignored: T[];
    ignoreHidden: number;
    otherHidden: number;
    revealWouldAdd: number;
    ignoredMatches: number;
    totalHidden: number;
}

export const IGNORED_KEY = 'bpbIgnoredClimbers';
export const PEAK_FILTER_KEY = 'bpbPeakReportFilter';
export const SYNC_KEY = 'bpbIgnoredSyncState';
export const MUTATE_MESSAGE = 'IGNORED_MUTATE';
export const PREFERENCE_MESSAGE = 'PEAK_REPORT_PREFERENCE';
export const LIMIT = 1500;
export const NAME_LIMIT = 200;
export const MAX_BYTES = 2 * 1024 * 1024;
export const BACKUP_PATH = 'ignored-climbers.json';
export const BACKUP_KIND = 'better-peakbagger-ignored-climbers';
export const emptyList = (): IgnoredClimbersList => ({ schemaVersion: 1, revision: 0, entries: [] });
export const validCid = (cid: unknown): cid is number =>
    typeof cid === 'number' && Number.isSafeInteger(cid) && cid > 0;
export const profileId = (href: string, base?: string | URL): number | null => {
    try {
        const url = new URL(href, base);
        if (!isPeakbaggerUrl(url.href) || url.username || url.password
            || !/^\/climber\/climber\.aspx$/i.test(url.pathname)
            || url.searchParams.getAll('cid').length !== 1) return null;
        const raw = url.searchParams.get('cid');
        const cid = /^\d+$/.test(raw || '') ? Number(raw) : null;
        return validCid(cid) ? cid : null;
    } catch { return null; }
};
export const cleanEntry = (value: unknown): IgnoredClimberEntry | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (!validCid(item.cid) || typeof item.name !== 'string'
        || !item.name.trim() || item.name.length > NAME_LIMIT
        || typeof item.addedAt !== 'number' || !Number.isFinite(item.addedAt) || item.addedAt < 0) return null;
    return { cid: item.cid, name: item.name.trim(), addedAt: item.addedAt };
};
export const validateEntries = (values: unknown): IgnoredClimberEntry[] | null => {
    if (!Array.isArray(values) || values.length > LIMIT) return null;
    const entries: IgnoredClimberEntry[] = [];
    const seen = new Set<number>();
    for (const value of values) {
        const entry = cleanEntry(value);
        if (!entry || seen.has(entry.cid)) return null;
        seen.add(entry.cid);
        entries.push(entry);
    }
    return entries;
};
// Missing storage is an empty new list; malformed storage is unavailable.
// Callers must never turn that distinction into an empty remote upload.
export const readList = (value: unknown): IgnoredClimbersList | null => {
    if (value === undefined) return emptyList();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || typeof record.revision !== 'number'
        || !Number.isSafeInteger(record.revision) || record.revision < 0) return null;
    const entries = validateEntries(record.entries);
    return entries ? { schemaVersion: 1, revision: record.revision, entries } : null;
};
export const signature = (entries: readonly IgnoredClimberEntry[]): string =>
    JSON.stringify([...entries].sort((a, b) => a.cid - b.cid)
        .map(({ cid, name, addedAt }) => ({ cid, name, addedAt })));
export const entrySignature = (entry: IgnoredClimberEntry | null | undefined): string =>
    entry ? signature([entry]) : 'absent';
export const readPreference = (value: unknown): PeakReportPreference | null => {
    if (value === undefined) return { schemaVersion: 1, favoritesOnly: false };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.schemaVersion === 1 && typeof record.favoritesOnly === 'boolean'
        ? { schemaVersion: 1, favoritesOnly: record.favoritesOnly } : null;
};
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
export const serializeBackup = (entries: unknown, exportedAt = new Date().toISOString()): string => {
    const valid = validateEntries(entries);
    if (!valid) throw new TypeError('The ignored-climber list is invalid.');
    const text = `${JSON.stringify({ kind: BACKUP_KIND, schemaVersion: 1, exportedAt,
        entries: valid }, null, 2)}\n`;
    if (bytes(text) > MAX_BYTES) throw new RangeError('The ignored-climber backup is too large.');
    return text;
};
export const parseBackup = (text: unknown): IgnoredClimberEntry[] | null => {
    if (typeof text !== 'string' || text.length > MAX_BYTES || bytes(text) > MAX_BYTES) return null;
    try {
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        if (record.kind !== BACKUP_KIND || record.schemaVersion !== 1
            || typeof record.exportedAt !== 'string' || !Number.isFinite(Date.parse(record.exportedAt))) return null;
        return validateEntries(record.entries);
    } catch { return null; }
};
export const membershipChanges = (
    before: readonly { cid: number }[],
    after: readonly { cid: number }[],
): IgnoredMembershipChanges => {
    const previous = new Set(before.map(entry => entry.cid));
    const next = new Set(after.map(entry => entry.cid));
    return { added: after.filter(entry => !previous.has(entry.cid)).length,
        removed: before.filter(entry => !next.has(entry.cid)).length };
};

// Absence is a value in a three-way merge, so deletions propagate. Never use
// wall-clock timestamps to resolve concurrent metadata changes.
export const mergeLists = (
    base: readonly IgnoredClimberEntry[],
    local: readonly IgnoredClimberEntry[],
    remote: readonly IgnoredClimberEntry[],
    choices: Readonly<Record<number, MergeChoice>> = {},
): MergeListsResult => {
    const maps = [base, local, remote].map(entries => new Map(entries.map(entry => [entry.cid, entry])));
    const ids = new Set([...maps[0].keys(), ...maps[1].keys(), ...maps[2].keys()]);
    const entries: IgnoredClimberEntry[] = [];
    const conflicts: MergeConflict[] = [];
    for (const cid of ids) {
        const [b, l, r] = maps.map(map => map.get(cid));
        const [bs, ls, rs] = [b, l, r].map(entrySignature);
        let winner: IgnoredClimberEntry | undefined;
        if (ls === rs || rs === bs) winner = l;
        else if (ls === bs) winner = r;
        else if (choices[cid] === 'device') winner = l;
        else if (choices[cid] === 'github') winner = r;
        else { conflicts.push({ cid, base: b || null, device: l || null, github: r || null }); continue; }
        if (winner) entries.push(winner);
    }
    return { entries, conflicts, overLimit: entries.length > LIMIT };
};
export const visibility = <T extends { climberId?: unknown }>(
    records: readonly T[],
    ignoredIds: ReadonlySet<number>,
    predicate: (record: T) => boolean = () => true,
    reveal = false,
): VisibilityResult<T> => {
    const visible: T[] = [];
    const ignored: T[] = [];
    const matches: T[] = [];
    let otherHidden = 0;
    for (const record of records) {
        const isIgnored = validCid(record.climberId) && ignoredIds.has(record.climberId);
        const ordinary = predicate(record);
        if (isIgnored) { ignored.push(record); if (ordinary) matches.push(record); }
        if (ordinary && (reveal || !isIgnored)) visible.push(record);
        else if (!ordinary && (reveal || !isIgnored)) otherHidden++;
    }
    const ignoreHidden = reveal ? 0 : ignored.length;
    return { visible, ignored, ignoreHidden, otherHidden,
        revealWouldAdd: reveal ? 0 : matches.length, ignoredMatches: matches.length,
        totalHidden: ignoreHidden + otherHidden };
};
