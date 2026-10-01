// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';

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
export const emptyList = () => ({ schemaVersion: 1, revision: 0, entries: [] });
export const validCid = cid => Number.isSafeInteger(cid) && cid > 0;
export const profileId = (href, base) => {
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
export const cleanEntry = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !validCid(value.cid) || typeof value.name !== 'string'
        || !value.name.trim() || value.name.length > NAME_LIMIT
        || !Number.isFinite(value.addedAt) || value.addedAt < 0) return null;
    return { cid: value.cid, name: value.name.trim(), addedAt: value.addedAt };
};
export const validateEntries = values => {
    if (!Array.isArray(values) || values.length > LIMIT) return null;
    const entries = values.map(cleanEntry);
    return entries.every(Boolean) && new Set(entries.map(entry => entry.cid)).size === entries.length
        ? entries : null;
};
// Missing storage is an empty new list; malformed storage is unavailable.
// Callers must never turn that distinction into an empty remote upload.
export const readList = value => {
    if (value === undefined) return emptyList();
    if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)
        || value.revision < 0) return null;
    const entries = validateEntries(value.entries);
    return entries ? { schemaVersion: 1, revision: value.revision, entries } : null;
};
export const signature = entries => JSON.stringify([...entries].sort((a, b) => a.cid - b.cid)
    .map(({ cid, name, addedAt }) => ({ cid, name, addedAt })));
export const entrySignature = entry => entry ? signature([entry]) : 'absent';
export const readPreference = value => value === undefined
    ? { schemaVersion: 1, favoritesOnly: false }
    : value?.schemaVersion === 1 && typeof value.favoritesOnly === 'boolean'
        ? { schemaVersion: 1, favoritesOnly: value.favoritesOnly } : null;
const bytes = text => new TextEncoder().encode(text).byteLength;
export const serializeBackup = (entries, exportedAt = new Date().toISOString()) => {
    const valid = validateEntries(entries);
    if (!valid) throw new TypeError('The ignored-climber list is invalid.');
    const text = `${JSON.stringify({ kind: BACKUP_KIND, schemaVersion: 1, exportedAt,
        entries: valid }, null, 2)}\n`;
    if (bytes(text) > MAX_BYTES) throw new RangeError('The ignored-climber backup is too large.');
    return text;
};
export const parseBackup = text => {
    if (typeof text !== 'string' || text.length > MAX_BYTES || bytes(text) > MAX_BYTES) return null;
    try {
        const value = JSON.parse(text);
        if (!value || value.kind !== BACKUP_KIND || value.schemaVersion !== 1
            || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) return null;
        return validateEntries(value.entries);
    } catch { return null; }
};
export const membershipChanges = (before, after) => {
    const previous = new Set(before.map(entry => entry.cid));
    const next = new Set(after.map(entry => entry.cid));
    return { added: after.filter(entry => !previous.has(entry.cid)).length,
        removed: before.filter(entry => !next.has(entry.cid)).length };
};

// Absence is a value in a three-way merge, so deletions propagate. Never use
// wall-clock timestamps to resolve concurrent metadata changes.
export const mergeLists = (base, local, remote, choices = {}) => {
    const maps = [base, local, remote].map(entries => new Map(entries.map(entry => [entry.cid, entry])));
    const ids = new Set([...maps[0].keys(), ...maps[1].keys(), ...maps[2].keys()]);
    const entries = [], conflicts = [];
    for (const cid of ids) {
        const [b, l, r] = maps.map(map => map.get(cid));
        const [bs, ls, rs] = [b, l, r].map(entrySignature);
        let winner;
        if (ls === rs || rs === bs) winner = l;
        else if (ls === bs) winner = r;
        else if (choices[cid] === 'device') winner = l;
        else if (choices[cid] === 'github') winner = r;
        else { conflicts.push({ cid, base: b || null, device: l || null, github: r || null }); continue; }
        if (winner) entries.push(winner);
    }
    return { entries, conflicts, overLimit: entries.length > LIMIT };
};
export const visibility = (records, ignoredIds, predicate = () => true, reveal = false) => {
    const visible = [], ignored = [], matches = [];
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
