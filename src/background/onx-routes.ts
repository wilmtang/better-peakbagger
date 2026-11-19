// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    MAX_ONX_GPX_BYTES,
    ONX_IMPORT_URL,
    ONX_PERMISSION,
    ONX_EXPORT_BUDGET_MS,
    ONX_ATTEMPTS_KEY,
    probeOnxImporter,
    prepareOnxImport,
    type OnxProbeResult,
} from '../onx/onx-import.ts';
import { ascentIdentity } from '../gpx/saved-gpx-source.ts';
import { createGpxHandoffRoutes, type GpxHandoffTrustedActions } from './gpx-handoff-routes.ts';
import { requestDeadline as Deadline } from '../net/request-deadline.ts';

export type OnxAttemptState =
    | 'opening'
    | 'preflight'
    | 'dispatching'
    | 'prepared'
    | 'attention'
    | 'not-supplied'
    | 'uncertain';

export interface OnxOutcome {
    ok: boolean;
    supplied: boolean;
    code: string;
    message: string;
}

export interface OnxAttemptResult extends OnxOutcome {
    attemptId: string;
    targetTabId: number | null;
    canContinue: boolean;
}

export interface OnxAttemptRecord {
    id: string;
    sourceTabId: number;
    sourceDocumentId: string | null;
    sourceUrl: string;
    expiresAt: number;
    state: OnxAttemptState;
    targetTabId: number | null;
    documentNonce?: string;
    targetDocumentId?: string | null;
    result?: OnxAttemptResult;
}

export interface OnxTrustedActions extends GpxHandoffTrustedActions {
    consumeCapability(
        message: Record<string, unknown>,
        sender: chrome.runtime.MessageSender,
        action: string,
    ): boolean | Promise<boolean>;
}

export interface OnxRouteOptions {
    ext: typeof chrome;
    isPeakbaggerSender: (sender: chrome.runtime.MessageSender) => boolean;
    trustedActions: OnxTrustedActions;
    action: string;
    now?: () => number;
}

export interface OnxPrepareResult extends OnxOutcome {
    attemptId?: string;
    targetTabId?: number | null;
    canContinue?: boolean;
}

export type OnxStatusResult =
    | OnxAttemptResult
    | { ok: false; supplied: true; code: string; message: string; attemptId: string }
    | { ok: false; code: 'unknown-attempt' }
    | { ok: true; code: 'pending'; phase: OnxAttemptState; attemptId: string; targetTabId: number | null };

export type OnxCancelResult =
    | OnxAttemptResult
    | { ok: false; supplied: true; code: string; message: string; attemptId: string }
    | { ok: false };

export interface OnxOpenResult {
    ok: boolean;
}

type OnxAttemptMap = Record<string, OnxAttemptRecord>;

const terminal = new Set<OnxAttemptState>(['prepared', 'attention', 'not-supplied', 'uncertain']);
const importer = (tab: chrome.tabs.Tab | null | undefined): boolean => {
    try {
        const url = new URL(tab?.url ?? '');
        return url.origin === 'https://backcountry.onxmaps.com'
            && url.pathname.toLowerCase() === '/backcountry/map/content/import';
    } catch { return false; }
};
const attention = {
    ok: false,
    supplied: false,
    code: 'needs-attention',
    message: 'Open onX and sign in if prompted, then continue the export.',
} as const satisfies OnxOutcome;
const uncertain = {
    ok: false,
    supplied: true,
    code: 'handoff-unconfirmed',
    message: 'Check onX before sending again. The file may already be there.',
} as const satisfies OnxOutcome;

export function createOnxRoutes({ ext, isPeakbaggerSender, trustedActions, action, now = () => Date.now() }: OnxRouteOptions) {
    // Reuse only the optional-permission entry point. Other providers retain
    // their existing navigation policy; the bounded onX transaction lives here.
    const permission = createGpxHandoffRoutes({
        ext,
        isPeakbaggerSender,
        trustedActions,
        action,
        provider: {
            name: 'onX',
            buttonLabel: 'Send to onX',
            permission: ONX_PERMISSION,
            accessPage: 'onx/access.html',
            permissionType: 'ONX_PERMISSION_REQUEST',
        },
    });
    let queue: Promise<unknown> = Promise.resolve();
    const cancelled = new Set<string>();
    const mutate = <T>(fn: (records: OnxAttemptMap) => T): Promise<T> => {
        const next = queue.then(async () => {
            if (!ext.storage?.session) throw new Error('Session storage unavailable.');
            const stored = await ext.storage.session.get(ONX_ATTEMPTS_KEY);
            const records = (stored[ONX_ATTEMPTS_KEY] as OnxAttemptMap | undefined) || {};
            const value = fn(records);
            await ext.storage.session.set({ [ONX_ATTEMPTS_KEY]: records });
            return value;
        });
        queue = next.catch(() => {});
        return next;
    };
    const owns = (
        record: OnxAttemptRecord | null | undefined,
        sender: chrome.runtime.MessageSender | null | undefined,
    ): record is OnxAttemptRecord => !!record && !!sender && isPeakbaggerSender(sender)
        && record.sourceTabId === sender.tab?.id && record.sourceUrl === sender.url
        && (!record.sourceDocumentId || record.sourceDocumentId === sender.documentId);
    const read = async (
        id: unknown,
        sender: chrome.runtime.MessageSender | null | undefined,
    ): Promise<OnxAttemptRecord | null> => {
        await queue;
        if (typeof id !== 'string' || !id) return null;
        if (!ext.storage?.session) throw new Error('Session storage unavailable.');
        const stored = await ext.storage.session.get(ONX_ATTEMPTS_KEY);
        const records = (stored[ONX_ATTEMPTS_KEY] as OnxAttemptMap | undefined) || {};
        return owns(records[id], sender) ? { ...records[id] } : null;
    };
    const finish = (id: string, outcome: OnxOutcome, acknowledged = false): Promise<OnxAttemptResult | null> => mutate(records => {
        const record = records[id];
        if (!record) return null;
        if (!terminal.has(record.state)) {
            if (record.state === 'dispatching' && !acknowledged) outcome = uncertain;
            record.state = outcome.ok ? 'prepared' : outcome.supplied ? 'uncertain'
                : outcome.code === 'needs-attention' ? 'attention' : 'not-supplied';
            record.result = {
                ...outcome,
                attemptId: id,
                targetTabId: record.targetTabId,
                canContinue: !outcome.supplied && !!record.targetTabId && outcome.code !== 'existing-preview',
            };
        }
        return record.result ?? null;
    });
    const cutoff = async (
        id: string,
        sender: chrome.runtime.MessageSender,
    ): Promise<OnxAttemptResult | { ok: false; supplied: true; code: string; message: string; attemptId: string }> => {
        const record = await read(id, sender);
        if (!record) return { ...uncertain, attemptId: id };
        if (terminal.has(record.state)) return record.result ?? { ...uncertain, attemptId: id };
        return await finish(id, attention) ?? { ...uncertain, attemptId: id };
    };
    const status = async (
        message: Record<string, unknown>,
        sender: chrome.runtime.MessageSender,
    ): Promise<OnxStatusResult> => {
        const record = await read(message.attemptId, sender);
        if (!record) return { ok: false, code: 'unknown-attempt' };
        if (terminal.has(record.state)) return record.result ?? { ...uncertain, attemptId: record.id };
        if (record.expiresAt <= now()) return cutoff(record.id, sender);
        return {
            ok: true,
            code: 'pending',
            phase: record.state,
            attemptId: record.id,
            targetTabId: record.targetTabId,
        };
    };
    const prepare = async (
        message: Record<string, unknown>,
        sender: chrome.runtime.MessageSender,
    ): Promise<OnxPrepareResult> => {
        const identity = ascentIdentity(sender?.url);
        const sourceTab = sender?.tab;
        const sourceTabId = sourceTab?.id;
        const attemptId = typeof message.attemptId === 'string' ? message.attemptId : '';
        const filename = typeof message.filename === 'string' ? message.filename : '';
        const gpx = typeof message.gpx === 'string' ? message.gpx : null;
        const messageExpiresAt = typeof message.expiresAt === 'number' ? message.expiresAt : NaN;
        if (!sender || !isPeakbaggerSender(sender) || !sourceTab || typeof sourceTabId !== 'number'
            || !Number.isInteger(sourceTabId) || !identity || identity.url !== message.sourceUrl
            || filename !== `peakbagger-${identity.id}.gpx`
            || gpx === null || new Blob([gpx]).size > MAX_ONX_GPX_BYTES
            || !/^[a-zA-Z0-9-]{8,80}$/.test(attemptId)
            || !Number.isFinite(messageExpiresAt) || messageExpiresAt <= now()) {
            return { ok: false, supplied: false, code: 'forbidden', message: 'Reload this saved ascent and try again.' };
        }
        const id = attemptId;
        // Reserve a small reply margin inside the single UI budget. No stage
        // gets a new timeout, and caller input can never extend the cutoff.
        const expiresAt = Math.min(messageExpiresAt - 100, now() + ONX_EXPORT_BUDGET_MS - 100);
        let reserved = false;
        const deadline = Deadline.createRequestDeadline(Math.max(1, expiresAt - now()));
        const check = (): void => {
            if (deadline.expired || now() >= expiresAt || cancelled.has(id)) throw new Error('expired');
        };
        const step = async <T>(promise: Promise<T>): Promise<T> => {
            const value = await deadline.run(promise);
            check();
            return value;
        };
        const update = (patch: Partial<OnxAttemptRecord>): Promise<void> => mutate(records => {
            const record = records[id];
            if (!record || terminal.has(record.state) || cancelled.has(id) || now() >= expiresAt) throw new Error('expired');
            Object.assign(record, patch);
        });
        try {
            if (!await step(Promise.resolve(trustedActions.consumeGrant(message, sender, action, { oneUse: true })))) {
                return { ok: false, supplied: false, code: 'activation-required', message: 'Click Send to onX again.' };
            }
            if (!await step(ext.permissions.contains(ONX_PERMISSION))) {
                return { ok: false, supplied: false, code: 'permission-required', message: 'onX access was not granted.' };
            }
            type Reservation =
                | { result: OnxPrepareResult; previousTabId?: undefined }
                | { result?: undefined; previousTabId: number | null | undefined };
            const reservation = await step<Reservation>(mutate(records => {
                if (records[id]) return { result: owns(records[id], sender) ? records[id].result || uncertain : uncertain };
                if (Object.values(records).some(record => record.sourceTabId === sourceTabId
                    && record.expiresAt > now() && !terminal.has(record.state))) {
                    return {
                        result: {
                            ok: false,
                            supplied: false,
                            code: 'already-running',
                            message: 'An onX transfer is already running.',
                        },
                    };
                }
                const hasResumeAttemptId = Boolean(message.resumeAttemptId);
                const resumeAttemptId = typeof message.resumeAttemptId === 'string' ? message.resumeAttemptId : '';
                const previous = hasResumeAttemptId && resumeAttemptId ? records[resumeAttemptId] : null;
                if (hasResumeAttemptId && (!owns(previous, sender) || !previous.result?.canContinue)) {
                    return { result: { ...uncertain, code: 'recovery-unavailable' } };
                }
                // Bounded metadata only; eviction never creates continuation authority.
                const keys = Object.keys(records).sort((a, b) => records[a].expiresAt - records[b].expiresAt);
                for (const key of keys) {
                    if (Object.keys(records).length < 64) break;
                    if (records[key].expiresAt <= now()) delete records[key];
                }
                if (Object.keys(records).length >= 64) throw new Error('Too many pending transfers.');
                records[id] = {
                    id,
                    sourceTabId,
                    sourceDocumentId: sender.documentId || null,
                    sourceUrl: sender.url ?? identity.url,
                    expiresAt,
                    state: 'opening',
                    targetTabId: null,
                };
                reserved = true;
                return { previousTabId: previous?.targetTabId };
            }));
            if (reservation.result) return reservation.result;
            let target: (chrome.tabs.Tab & { id: number }) | null = null;
            if (reservation.previousTabId) {
                const existingTarget = await step(ext.tabs.get(reservation.previousTabId).catch(() => null));
                if (existingTarget && typeof existingTarget.id === 'number') {
                    if (!importer(existingTarget)) {
                        // An unobservable page may be the identity service. Never
                        // navigate it. Continue only after the user completes login.
                        let allowed = false;
                        try { allowed = new URL(existingTarget.url ?? '').origin === 'https://backcountry.onxmaps.com'; } catch { /* unknown */ }
                        if (!allowed) {
                            await step(update({ targetTabId: existingTarget.id }));
                            return await step(finish(id, attention)) ?? { ...uncertain, attemptId: id };
                        }
                        // Explicit Continue opens a fresh importer; don't overwrite a map.
                    } else {
                        target = existingTarget as chrome.tabs.Tab & { id: number };
                    }
                }
            }
            if (!target) {
                const creating = ext.tabs.create({ url: ONX_IMPORT_URL, active: false, windowId: sourceTab.windowId });
                // tabs.create cannot be recalled. Remember a late-created tab
                // for inspection, without reviving the expired transaction.
                creating.then(created => mutate(records => {
                    const record = records[id];
                    if (record && !record.targetTabId && typeof created.id === 'number') {
                        record.targetTabId = created.id;
                        if (record.result) record.result.targetTabId = created.id;
                    }
                })).catch(() => {});
                const createdTab = await step(creating);
                if (typeof createdTab.id !== 'number' || !Number.isInteger(createdTab.id)) {
                    throw new Error('onX tab has no id.');
                }
                target = createdTab as chrome.tabs.Tab & { id: number };
            }
            await step(update({ targetTabId: target.id, state: 'preflight' }));
            let ready: { documentId?: string; documentNonce: string };
            while (true) {
                const tab = await step(ext.tabs.get(target.id));
                if (importer(tab)) {
                    let probe: chrome.scripting.InjectionResult<OnxProbeResult> | undefined;
                    try {
                        [probe] = await step(ext.scripting.executeScript({
                            target: { tabId: target.id },
                            injectImmediately: true,
                            func: probeOnxImporter,
                            args: [{ attemptId: id, expiresAt }],
                        }));
                    } catch {
                        // Navigation can win between tabs.get and injection.
                        // Retrying this GPX-free probe is safe; delivery below
                        // is always dispatched once and never retried.
                        check();
                    }
                    const value = probe?.result;
                    if (value?.attemptId === id && value.ok && value.documentNonce) {
                        ready = { documentId: probe?.documentId, documentNonce: value.documentNonce };
                        break;
                    }
                    if (value && !['not-ready', 'expired'].includes(value.code)) {
                        const membership = value.code === 'membership-required';
                        return await step(finish(id, {
                            ok: false,
                            supplied: false,
                            code: value.code,
                            message: membership ? 'onX import requires Premium or Elite membership.'
                                : 'Check onX’s importer before sending again.',
                        }, true)) ?? { ...uncertain, attemptId: id };
                    }
                }
                // Read-hidden redirects, loading and provisional blank documents
                // may silently return. Wait within this attempt, without GPX.
                await step(new Promise(resolve => setTimeout(resolve, Math.min(100, expiresAt - now()))));
            }
            const source = await step(ext.tabs.get(sourceTabId));
            if (source.url !== sender.url || !await step(ext.permissions.contains(ONX_PERMISSION))) throw new Error('Source changed.');
            // Persist before dispatch; suspension or lost acknowledgement must
            // never turn possible delivery into a new automatic attempt.
            await step(update({
                state: 'dispatching',
                documentNonce: ready.documentNonce,
                targetDocumentId: ready.documentId || null,
            }));
            check();
            const [injection] = await step(ext.scripting.executeScript({
                target: ready.documentId ? { tabId: target.id, documentIds: [ready.documentId] } : { tabId: target.id },
                injectImmediately: true,
                func: prepareOnxImport,
                args: [{
                    gpx,
                    filename,
                    attemptId: id,
                    documentNonce: ready.documentNonce,
                    expiresAt,
                }],
            }));
            const outcome = injection?.result;
            if (!outcome || outcome.attemptId !== id || outcome.documentNonce !== ready.documentNonce
                || typeof outcome.ok !== 'boolean' || typeof outcome.supplied !== 'boolean') throw new Error('Unconfirmed.');
            return await step(finish(id, {
                ok: outcome.ok,
                supplied: outcome.supplied,
                code: outcome.code,
                message: outcome.ok ? 'Ready in onX. Review the file and click Import.'
                    : outcome.supplied ? uncertain.message : 'onX’s importer is not ready. No GPX was sent.',
            }, true)) ?? { ...uncertain, attemptId: id };
        } catch {
            return reserved ? await cutoff(id, sender).catch(() => ({ ...uncertain, attemptId: id }))
                : { ok: false, supplied: false, code: 'setup-unavailable', message: 'The transfer could not start. Try again.' };
        } finally {
            deadline.clear();
            cancelled.delete(id);
        }
    };
    const cancel = async (
        message: Record<string, unknown>,
        sender: chrome.runtime.MessageSender,
    ): Promise<OnxCancelResult> => {
        const record = await read(message.attemptId, sender);
        if (!record) return { ok: false };
        cancelled.add(record.id);
        return cutoff(record.id, sender);
    };
    const open = async (
        message: Record<string, unknown>,
        sender: chrome.runtime.MessageSender,
    ): Promise<OnxOpenResult> => {
        if (!sender || !await trustedActions.consumeCapability(message, sender, action)) return { ok: false };
        const record = await read(message.attemptId, sender);
        if (!record?.targetTabId) return { ok: false };
        const tab = await ext.tabs.get(record.targetTabId);
        await ext.tabs.update(tab.id ?? record.targetTabId, { active: true });
        if (typeof tab.windowId === 'number' && Number.isInteger(tab.windowId)) {
            await ext.windows?.update(tab.windowId, { focused: true });
        }
        return { ok: true };
    };
    const forgetSource = (tabId: number): Promise<void> => mutate(records => {
        for (const record of Object.values(records)) {
            if (record.sourceTabId === tabId && !terminal.has(record.state)) {
                cancelled.add(record.id);
                const outcome = record.state === 'dispatching' ? uncertain : attention;
                record.state = outcome.supplied ? 'uncertain' : 'not-supplied';
                record.result = { ...outcome, attemptId: record.id, targetTabId: record.targetTabId, canContinue: false };
            }
        }
    });
    return {
        forgetSource,
        handlers: {
            ONX_PERMISSION_REQUEST: permission.handlers.ONX_PERMISSION_REQUEST,
            ONX_IMPORT_PREPARE: prepare,
            ONX_IMPORT_STATUS: status,
            ONX_IMPORT_CANCEL: cancel,
            ONX_IMPORT_OPEN: open,
        },
    };
}
