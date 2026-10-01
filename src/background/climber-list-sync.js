// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from '../favorites/ignored-climbers.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';
import { githubErrors as Errors } from '../github/github-errors.js';

export const ignoredSyncScope = access => JSON.stringify([access?.authorizationEpoch ?? null,
    access?.repo?.owner ?? null, access?.repo?.name ?? null, access?.repo?.branch ?? null]);
const remoteSignature = entries => entries === null ? null : I.signature(entries);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const IGNORED_SYNC_ALARM = 'bpb-ignored-sync';
export const IGNORED_CHANGE_ALARM = 'bpb-ignored-sync-changes';
const initialState = () => ({ schemaVersion: 1, enabled: false, controlRevision: 0,
    scope: null, base: null, pending: null, review: null, phase: 'local', error: '',
    lastBackup: null, lastSuccess: null, lastChecked: 0, retryAt: 0, head: null });
const entriesValid = entries => I.validateEntries(entries) !== null;
export const readIgnoredSyncState = value => {
    if (value === undefined) return initialState();
    if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean'
        || !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0
        || (value.scope !== null && typeof value.scope !== 'string')
        || (value.base !== null && !entriesValid(value.base))
        || (value.enabled && (typeof value.scope !== 'string' || value.base === null))
        || !['local', 'review', 'offline', 'backed-up', 'restored', 'pending', 'synced', 'working'].includes(value.phase)
        || typeof value.error !== 'string') return null;
    for (const key of ['pending', 'review']) {
        const record = value[key];
        if (record !== null && (!record || typeof record.id !== 'string' || typeof record.scope !== 'string'
            || !entriesValid(record.local) || (record.remote !== null && !entriesValid(record.remote))
            || !Number.isSafeInteger(record.revision) || record.revision < 0)) return null;
        if (key === 'pending' && record && (!entriesValid(record.result)
            || !Number.isSafeInteger(record.controlRevision))) return null;
        if (record?.base != null && !entriesValid(record.base)) return null;
        if (key === 'review' && record && (!Number.isFinite(record.expiresAt)
            || !['backup', 'restore', 'setup', 'conflict', 'recovery'].includes(record.kind))) return null;
    }
    return structuredClone(value);
};

// Storage commits share the local mutation lane. GitHub commits share the
// repository write queue. Neither queue holds the local list across network I/O.
export const createClimberListSync = ({ storage, store, writeQueue, getAccess,
    alarms = null, now = Date.now, id = () => crypto.randomUUID() } = {}) => {
    let tail = Promise.resolve(), generation = 0, activeDeadline = null, syncPromise = null;
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
        if (!readIgnoredSyncState(next)) fail('storage', 'Ignored-climber backup state could not be saved.');
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
        message: error.message || 'Ignored climbers could not be backed up. Try again.' },
    ...(error.preview ? { preview: error.preview } : {}) });
    const safely = async operation => {
        try { return await operation(); }
        catch (error) {
            // Retain the journal on any uncertain network/storage outcome.
            try { await saveState(state => ({ ...state,
                phase: state.pending || ['invalid', 'stale', 'limit', 'superseded', 'missing', 'conflict', 'setup', 'review'].includes(error.code) ? 'review' : 'offline',
                error: error.message, lastChecked: now(),
                retryAt: error.retryAfterSeconds ? now() + error.retryAfterSeconds * 1000 : state.retryAt || 0 })); }
            catch { /* never report success when storage is unavailable */ }
            return publicFailure(error);
        }
    };
    const preview = review => {
        const remote = review.remote || [], base = review.base || [];
        const merged = I.mergeLists(base, review.local, remote);
        const choices = Object.fromEntries(merged.conflicts.map(conflict => [conflict.cid, 'device']));
        const candidate = I.mergeLists(base, review.local, remote, choices).entries;
        const impact = entries => ({ local: I.membershipChanges(review.local, entries), remote: I.membershipChanges(remote, entries) });
        return { ...review, deviceCount: review.local.length, githubCount: remote.length,
            conflicts: merged.conflicts, mergeCount: candidate.length,
            impacts: { device: impact(review.local), github: impact(remote), merge: impact(candidate) } };
    };
    const storeReview = async (kind, scope, list, remote, base = null) => {
        const review = { id: id(), kind, scope, local: list.entries, revision: list.revision,
            remote, base, expiresAt: now() + 10 * 60 * 1000 };
        await saveState(current => ({ ...current, review, phase: 'review', error: '', lastChecked: now() }));
        return preview(review);
    };
    const prepare = kind => network(async ({ signal, guard }) => {
        const { list, state } = await snapshot();
        const access = await accessFor(signal); const scope = ignoredSyncScope(access);
        const remote = readRemote(await access.client.readRootFile(I.BACKUP_PATH, { maxBytes: I.MAX_BYTES }));
        await guard(scope);
        if (kind === 'restore' && remote === null) fail('missing', 'No ignored-climber backup yet.');
        const review = await storeReview(kind, scope, list, remote);
        return { ok: true, preview: review, needsReview: kind !== 'backup'
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
            const enabled = state.enabled || pending.enable === true;
            const hasChanges = I.signature(list.entries) !== I.signature(pending.result);
            const next = { ...state, enabled, scope: pending.scope, base: pending.result, pending: null, review: null,
                phase: enabled ? hasChanges ? 'pending' : 'synced' : 'backed-up', error: '',
                lastBackup: now(), lastSuccess: enabled ? now() : state.lastSuccess, lastChecked: now(), retryAt: 0,
                head: result?.recovered ? null : result?.sha || state.head, targetBranch: result?.branch || pending.targetBranch || state.targetBranch || null };
            await guard(pending.scope);
            await storage.set({ [I.IGNORED_KEY]: list, [I.SYNC_KEY]: next });
            if (enabled) armPeriodic();
            if (enabled && hasChanges) armChanges();
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
                const next = { ...latest, review: null, phase: latest.enabled ? 'pending' : 'restored', error: '',
                    ...(!latest.enabled ? { scope: review.scope, base: remote } : {}) };
                await guard(review.scope);
                await storage.set({ [I.IGNORED_KEY]: replacement, [I.SYNC_KEY]: next });
                if (latest.enabled) armChanges();
                return { ok: true, state: next, list: replacement, undo: changed
                    ? { entries: current.entries, expectedRevision: replacement.revision, expectedSignature: I.signature(replacement.entries) } : null };
            });
        }
        if (!['device', 'github', 'merge'].includes(mode)) fail('invalid', 'Choose how to reconcile the lists.');
        const merged = mode === 'device' ? { entries: review.local, conflicts: [] }
            : mode === 'github' ? { entries: review.remote || [], conflicts: [] }
                : I.mergeLists(review.base || [], review.local, review.remote || [], choices);
        if (merged.conflicts.length) fail('conflict', 'Choose a version for each affected climber.');
        if (!entriesValid(merged.entries)) fail('limit', 'The merged list exceeds 1,500 climbers.');
        let pending;
        const result = await writeQueue.run(async () => {
            const access = await guard(review.scope);
            return access.client.updateRootFile(I.BACKUP_PATH, async (text, metadata = {}) => {
                const remote = readRemote(text); await guard(review.scope);
                if (remoteSignature(remote) !== remoteSignature(review.remote)) fail('stale', 'The GitHub list changed. Review a fresh preview.');
                await store.run(async () => {
                    const current = await store.read(), latest = await readState(); assertReviewed(review, current);
                    if (latest.review?.id !== review.id) fail('stale', 'Review the lists again.');
                    pending = { id: id(), kind: review.kind, enable: review.kind === 'setup' || latest.enabled, scope: review.scope, local: current.entries,
                        revision: current.revision, remote, result: merged.entries, controlRevision: latest.controlRevision, targetBranch: metadata.branch || null };
                    await storage.set({ [I.SYNC_KEY]: { ...latest, pending, review: null, phase: 'working', error: '' } });
                });
                return remoteSignature(remote) === I.signature(merged.entries) ? text : I.serializeBackup(merged.entries);
            }, 'Reconcile ignored climbers', { maxBytes: I.MAX_BYTES, beforeCommit: async () => {
                await guard(review.scope);
                const current = await snapshot(); assertReviewed(review, current.list);
            } });
        });
        return reconcile(pending, result, guard);
    });
    const armPeriodic = () => {
        if (!alarms) return;
        const token = generation;
        void Promise.resolve(alarms.get?.(IGNORED_SYNC_ALARM)).then(async existing => {
            const state = await readState();
            if (token !== generation || !state.enabled) return;
            if (existing?.periodInMinutes !== 15) return alarms.create(IGNORED_SYNC_ALARM, { delayInMinutes: 15, periodInMinutes: 15 });
        }).catch(() => {});
    };
    const armChanges = (delayInMinutes = 0.5) => { if (alarms) void Promise.resolve(alarms.create(IGNORED_CHANGE_ALARM,
        { delayInMinutes })).catch(() => {}); };
    const cancel = () => { generation++; activeDeadline?.abort(); };
    const recover = async (state, signal, guard) => {
        const pending = state.pending; if (!pending) return null;
        const access = await accessFor(signal, pending.scope);
        const remote = readRemote(await access.client.readRootFile(I.BACKUP_PATH, { maxBytes: I.MAX_BYTES }));
        await guard(pending.scope);
        if (remoteSignature(remote) === I.signature(pending.result)) {
            // A disable request cannot be reversed by recovering an old setup.
            if (state.controlRevision !== pending.controlRevision) {
                fail('review', 'A cancelled upload may have completed. Review the lists before continuing.');
            }
            return reconcile(pending, { recovered: true }, guard);
        }
        if (remoteSignature(remote) === remoteSignature(pending.remote)) {
            await saveState(current => {
                if (current.pending?.id !== pending.id) fail('superseded', 'Review changes again.');
                return { ...current, pending: null, phase: current.enabled ? 'pending' : 'review', error: '' };
            });
            return null;
        }
        const list = (await snapshot()).list;
        const review = await storeReview('recovery', pending.scope, list, remote);
        throw Object.assign(new Error('The interrupted upload could not be confirmed. Review the current lists.'), { code: 'review', preview: review });
    };
    const syncOperation = () => network(async ({ signal, guard }) => {
        let observed = await snapshot();
        if (observed.state.retryAt > now()) fail('rate-limit', 'GitHub asked us to wait before retrying. Changes remain saved on this device.');
        if (observed.state.pending) {
            const recovered = await recover(observed.state, signal, guard);
            if (recovered) return recovered;
            observed = await snapshot();
        }
        if (!observed.state.enabled || observed.state.base === null) return prepare('setup');
        const scope = observed.state.scope;
        let pending;
        const result = await writeQueue.run(async () => {
            const access = await guard(scope);
            return access.client.updateRootFile(I.BACKUP_PATH, async (text, metadata = {}) => {
                const remote = readRemote(text); await guard(scope);
                const { list, state } = await snapshot();
                if (!state.enabled || state.scope !== scope) fail('superseded', 'Set up sync for the current GitHub connection.');
                if (state.targetBranch && metadata.branch && state.targetBranch !== metadata.branch) {
                    fail('setup', 'The repository default branch changed. Set up sync again.');
                }
                if (remote === null) {
                    const review = await storeReview('recovery', scope, list, null);
                    throw Object.assign(new Error('The ignored-climber file disappeared. Review changes before recreating it.'), { code: 'review', preview: review });
                }
                const merged = I.mergeLists(state.base, list.entries, remote);
                if (merged.conflicts.length || merged.overLimit) {
                    const review = await storeReview('conflict', scope, list, remote, state.base);
                    throw Object.assign(new Error(merged.overLimit ? 'The merged list exceeds 1,500 climbers.'
                        : 'Both lists changed the same climber. Choose which version to keep.'), { code: 'review', preview: review });
                }
                await store.run(async () => {
                    const current = await store.read(), latest = await readState();
                    if (!latest.enabled || latest.scope !== scope || current.revision !== list.revision
                        || I.signature(current.entries) !== I.signature(list.entries)) fail('stale', 'The list changed before upload. Sync again.');
                    pending = { id: id(), kind: 'sync', enable: true, scope, local: list.entries,
                        revision: list.revision, remote, result: merged.entries, controlRevision: latest.controlRevision,
                        observedHead: metadata.head || null, targetBranch: metadata.branch || null };
                    await guard(scope);
                    await storage.set({ [I.SYNC_KEY]: { ...latest, pending, review: null, phase: 'working', error: '' } });
                });
                return remoteSignature(remote) === I.signature(merged.entries) ? text : I.serializeBackup(merged.entries);
            }, 'Sync ignored climbers', { maxBytes: I.MAX_BYTES, beforeCommit: async () => {
                await guard(scope);
                const current = await snapshot();
                if (!current.state.enabled || current.state.controlRevision !== pending.controlRevision
                    || current.list.revision !== pending.revision || I.signature(current.list.entries) !== I.signature(pending.local)) {
                    fail('stale', 'The list changed before upload. Sync again.');
                }
            } });
        });
        return reconcile(pending, result, guard);
    });
    const sync = () => {
        if (syncPromise) return syncPromise;
        const operation = serial(() => safely(syncOperation)); syncPromise = operation;
        void operation.finally(() => { if (syncPromise === operation) syncPromise = null; });
        return operation;
    };
    const automatic = async () => {
        const { state } = await snapshot();
        if (!state.enabled || (state.phase === 'review' && (state.review || !state.pending))) return { ok: true, skipped: true };
        if (state.retryAt > now()) { armChanges(Math.max(0.5, (state.retryAt - now()) / 60000)); return { ok: true, skipped: true }; }
        const response = await sync();
        if (!response.ok && (await readState()).phase !== 'review') {
            armChanges(Math.max(1, (response.error?.retryAfterSeconds || 60) / 60));
        }
        return response;
    };
    const status = () => safely(async () => {
        const { list, state } = await snapshot();
        if (state.enabled && state.phase === 'synced' && I.signature(list.entries) !== remoteSignature(state.base)) state.phase = 'pending';
        return { ok: true, count: list.entries.length, state, preview: state.review ? preview(state.review) : null };
    });
    const disable = async () => {
        cancel();
        if (alarms?.clear) { await alarms.clear(IGNORED_SYNC_ALARM); await alarms.clear(IGNORED_CHANGE_ALARM); }
        return safely(async () => ({ ok: true, state: await saveState(state => ({ ...state, enabled: false,
            controlRevision: state.controlRevision + 1, review: null,
            phase: state.pending ? 'review' : 'local', error: state.pending ? 'An interrupted upload needs review.' : '' })) }));
    };
    const connectionChanged = () => {
        cancel();
        void saveState(state => ({ ...state, enabled: false, controlRevision: state.controlRevision + 1,
            review: null, phase: 'review', error: 'The GitHub connection changed. Set up sync again.' })).catch(() => {});
        if (alarms?.clear) { void alarms.clear(IGNORED_SYNC_ALARM); void alarms.clear(IGNORED_CHANGE_ALARM); }
    };
    const localChanged = async () => {
        const token = generation;
        const changed = await store.run(async () => {
            const list = await store.read(), state = await readState();
            if (!state.enabled || I.signature(list.entries) === remoteSignature(state.base)) return false;
            await storage.set({ [I.SYNC_KEY]: { ...state, phase: state.review ? 'review' : 'pending' } });
            return true;
        });
        if (changed && token === generation) armChanges();
    };
    const start = async ({ startup = false } = {}) => {
        const { state } = await snapshot();
        if (state.enabled) { armPeriodic(); if (startup || state.pending) return automatic(); return { ok: true, skipped: true }; }
        // Setup was confirmed, but the worker stopped before reconciliation.
        if (state.pending?.enable && state.pending.controlRevision === state.controlRevision) return sync();
        return { ok: true, skipped: true };
    };
    const check = async () => {
        const { state } = await snapshot();
        if (now() - (state.lastChecked || 0) < 60000) return { ok: true, skipped: true };
        return automatic();
    };
    const action = message => {
        if (message.action === 'disable') return disable();
        if (message.action === 'sync') return sync();
        if (message.action === 'check') return safely(check);
        return serial(() => safely(async () => {
            if (message.action === 'setup') return prepare('setup');
            if (message.action === 'backup' || message.action === 'restore') {
                if (message.action === 'backup' && (await snapshot()).state.enabled) return syncOperation();
                const prepared = await prepare(message.action);
                if (!prepared.needsReview) return confirm(prepared.preview.id, 'device');
                return prepared;
            }
            if (message.action === 'dismiss') return { ok: true, state: await saveState(state => ({ ...state,
                review: null, phase: state.pending ? 'review' : state.enabled ? 'pending' : 'local', error: '' })) };
            if (message.action === 'confirm') return confirm(message.reviewId, message.mode, message.choices);
            fail('invalid', 'Invalid ignored-climber backup action.');
        }));
    };
    return { status, action, cancel, connectionChanged, localChanged, start,
        onAlarm: name => [IGNORED_SYNC_ALARM, IGNORED_CHANGE_ALARM].includes(name) ? safely(automatic) : undefined };
};
