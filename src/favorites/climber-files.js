// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.js';
import * as I from './ignored-climbers.js';
import { boundedText as Text } from '../net/bounded-text.js';

export const MAX_BYTES = 2 * 1024 * 1024;
const FAVORITES_KIND = 'better-peakbagger-favorite-climbers';
const invalid = () => new Error('Choose a valid JSON file for this list (up to 1,500 climbers and 2 MB).');
export const listKey = kind => kind === 'favorites' ? F.FAVORITES_KEY : kind === 'ignored' ? I.IGNORED_KEY : null;

export function readStoredList(kind, value) {
    if (kind === 'ignored') {
        const list = I.readList(value);
        if (list) return list;
    } else if (kind === 'favorites') {
        if (value === undefined) return F.cleanFavorites(undefined);
        const parsed = F.parseBackup(JSON.stringify(value));
        if (parsed.ok) return parsed.favorites;
    }
    throw new Error('The saved list could not be read. It has not been changed.');
}

export function serializeListFile(kind, list) {
    const valid = readStoredList(kind, list);
    const exportedAt = new Date().toISOString();
    return kind === 'ignored' ? I.serializeBackup(valid.entries, exportedAt)
        : F.serializeBackup({ kind: FAVORITES_KIND, ...F.buildBackupPayload(valid, { exportedAt }) });
}

export function parseListFile(kind, text) {
    if (!listKey(kind) || typeof text !== 'string' || Text.encodedByteLength(text) > MAX_BYTES) throw invalid();
    try {
        const value = JSON.parse(text);
        Text.assertBoundedStructure(value, { maxDepth: 8, maxNodes: 20000, maxArrayItems: 1500,
            maxObjectKeys: 16, maxStringChars: 2048, label: 'Climber file' });
        if (kind === 'favorites') {
            // Accept existing GitHub favorites files, which predate `kind`.
            // Never reinterpret an empty ignored-climbers file as favorites.
            if (value.kind !== undefined && value.kind !== FAVORITES_KIND) throw invalid();
            const parsed = F.parseBackup(text);
            if (parsed.ok) return parsed.favorites;
        } else {
            const entries = I.parseBackup(text);
            if (entries) return { ...I.emptyList(), entries };
        }
    } catch { throw invalid(); }
    throw invalid();
}

export function replacementMutation(kind, current, replacement) {
    return kind === 'favorites'
        ? { type: F.MUTATION_MESSAGE_TYPE, mutation: { kind: 'replace', favorites: replacement,
            expectedSignature: F.backupSignature(current) } }
        : { type: I.MUTATE_MESSAGE, mutation: { kind: 'replace', entries: replacement.entries,
            expectedRevision: current.revision, expectedSignature: I.signature(current.entries) } };
}

export const membershipChanges = I.membershipChanges;
