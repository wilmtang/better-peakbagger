// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MAX_ONX_GPX_BYTES, ONX_IMPORT_URL, ONX_PERMISSION, ONX_EXPORT_BUDGET_MS,
    ONX_ATTEMPTS_KEY, probeOnxImporter, prepareOnxImport } from '../onx/onx-import.js';
import { ascentIdentity } from '../gpx/saved-gpx-source.js';
import { createGpxHandoffRoutes } from './gpx-handoff-routes.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';

const terminal = new Set(['prepared', 'attention', 'not-supplied', 'uncertain']);
const importer = tab => {
    try {
        const url = new URL(tab?.url);
        return url.origin === 'https://backcountry.onxmaps.com'
            && url.pathname.toLowerCase() === '/backcountry/map/content/import';
    } catch { return false; }
};
const attention = { ok: false, supplied: false, code: 'needs-attention',
    message: 'Open onX and sign in if prompted, then continue the export.' };
const uncertain = { ok: false, supplied: true, code: 'handoff-unconfirmed',
    message: 'Check onX before sending again. The file may already be there.' };

export function createOnxRoutes({ ext, isPeakbaggerSender, trustedActions, action, now = () => Date.now() }) {
    // Reuse only the optional-permission entry point. Other providers retain
    // their existing navigation policy; the bounded onX transaction lives here.
    const permission = createGpxHandoffRoutes({ ext, isPeakbaggerSender, trustedActions, action,
        provider: { name: 'onX', buttonLabel: 'Send to onX', permission: ONX_PERMISSION,
            accessPage: 'onx/access.html', permissionType: 'ONX_PERMISSION_REQUEST' } });
    let queue = Promise.resolve();
    const cancelled = new Set();
    const mutate = fn => {
        const next = queue.then(async () => {
            if (!ext.storage?.session) throw new Error('Session storage unavailable.');
            const records = (await ext.storage.session.get(ONX_ATTEMPTS_KEY))[ONX_ATTEMPTS_KEY] || {};
            const value = fn(records);
            await ext.storage.session.set({ [ONX_ATTEMPTS_KEY]: records });
            return value;
        });
        queue = next.catch(() => {});
        return next;
    };
    const owns = (record, sender) => record && isPeakbaggerSender(sender)
        && record.sourceTabId === sender.tab?.id && record.sourceUrl === sender.url
        && (!record.sourceDocumentId || record.sourceDocumentId === sender.documentId);
    const read = async (id, sender) => {
        await queue;
        const records = (await ext.storage.session.get(ONX_ATTEMPTS_KEY))[ONX_ATTEMPTS_KEY] || {};
        return owns(records[id], sender) ? { ...records[id] } : null;
    };
    const finish = (id, outcome, acknowledged = false) => mutate(records => {
        const record = records[id];
        if (!record) return null;
        if (!terminal.has(record.state)) {
            if (record.state === 'dispatching' && !acknowledged) outcome = uncertain;
            record.state = outcome.ok ? 'prepared' : outcome.supplied ? 'uncertain'
                : outcome.code === 'needs-attention' ? 'attention' : 'not-supplied';
            record.result = { ...outcome, attemptId: id, targetTabId: record.targetTabId,
                canContinue: !outcome.supplied && !!record.targetTabId && outcome.code !== 'existing-preview' };
        }
        return record.result;
    });
    const cutoff = async (id, sender) => {
        const record = await read(id, sender);
        if (!record) return { ...uncertain, attemptId: id };
        return terminal.has(record.state) ? record.result : finish(id, attention);
    };
    const status = async (message, sender) => {
        const record = await read(message.attemptId, sender);
        if (!record) return { ok: false, code: 'unknown-attempt' };
        if (terminal.has(record.state)) return record.result;
        if (record.expiresAt <= now()) return cutoff(record.id, sender);
        return { ok: true, code: 'pending', phase: record.state,
            attemptId: record.id, targetTabId: record.targetTabId };
    };
    const prepare = async (message, sender) => {
        const identity = ascentIdentity(sender?.url);
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)
            || !identity || identity.url !== message.sourceUrl
            || message.filename !== `peakbagger-${identity.id}.gpx`
            || typeof message.gpx !== 'string' || new Blob([message.gpx]).size > MAX_ONX_GPX_BYTES
            || !/^[a-zA-Z0-9-]{8,80}$/.test(message.attemptId || '')
            || !Number.isFinite(message.expiresAt) || message.expiresAt <= now()) {
            return { ok: false, supplied: false, code: 'forbidden', message: 'Reload this saved ascent and try again.' };
        }
        const id = message.attemptId;
        // Reserve a small reply margin inside the single UI budget. No stage
        // gets a new timeout, and caller input can never extend the cutoff.
        const expiresAt = Math.min(message.expiresAt - 100, now() + ONX_EXPORT_BUDGET_MS - 100);
        let reserved = false;
        const deadline = Deadline.createRequestDeadline(Math.max(1, expiresAt - now()));
        const check = () => {
            if (deadline.expired || now() >= expiresAt || cancelled.has(id)) throw new Error('expired');
        };
        const step = async promise => { const value = await deadline.run(promise); check(); return value; };
        const update = patch => mutate(records => {
            const record = records[id];
            if (!record || terminal.has(record.state) || cancelled.has(id) || now() >= expiresAt) throw new Error('expired');
            Object.assign(record, patch);
        });
        try {
            if (!await step(trustedActions.consumeGrant(message, sender, action, { oneUse: true }))) {
                return { ok: false, supplied: false, code: 'activation-required', message: 'Click Send to onX again.' };
            }
            if (!await step(ext.permissions.contains(ONX_PERMISSION))) {
                return { ok: false, supplied: false, code: 'permission-required', message: 'onX access was not granted.' };
            }
            const reservation = await step(mutate(records => {
                if (records[id]) return { result: owns(records[id], sender) ? records[id].result || uncertain : uncertain };
                if (Object.values(records).some(record => record.sourceTabId === sender.tab.id
                    && record.expiresAt > now() && !terminal.has(record.state))) return { result: {
                    ok: false, supplied: false, code: 'already-running', message: 'An onX transfer is already running.' } };
                const previous = message.resumeAttemptId ? records[message.resumeAttemptId] : null;
                if (message.resumeAttemptId && (!owns(previous, sender) || !previous.result?.canContinue)) {
                    return { result: { ...uncertain, code: 'recovery-unavailable' } };
                }
                // Bounded metadata only; eviction never creates continuation authority.
                const keys = Object.keys(records).sort((a, b) => records[a].expiresAt - records[b].expiresAt);
                for (const key of keys) {
                    if (Object.keys(records).length < 64) break;
                    if (records[key].expiresAt <= now()) delete records[key];
                }
                if (Object.keys(records).length >= 64) throw new Error('Too many pending transfers.');
                records[id] = { id, sourceTabId: sender.tab.id, sourceDocumentId: sender.documentId || null,
                    sourceUrl: sender.url, expiresAt, state: 'opening', targetTabId: null };
                reserved = true;
                return { previousTabId: previous?.targetTabId };
            }));
            if (reservation.result) return reservation.result;
            let target;
            if (reservation.previousTabId) {
                target = await step(ext.tabs.get(reservation.previousTabId).catch(() => null));
                if (target && !importer(target)) {
                    // An unobservable page may be the identity service. Never
                    // navigate it. Continue only after the user completes login.
                    let allowed = false;
                    try { allowed = new URL(target.url).origin === 'https://backcountry.onxmaps.com'; } catch { /* unknown */ }
                    if (!allowed) {
                        await step(update({ targetTabId: target.id }));
                        return await step(finish(id, attention));
                    }
                    target = null; // Explicit Continue opens a fresh importer; don't overwrite a map.
                }
            }
            if (!target) {
                const creating = ext.tabs.create({ url: ONX_IMPORT_URL, active: false, windowId: sender.tab.windowId });
                // tabs.create cannot be recalled. Remember a late-created tab
                // for inspection, without reviving the expired transaction.
                creating.then(tab => mutate(records => {
                    const record = records[id];
                    if (record && !record.targetTabId) {
                        record.targetTabId = tab.id;
                        if (record.result) record.result.targetTabId = tab.id;
                    }
                })).catch(() => {});
                target = await step(creating);
            }
            await step(update({ targetTabId: target.id, state: 'preflight' }));
            let ready;
            while (true) {
                const tab = await step(ext.tabs.get(target.id));
                if (importer(tab)) {
                    let probe;
                    try {
                        [probe] = await step(ext.scripting.executeScript({ target: { tabId: target.id },
                            injectImmediately: true, func: probeOnxImporter, args: [{ attemptId: id, expiresAt }] }));
                    } catch {
                        // Navigation can win between tabs.get and injection.
                        // Retrying this GPX-free probe is safe; delivery below
                        // is always dispatched once and never retried.
                        check();
                    }
                    const value = probe?.result;
                    if (value?.attemptId === id && value.ok && value.documentNonce) { ready = probe; break; }
                    if (value && !['not-ready', 'expired'].includes(value.code)) {
                        const membership = value.code === 'membership-required';
                        return await step(finish(id, { ok: false, supplied: false, code: value.code,
                            message: membership ? 'onX import requires Premium or Elite membership.'
                                : 'Check onX’s importer before sending again.' }, true));
                    }
                }
                // Read-hidden redirects, loading and provisional blank documents
                // may silently return. Wait within this attempt, without GPX.
                await step(new Promise(resolve => setTimeout(resolve, Math.min(100, expiresAt - now()))));
            }
            const source = await step(ext.tabs.get(sender.tab.id));
            if (source.url !== sender.url || !await step(ext.permissions.contains(ONX_PERMISSION))) throw new Error('Source changed.');
            // Persist before dispatch; suspension or lost acknowledgement must
            // never turn possible delivery into a new automatic attempt.
            await step(update({ state: 'dispatching', documentNonce: ready.result.documentNonce,
                targetDocumentId: ready.documentId || null }));
            check();
            const [injection] = await step(ext.scripting.executeScript({
                target: ready.documentId ? { tabId: target.id, documentIds: [ready.documentId] } : { tabId: target.id },
                injectImmediately: true, func: prepareOnxImport,
                args: [{ gpx: message.gpx, filename: message.filename, attemptId: id,
                    documentNonce: ready.result.documentNonce, expiresAt }],
            }));
            const outcome = injection?.result;
            if (!outcome || outcome.attemptId !== id || outcome.documentNonce !== ready.result.documentNonce
                || typeof outcome.ok !== 'boolean' || typeof outcome.supplied !== 'boolean') throw new Error('Unconfirmed.');
            return await step(finish(id, { ok: outcome.ok, supplied: outcome.supplied, code: outcome.code,
                message: outcome.ok ? 'Ready in onX. Review the file and click Import.'
                    : outcome.supplied ? uncertain.message : 'onX’s importer is not ready. No GPX was sent.' }, true));
        } catch {
            return reserved ? await cutoff(id, sender).catch(() => ({ ...uncertain, attemptId: id }))
                : { ok: false, supplied: false, code: 'setup-unavailable', message: 'The transfer could not start. Try again.' };
        } finally {
            deadline.clear();
            cancelled.delete(id);
        }
    };
    const cancel = async (message, sender) => {
        const record = await read(message.attemptId, sender);
        if (!record) return { ok: false };
        cancelled.add(record.id);
        return cutoff(record.id, sender);
    };
    const open = async (message, sender) => {
        if (!await trustedActions.consumeCapability(message, sender, action)) return { ok: false };
        const record = await read(message.attemptId, sender);
        if (!record?.targetTabId) return { ok: false };
        const tab = await ext.tabs.get(record.targetTabId);
        await ext.tabs.update(tab.id, { active: true });
        if (Number.isInteger(tab.windowId)) await ext.windows?.update(tab.windowId, { focused: true });
        return { ok: true };
    };
    const forgetSource = tabId => mutate(records => {
        for (const record of Object.values(records)) {
            if (record.sourceTabId === tabId && !terminal.has(record.state)) {
                cancelled.add(record.id);
                const outcome = record.state === 'dispatching' ? uncertain : attention;
                record.state = outcome.supplied ? 'uncertain' : 'not-supplied';
                record.result = { ...outcome, attemptId: record.id, targetTabId: record.targetTabId, canContinue: false };
            }
        }
    });
    return { forgetSource, handlers: { ONX_PERMISSION_REQUEST: permission.handlers.ONX_PERMISSION_REQUEST, ONX_IMPORT_PREPARE: prepare,
        ONX_IMPORT_STATUS: status, ONX_IMPORT_CANCEL: cancel, ONX_IMPORT_OPEN: open } };
}
