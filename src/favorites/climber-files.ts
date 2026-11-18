// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.ts';
import * as I from './ignored-climbers.ts';
import { boundedText as Text } from '../net/bounded-text.ts';

export type ClimberListKind = 'favorites' | 'ignored';
export type StoredFavoritesList = ReturnType<typeof F.cleanFavorites>;
export type StoredIgnoredList = NonNullable<ReturnType<typeof I.readList>>;
export type StoredClimberList = StoredFavoritesList | StoredIgnoredList;

export interface FavoritesReplacementMutation {
    type: typeof F.MUTATION_MESSAGE_TYPE;
    mutation: {
        kind: 'replace';
        favorites: StoredFavoritesList;
        expectedSignature: ReturnType<typeof F.backupSignature>;
    };
}

export interface IgnoredReplacementMutation {
    type: typeof I.MUTATE_MESSAGE;
    mutation: {
        kind: 'replace';
        entries: StoredIgnoredList['entries'];
        expectedRevision: StoredIgnoredList['revision'];
        expectedSignature: ReturnType<typeof I.signature>;
    };
}

export const MAX_BYTES = 2 * 1024 * 1024;
const FAVORITES_KIND = 'better-peakbagger-favorite-climbers';
const invalid = (): Error => new Error('Choose a valid JSON file for this list (up to 1,500 climbers and 2 MB).');
export const listKey = (kind: unknown): string | null =>
    kind === 'favorites' ? F.FAVORITES_KEY : kind === 'ignored' ? I.IGNORED_KEY : null;

export function readStoredList(kind: 'favorites', value: unknown): StoredFavoritesList;
export function readStoredList(kind: 'ignored', value: unknown): StoredIgnoredList;
export function readStoredList(kind: ClimberListKind | string, value: unknown): StoredClimberList;
export function readStoredList(kind: ClimberListKind | string, value: unknown): StoredClimberList {
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

export function serializeListFile(kind: ClimberListKind | string, list: unknown): string {
    if (kind === 'ignored') {
        const valid = readStoredList('ignored', list);
        return I.serializeBackup(valid.entries, new Date().toISOString());
    }
    if (kind === 'favorites') {
        const valid = readStoredList('favorites', list);
        const exportedAt = new Date().toISOString();
        return F.serializeBackup({ kind: FAVORITES_KIND, ...F.buildBackupPayload(valid, { exportedAt }) });
    }
    throw new Error('The saved list could not be read. It has not been changed.');
}

export function parseListFile(kind: 'favorites', text: unknown): StoredFavoritesList;
export function parseListFile(kind: 'ignored', text: unknown): StoredIgnoredList;
export function parseListFile(kind: ClimberListKind | string, text: unknown): StoredClimberList;
export function parseListFile(kind: ClimberListKind | string, text: unknown): StoredClimberList {
    if (!listKey(kind) || typeof text !== 'string' || Text.encodedByteLength(text) > MAX_BYTES) throw invalid();
    try {
        const value: unknown = JSON.parse(text);
        Text.assertBoundedStructure(value, { maxDepth: 8, maxNodes: 20000, maxArrayItems: 1500,
            maxObjectKeys: 16, maxStringChars: 2048, label: 'Climber file' });
        if (kind === 'favorites') {
            // Accept existing GitHub favorites files, which predate `kind`.
            // Never reinterpret an empty ignored-climbers file as favorites.
            const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
            if (!record || (record.kind !== undefined && record.kind !== FAVORITES_KIND)) throw invalid();
            const parsed = F.parseBackup(text);
            if (parsed.ok) return parsed.favorites;
        } else {
            const entries = I.parseBackup(text);
            if (entries) return { ...I.emptyList(), entries };
        }
    } catch { throw invalid(); }
    throw invalid();
}

export function replacementMutation(
    kind: 'favorites',
    current: StoredFavoritesList,
    replacement: StoredFavoritesList,
): FavoritesReplacementMutation;
export function replacementMutation(
    kind: 'ignored',
    current: StoredIgnoredList,
    replacement: StoredIgnoredList,
): IgnoredReplacementMutation;
export function replacementMutation(
    kind: ClimberListKind | string,
    current: StoredClimberList,
    replacement: StoredClimberList,
): FavoritesReplacementMutation | IgnoredReplacementMutation;
export function replacementMutation(
    kind: ClimberListKind | string,
    current: StoredClimberList,
    replacement: StoredClimberList,
): FavoritesReplacementMutation | IgnoredReplacementMutation {
    if (kind === 'favorites') {
        const currentFavorites = current as StoredFavoritesList;
        const nextFavorites = replacement as StoredFavoritesList;
        return {
            type: F.MUTATION_MESSAGE_TYPE,
            mutation: {
                kind: 'replace',
                favorites: nextFavorites,
                expectedSignature: F.backupSignature(currentFavorites),
            },
        };
    }
    const currentIgnored = current as StoredIgnoredList;
    const nextIgnored = replacement as StoredIgnoredList;
    return {
        type: I.MUTATE_MESSAGE,
        mutation: {
            kind: 'replace',
            entries: nextIgnored.entries,
            expectedRevision: currentIgnored.revision,
            expectedSignature: I.signature(currentIgnored.entries),
        },
    };
}

export const membershipChanges = I.membershipChanges;
