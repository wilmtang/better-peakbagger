// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from '../favorites/ignored-climbers.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';
import { githubErrors as Errors } from '../github/github-errors.js';

export const ignoredSyncScope = access => JSON.stringify([access?.authorizationEpoch ?? null,
    access?.repo?.owner ?? null, access?.repo?.name ?? null, access?.repo?.branch ?? null]);
const remoteSignature = entries => entries === null ? null : I.signature(entries);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const initialState = () => ({ schemaVersion: 1, enabled: false, controlRevision: 0,
    scope: null, base: null, pending: null, review: null, phase: 'local', error: '',
    lastBackup: null, lastSuccess: null, lastChecked: 0 });
const entriesValid = entries => I.validateEntries(entries) !== null;
export const readIgnoredSyncState = value => {
    if (value === undefined) return initialState();
    if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean'
        || !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0
        || (value.scope !== null && typeof value.scope !== 'string')
        || (value.base !== null && !entriesValid(value.base))
        || typeof value.phase !== 'string' || typeof value.error !== 'string') return null;
    for (const key of ['pending', 'review']) {
        const record = value[key];
        if (record !== null && (!record || typeof record.id !== 'string' || typeof record.scope !== 'string'
            || !entriesValid(record.local) || (record.remote !== null && !entriesValid(record.remote))
            || !Number.isSafeInteger(record.revision) || record.revision < 0)) return null;
        if (key === 'pending' && record && (!entriesValid(record.result)
            || !Number.isSafeInteger(record.controlRevision))) return null;
        if (key === 'review' && record && (!Number.isFinite(record.expiresAt)
            || !['backup', 'restore', 'setup', 'conflict', 'recovery'].includes(record.kind))) return null;
    }
    return structuredClone(value);
};

// Storage commits share the local mutation lane. GitHub commits share the
// repository write queue. Neither queue holds the local list across network I/O.
export const createClimberListSync = ({ storage, store, writeQueue, getAccess,
    now = Date.now, id = () => crypto.randomUUID() } = {}) => {
    let tail = Promise.resolve(), generation = 0, activeDeadline = null;
    const serial = operation => {
        const result = tail.then(operation, operation); tail = result.catch(() => {}); return result;
    };
    const readState = async () => {
        const raw = (await storage.get(I.SYNC_KEY))[I.SYNC_KEY];
        const state = readIgnoredSyncState(raw);
        if (!state) fail('storage', 'Ignored-climber backup state is unavailable. Try again.');
        return state;
    };
    const snapshot = () => store.run(async () => ({ list: await store.read(), state: await readState() }));
    const saveState = transform => store.run(async () => {
        const state = await readState(); const next = await transform(state);
        await storage.set({ [I.SYNC_KEY]: next }); return next;
    });
    const readRemote = text => {
        if (text === null) return null;
        const entries = I.parseBackup(text);
        if (!entries) fail('invalid', 'The ignored-climber backup is invalid, too large, or uses a newer format.');
        return entries;
    };
    const accessFor = async (signal, scope = null) => {
        const access = await getAccess({ signal });
        if (access.error) fail(access.error.code, access.error.message || 'Connect a GitHub backup repository in Settings.');
        if (scope !== null && ignoredSyncScope(access) !== scope) fail('superseded', 'The GitHub connection changed. Review the lists again.');
        return access;
    };
    const network = async operation => {
        const token = generation;
        const deadline = Deadline.createRequestDeadline(120000); activeDeadline = deadline;
        const guard = async scope => {
            if (token !== generation || deadline.signal?.aborted) fail('cancelled', 'This action was cancelled. Changes remain saved on this device.');
            return accessFor(deadline.signal, scope);
        };
        try { return await deadline.run(operation({ signal: deadline.signal, guard })); }
        finally { deadline.clear(); if (activeDeadline === deadline) activeDeadline = null; }
    };
    const publicFailure = error => ({ ok: false, error: {
        ...Errors.publicError(error), code: error.code || 'unavailable',
        message: error.message || 'Ignored climbers could not be backed up. Try again.' } });
    const safely = async operation => {
        try { return await operation(); }
        catch (error) {
            // Retain the journal on any uncertain network/storage outcome.
            try { await saveState(state => ({ ...state, phase: state.pending ? 'review' : 'offline', error: error.message })); }
            catch { /* never report success when storage is unavailable */ }
            return publicFailure(error);
        }
    };
    const preview = review => {
        const remote = review.remote || [];
        const merged = I.mergeLists([], review.local, remote);
        return { ...review, deviceCount: review.local.length, githubCount: remote.length,
            conflicts: merged.conflicts, mergeCount: new Set([...review.local, ...remote].map(entry => entry.cid)).size,
            impacts: { device: { local: I.membershipChanges(review.local, review.local), remote: I.membershipChanges(remote, review.local) },
                github: { local: I.membershipChanges(review.local, remote), remote: I.membershipChanges(remote, remote) },
                merge: { local: I.membershipChanges(review.local, [...new Map([...remote, ...review.local].map(entry => [entry.cid, entry])).values()]),
                    remote: I.membershipChanges(remote, [...new Map([...remote, ...review.local].map(entry => [entry.cid, entry])).values()]) } } };
    };
    const prepare = kind => network(async ({ signal, guard }) => {
        const { list, state } = await snapshot();
        const access = await accessFor(signal); const scope = ignoredSyncScope(access);
        const remote = readRemote(await access.client.readRootFile(I.BACKUP_PATH, { maxBytes: I.MAX_BYTES }));
        await guard(scope);
        if (kind === 'restore' && remote === null) fail('missing', 'No ignored-climber backup yet.');
        const review = { id: id(), kind, scope, local: list.entries, revision: list.revision,
            remote, expiresAt: now() + 10 * 60 * 1000 };
        await saveState(current => ({ ...current, review, phase: 'review', error: '' }));
        return { ok: true, preview: preview(review), needsReview: kind !== 'backup'
            || (remote !== null && (state.scope !== scope || remoteSignature(state.base) !== remoteSignature(remote))) };
    });
    const assertReviewed = (review, list) => {
        if (list.revision !== review.revision || I.signature(list.entries) !== I.signature(review.local)) {
            fail('stale', 'Ignored climbers changed. Review the updated lists before continuing.');
        }
    };
    const reconcile = async (pending, result, guard) => {
        await guard(pending.scope);
        return store.run(async () => {
            const current = await store.read(), state = await readState();
            if (state.pending?.id !== pending.id || state.controlRevision !== pending.controlRevision) {
                fail('superseded', 'The action changed before confirmation. Review changes.');
            }
            const rebased = I.mergeLists(pending.local, current.entries, pending.result);
            // A local edit made during upload stays authoritative and pending.
            if (rebased.conflicts.length) {
                const choices = Object.fromEntries(rebased.conflicts.map(conflict => [conflict.cid, 'device']));
                Object.assign(rebased, I.mergeLists(pending.local, current.entries, pending.result, choices));
            }
            if (rebased.overLimit) fail('limit', 'The merged list exceeds 1,500 climbers. Review the lists.');
            const changed = I.signature(current.entries) !== I.signature(rebased.entries);
            if (changed && current.revision === Number.MAX_SAFE_INTEGER) fail('storage', 'The list revision cannot be advanced.');
            const list = changed ? { schemaVersion: 1, revision: current.revision + 1, entries: rebased.entries } : current;
            const next = { ...state, scope: pending.scope, base: pending.result, pending: null, review: null,
                phase: 'backed-up', error: '', lastBackup: now(), lastChecked: now() };
            await guard(pending.scope);
            await storage.set({ [I.IGNORED_KEY]: list, [I.SYNC_KEY]: next });
            return { ok: true, state: next, list, result, undo: changed
                ? { entries: current.entries, expectedRevision: list.revision, expectedSignature: I.signature(list.entries) } : null };
        });
    };
    const confirm = (reviewId, mode = 'merge', choices = {}) => network(async ({ signal, guard }) => {
        const { list, state } = await snapshot(), review = state.review;
        if (!review || review.id !== reviewId || review.expiresAt <= now()) fail('stale', 'This preview expired. Review the lists again.');
        assertReviewed(review, list);
        await guard(review.scope);
        if (review.kind === 'restore') {
            const access = await accessFor(signal, review.scope);
            const remote = readRemote(await access.client.readRootFile(I.BACKUP_PATH, { maxBytes: I.MAX_BYTES }));
            await guard(review.scope);
            if (remoteSignature(remote) !== remoteSignature(review.remote)) fail('stale', 'The GitHub list changed. Review a fresh preview.');
            return store.run(async () => {
                const current = await store.read(), latest = await readState(); assertReviewed(review, current);
                if (latest.review?.id !== review.id) fail('stale', 'Review the lists again.');
                const changed = I.signature(current.entries) !== I.signature(remote);
                if (changed && current.revision === Number.MAX_SAFE_INTEGER) fail('storage', 'The list revision cannot be advanced.');
                const replacement = changed ? { schemaVersion: 1, revision: current.revision + 1, entries: remote } : current;
                const next = { ...latest, review: null, phase: 'restored', error: '',
                    ...(!latest.enabled ? { scope: review.scope, base: remote } : {}) };
                await guard(review.scope);
                await storage.set({ [I.IGNORED_KEY]: replacement, [I.SYNC_KEY]: next });
                return { ok: true, state: next, list: replacement, undo: changed
                    ? { entries: current.entries, expectedRevision: replacement.revision, expectedSignature: I.signature(replacement.entries) } : null };
            });
        }
        if (!['device', 'github', 'merge'].includes(mode)) fail('invalid', 'Choose how to reconcile the lists.');
        const merged = mode === 'device' ? { entries: review.local, conflicts: [] }
            : mode === 'github' ? { entries: review.remote || [], conflicts: [] }
                : I.mergeLists([], review.local, review.remote || [], choices);
        if (merged.conflicts.length) fail('conflict', 'Choose a version for each affected climber.');
        if (!entriesValid(merged.entries)) fail('limit', 'The merged list exceeds 1,500 climbers.');
        let pending;
        const result = await writeQueue.run(async () => {
            const access = await guard(review.scope);
            return access.client.updateRootFile(I.BACKUP_PATH, async text => {
                const remote = readRemote(text); await guard(review.scope);
                if (remoteSignature(remote) !== remoteSignature(review.remote)) fail('stale', 'The GitHub list changed. Review a fresh preview.');
                await store.run(async () => {
                    const current = await store.read(), latest = await readState(); assertReviewed(review, current);
                    if (latest.review?.id !== review.id) fail('stale', 'Review the lists again.');
                    pending = { id: id(), kind: 'backup', scope: review.scope, local: current.entries,
                        revision: current.revision, remote, result: merged.entries, controlRevision: latest.controlRevision };
                    await storage.set({ [I.SYNC_KEY]: { ...latest, pending, phase: 'working', error: '' } });
                });
                return remoteSignature(remote) === I.signature(merged.entries) ? text : I.serializeBackup(merged.entries);
            }, 'Reconcile ignored climbers', { maxBytes: I.MAX_BYTES, beforeCommit: async () => {
                await guard(review.scope);
                const current = await snapshot(); assertReviewed(review, current.list);
            } });
        });
        return reconcile(pending, result, guard);
    });
    const status = () => safely(async () => {
        const { list, state } = await snapshot();
        return { ok: true, count: list.entries.length, state, preview: state.review ? preview(state.review) : null };
    });
    const cancel = () => { generation++; activeDeadline?.abort(); };
    const action = message => serial(() => safely(async () => {
        if (message.action === 'backup' || message.action === 'restore') {
            const prepared = await prepare(message.action);
            if (!prepared.needsReview) return confirm(prepared.preview.id, 'device');
            return prepared;
        }
        if (message.action === 'dismiss') return { ok: true, state: await saveState(state => ({ ...state, review: null, phase: state.pending ? 'review' : 'local', error: '' })) };
        if (message.action === 'confirm') return confirm(message.reviewId, message.mode, message.choices);
        fail('invalid', 'Invalid ignored-climber backup action.');
    }));
    return { status, action, cancel };
};
