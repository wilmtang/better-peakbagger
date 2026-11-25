// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from '../favorites/ignored-climbers.ts';
import type {
    IgnoredClimberEntry,
    IgnoredClimbersList,
    PeakReportPreference,
} from '../favorites/ignored-climbers.ts';
import { climberListLane, assertIgnoredMembership } from './climber-list-policy.ts';

export interface IgnoredStorageArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface IgnoredStoreOptions {
    storage: IgnoredStorageArea;
}

export interface IgnoredStoreError {
    code: string;
    message: string;
}

export type IgnoredMutation =
    | { kind: 'add'; entry: IgnoredClimberEntry; expectedEntry?: string }
    | { kind: 'remove'; cid: number; expectedEntry?: string }
    | { kind: 'replace'; entries: IgnoredClimberEntry[]; expectedRevision: number; expectedSignature: string };

export type IgnoredMutateResult =
    | {
        ok: true;
        changed: boolean;
        list: IgnoredClimbersList;
        previous?: IgnoredClimbersList;
        alreadyPresent?: boolean;
    }
    | {
        ok: false;
        error: IgnoredStoreError;
    };

export type IgnoredPreferenceResult =
    | { ok: true; preference: PeakReportPreference }
    | { ok: false; error: IgnoredStoreError };

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const failure = (code: string, message: string): { ok: false; error: IgnoredStoreError } => ({
    ok: false,
    error: { code, message },
});

export const createIgnoredStore = ({ storage }: IgnoredStoreOptions) => {
    // Sync uses this same lane for snapshot reconciliation and atomic storage
    // commits. Network work never holds it, so offline edits remain available.
    const run = climberListLane(storage);
    const assertAllowed = (entries: readonly IgnoredClimberEntry[]) => assertIgnoredMembership(storage, entries);
    const read = async (): Promise<IgnoredClimbersList> => {
        const stored = await storage.get(I.IGNORED_KEY);
        const list = I.readList(stored[I.IGNORED_KEY]);
        if (!list) throw new Error('Ignored climbers are unavailable. Try again.');
        return list;
    };
    const mutate = (mutation: unknown): Promise<IgnoredMutateResult> => run(async (): Promise<IgnoredMutateResult> => {
        const current = await read();
        const rawMutation = asRecord(mutation);
        if (!rawMutation) return failure('invalid', 'Invalid list change.');
        let entries = current.entries;
        switch (rawMutation.kind) {
        case 'add': {
            const entry = I.cleanEntry(rawMutation.entry);
            if (!entry) return failure('invalid', 'Invalid climber.');
            await assertAllowed([entry]);
            const existing = entries.find(candidate => candidate.cid === entry.cid);
            if (rawMutation.expectedEntry !== undefined
                && rawMutation.expectedEntry !== I.entrySignature(existing)) {
                return failure('stale', 'This climber changed. Review the entry before undoing.');
            }
            if (existing) return { ok: true, changed: false, list: current, alreadyPresent: true };
            if (entries.length >= I.LIMIT) return failure('limit', 'Ignored climbers can hold up to 1,500 entries.');
            entries = [entry, ...entries];
            break;
        }
        case 'remove': {
            const cid = rawMutation.cid;
            if (!I.validCid(cid)) return failure('invalid', 'Invalid climber.');
            if (rawMutation.expectedEntry !== undefined && rawMutation.expectedEntry !== I.entrySignature(
                entries.find(entry => entry.cid === cid))) {
                return failure('stale', 'This climber changed. Review the entry and try again.');
            }
            entries = entries.filter(entry => entry.cid !== cid);
            break;
        }
        case 'replace': {
            const validated = I.validateEntries(rawMutation.entries);
            if (!validated) return failure('invalid', 'Invalid ignored-climber list.');
            if (rawMutation.expectedRevision !== current.revision
                || rawMutation.expectedSignature !== I.signature(current.entries)) {
                return failure('stale', 'Ignored climbers changed. Review the updated list and try again.');
            }
            await assertAllowed(validated);
            entries = validated;
            break;
        }
        default: return failure('invalid', 'Invalid list change.');
        }
        const changed = I.signature(entries) !== I.signature(current.entries);
        if (changed && current.revision === Number.MAX_SAFE_INTEGER) {
            return failure('storage', 'The list revision cannot be advanced.');
        }
        const list: IgnoredClimbersList = changed
            ? { schemaVersion: 1, revision: current.revision + 1, entries }
            : current;
        if (changed) await storage.set({ [I.IGNORED_KEY]: list });
        return { ok: true, changed, list, previous: current };
    }).catch((error: unknown) => {
        const details = error && typeof error === 'object'
            ? error as { code?: unknown; message?: unknown }
            : null;
        return failure(
            typeof details?.code === 'string' && details.code ? details.code : 'storage',
            typeof details?.message === 'string' && details.message
                ? details.message
                : 'Ignored climbers could not be saved. Try again.',
        );
    });
    const preference = (favoritesOnly: unknown): Promise<IgnoredPreferenceResult> => run(
        async (): Promise<IgnoredPreferenceResult> => {
            if (typeof favoritesOnly !== 'boolean') return failure('invalid', 'Invalid report preference.');
            const value: PeakReportPreference = { schemaVersion: 1, favoritesOnly };
            await storage.set({ [I.PEAK_FILTER_KEY]: value });
            return { ok: true, preference: value };
        },
    ).catch(() => failure('storage', 'This view could not be remembered. Try again.'));
    return { run, read, mutate, preference, assertAllowed };
};

export type IgnoredStore = ReturnType<typeof createIgnoredStore>;
