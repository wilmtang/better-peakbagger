// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from '../favorites/ignored-climbers.ts';
import { requestDeadline as Deadline, type RequestDeadline } from '../net/request-deadline.ts';
import { githubErrors as Errors, type PublicGithubError } from '../github/github-errors.ts';

export type IgnoredSyncPhase =
    | 'local'
    | 'review'
    | 'offline'
    | 'backed-up'
    | 'restored'
    | 'pending'
    | 'synced'
    | 'working';

export type IgnoredReviewKind = 'backup' | 'restore' | 'setup' | 'conflict' | 'recovery';

export interface IgnoredSyncScopeInput {
    authorizationEpoch?: number;
    repo?: {
        owner?: string | null;
        name?: string | null;
        branch?: string | null;
    } | null;
}

export interface IgnoredSyncPending {
    id: string;
    kind: IgnoredReviewKind | 'sync';
    enable: boolean;
    scope: string;
    local: I.IgnoredClimberEntry[];
    revision: number;
    remote: I.IgnoredClimberEntry[] | null;
    base?: I.IgnoredClimberEntry[] | null;
    result: I.IgnoredClimberEntry[];
    controlRevision: number;
    observedHead?: string | null;
    targetBranch?: string | null;
}

export interface IgnoredSyncReview {
    id: string;
    kind: IgnoredReviewKind;
    scope: string;
    local: I.IgnoredClimberEntry[];
    revision: number;
    remote: I.IgnoredClimberEntry[] | null;
    base: I.IgnoredClimberEntry[] | null;
    expiresAt: number;
}

export interface IgnoredSyncState {
    schemaVersion: 1;
    enabled: boolean;
    controlRevision: number;
    scope: string | null;
    base: I.IgnoredClimberEntry[] | null;
    pending: IgnoredSyncPending | null;
    review: IgnoredSyncReview | null;
    phase: IgnoredSyncPhase;
    error: string;
    lastBackup: number | null;
    lastSuccess: number | null;
    lastChecked: number;
    retryAt: number;
    head: string | null;
    targetBranch?: string | null;
}

export interface IgnoredSyncImpacts {
    local: I.IgnoredMembershipChanges;
    remote: I.IgnoredMembershipChanges;
}

export interface IgnoredSyncPreview extends IgnoredSyncReview {
    deviceCount: number;
    githubCount: number;
    conflicts: I.MergeConflict[];
    mergeCount: number;
    impacts: {
        device: IgnoredSyncImpacts;
        github: IgnoredSyncImpacts;
        merge: IgnoredSyncImpacts;
    };
}

export interface IgnoredSyncUndo {
    entries: I.IgnoredClimberEntry[];
    expectedRevision: number;
    expectedSignature: string;
}

export interface IgnoredSyncUpdateResult {
    recovered?: boolean;
    sha?: string | null;
    branch?: string | null;
    [key: string]: unknown;
}

export interface IgnoredSyncClient {
    readRootFile(path: string, options?: { maxBytes?: number | null }): Promise<string | null>;
    updateRootFile(
        path: string,
        update: (
            current: string | null,
            context?: { head?: string; fileSha?: string | null; branch?: string },
        ) => string | Promise<string>,
        commitMessage: string,
        options?: { maxBytes?: number | null; beforeCommit?: (() => unknown | Promise<unknown>) | null },
    ): Promise<IgnoredSyncUpdateResult>;
}

export interface IgnoredSyncAccess extends IgnoredSyncScopeInput {
    client: IgnoredSyncClient;
    error?: undefined;
}

export interface IgnoredSyncAccessFailure {
    authorizationEpoch?: number;
    error: {
        code: string;
        message?: string;
        status?: number;
        retryAfterSeconds?: number;
    };
}

export type IgnoredSyncAccessResult = IgnoredSyncAccess | IgnoredSyncAccessFailure;

export interface IgnoredSyncStorage {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface IgnoredSyncStore {
    run<T>(operation: () => Promise<T> | T): Promise<T>;
    read(): Promise<I.IgnoredClimbersList>;
    assertAllowed(entries: readonly I.IgnoredClimberEntry[]): Promise<void>;
}

export interface IgnoredSyncWriteQueue {
    run<T>(write: () => Promise<T> | T): Promise<T>;
}

export interface IgnoredSyncAlarms {
    get?(name: string): unknown;
    create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }): unknown;
    clear?(name: string): unknown;
}

export interface CreateClimberListSyncOptions {
    storage: IgnoredSyncStorage;
    store: IgnoredSyncStore;
    writeQueue: IgnoredSyncWriteQueue;
    getAccess: (options: { signal?: AbortSignal }) => Promise<IgnoredSyncAccessResult>;
    alarms?: IgnoredSyncAlarms | null;
    now?: () => number;
    id?: () => string;
}

export interface IgnoredSyncActionMessage {
    action?: unknown;
    reviewId?: unknown;
    mode?: unknown;
    choices?: unknown;
    [key: string]: unknown;
}

export type IgnoredSyncFailure = {
    ok: false;
    error: Omit<PublicGithubError, 'code'> & { code: string; message: string };
    preview?: IgnoredSyncPreview;
};

export type IgnoredSyncResponse =
    | IgnoredSyncFailure
    | { ok: true; skipped: true }
    | { ok: true; preview: IgnoredSyncPreview; needsReview: boolean }
    | { ok: true; state: IgnoredSyncState; list?: I.IgnoredClimbersList; result?: IgnoredSyncUpdateResult; undo?: IgnoredSyncUndo | null }
    | { ok: true; count: number; state: IgnoredSyncState; preview: IgnoredSyncPreview | null };

interface SyncErrorLike {
    code?: unknown;
    message?: unknown;
    retryAfterSeconds?: unknown;
    preview?: unknown;
}

const SYNC_PHASES = new Set<string>([
    'local', 'review', 'offline', 'backed-up', 'restored', 'pending', 'synced', 'working',
]);
const REVIEW_KINDS = new Set<string>(['backup', 'restore', 'setup', 'conflict', 'recovery']);

export const ignoredSyncScope = (access: IgnoredSyncScopeInput | null | undefined): string => JSON.stringify([
    access?.authorizationEpoch ?? null,
    access?.repo?.owner ?? null,
    access?.repo?.name ?? null,
    access?.repo?.branch ?? null,
]);
const remoteSignature = (entries: readonly I.IgnoredClimberEntry[] | null): string | null =>
    entries === null ? null : I.signature(entries);
function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}
export const IGNORED_SYNC_ALARM = 'bpb-ignored-sync';
export const IGNORED_CHANGE_ALARM = 'bpb-ignored-sync-changes';
const initialState = (): IgnoredSyncState => ({
    schemaVersion: 1, enabled: false, controlRevision: 0,
    scope: null, base: null, pending: null, review: null, phase: 'local', error: '',
    lastBackup: null, lastSuccess: null, lastChecked: 0, retryAt: 0, head: null,
});
const automaticSyncBlocked = (state: IgnoredSyncState): boolean => !state.enabled
    || (state.phase === 'review' && (Boolean(state.review) || !state.pending));
const entriesValid = (entries: unknown): entries is I.IgnoredClimberEntry[] => I.validateEntries(entries) !== null;
export const readIgnoredSyncState = (value: unknown): IgnoredSyncState | null => {
    if (value === undefined) return initialState();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const state = value as Record<string, unknown>;
    if (state.schemaVersion !== 1 || typeof state.enabled !== 'boolean'
        || typeof state.controlRevision !== 'number'
        || !Number.isSafeInteger(state.controlRevision) || state.controlRevision < 0
        || (state.scope !== null && typeof state.scope !== 'string')
        || (state.base !== null && !entriesValid(state.base))
        || (state.enabled && state.base !== null && typeof state.scope !== 'string')
        || typeof state.phase !== 'string' || !SYNC_PHASES.has(state.phase)
        || typeof state.error !== 'string') return null;
    for (const key of ['pending', 'review'] as const) {
        const raw = state[key];
        if (raw !== null && (!raw || typeof raw !== 'object' || Array.isArray(raw))) return null;
        const record = raw as Record<string, unknown> | null;
        if (record !== null && (typeof record.id !== 'string' || typeof record.scope !== 'string'
            || !entriesValid(record.local) || (record.remote !== null && !entriesValid(record.remote))
            || typeof record.revision !== 'number'
            || !Number.isSafeInteger(record.revision) || record.revision < 0)) return null;
        if (key === 'pending' && record && (!entriesValid(record.result)
            || typeof record.controlRevision !== 'number'
            || !Number.isSafeInteger(record.controlRevision))) return null;
        if (record?.base != null && !entriesValid(record.base)) return null;
        if (key === 'review' && record && (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)
            || typeof record.kind !== 'string' || !REVIEW_KINDS.has(record.kind))) return null;
    }
    return structuredClone(value) as IgnoredSyncState;
};

// Storage commits share the local mutation lane. GitHub commits share the
// repository write queue. Neither queue holds the local list across network I/O.
export const createClimberListSync = ({
    storage,
    store,
    writeQueue,
    getAccess,
    alarms = null,
    now = Date.now,
    id = () => crypto.randomUUID(),
}: CreateClimberListSyncOptions) => {
    let tail: Promise<unknown> = Promise.resolve();
    let generation = 0;
    let activeDeadline: RequestDeadline | null = null;
    let syncPromise: Promise<IgnoredSyncResponse> | null = null;
    const serial = <T>(operation: () => Promise<T> | T): Promise<T> => {
        const result = tail.then(operation, operation);
        tail = result.catch(() => {});
        return result;
    };
    const readState = async (): Promise<IgnoredSyncState> => {
        const raw = (await storage.get(I.SYNC_KEY))[I.SYNC_KEY];
        const state = readIgnoredSyncState(raw);
        if (!state) fail('storage', 'Ignored-climber backup state is unavailable. Try again.');
        return state;
    };
    const snapshot = () => store.run(async () => ({ list: await store.read(), state: await readState() }));
    const saveState = (transform: (state: IgnoredSyncState) => IgnoredSyncState | Promise<IgnoredSyncState>): Promise<IgnoredSyncState> =>
        store.run(async () => {
            const state = await readState();
            const next = await transform(state);
            if (!readIgnoredSyncState(next)) fail('storage', 'Ignored-climber backup state could not be saved.');
            await storage.set({ [I.SYNC_KEY]: next });
            return next;
        });
    const readRemote = (text: string | null): I.IgnoredClimberEntry[] | null => {
        if (text === null) return null;
        const entries = I.parseBackup(text);
        if (!entries) fail('invalid', 'The ignored-climber backup is invalid, too large, or uses a newer format.');
        return entries;
    };
    const accessFor = async (signal: AbortSignal | undefined, scope: string | null = null): Promise<IgnoredSyncAccess> => {
        const access = await getAccess({ signal });
        if (access.error) fail(access.error.code, access.error.message || 'Connect a GitHub backup repository in Settings.');
        if (scope !== null && ignoredSyncScope(access) !== scope) {
            fail('superseded', 'The GitHub connection changed. Review the lists again.');
        }
        return access;
    };
    const network = async <T>(
        operation: (context: { signal: AbortSignal | undefined; guard: (scope?: string | null) => Promise<IgnoredSyncAccess> }) => Promise<T>,
    ): Promise<T> => {
        const token = generation;
        const deadline = Deadline.createRequestDeadline(120000);
        activeDeadline = deadline;
        const guard = async (scope: string | null = null): Promise<IgnoredSyncAccess> => {
            if (token !== generation || deadline.signal?.aborted) {
                fail('cancelled', 'This action was cancelled. Changes remain saved on this device.');
            }
            return accessFor(deadline.signal, scope);
        };
        try { return await deadline.run(operation({ signal: deadline.signal, guard })); }
        finally { deadline.clear(); if (activeDeadline === deadline) activeDeadline = null; }
    };
    const publicFailure = (error: unknown): IgnoredSyncFailure => {
        const err = error && typeof error === 'object' ? (error as SyncErrorLike) : null;
        const code = typeof err?.code === 'string' && err.code ? err.code : 'unavailable';
        const message = typeof err?.message === 'string' && err.message
            ? err.message
            : 'Ignored climbers could not be backed up. Try again.';
        return {
            ok: false,
            error: { ...Errors.publicError(error), code, message },
            ...(err?.preview ? { preview: err.preview as IgnoredSyncPreview } : {}),
        };
    };
    const safely = async <T>(operation: () => Promise<T>): Promise<T | IgnoredSyncFailure> => {
        try { return await operation(); }
        catch (error) {
            const err = error && typeof error === 'object' ? (error as SyncErrorLike) : null;
            const errCode = typeof err?.code === 'string' ? err.code : '';
            const errMessage = typeof err?.message === 'string' ? err.message : '';
            const retryAfterSeconds = typeof err?.retryAfterSeconds === 'number' ? err.retryAfterSeconds : 0;
            // Retain the journal on any uncertain network/storage outcome.
            try {
                await saveState(state => ({
                    ...state,
                    phase: state.pending || ['invalid', 'stale', 'limit', 'superseded', 'missing', 'conflict', 'list-conflict', 'setup', 'review'].includes(errCode) ? 'review' : 'offline',
                    error: errMessage,
                    lastChecked: now(),
                    retryAt: retryAfterSeconds ? now() + retryAfterSeconds * 1000 : state.retryAt || 0,
                }));
            } catch { /* never report success when storage is unavailable */ }
            return publicFailure(error);
        }
    };
    const preview = (review: IgnoredSyncReview): IgnoredSyncPreview => {
        const remote = review.remote || [];
        const base = review.base || [];
        const merged = I.mergeLists(base, review.local, remote);
        const choices = Object.fromEntries(merged.conflicts.map(conflict => [conflict.cid, 'device' as const]));
        const candidate = I.mergeLists(base, review.local, remote, choices).entries;
        const impact = (entries: readonly I.IgnoredClimberEntry[]): IgnoredSyncImpacts => ({
            local: I.membershipChanges(review.local, entries),
            remote: I.membershipChanges(remote, entries),
        });
        return {
            ...review,
            deviceCount: review.local.length,
            githubCount: remote.length,
            conflicts: merged.conflicts,
            mergeCount: candidate.length,
            impacts: { device: impact(review.local), github: impact(remote), merge: impact(candidate) },
        };
    };
    const storeReview = async (
        kind: IgnoredReviewKind,
        scope: string,
        list: I.IgnoredClimbersList,
        remote: I.IgnoredClimberEntry[] | null,
        base: I.IgnoredClimberEntry[] | null = null,
    ): Promise<IgnoredSyncPreview> => {
        const review: IgnoredSyncReview = {
            id: id(), kind, scope, local: list.entries, revision: list.revision,
            remote, base, expiresAt: now() + 10 * 60 * 1000,
        };
        await saveState(current => ({ ...current, review, phase: 'review', error: '', lastChecked: now() }));
        return preview(review);
    };
    const prepare = (kind: IgnoredReviewKind) => network(async ({ signal, guard }) => {
        const { list, state } = await snapshot();
        const access = await accessFor(signal);
        const scope = ignoredSyncScope(access);
        const remote = readRemote(await access.client.readRootFile(I.BACKUP_PATH, { maxBytes: I.MAX_BYTES }));
        await guard(scope);
        if (kind === 'restore' && remote === null) fail('missing', 'No ignored-climber backup yet.');
        const review = await storeReview(kind, scope, list, remote);
        return {
            ok: true as const,
            preview: review,
            needsReview: kind !== 'backup'
                || (remote !== null && (state.scope !== scope || remoteSignature(state.base) !== remoteSignature(remote))),
        };
    });
    const assertReviewed = (review: IgnoredSyncReview, list: I.IgnoredClimbersList): void => {
        if (list.revision !== review.revision || I.signature(list.entries) !== I.signature(review.local)) {
            fail('stale', 'Ignored climbers changed. Review the updated lists before continuing.');
        }
    };
    const reconcile = async (
        pending: IgnoredSyncPending,
        result: IgnoredSyncUpdateResult | null | undefined,
        guard: (scope?: string | null) => Promise<IgnoredSyncAccess>,
    ) => {
        await guard(pending.scope);
        return store.run(async () => {
            const current = await store.read();
            const state = await readState();
            if (state.pending?.id !== pending.id || state.controlRevision !== pending.controlRevision) {
                fail('superseded', 'The action changed before confirmation. Review changes.');
            }
            const rebased = I.mergeLists(pending.local, current.entries, pending.result);
            // A local edit made during upload stays authoritative and pending.
            if (rebased.conflicts.length) {
                const choices = Object.fromEntries(rebased.conflicts.map(conflict => [conflict.cid, 'device' as const]));
                Object.assign(rebased, I.mergeLists(pending.local, current.entries, pending.result, choices));
            }
            if (rebased.overLimit) fail('limit', 'The merged list exceeds 1,500 climbers. Review the lists.');
            await store.assertAllowed(rebased.entries);
            const changed = I.signature(current.entries) !== I.signature(rebased.entries);
            if (changed && current.revision === Number.MAX_SAFE_INTEGER) fail('storage', 'The list revision cannot be advanced.');
            const list: I.IgnoredClimbersList = changed
                ? { schemaVersion: 1, revision: current.revision + 1, entries: rebased.entries }
                : current;
            const enabled = state.enabled || pending.enable === true;
            const hasChanges = I.signature(list.entries) !== I.signature(pending.result);
            const next: IgnoredSyncState = {
                ...state,
                enabled,
                scope: pending.scope,
                base: pending.result,
                pending: null,
                review: null,
                phase: enabled ? hasChanges ? 'pending' : 'synced' : 'backed-up',
                error: '',
                lastBackup: now(),
                lastSuccess: enabled ? now() : state.lastSuccess,
                lastChecked: now(),
                retryAt: 0,
                head: result?.recovered ? null : result?.sha || state.head,
                targetBranch: result?.branch || pending.targetBranch || state.targetBranch || null,
            };
            await guard(pending.scope);
            await storage.set({ [I.IGNORED_KEY]: list, [I.SYNC_KEY]: next });
            if (enabled) armPeriodic();
            if (enabled && hasChanges) armChanges();
            return {
                ok: true as const,
                state: next,
                list,
                result: result ?? undefined,
                undo: changed
                    ? { entries: current.entries, expectedRevision: list.revision, expectedSignature: I.signature(list.entries) }
                    : null,
            };
        });
    };
    const confirm = (
        reviewId: unknown,
        rawMode: unknown = 'merge',
        rawChoices: unknown = {},
    ) => network(async ({ signal, guard }) => {
        const { list, state } = await snapshot();
        const review = state.review;
        if (!review || review.id !== reviewId || review.expiresAt <= now()) {
            fail('stale', 'This preview expired. Review the lists again.');
        }
        assertReviewed(review, list);
        await guard(review.scope);
        if (review.kind === 'restore') {
            const access = await accessFor(signal, review.scope);
            const remote = readRemote(await access.client.readRootFile(I.BACKUP_PATH, { maxBytes: I.MAX_BYTES }));
            await guard(review.scope);
            if (remote === null || remoteSignature(remote) !== remoteSignature(review.remote)) {
                fail('stale', 'The GitHub list changed. Review a fresh preview.');
            }
            return store.run(async () => {
                const current = await store.read();
                const latest = await readState();
                assertReviewed(review, current);
                if (latest.review?.id !== review.id) fail('stale', 'Review the lists again.');
                const changed = I.signature(current.entries) !== I.signature(remote);
                if (changed && current.revision === Number.MAX_SAFE_INTEGER) fail('storage', 'The list revision cannot be advanced.');
                const replacement: I.IgnoredClimbersList = changed
                    ? { schemaVersion: 1, revision: current.revision + 1, entries: remote }
                    : current;
                await store.assertAllowed(replacement.entries);
                const next: IgnoredSyncState = {
                    ...latest,
                    review: null,
                    phase: latest.enabled ? 'pending' : 'restored',
                    error: '',
                    ...(!latest.enabled ? { scope: review.scope, base: remote } : {}),
                };
                await guard(review.scope);
                await storage.set({ [I.IGNORED_KEY]: replacement, [I.SYNC_KEY]: next });
                if (latest.enabled) armChanges();
                return {
                    ok: true as const,
                    state: next,
                    list: replacement,
                    undo: changed
                        ? { entries: current.entries, expectedRevision: replacement.revision, expectedSignature: I.signature(replacement.entries) }
                        : null,
                };
            });
        }
        const mode = rawMode === undefined ? 'merge' : rawMode;
        if (typeof mode !== 'string' || !['device', 'github', 'merge'].includes(mode)) {
            fail('invalid', 'Choose how to reconcile the lists.');
        }
        const choices = rawChoices && typeof rawChoices === 'object'
            ? (rawChoices as Readonly<Record<number, I.MergeChoice>>)
            : {};
        const merged = mode === 'device' ? { entries: review.local, conflicts: [] as I.MergeConflict[] }
            : mode === 'github' ? { entries: review.remote || [], conflicts: [] as I.MergeConflict[] }
                : I.mergeLists(review.base || [], review.local, review.remote || [], choices);
        if (merged.conflicts.length) fail('conflict', 'Choose a version for each affected climber.');
        if (!entriesValid(merged.entries)) fail('limit', 'The merged list exceeds 1,500 climbers.');
        const pendingBox: { value: IgnoredSyncPending | null } = { value: null };
        const result = await writeQueue.run(async () => {
            const access = await guard(review.scope);
            return access.client.updateRootFile(I.BACKUP_PATH, async (text, metadata = {}) => {
                const remote = readRemote(text);
                await guard(review.scope);
                if (remoteSignature(remote) !== remoteSignature(review.remote)) {
                    fail('stale', 'The GitHub list changed. Review a fresh preview.');
                }
                await store.run(async () => {
                    const current = await store.read();
                    const latest = await readState();
                    assertReviewed(review, current);
                    if (latest.review?.id !== review.id) fail('stale', 'Review the lists again.');
                    await store.assertAllowed(merged.entries);
                    const nextPending: IgnoredSyncPending = {
                        id: id(),
                        kind: review.kind,
                        enable: review.kind === 'setup' || latest.enabled,
                        scope: review.scope,
                        local: current.entries,
                        revision: current.revision,
                        remote,
                        result: merged.entries,
                        controlRevision: latest.controlRevision,
                        targetBranch: metadata.branch || null,
                    };
                    pendingBox.value = nextPending;
                    await storage.set({ [I.SYNC_KEY]: { ...latest, pending: nextPending, review: null, phase: 'working', error: '' } });
                });
                return remoteSignature(remote) === I.signature(merged.entries)
                    ? (text ?? I.serializeBackup(merged.entries))
                    : I.serializeBackup(merged.entries);
            }, 'Reconcile ignored climbers', {
                maxBytes: I.MAX_BYTES,
                beforeCommit: async () => {
                    await guard(review.scope);
                    const current = await snapshot();
                    assertReviewed(review, current.list);
                    if (!pendingBox.value) fail('stale', 'Review changes again.');
                    await store.assertAllowed(pendingBox.value.result);
                },
            });
        });
        if (!pendingBox.value) fail('stale', 'Review changes again.');
        return reconcile(pendingBox.value, result, guard);
    });
    const armPeriodic = () => {
        if (!alarms) return;
        const token = generation;
        void Promise.resolve(alarms.get?.(IGNORED_SYNC_ALARM)).then(async rawExisting => {
            const existing = rawExisting as { periodInMinutes?: number } | undefined;
            const state = await readState();
            if (token !== generation || !state.enabled) return;
            if (existing?.periodInMinutes !== 15) {
                return alarms.create(IGNORED_SYNC_ALARM, { delayInMinutes: 15, periodInMinutes: 15 });
            }
        }).catch(() => {});
    };
    const armChanges = (delayInMinutes = 0.5) => {
        if (alarms) {
            void Promise.resolve(alarms.create(IGNORED_CHANGE_ALARM, { delayInMinutes })).catch(() => {});
        }
    };
    const cancel = () => { generation++; activeDeadline?.abort(); };
    const recover = async (
        state: IgnoredSyncState,
        signal: AbortSignal | undefined,
        guard: (scope?: string | null) => Promise<IgnoredSyncAccess>,
    ) => {
        const pending = state.pending;
        if (!pending) return null;
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
        throw Object.assign(new Error('The interrupted upload could not be confirmed. Review the current lists.'), {
            code: 'review',
            preview: review,
        });
    };
    const syncOperation = ({ automatic = false }: { automatic?: boolean } = {}): Promise<IgnoredSyncResponse> =>
        network(async ({ signal, guard }) => {
            const token = generation;
            let observed = await snapshot();
            // A check can wait behind a manual preview or opt-out. Revalidate on
            // entering the operation lane before automatic work can replace review.
            if (automatic && automaticSyncBlocked(observed.state)) return { ok: true as const, skipped: true as const };
            if (observed.state.retryAt > now()) {
                fail('rate-limit', 'GitHub asked us to wait before retrying. Changes remain saved on this device.');
            }
            if (observed.state.pending) {
                const recovered = await recover(observed.state, signal, guard);
                if (recovered) return recovered;
                observed = await snapshot();
            }
            if (!observed.state.enabled) return prepare('setup');
            if (observed.state.base === null) {
                // Establish a fresh baseline by keeping both lists. Ambiguous
                // metadata and oversized unions still require an explicit review.
                const prepared = await prepare('setup');
                const merged = I.mergeLists([], prepared.preview.local, prepared.preview.remote || []);
                if (merged.conflicts.length || merged.overLimit) return prepared;
                // Confirmation starts a new network stage. It must not adopt a
                // newer generation after this automatic setup was cancelled.
                if (token !== generation || signal?.aborted) fail('cancelled', 'This action was cancelled.');
                return confirm(prepared.preview.id, 'merge');
            }
            const scope = observed.state.scope;
            const pendingBox: { value: IgnoredSyncPending | null } = { value: null };
            const result = await writeQueue.run(async () => {
                const access = await guard(scope);
                return access.client.updateRootFile(I.BACKUP_PATH, async (text, metadata = {}) => {
                    const remote = readRemote(text);
                    await guard(scope);
                    const { list, state } = await snapshot();
                    if (!state.enabled || state.scope !== scope) fail('superseded', 'Set up sync for the current GitHub connection.');
                    if (state.targetBranch && metadata.branch && state.targetBranch !== metadata.branch) {
                        fail('setup', 'The repository default branch changed. Set up sync again.');
                    }
                    if (remote === null) {
                        const review = await storeReview('recovery', scope!, list, null);
                        throw Object.assign(new Error('The ignored-climber file disappeared. Review changes before recreating it.'), {
                            code: 'review',
                            preview: review,
                        });
                    }
                    const merged = I.mergeLists(state.base || [], list.entries, remote);
                    if (merged.conflicts.length || merged.overLimit) {
                        const review = await storeReview('conflict', scope!, list, remote, state.base);
                        throw Object.assign(new Error(merged.overLimit ? 'The merged list exceeds 1,500 climbers.'
                            : 'Both lists changed the same climber. Choose which version to keep.'), {
                            code: 'review',
                            preview: review,
                        });
                    }
                    await store.run(async () => {
                        const current = await store.read();
                        const latest = await readState();
                        if (!latest.enabled || latest.scope !== scope || current.revision !== list.revision
                            || I.signature(current.entries) !== I.signature(list.entries)) {
                            fail('stale', 'The list changed before upload. Sync again.');
                        }
                        await store.assertAllowed(merged.entries);
                        const nextPending: IgnoredSyncPending = {
                            id: id(),
                            kind: 'sync',
                            enable: true,
                            scope: scope!,
                            local: list.entries,
                            revision: list.revision,
                            remote,
                            result: merged.entries,
                            controlRevision: latest.controlRevision,
                            observedHead: metadata.head || null,
                            targetBranch: metadata.branch || null,
                        };
                        pendingBox.value = nextPending;
                        await guard(scope);
                        await storage.set({ [I.SYNC_KEY]: { ...latest, pending: nextPending, review: null, phase: 'working', error: '' } });
                    });
                    return remoteSignature(remote) === I.signature(merged.entries)
                        ? (text ?? I.serializeBackup(merged.entries))
                        : I.serializeBackup(merged.entries);
                }, 'Sync ignored climbers', {
                    maxBytes: I.MAX_BYTES,
                    beforeCommit: async () => {
                        await guard(scope);
                        const current = await snapshot();
                        const activePending = pendingBox.value;
                        if (!activePending) fail('stale', 'The list changed before upload. Sync again.');
                        await store.assertAllowed(activePending.result);
                        if (!current.state.enabled || current.state.controlRevision !== activePending.controlRevision
                            || current.list.revision !== activePending.revision
                            || I.signature(current.list.entries) !== I.signature(activePending.local)) {
                            fail('stale', 'The list changed before upload. Sync again.');
                        }
                    },
                });
            });
            if (!pendingBox.value) fail('stale', 'The list changed before upload. Sync again.');
            return reconcile(pendingBox.value, result, guard);
        });
    const sync = (options?: { automatic?: boolean }): Promise<IgnoredSyncResponse> => {
        if (syncPromise) return syncPromise;
        const operation = serial(() => safely(() => syncOperation(options)));
        syncPromise = operation;
        void operation.finally(() => { if (syncPromise === operation) syncPromise = null; });
        return operation;
    };
    const automatic = async (): Promise<IgnoredSyncResponse> => {
        const { state } = await snapshot();
        if (automaticSyncBlocked(state)) return { ok: true, skipped: true };
        const access = await getAccess({});
        if (access.error && ['not-connected', 'no-repo'].includes(access.error.code)) return { ok: true, skipped: true };
        if (state.retryAt > now()) {
            armChanges(Math.max(0.5, (state.retryAt - now()) / 60000));
            return { ok: true, skipped: true };
        }
        const response = await sync({ automatic: true });
        if (!response.ok && (await readState()).phase !== 'review') {
            armChanges(Math.max(1, (response.error?.retryAfterSeconds || 60) / 60));
        }
        return response;
    };
    const status = (): Promise<IgnoredSyncResponse> => safely(async () => {
        const { list, state } = await snapshot();
        if (state.enabled && state.phase === 'synced' && I.signature(list.entries) !== remoteSignature(state.base)) {
            state.phase = 'pending';
        }
        return { ok: true as const, count: list.entries.length, state, preview: state.review ? preview(state.review) : null };
    });
    const disable = async (): Promise<IgnoredSyncResponse> => {
        cancel();
        if (alarms?.clear) {
            await alarms.clear(IGNORED_SYNC_ALARM);
            await alarms.clear(IGNORED_CHANGE_ALARM);
        }
        return safely(async () => ({
            ok: true as const,
            state: await saveState(state => ({
                ...state,
                enabled: false,
                controlRevision: state.controlRevision + 1,
                review: null,
                phase: state.pending ? 'review' : 'local',
                error: state.pending ? 'An interrupted upload needs review.' : '',
            })),
        }));
    };
    const enable = (): Promise<IgnoredSyncResponse> => {
        const token = generation;
        return serial(() => safely(async () => {
            const state = await saveState(current => {
                if (token !== generation) fail('cancelled', 'This action was cancelled.');
                return { ...current, enabled: true, phase: current.review || current.pending ? 'review' : 'pending', error: '' };
            });
            armPeriodic();
            armChanges();
            return { ok: true as const, state };
        }));
    };
    const connectionChanged = (): Promise<IgnoredSyncResponse | void> => {
        cancel();
        if (alarms?.clear) {
            void alarms.clear(IGNORED_SYNC_ALARM);
            void alarms.clear(IGNORED_CHANGE_ALARM);
        }
        return saveState(state => ({
            ...state,
            controlRevision: state.controlRevision + 1,
            scope: null,
            base: null,
            targetBranch: null,
            review: null,
            phase: state.pending ? 'review' : state.enabled ? 'pending' : 'local',
            error: state.pending ? 'An interrupted upload needs review.' : '',
        })).then(() => start()).catch(() => {});
    };
    const localChanged = async (): Promise<void> => {
        const token = generation;
        const changed = await store.run(async () => {
            const list = await store.read();
            const state = await readState();
            if (!state.enabled || I.signature(list.entries) === remoteSignature(state.base)) return false;
            await storage.set({ [I.SYNC_KEY]: { ...state, phase: state.review ? 'review' : 'pending' } });
            return true;
        });
        if (changed && token === generation) armChanges();
    };
    const start = async ({ startup = false }: { startup?: boolean } = {}): Promise<IgnoredSyncResponse> => {
        const { state } = await snapshot();
        if (state.enabled) {
            armPeriodic();
            if (startup || state.pending || state.base === null) return automatic();
            return { ok: true, skipped: true };
        }
        // Setup was confirmed, but the worker stopped before reconciliation.
        if (state.pending?.enable && state.pending.controlRevision === state.controlRevision) return sync();
        return { ok: true, skipped: true };
    };
    const check = async (): Promise<IgnoredSyncResponse> => {
        const { state } = await snapshot();
        if (now() - (state.lastChecked || 0) < 60000) return { ok: true, skipped: true };
        return automatic();
    };
    const action = (message: IgnoredSyncActionMessage): Promise<IgnoredSyncResponse> => {
        if (message.action === 'enable') return enable();
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
            if (message.action === 'dismiss') {
                return {
                    ok: true as const,
                    state: await saveState(state => ({
                        ...state,
                        review: null,
                        phase: state.pending ? 'review' : state.enabled ? 'pending' : 'local',
                        error: '',
                    })),
                };
            }
            if (message.action === 'confirm') return confirm(message.reviewId, message.mode, message.choices);
            fail('invalid', 'Invalid ignored-climber backup action.');
        }));
    };
    return {
        status,
        action,
        cancel,
        connectionChanged,
        localChanged,
        start,
        onAlarm: (name: string): Promise<IgnoredSyncResponse> | undefined =>
            [IGNORED_SYNC_ALARM, IGNORED_CHANGE_ALARM].includes(name) ? safely(automatic) : undefined,
    };
};
