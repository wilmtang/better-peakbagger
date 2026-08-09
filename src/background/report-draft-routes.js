// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Worker-owned confirmation boundary for local trip-report drafts.

import { reportDrafts as ReportDrafts } from '../reports/report-drafts.js';

const PENDING_KEY = 'bpbPendingReportDraftSaves';
const TTL_MS = 30 * 60 * 1000;
const LIMIT = 30;
const HANDLER_TYPES = new Set([
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

export const createReportDraftRoutes = ({ ext, now, isPeakbaggerSender, mutateMap }) => {
    if (!ext?.storage?.local || typeof now !== 'function'
        || typeof isPeakbaggerSender !== 'function' || typeof mutateMap !== 'function') {
        throw new TypeError('report draft routes require storage, sender validation, and map mutation');
    }

    let nextGeneration = 0;
    let routeQueue = Promise.resolve();
    const serialize = operation => {
        const result = routeQueue.then(operation);
        routeQueue = result.catch(() => {});
        return result;
    };

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
    cleanIdentity,
    cleanAttemptId,
    createReportDraftRoutes,
};
