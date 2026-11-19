// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Worker-owned confirmation boundary for local trip-report drafts.

import { reportDrafts as ReportDrafts, type ReportDraftRecord } from '../reports/report-drafts.ts';

export interface ReportDraftStorageArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
}

export interface ReportDraftExt {
    storage: {
        local: ReportDraftStorageArea;
    };
}

export interface ReportDraftSender {
    url?: string;
    tab?: {
        id?: number;
    };
}

export interface CleanedDraftIdentity {
    cid: string;
    aid: string | null;
    pid: string | null;
}

export interface PendingDraftSave {
    sourceTabId: number;
    draftKey: string;
    identity: CleanedDraftIdentity;
    attemptId: string;
    generation: string;
    requestedAt: number;
    expiresAt: number;
}

export interface CreateReportDraftRoutesOptions {
    ext: ReportDraftExt;
    now: () => number;
    isPeakbaggerSender: (sender: ReportDraftSender) => boolean;
    isExtensionPage: (sender: ReportDraftSender) => boolean;
    mutateMap: <Result = unknown, Value = PendingDraftSave>(
        key: string,
        mutate: (map: Record<string, Value>) => Result | Promise<Result>,
    ) => Promise<Result>;
}

export type ReportDraftMessage = Record<string, unknown>;

export type ReportDraftHandlerType =
    | 'REPORT_DRAFT_WRITE'
    | 'REPORT_DRAFT_REMOVE'
    | 'REPORT_DRAFT_DELETE'
    | 'REPORT_DRAFT_RESTORE'
    | 'REPORT_DRAFT_DELETE_MANY'
    | 'REPORT_DRAFT_RESTORE_MANY'
    | 'REPORT_DRAFT_FINALIZE_DELETE'
    | 'REPORT_DRAFT_FINALIZE_DELETE_MANY'
    | 'REPORT_DRAFT_PRUNE'
    | 'REPORT_DRAFT_SAVE_PENDING'
    | 'REPORT_DRAFT_SAVE_CONFIRMED'
    | 'REPORT_DRAFT_SAVE_CANCEL';

interface DraftTombstone {
    deletedGeneration: string;
    deletedAt: number;
}

interface ExpectedRecord {
    generation: string | null;
    savedAt: number;
}

const PENDING_KEY = 'bpbPendingReportDraftSaves';
const TTL_MS = 30 * 60 * 1000;
const LIMIT = 30;
const HANDLER_TYPES = new Set<string>([
    'REPORT_DRAFT_WRITE',
    'REPORT_DRAFT_REMOVE',
    'REPORT_DRAFT_DELETE',
    'REPORT_DRAFT_RESTORE',
    'REPORT_DRAFT_DELETE_MANY',
    'REPORT_DRAFT_RESTORE_MANY',
    'REPORT_DRAFT_FINALIZE_DELETE',
    'REPORT_DRAFT_FINALIZE_DELETE_MANY',
    'REPORT_DRAFT_PRUNE',
    'REPORT_DRAFT_SAVE_PENDING',
    'REPORT_DRAFT_SAVE_CONFIRMED',
    'REPORT_DRAFT_SAVE_CANCEL',
]);

const cleanDigits = (value: unknown, { signed = false, positive = false } = {}): string | null => {
    const text = String(value ?? '');
    const pattern = signed ? /^-?\d+$/ : /^\d+$/;
    if (!pattern.test(text)) return null;
    const number = Number(text);
    if (!Number.isSafeInteger(number) || (positive && number <= 0)) return null;
    return String(number);
};

const cleanIdentity = (value: unknown): CleanedDraftIdentity | null => {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    const cid = cleanDigits(raw?.cid) || '0';
    const aid = raw?.aid == null || raw.aid === ''
        ? null
        : cleanDigits(raw.aid, { positive: true });
    const pid = raw?.pid == null || raw.pid === ''
        ? null
        : cleanDigits(raw.pid, { signed: true });
    if ((raw?.aid != null && raw.aid !== '' && !aid)
        || (raw?.pid != null && raw.pid !== '' && !pid)
        || (aid && pid)) return null;
    return { cid, aid, pid };
};

const senderIdentity = (sender: ReportDraftSender | null | undefined): CleanedDraftIdentity | null => {
    try {
        const url = new URL(sender?.url || '');
        if (!/\/climber\/ascentedit\.aspx$/i.test(url.pathname)) return null;
        return cleanIdentity({
            cid: url.searchParams.get('cid'),
            aid: url.searchParams.get('aid'),
            pid: url.searchParams.get('pid'),
        });
    } catch { return null; }
};

const sameIdentity = (
    left: CleanedDraftIdentity | null | undefined,
    right: CleanedDraftIdentity | null | undefined,
): boolean => !!left && !!right
    && left.cid === right.cid && left.aid === right.aid && left.pid === right.pid;
const cleanAttemptId = (value: unknown): string | null => typeof value === 'string'
    && /^[a-zA-Z0-9:_-]{1,100}$/.test(value) ? value : null;

const GENERATION_FIELD = ReportDrafts.GENERATION_FIELD;
const TOMBSTONE_FIELD = 'deletedGeneration';
const DELETION_EPOCH_KEY = ReportDrafts.DELETION_EPOCH_KEY;
const TOMBSTONE_LIMIT = ReportDrafts.LIMIT * 2;
const UNDO_PROTECTION_MS = 60_000;
const cleanDraftKey = (value: unknown): string | null => typeof value === 'string' && ReportDrafts.parseKey(value)
    ? value : null;
const cleanGeneration = (value: unknown): string | null => typeof value === 'string'
    && /^\d+:[1-9]\d*:[a-zA-Z0-9_-]{8,100}$/.test(value) ? value : null;
const isTombstone = (value: unknown): value is DraftTombstone => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Boolean(cleanGeneration(record[TOMBSTONE_FIELD]))
        && typeof record.deletedAt === 'number' && Number.isFinite(record.deletedAt);
};
const cleanExpectedRecord = (entry: unknown): ExpectedRecord | null => {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as { expectedSavedAt?: unknown; expectedGeneration?: unknown };
    if (typeof record.expectedSavedAt !== 'number' || !Number.isFinite(record.expectedSavedAt)) return null;
    const generation = record.expectedGeneration == null ? null : cleanGeneration(record.expectedGeneration);
    return record.expectedGeneration != null && !generation
        ? null : { generation, savedAt: record.expectedSavedAt };
};
const expectedRecordMatches = (current: unknown, expected: ExpectedRecord): current is ReportDraftRecord => {
    if (!ReportDrafts.validRecord(current) || current.savedAt !== expected.savedAt) return false;
    const currentGeneration = cleanGeneration(current[GENERATION_FIELD]);
    return expected.generation == null ? !currentGeneration : currentGeneration === expected.generation;
};

export const createReportDraftRoutes = ({
    ext,
    now,
    isPeakbaggerSender,
    isExtensionPage,
    mutateMap,
}: CreateReportDraftRoutesOptions) => {
    if (!ext?.storage?.local || typeof now !== 'function'
        || typeof isPeakbaggerSender !== 'function' || typeof isExtensionPage !== 'function'
        || typeof mutateMap !== 'function') {
        throw new TypeError('report draft routes require storage, sender validation, and map mutation');
    }

    let nextGeneration = 0;
    let routeQueue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = routeQueue.then(operation);
        routeQueue = result.catch(() => {});
        return result;
    };

    const createGeneration = (): string => {
        nextGeneration++;
        let nonce: string;
        try { nonce = globalThis.crypto.randomUUID(); }
        catch { nonce = `fallback-${nextGeneration}-${Math.random().toString(36).slice(2)}`; }
        return `${now()}:${nextGeneration}:${nonce}`;
    };
    const exactEditorKey = (draftKey: string, sender: ReportDraftSender): boolean => {
        const parsed = ReportDrafts.parseKey(draftKey);
        return isPeakbaggerSender(sender)
            && sameIdentity(senderIdentity(sender), cleanIdentity({
                cid: parsed?.cid,
                aid: parsed?.kind === 'ascent' ? parsed.id : null,
                pid: parsed?.kind === 'peak' ? parsed.id : null,
            }));
    };
    const mutationSender = (sender: ReportDraftSender, draftKey: string): boolean => isExtensionPage(sender)
        || exactEditorKey(draftKey, sender);
    const tombstone = (): DraftTombstone => ({
        [TOMBSTONE_FIELD]: createGeneration(),
        deletedAt: now(),
    });
    // Publish the barrier before retiring keys. An interrupted cleanup leaves
    // extra markers, never an old absence snapshot with renewed authority.
    const retireKeys = async (keys: string[]): Promise<void> => {
        if (!keys.length) return;
        await ext.storage.local.set({ [DELETION_EPOCH_KEY]: createGeneration() });
        await ext.storage.local.remove(keys);
    };
    const readMutation = async (draftKey: string, message: ReportDraftMessage) => {
        const values = await ext.storage.local.get([draftKey, DELETION_EPOCH_KEY]);
        const current = values[draftKey];
        const rawEpoch = values[DELETION_EPOCH_KEY];
        const matches = !Object.hasOwn(message, 'expectedVersion')
            || (message.expectedVersion === ReportDrafts.version(current)
                && (current !== undefined || (message.expectedDeletionEpoch ?? null) === (rawEpoch ?? null)));
        return {
            current,
            matches,
            deletionEpoch: typeof rawEpoch === 'string' ? rawEpoch : null,
        };
    };

    const write = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        const draftKey = cleanDraftKey(message?.draftKey);
        const rawRecord = message?.record;
        if (!draftKey || !exactEditorKey(draftKey, sender) || !ReportDrafts.validRecord(rawRecord)) {
            return { ok: false, error: { code: 'invalid-draft-write' } };
        }
        const { current, matches, deletionEpoch } = await readMutation(draftKey, message);
        if (!matches) {
            return { ok: true, draftKey, written: false, reason: 'changed' };
        }
        if (message.expectedSavedAt !== undefined || message.expectedGeneration !== undefined) {
            const expected = cleanExpectedRecord(message);
            if (!expected) {
                return { ok: false, error: { code: 'invalid-draft-write' } };
            }
            if (!expectedRecordMatches(current, expected)) {
                return { ok: true, draftKey, written: false, reason: 'changed' };
            }
        }
        if (!Object.hasOwn(message, 'expectedVersion') && ((ReportDrafts.validRecord(current) && current.savedAt > rawRecord.savedAt)
            || (isTombstone(current) && current.deletedAt >= rawRecord.savedAt)
            || (current === undefined && deletionEpoch && rawRecord.savedAt <= Number(deletionEpoch.split(':')[0])))) {
            return { ok: true, draftKey, written: false, reason: 'superseded' };
        }
        const record = structuredClone(rawRecord);
        record[GENERATION_FIELD] = createGeneration();
        await ext.storage.local.set({ [draftKey]: record });
        return { ok: true, draftKey, written: true, record };
    });

    const remove = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        const draftKey = cleanDraftKey(message?.draftKey);
        if (!draftKey || !mutationSender(sender, draftKey)) {
            return { ok: false, error: { code: 'invalid-draft-remove' } };
        }
        if (Object.hasOwn(message, 'expectedVersion')) {
            const { matches } = await readMutation(draftKey, message);
            if (!matches) {
                return { ok: true, draftKey, removed: false, reason: 'changed' };
            }
        }
        // Cleanup and recovery offers act on a snapshot. Keep explicit terminal
        // removals unconditional, but never let an old snapshot consume a newer save.
        if (message?.expectedSavedAt !== undefined || message?.expectedGeneration !== undefined) {
            const expected = cleanExpectedRecord(message);
            if (!expected) {
                return { ok: false, error: { code: 'invalid-draft-remove' } };
            }
            const current = (await ext.storage.local.get(draftKey))[draftKey];
            if (!expectedRecordMatches(current, expected)) {
                return { ok: true, draftKey, removed: false, reason: 'changed' };
            }
        }
        const marker = tombstone();
        await ext.storage.local.set({ [draftKey]: marker });
        return {
            ok: true,
            draftKey,
            removed: true,
            generation: marker[TOMBSTONE_FIELD],
            version: ReportDrafts.version(marker),
        };
    });

    const deleteOne = async (entry: ReportDraftMessage, sender: ReportDraftSender) => {
        const draftKey = cleanDraftKey(entry?.draftKey);
        const expected = cleanExpectedRecord(entry);
        if (!draftKey || !isExtensionPage(sender) || !expected) {
            return { ok: false, error: { code: 'invalid-draft-delete' } };
        }
        const current = (await ext.storage.local.get(draftKey))[draftKey];
        if (!expectedRecordMatches(current, expected)) {
            return { ok: true, draftKey, deleted: false, reason: 'changed' };
        }
        const marker = tombstone();
        await ext.storage.local.set({ [draftKey]: marker });
        return {
            ok: true,
            draftKey,
            deleted: true,
            generation: marker[TOMBSTONE_FIELD],
            record: current,
        };
    };
    const deleteDraft = (message: ReportDraftMessage, sender: ReportDraftSender) =>
        serialize(() => deleteOne(message, sender));

    const restoreOne = async (entry: ReportDraftMessage, sender: ReportDraftSender) => {
        const draftKey = cleanDraftKey(entry?.draftKey);
        const expectedGeneration = cleanGeneration(entry?.generation);
        const rawRecord = entry?.record;
        if (!draftKey || !expectedGeneration || !isExtensionPage(sender)
            || !ReportDrafts.validRecord(rawRecord)) {
            return { ok: false, error: { code: 'invalid-draft-restore' } };
        }
        const current = (await ext.storage.local.get(draftKey))[draftKey];
        if (!isTombstone(current) || current[TOMBSTONE_FIELD] !== expectedGeneration) {
            return { ok: true, draftKey, restored: false, reason: 'changed' };
        }
        const record = structuredClone(rawRecord);
        record[GENERATION_FIELD] = createGeneration();
        await ext.storage.local.set({ [draftKey]: record });
        return { ok: true, draftKey, restored: true, record };
    };
    const restore = (message: ReportDraftMessage, sender: ReportDraftSender) =>
        serialize(() => restoreOne(message, sender));

    const deleteMany = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        if (!isExtensionPage(sender) || !Array.isArray(message?.entries) || message.entries.length > LIMIT) {
            return { ok: false, error: { code: 'invalid-draft-delete-many' } };
        }
        const entries: { draftKey: string; expected: ExpectedRecord }[] = [];
        for (const rawEntry of message.entries) {
            const draftKey = cleanDraftKey((rawEntry as { draftKey?: unknown } | null | undefined)?.draftKey);
            const expected = cleanExpectedRecord(rawEntry);
            if (!draftKey || !expected) {
                return { ok: false, error: { code: 'invalid-draft-delete-many' } };
            }
            entries.push({ draftKey, expected });
        }
        const current = await ext.storage.local.get(entries.map(entry => entry.draftKey));
        const patch: Record<string, DraftTombstone> = {};
        const results = entries.map(entry => {
            const record = current[entry.draftKey];
            if (!expectedRecordMatches(record, entry.expected)) {
                return { ok: true, draftKey: entry.draftKey, deleted: false, reason: 'changed' };
            }
            const marker = tombstone();
            patch[entry.draftKey] = marker;
            return {
                ok: true,
                draftKey: entry.draftKey,
                deleted: true,
                generation: marker[TOMBSTONE_FIELD],
                record,
            };
        });
        if (Object.keys(patch).length) await ext.storage.local.set(patch);
        return { ok: true, results };
    });

    const restoreMany = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        if (!isExtensionPage(sender) || !Array.isArray(message?.entries) || message.entries.length > LIMIT) {
            return { ok: false, error: { code: 'invalid-draft-restore-many' } };
        }
        const entries: { draftKey: string; generation: string; record: ReportDraftRecord }[] = [];
        for (const rawEntry of message.entries) {
            const item = rawEntry && typeof rawEntry === 'object' ? (rawEntry as Record<string, unknown>) : null;
            const draftKey = cleanDraftKey(item?.draftKey);
            const expectedGeneration = cleanGeneration(item?.generation);
            const rawRecord = item?.record;
            if (!draftKey || !expectedGeneration || !ReportDrafts.validRecord(rawRecord)) {
                return { ok: false, error: { code: 'invalid-draft-restore-many' } };
            }
            entries.push({ draftKey, generation: expectedGeneration, record: rawRecord });
        }
        const current = await ext.storage.local.get(entries.map(entry => entry.draftKey));
        const patch: Record<string, ReportDraftRecord> = {};
        const results = entries.map(entry => {
            const value = current[entry.draftKey];
            if (!isTombstone(value) || value[TOMBSTONE_FIELD] !== entry.generation) {
                return { ok: true, draftKey: entry.draftKey, restored: false, reason: 'changed' };
            }
            const record = structuredClone(entry.record);
            record[GENERATION_FIELD] = createGeneration();
            patch[entry.draftKey] = record;
            return { ok: true, draftKey: entry.draftKey, restored: true, record };
        });
        if (Object.keys(patch).length) await ext.storage.local.set(patch);
        return { ok: true, results };
    });

    const finalizeOne = async (entry: ReportDraftMessage, sender: ReportDraftSender): Promise<boolean> => {
        const draftKey = cleanDraftKey(entry?.draftKey);
        const expectedGeneration = cleanGeneration(entry?.generation);
        if (!draftKey || !expectedGeneration || !isExtensionPage(sender)) return false;
        const current = (await ext.storage.local.get(draftKey))[draftKey];
        if (!isTombstone(current) || current[TOMBSTONE_FIELD] !== expectedGeneration) return false;
        await retireKeys([draftKey]);
        return true;
    };
    const finalize = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => ({
        ok: true,
        finalized: await finalizeOne(message, sender),
    }));
    const finalizeMany = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        if (!isExtensionPage(sender) || !Array.isArray(message?.entries) || message.entries.length > LIMIT) {
            return { ok: false };
        }
        const entries: { draftKey: string; generation: string }[] = [];
        for (const rawEntry of message.entries) {
            const item = rawEntry && typeof rawEntry === 'object' ? (rawEntry as Record<string, unknown>) : null;
            const draftKey = cleanDraftKey(item?.draftKey);
            const expectedGeneration = cleanGeneration(item?.generation);
            if (!draftKey || !expectedGeneration) return { ok: false };
            entries.push({ draftKey, generation: expectedGeneration });
        }
        const current = await ext.storage.local.get(entries.map(entry => entry.draftKey));
        const finalized = entries.filter(entry => {
            const value = current[entry.draftKey];
            return isTombstone(value) && value[TOMBSTONE_FIELD] === entry.generation;
        }).map(entry => entry.draftKey);
        await retireKeys(finalized);
        return { ok: true, finalized };
    });

    const prune = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        if (!isPeakbaggerSender(sender) && !isExtensionPage(sender)) return { ok: false };
        const keepKey = message?.keepKey == null ? null : cleanDraftKey(message.keepKey);
        if (message?.keepKey != null && !keepKey) return { ok: false };
        const everything = await ext.storage.local.get(null);
        const drafts = Object.entries(everything || {})
            .filter((entry): entry is [string, ReportDraftRecord] =>
                Boolean(cleanDraftKey(entry[0])) && ReportDrafts.validRecord(entry[1]));
        const expired = drafts.filter(([, value]) => now() - value.savedAt > ReportDrafts.TTL_MS);
        const fresh = drafts.filter(([, value]) => now() - value.savedAt <= ReportDrafts.TTL_MS)
            .sort((a, b) => b[1].savedAt - a[1].savedAt);
        const markers = Object.entries(everything || {})
            .filter((entry): entry is [string, DraftTombstone] =>
                Boolean(cleanDraftKey(entry[0])) && isTombstone(entry[1]))
            .sort((a, b) => b[1].deletedAt - a[1].deletedAt);
        const retiredMarkers = markers.filter(([, value], index) => now() - value.deletedAt > ReportDrafts.TTL_MS
            || (index >= TOMBSTONE_LIMIT && now() - value.deletedAt > UNDO_PROTECTION_MS));
        const doomed = [...expired, ...fresh.slice(ReportDrafts.LIMIT), ...retiredMarkers]
            .map(([key]) => key)
            .filter(key => key !== keepKey);
        await retireKeys(doomed);
        return { ok: true, removed: doomed };
    });

    const pending = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        const identity = cleanIdentity(message?.identity);
        const fromUrl = senderIdentity(sender);
        const sourceTabId = sender?.tab?.id;
        const draftKey = typeof message?.draftKey === 'string' ? message.draftKey : '';
        const attemptId = cleanAttemptId(message?.attemptId);
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sourceTabId)
            || !identity || !attemptId || !sameIdentity(identity, fromUrl)
            || ReportDrafts.keyFor(identity) !== draftKey) {
            return { ok: false, error: { code: 'invalid-pending-save' } };
        }
        const tabId = sourceTabId as number;
        const requestedAt = now();
        const generation = `${requestedAt}:${++nextGeneration}`;
        await mutateMap(PENDING_KEY, saves => {
            saves[tabId] = {
                sourceTabId: tabId,
                draftKey,
                identity,
                attemptId,
                generation,
                requestedAt,
                expiresAt: requestedAt + TTL_MS,
            };
            const ordered = Object.entries(saves)
                .sort((a, b) => b[1].requestedAt - a[1].requestedAt);
            for (const [key] of ordered.slice(LIMIT)) delete saves[key];
        });
        return { ok: true, generation };
    });

    const confirmed = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        const sourceTabId = sender?.tab?.id;
        const fromUrl = senderIdentity(sender);
        const aid = cleanDigits(message?.aid, { positive: true });
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sourceTabId) || !fromUrl || !aid) {
            return { ok: false, error: { code: 'invalid-save-confirmation' } };
        }
        const tabId = sourceTabId as number;
        const confirmedBox: { save: PendingDraftSave | null } = { save: null };
        await mutateMap(PENDING_KEY, saves => {
            const candidate = saves[tabId];
            if (!candidate || candidate.expiresAt <= now()) return;
            const expected = candidate.identity;
            const identityMatches = expected.aid
                ? fromUrl.aid === expected.aid && aid === expected.aid
                : !fromUrl.aid && fromUrl.pid === expected.pid && fromUrl.cid === expected.cid;
            if (!identityMatches) return;
            confirmedBox.save = candidate;
        });
        const confirmedSave = confirmedBox.save;
        if (!confirmedSave) {
            return { ok: false, error: { code: 'save-confirmation-mismatch' } };
        }
        const current = (await ext.storage.local.get(confirmedSave.draftKey))[confirmedSave.draftKey];
        const pendingSave = current && typeof current === 'object'
            ? (current as { pendingSave?: { attemptId?: unknown } }).pendingSave
            : undefined;
        const currentAttemptId = cleanAttemptId(pendingSave?.attemptId);
        const removed = !current || currentAttemptId === confirmedSave.attemptId;
        if (current && removed) await retireKeys([confirmedSave.draftKey]);
        await mutateMap(PENDING_KEY, saves => {
            if (saves[tabId]?.generation === confirmedSave.generation) delete saves[tabId];
        });
        return { ok: true, draftKey: confirmedSave.draftKey, removed };
    });

    const cancel = (message: ReportDraftMessage, sender: ReportDraftSender) => serialize(async () => {
        const sourceTabId = sender?.tab?.id;
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sourceTabId)) return { ok: false };
        const tabId = sourceTabId as number;
        await mutateMap(PENDING_KEY, saves => {
            if (!message?.draftKey || saves[tabId]?.draftKey === message.draftKey) {
                delete saves[tabId];
            }
        });
        return { ok: true };
    });

    const cleanup = (cutoff: number) => serialize(() => mutateMap(PENDING_KEY, saves => {
        for (const [tabId, save] of Object.entries(saves)) {
            if (!save || save.expiresAt <= cutoff) delete saves[tabId];
        }
    }));

    const forgetTab = (tabId: number) => serialize(() => mutateMap(PENDING_KEY, saves => {
        delete saves[tabId];
    }));

    return {
        handlers: {
            REPORT_DRAFT_WRITE: write,
            REPORT_DRAFT_REMOVE: remove,
            REPORT_DRAFT_DELETE: deleteDraft,
            REPORT_DRAFT_RESTORE: restore,
            REPORT_DRAFT_DELETE_MANY: deleteMany,
            REPORT_DRAFT_RESTORE_MANY: restoreMany,
            REPORT_DRAFT_FINALIZE_DELETE: finalize,
            REPORT_DRAFT_FINALIZE_DELETE_MANY: finalizeMany,
            REPORT_DRAFT_PRUNE: prune,
            REPORT_DRAFT_SAVE_PENDING: pending,
            REPORT_DRAFT_SAVE_CONFIRMED: confirmed,
            REPORT_DRAFT_SAVE_CANCEL: cancel,
        },
        isHandler: (type: string): type is ReportDraftHandlerType => HANDLER_TYPES.has(type),
        cleanup,
        forgetTab,
    };
};

export const reportDraftRoutes = {
    PENDING_KEY,
    TTL_MS,
    LIMIT,
    GENERATION_FIELD,
    createReportDraftRoutes,
};
