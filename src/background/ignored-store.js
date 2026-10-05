// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from '../favorites/ignored-climbers.js';
import { climberListLane, assertIgnoredMembership } from './climber-list-policy.js';

const failure = (code, message) => ({ ok: false, error: { code, message } });
export const createIgnoredStore = ({ storage } = {}) => {
    // Sync uses this same lane for snapshot reconciliation and atomic storage
    // commits. Network work never holds it, so offline edits remain available.
    const run = climberListLane(storage);
    const assertAllowed = entries => assertIgnoredMembership(storage, entries);
    const read = async () => {
        const stored = await storage.get(I.IGNORED_KEY);
        const list = I.readList(stored[I.IGNORED_KEY]);
        if (!list) throw new Error('Ignored climbers are unavailable. Try again.');
        return list;
    };
    const mutate = mutation => run(async () => {
        const current = await read();
        if (!mutation || typeof mutation !== 'object') return failure('invalid', 'Invalid list change.');
        let entries = current.entries;
        switch (mutation.kind) {
        case 'add': {
            const entry = I.cleanEntry(mutation.entry);
            if (!entry) return failure('invalid', 'Invalid climber.');
            await assertAllowed([entry]);
            const existing = entries.find(candidate => candidate.cid === entry.cid);
            if (mutation.expectedEntry !== undefined
                && mutation.expectedEntry !== I.entrySignature(existing)) {
                return failure('stale', 'This climber changed. Review the entry before undoing.');
            }
            if (existing) return { ok: true, changed: false, list: current, alreadyPresent: true };
            if (entries.length >= I.LIMIT) return failure('limit', 'Ignored climbers can hold up to 1,500 entries.');
            entries = [entry, ...entries];
            break;
        }
        case 'remove':
            if (!I.validCid(mutation.cid)) return failure('invalid', 'Invalid climber.');
            if (mutation.expectedEntry !== undefined && mutation.expectedEntry !== I.entrySignature(
                entries.find(entry => entry.cid === mutation.cid))) {
                return failure('stale', 'This climber changed. Review the entry and try again.');
            }
            entries = entries.filter(entry => entry.cid !== mutation.cid);
            break;
        case 'replace':
            entries = I.validateEntries(mutation.entries);
            if (!entries) return failure('invalid', 'Invalid ignored-climber list.');
            if (mutation.expectedRevision !== current.revision
                || mutation.expectedSignature !== I.signature(current.entries)) {
                return failure('stale', 'Ignored climbers changed. Review the updated list and try again.');
            }
            await assertAllowed(entries);
            break;
        default: return failure('invalid', 'Invalid list change.');
        }
        const changed = I.signature(entries) !== I.signature(current.entries);
        if (changed && current.revision === Number.MAX_SAFE_INTEGER) {
            return failure('storage', 'The list revision cannot be advanced.');
        }
        const list = changed ? { schemaVersion: 1, revision: current.revision + 1, entries } : current;
        if (changed) await storage.set({ [I.IGNORED_KEY]: list });
        return { ok: true, changed, list, previous: current };
    }).catch(error => failure(error.code || 'storage', error.message || 'Ignored climbers could not be saved. Try again.'));
    const preference = favoritesOnly => run(async () => {
        if (typeof favoritesOnly !== 'boolean') return failure('invalid', 'Invalid report preference.');
        const value = { schemaVersion: 1, favoritesOnly };
        await storage.set({ [I.PEAK_FILTER_KEY]: value });
        return { ok: true, preference: value };
    }).catch(() => failure('storage', 'This view could not be remembered. Try again.'));
    return { run, read, mutate, preference, assertAllowed };
};
