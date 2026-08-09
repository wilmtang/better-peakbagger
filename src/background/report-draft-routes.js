// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Worker-owned confirmation boundary for local trip-report drafts.

import { reportDrafts as ReportDrafts } from '../reports/report-drafts.js';

const PENDING_KEY = 'bpbPendingReportDraftSaves';
const TTL_MS = 30 * 60 * 1000;
const LIMIT = 30;
const HANDLER_TYPES = new Set([
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

const cleanDigits = (value, { signed = false, positive = false } = {}) => {
    const text = String(value ?? '');
    const pattern = signed ? /^-?\d+$/ : /^\d+$/;
    if (!pattern.test(text)) return null;
    const number = Number(text);
    if (!Number.isSafeInteger(number) || (positive && number <= 0)) return null;
    return String(number);
};

const cleanIdentity = value => {
    const cid = cleanDigits(value?.cid) || '0';
    const aid = value?.aid == null || value.aid === ''
        ? null
        : cleanDigits(value.aid, { positive: true });
    const pid = value?.pid == null || value.pid === ''
        ? null
        : cleanDigits(value.pid, { signed: true });
    if ((value?.aid != null && value.aid !== '' && !aid)
        || (value?.pid != null && value.pid !== '' && !pid)
        || (aid && pid)) return null;
    return { cid, aid, pid };
};

const senderIdentity = sender => {
    try {
        const url = new URL(sender.url);
        if (!/\/climber\/ascentedit\.aspx$/i.test(url.pathname)) return null;
        return cleanIdentity({
            cid: url.searchParams.get('cid'),
            aid: url.searchParams.get('aid'),
            pid: url.searchParams.get('pid'),
        });
    } catch { return null; }
};

const sameIdentity = (left, right) => !!left && !!right
    && left.cid === right.cid && left.aid === right.aid && left.pid === right.pid;
const cleanAttemptId = value => typeof value === 'string'
    && /^[a-zA-Z0-9:_-]{1,100}$/.test(value) ? value : null;

const GENERATION_FIELD = ReportDrafts.GENERATION_FIELD;
const TOMBSTONE_FIELD = 'deletedGeneration';
const cleanDraftKey = value => typeof value === 'string' && ReportDrafts.parseKey(value)
    ? value : null;
const cleanGeneration = value => typeof value === 'string'
    && /^\d+:[1-9]\d*:[a-zA-Z0-9_-]{8,100}$/.test(value) ? value : null;
const isTombstone = value => !!value && typeof value === 'object'
    && cleanGeneration(value[TOMBSTONE_FIELD]) && Number.isFinite(value.deletedAt);
const expectedRecordMatches = (current, expectedGeneration, expectedSavedAt) => {
    if (!ReportDrafts.validRecord(current) || current.savedAt !== expectedSavedAt) return false;
    const currentGeneration = cleanGeneration(current[GENERATION_FIELD]);
    return expectedGeneration == null ? !currentGeneration : currentGeneration === expectedGeneration;
};

export const createReportDraftRoutes = ({ ext, now, isPeakbaggerSender, isExtensionPage, mutateMap }) => {
    if (!ext?.storage?.local || typeof now !== 'function'
        || typeof isPeakbaggerSender !== 'function' || typeof isExtensionPage !== 'function'
        || typeof mutateMap !== 'function') {
        throw new TypeError('report draft routes require storage, sender validation, and map mutation');
    }

    let nextGeneration = 0;
    let routeQueue = Promise.resolve();
    const serialize = operation => {
        const result = routeQueue.then(operation);
        routeQueue = result.catch(() => {});
        return result;
    };

    const createGeneration = () => {
        nextGeneration++;
        let nonce;
        try { nonce = globalThis.crypto.randomUUID(); }
        catch (error) { nonce = `fallback-${nextGeneration}-${Math.random().toString(36).slice(2)}`; }
        return `${now()}:${nextGeneration}:${nonce}`;
    };
    const exactEditorKey = (draftKey, sender) => isPeakbaggerSender(sender)
        && sameIdentity(senderIdentity(sender), cleanIdentity({
            cid: ReportDrafts.parseKey(draftKey)?.cid,
            aid: ReportDrafts.parseKey(draftKey)?.kind === 'ascent'
                ? ReportDrafts.parseKey(draftKey)?.id : null,
            pid: ReportDrafts.parseKey(draftKey)?.kind === 'peak'
                ? ReportDrafts.parseKey(draftKey)?.id : null,
        }));
    const mutationSender = (sender, draftKey) => isExtensionPage(sender)
        || exactEditorKey(draftKey, sender);
    const tombstone = () => ({
        [TOMBSTONE_FIELD]: createGeneration(),
        deletedAt: now(),
    });

    const write = (message, sender) => serialize(async () => {
        const draftKey = cleanDraftKey(message?.draftKey);
        if (!draftKey || !exactEditorKey(draftKey, sender) || !ReportDrafts.validRecord(message?.record)) {
            return { ok: false, error: { code: 'invalid-draft-write' } };
        }
        const current = (await ext.storage.local.get(draftKey))[draftKey];
        if ((ReportDrafts.validRecord(current) && current.savedAt > message.record.savedAt)
            || (isTombstone(current) && current.deletedAt >= message.record.savedAt)) {
            return { ok: true, draftKey, written: false, reason: 'superseded' };
        }
        const record = structuredClone(message.record);
        record[GENERATION_FIELD] = createGeneration();
        await ext.storage.local.set({ [draftKey]: record });
        return { ok: true, draftKey, written: true, record };
    });

    const removeOne = async (draftKey, sender) => {
        if (!draftKey || !mutationSender(sender, draftKey)) {
            return { ok: false, error: { code: 'invalid-draft-remove' } };
        }
        const marker = tombstone();
        await ext.storage.local.set({ [draftKey]: marker });
        return { ok: true, draftKey, generation: marker[TOMBSTONE_FIELD] };
    };
    const remove = (message, sender) => serialize(() => removeOne(cleanDraftKey(message?.draftKey), sender));

    const deleteOne = async (entry, sender) => {
        const draftKey = cleanDraftKey(entry?.draftKey);
        const expectedGeneration = entry?.expectedGeneration == null
            ? null : cleanGeneration(entry.expectedGeneration);
        const expectedSavedAt = entry?.expectedSavedAt;
        if (!draftKey || !isExtensionPage(sender) || !Number.isFinite(expectedSavedAt)
            || (entry?.expectedGeneration != null && !expectedGeneration)) {
            return { ok: false, error: { code: 'invalid-draft-delete' } };
        }
        const current = (await ext.storage.local.get(draftKey))[draftKey];
        if (!expectedRecordMatches(current, expectedGeneration, expectedSavedAt)) {
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
    const deleteDraft = (message, sender) => serialize(() => deleteOne(message, sender));

    const restoreOne = async (entry, sender) => {
        const draftKey = cleanDraftKey(entry?.draftKey);
        const expectedGeneration = cleanGeneration(entry?.generation);
        if (!draftKey || !expectedGeneration || !isExtensionPage(sender)
            || !ReportDrafts.validRecord(entry?.record)) {
            return { ok: false, error: { code: 'invalid-draft-restore' } };
        }
        const current = (await ext.storage.local.get(draftKey))[draftKey];
        if (!isTombstone(current) || current[TOMBSTONE_FIELD] !== expectedGeneration) {
            return { ok: true, draftKey, restored: false, reason: 'changed' };
        }
        const record = structuredClone(entry.record);
        record[GENERATION_FIELD] = createGeneration();
        await ext.storage.local.set({ [draftKey]: record });
        return { ok: true, draftKey, restored: true, record };
    };
    const restore = (message, sender) => serialize(() => restoreOne(message, sender));

    const deleteMany = (message, sender) => serialize(async () => {
        if (!isExtensionPage(sender) || !Array.isArray(message?.entries) || message.entries.length > LIMIT) {
            return { ok: false, error: { code: 'invalid-draft-delete-many' } };
        }
        const entries = message.entries.map(entry => ({
            draftKey: cleanDraftKey(entry?.draftKey),
            expectedGeneration: entry?.expectedGeneration == null
                ? null : cleanGeneration(entry.expectedGeneration),
            expectedSavedAt: entry?.expectedSavedAt,
            hadGeneration: entry?.expectedGeneration != null,
        }));
        if (entries.some(entry => !entry.draftKey || !Number.isFinite(entry.expectedSavedAt)
            || (entry.hadGeneration && !entry.expectedGeneration))) {
            return { ok: false, error: { code: 'invalid-draft-delete-many' } };
        }
        const current = await ext.storage.local.get(entries.map(entry => entry.draftKey));
        const patch = {};
        const results = entries.map(entry => {
            const record = current[entry.draftKey];
            if (!expectedRecordMatches(record, entry.expectedGeneration, entry.expectedSavedAt)) {
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

    const restoreMany = (message, sender) => serialize(async () => {
        if (!isExtensionPage(sender) || !Array.isArray(message?.entries) || message.entries.length > LIMIT) {
            return { ok: false, error: { code: 'invalid-draft-restore-many' } };
        }
        const entries = message.entries.map(entry => ({
            draftKey: cleanDraftKey(entry?.draftKey),
            generation: cleanGeneration(entry?.generation),
            record: entry?.record,
        }));
        if (entries.some(entry => !entry.draftKey || !entry.generation
            || !ReportDrafts.validRecord(entry.record))) {
            return { ok: false, error: { code: 'invalid-draft-restore-many' } };
        }
        const current = await ext.storage.local.get(entries.map(entry => entry.draftKey));
        const patch = {};
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

    const finalizeOne = async (entry, sender) => {
        const draftKey = cleanDraftKey(entry?.draftKey);
        const expectedGeneration = cleanGeneration(entry?.generation);
        if (!draftKey || !expectedGeneration || !isExtensionPage(sender)) return false;
        const current = (await ext.storage.local.get(draftKey))[draftKey];
        if (!isTombstone(current) || current[TOMBSTONE_FIELD] !== expectedGeneration) return false;
        await ext.storage.local.remove(draftKey);
        return true;
    };
    const finalize = (message, sender) => serialize(async () => ({
        ok: true,
        finalized: await finalizeOne(message, sender),
    }));
    const finalizeMany = (message, sender) => serialize(async () => {
        if (!isExtensionPage(sender) || !Array.isArray(message?.entries) || message.entries.length > LIMIT) {
            return { ok: false };
        }
        const entries = message.entries.map(entry => ({
            draftKey: cleanDraftKey(entry?.draftKey),
            generation: cleanGeneration(entry?.generation),
        }));
        if (entries.some(entry => !entry.draftKey || !entry.generation)) return { ok: false };
        const current = await ext.storage.local.get(entries.map(entry => entry.draftKey));
        const finalized = entries.filter(entry => isTombstone(current[entry.draftKey])
            && current[entry.draftKey][TOMBSTONE_FIELD] === entry.generation)
            .map(entry => entry.draftKey);
        if (finalized.length) await ext.storage.local.remove(finalized);
        return { ok: true, finalized };
    });

    const prune = (message, sender) => serialize(async () => {
        if (!isPeakbaggerSender(sender) && !isExtensionPage(sender)) return { ok: false };
        const keepKey = message?.keepKey == null ? null : cleanDraftKey(message.keepKey);
        if (message?.keepKey != null && !keepKey) return { ok: false };
        const everything = await ext.storage.local.get(null);
        const drafts = Object.entries(everything || {})
            .filter(([key, value]) => cleanDraftKey(key) && ReportDrafts.validRecord(value));
        const expired = drafts.filter(([, value]) => now() - value.savedAt > ReportDrafts.TTL_MS);
        const fresh = drafts.filter(([, value]) => now() - value.savedAt <= ReportDrafts.TTL_MS)
            .sort((a, b) => b[1].savedAt - a[1].savedAt);
        const doomed = [...expired, ...fresh.slice(ReportDrafts.LIMIT)]
            .map(([key]) => key)
            .filter(key => key !== keepKey);
        if (doomed.length) await ext.storage.local.remove(doomed);
        return { ok: true, removed: doomed };
    });

    const pending = (message, sender) => serialize(async () => {
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
        const requestedAt = now();
        const generation = `${requestedAt}:${++nextGeneration}`;
        await mutateMap(PENDING_KEY, saves => {
            saves[sourceTabId] = {
                sourceTabId,
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

    const confirmed = (message, sender) => serialize(async () => {
        const sourceTabId = sender?.tab?.id;
        const fromUrl = senderIdentity(sender);
        const aid = cleanDigits(message?.aid, { positive: true });
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sourceTabId) || !fromUrl || !aid) {
            return { ok: false, error: { code: 'invalid-save-confirmation' } };
        }
        let confirmedSave = null;
        await mutateMap(PENDING_KEY, saves => {
            const candidate = saves[sourceTabId];
            if (!candidate || candidate.expiresAt <= now()) return;
            const expected = candidate.identity;
            const identityMatches = expected.aid
                ? fromUrl.aid === expected.aid && aid === expected.aid
                : !fromUrl.aid && fromUrl.pid === expected.pid && fromUrl.cid === expected.cid;
            if (!identityMatches) return;
            confirmedSave = candidate;
        });
        if (!confirmedSave) {
            return { ok: false, error: { code: 'save-confirmation-mismatch' } };
        }
        const current = (await ext.storage.local.get(confirmedSave.draftKey))[confirmedSave.draftKey];
        const currentAttemptId = cleanAttemptId(current?.pendingSave?.attemptId);
        const removed = !current || currentAttemptId === confirmedSave.attemptId;
        if (current && removed) await ext.storage.local.remove(confirmedSave.draftKey);
        await mutateMap(PENDING_KEY, saves => {
            if (saves[sourceTabId]?.generation === confirmedSave.generation) delete saves[sourceTabId];
        });
        return { ok: true, draftKey: confirmedSave.draftKey, removed };
    });

    const cancel = (message, sender) => serialize(async () => {
        const sourceTabId = sender?.tab?.id;
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sourceTabId)) return { ok: false };
        await mutateMap(PENDING_KEY, saves => {
            if (!message?.draftKey || saves[sourceTabId]?.draftKey === message.draftKey) {
                delete saves[sourceTabId];
            }
        });
        return { ok: true };
    });

    const cleanup = cutoff => serialize(() => mutateMap(PENDING_KEY, saves => {
        for (const [tabId, save] of Object.entries(saves)) {
            if (!save || save.expiresAt <= cutoff) delete saves[tabId];
        }
    }));

    const forgetTab = tabId => serialize(() => mutateMap(PENDING_KEY, saves => {
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
        isHandler: type => HANDLER_TYPES.has(type),
        cleanup,
        forgetTab,
    };
};

export const reportDraftRoutes = {
    PENDING_KEY,
    TTL_MS,
    LIMIT,
    GENERATION_FIELD,
    TOMBSTONE_FIELD,
    cleanIdentity,
    cleanAttemptId,
    createReportDraftRoutes,
};
