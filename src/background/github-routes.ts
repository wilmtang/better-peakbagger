// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guardRootBackup, type GuardRootBackupInput } from '../github/root-backup-guard.ts';
import { createClimberListSync, type IgnoredSyncActionMessage } from './climber-list-sync.ts';
import * as Ignored from '../favorites/ignored-climbers.ts';
import { createIgnoredStore } from './ignored-store.ts';
import { settings as Settings, type SettingsData } from '../settings/settings.ts';
import {
    settingsTransfer as Transfer,
    type SettingsTransferGithubConnection,
} from '../settings/settings-transfer.ts';
import { customLayerBackup, type CustomLayerBackup, type CustomLayerSnapshot } from '../maps/custom-overlay-transfer.ts';
import { CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY } from '../maps/custom-overlay-schema.ts';
import { favoriteClimbers as Favorites } from '../favorites/favorite-climbers.ts';
import {
    photoBackup as PhotoBackup,
    type PhotoBackupMergeResult,
    type PhotoBackupPayload,
} from '../photos/photo-backup.ts';
import { photoStore as PhotoStore } from '../photos/photo-store.ts';
import {
    githubAuth as GithubAuth,
    type GithubAccount,
    type GithubAuthRecord,
    type GithubAuthSnapshot,
    type GithubBackupRepository,
} from '../github/github-auth.ts';
import { githubClient as GithubClient, type AscentBackupSnapshot } from '../github/github-client.ts';
import { githubErrors as GithubErrors, type PublicGithubError } from '../github/github-errors.ts';
import { githubWriteQueue as GithubWriteQueue } from '../github/github-write-queue.ts';
import { requestDeadline as Deadline } from '../net/request-deadline.ts';
import { publicErrors as PublicErrors } from './public-errors.ts';
import { trustedActions as TrustedActions } from './trusted-actions.ts';
import { createPackagedPageMatcher } from './sender-policy.ts';

export type GithubRouteHandler = (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
) => unknown;

export interface GithubRouteDefinition {
    handler: GithubRouteHandler;
    extensionOnly: boolean;
}

export type GithubRoutesMessage = Record<string, unknown>;

export interface GithubLocalStorageArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove?(keys: string | string[]): Promise<void>;
}

export interface GithubSessionStorageArea {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
}

export interface GithubAlarmsArea {
    create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }): unknown;
    get?(name: string): Promise<{ periodInMinutes?: number } | undefined>;
    clear?(name: string): Promise<boolean>;
}

export interface GithubRoutesExt {
    runtime?: {
        id?: string;
        getURL?: (path: string) => string;
        getManifest?: () => { version?: string };
    };
    storage: {
        local: GithubLocalStorageArea;
    };
    alarms?: GithubAlarmsArea | null;
}

export type GithubBackupClient = ReturnType<typeof GithubClient.createGithubClient>;

export interface ConnectedGithubSuccess {
    authorizationEpoch?: number;
    repo: {
        owner: string;
        name: string;
        branch: string | null;
    };
    client: GithubBackupClient;
    error?: undefined;
}

export interface ConnectedGithubFailure {
    authorizationEpoch?: number;
    error: {
        code: string;
        message?: string;
        status?: number;
        retryAfterSeconds?: number;
    };
}

export type ConnectedGithubAccess = ConnectedGithubSuccess | ConnectedGithubFailure;

export interface PhotoBackupSettingsReader {
    requireCurrent(): Promise<Pick<SettingsData, 'autoPhotoLibraryBackup'>>;
    get(): Promise<Pick<SettingsData, 'autoPhotoLibraryBackup'>>;
}

export interface CreateGithubRoutesOptions {
    customLayers?: {
        snapshot(options?: { includePrivate?: boolean }): Promise<CustomLayerSnapshot>;
    } | null;
    ext: GithubRoutesExt;
    snapshotKey?: string;
    storage?: () => GithubSessionStorageArea;
    now: () => number;
    peakbaggerLogin?: () => Promise<number | string | null | undefined>;
    peakbaggerNavigationAccount?: () => Promise<{ status?: string; cid?: number | string | null } | null | undefined>;
    isPeakbaggerSender?: (sender: chrome.runtime.MessageSender) => boolean;
    isClimbListSender?: (sender: chrome.runtime.MessageSender) => boolean;
    isFresh?: (record: unknown) => boolean;
    readMap?: <Value = Record<string, unknown>>(key: string) => Promise<Record<string, Value>>;
    mutateMap?: <Result = unknown, Value = Record<string, unknown>>(
        key: string,
        mutate: (map: Record<string, Value>) => Result | Promise<Result>,
    ) => Promise<Result>;
    createPhotoStore?: typeof PhotoStore.createPhotoStore;
    resolveGithubAccess?: ((options?: {
        requireEnabled?: boolean;
        signal?: AbortSignal | null;
    }) => Promise<ConnectedGithubAccess>) | null;
    ignoredStore?: ReturnType<typeof createIgnoredStore> | null;
    photoBackupSettings?: PhotoBackupSettingsReader;
    trustedActions?: {
        consumeGrant(
            message: object,
            sender: chrome.runtime.MessageSender,
            action: string,
            options?: { oneUse?: boolean },
        ): Promise<boolean> | boolean;
    } | null;
}

interface PendingGithubAuth {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string | null;
    expiresIn: number;
    interval: number;
    startedAt: number;
    expiresAt: number;
    nextPollAt: number;
}

interface StoredSnapshotIdentity {
    ascentId?: unknown;
    peakId?: unknown;
    date?: unknown;
}

interface StoredBackupSnapshot {
    ascent?: Record<string, unknown>;
    peak?: Record<string, unknown>;
    report?: {
        markdown?: unknown;
        submitted?: unknown;
    };
    backup?: Record<string, unknown>;
}

interface StoredSnapshotRecord {
    identity?: StoredSnapshotIdentity | null;
    attemptId?: string | null;
    snapshot?: StoredBackupSnapshot;
    sourceTabId?: number | null;
    generation?: string;
    savedAt?: number;
    expiresAt?: number;
}

interface AscentDeleteIntentRecord {
    aid: number;
    sourceTabId: number;
    state: 'pending' | 'completed';
    createdAt: number;
    completedAt?: number;
    expiresAt: number;
}

interface AutoBackupState {
    signature?: string;
    scope?: string;
    syncedAt?: string;
    needsReview?: boolean;
    attempts?: number;
    attemptScope?: string;
}

interface PhotoBackupStateRecord {
    signature?: string;
    signatureVersion?: number;
    generation?: number;
    revisions?: Record<string, number>;
    syncedAt?: string;
    restoredAt?: string;
    commitUrl?: string | null;
    repo?: {
        owner: string;
        name: string;
        branch?: string | null;
    } | null;
    attempts?: number;
    reconciliationPending?: boolean;
    capacityBlockedGeneration?: number | null;
    capacityActualBytes?: number;
    capacityMaxBytes?: number;
}

type BackupPhotoLibraryResult =
    | {
        ok: true;
        current: boolean;
        signature?: string;
        unchanged?: boolean;
        reconciliationPending?: boolean;
        result?: unknown;
        counts?: unknown;
        warning?: { code: string; message: string };
    }
    | {
        ok: false;
        error: { code: string; message?: string; [key: string]: unknown };
    };

const GITHUB_AUTH_PENDING_KEY = 'bpbGithubAuthPending';
const FAVORITE_CLIMBERS_BACKUP_PATH = 'favorite-climbers.json';
const SETTINGS_BACKUP_ALARM = 'bpb-settings-backup';
const SETTINGS_BACKUP_STATE_KEY = 'bpbSettingsBackupState';
const FAVORITES_BACKUP_ALARM = 'bpb-favorites-backup';
const FAVORITES_BACKUP_STATE_KEY = 'bpbFavoritesBackupState';
const PHOTO_BACKUP_ALARM = 'bpb-photo-library-backup';
const PHOTO_BACKUP_STATE_KEY = 'bpbPhotoLibraryBackupState';
const PHOTO_BACKUP_GATE_KEY = 'bpbPhotoLibraryBackupGate';
const AUTO_BACKUP_DELAY_MINUTES = 1;
const AUTO_BACKUP_RETRY_MINUTES = 10;
const AUTO_BACKUP_MAX_RETRIES = 2;
const AUTO_BACKUP_WATCHDOG_MINUTES = 30;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_LIMIT = 10;
const PROFILE_BACKUP_BATCH_LIMIT = 10;
const ASCENT_DELETE_INTENTS_KEY = 'bpbGithubAscentDeleteIntents';
const ASCENT_DELETE_TTL_MS = 30 * 60 * 1000;
const ASCENT_GITHUB_OPERATION_TIMEOUT_MS = 2 * 60 * 1000;

// Keep access policy beside every handler. A bare function is rejected while
// the worker boots, so adding a route without deciding who may call it cannot
// silently inherit a stale hand-maintained allowlist.
export const createGithubRouteTable = <T extends Record<string, GithubRouteDefinition>>(definitions: T) => {
    const handlers: Record<string, GithubRouteHandler> = {};
    const extensionOnly = new Set<string>();
    for (const [type, definition] of Object.entries(definitions || {})) {
        if (!definition || typeof definition.handler !== 'function'
            || typeof definition.extensionOnly !== 'boolean') {
            throw new TypeError(`GitHub route ${type} must declare its access policy.`);
        }
        handlers[type] = definition.handler;
        if (definition.extensionOnly) extensionOnly.add(type);
    }
    return {
        handlers: Object.freeze(handlers) as Readonly<{ [K in keyof T]: T[K]['handler'] }>,
        isExtensionOnly: (type: string): boolean => extensionOnly.has(type),
    };
};

const peakbaggerPage = (handler: GithubRouteHandler): GithubRouteDefinition => ({ handler, extensionOnly: false });

export function createGithubRoutes({
    customLayers = null,
    ext,
    snapshotKey: SNAPSHOTS_KEY = '',
    storage = (() => {
        throw new Error('Session storage is unavailable.');
    }) as unknown as () => GithubSessionStorageArea,
    now,
    peakbaggerLogin = async () => null,
    peakbaggerNavigationAccount = async () => ({ status: 'unverified', cid: null }),
    isPeakbaggerSender = () => false,
    isClimbListSender = () => false,
    isFresh = () => false,
    readMap = async () => ({}),
    mutateMap = async (_key, mutate) => mutate({}),
    createPhotoStore = PhotoStore.createPhotoStore,
    resolveGithubAccess = null,
    ignoredStore = null,
    photoBackupSettings = Settings,
    trustedActions = null,
}: CreateGithubRoutesOptions) {
    const optionsPages = ['options/options.html'];
    const climberPages = [...optionsPages, 'options/favorites.html'];
    const photoPages = [...optionsPages, 'photos/photos.html'];
    const extensionPage = (
        handler: GithubRouteHandler,
        pages: string[] = optionsPages,
    ): GithubRouteDefinition => {
        const accepts = createPackagedPageMatcher(ext, pages);
        return {
            extensionOnly: true,
            handler: (message, sender) => accepts(sender)
                ? handler(message, sender) : { ok: false, error: { code: 'forbidden' } },
        };
    };
    // ---- GitHub ascent and TR backup: auth + repository setup --------------
    //
    // These GitHub routes keep the token in the worker and never return it in a
    // GitHub response. The separate exact-Settings-page file route may include
    // it only for an explicit manual transfer. The device-flow poll is driven
    // in the worker; the options page shows the user code and advances a
    // persisted, one-request-at-a-time poll through GITHUB_AUTH_STATE. Repo
    // scoping happens on GitHub's own install page, then discovery lists exactly
    // what the token can reach.

    const netFetch = (url: string, init?: RequestInit) => fetch(url, init);
    const readPendingGithubAuth = async (): Promise<PendingGithubAuth | null> =>
        ((await storage().get(GITHUB_AUTH_PENDING_KEY))[GITHUB_AUTH_PENDING_KEY] as PendingGithubAuth | undefined) || null;
    const writePendingGithubAuth = (pending: PendingGithubAuth) =>
        storage().set({ [GITHUB_AUTH_PENDING_KEY]: pending });
    const clearPendingGithubAuth = () => storage().remove(GITHUB_AUTH_PENDING_KEY);
    let githubAuthEpoch = 0;
    let githubAuthStateQueue: Promise<unknown> = Promise.resolve();
    const mutateGithubAuthState = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = githubAuthStateQueue.then(operation, operation);
        githubAuthStateQueue = pending.catch(() => {});
        return pending;
    };
    const samePendingGithubAuth = (
        left: PendingGithubAuth | null | undefined,
        right: PendingGithubAuth | null | undefined,
    ): boolean => !!left && !!right
        && left.deviceCode === right.deviceCode
        && left.startedAt === right.startedAt;
    const publicGithubAuthState = (pending: PendingGithubAuth) => ({
        phase: 'polling' as const,
        userCode: pending.userCode,
        verificationUri: pending.verificationUri,
        verificationUriComplete: pending.verificationUriComplete,
        expiresIn: pending.expiresIn,
        startedAt: pending.startedAt,
    });

    const positiveAscentId = (value: unknown): number | null => {
        if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    };

    const peakbaggerMyAscents = async () => {
        let account: { status?: string; cid?: number | string | null } | null | undefined;
        try {
            account = await peakbaggerNavigationAccount();
        } catch (error) {
            if (PublicErrors.isPublic(error)) return { ok: false, error: { source: 'peakbagger', ...PublicErrors.expose(error) } };
            const err = error && typeof error === 'object'
                ? (error as { source?: unknown; code?: unknown; message?: unknown })
                : null;
            const peakbaggerFailure = err?.source === 'peakbagger';
            return {
                ok: false,
                error: {
                    ...(peakbaggerFailure ? { source: 'peakbagger' } : {}),
                    code: peakbaggerFailure && typeof err?.code === 'string' && err.code
                        ? err.code : 'peakbagger-unavailable',
                    message: peakbaggerFailure && typeof err?.message === 'string' && err.message
                        ? err.message
                        : 'Could not reach Peakbagger. Check your connection, then try again.',
                },
            };
        }
        const cid = account?.status === 'signed-in' ? positiveAscentId(account.cid) : null;
        if (!cid) {
            const signedOut = account?.status === 'signed-out';
            return {
                ok: false,
                error: {
                    code: signedOut ? 'peakbagger-signed-out' : 'peakbagger-unverified',
                    message: signedOut ? 'Sign in to Peakbagger, then try again.'
                        : 'Your Peakbagger account could not be verified. Open Peakbagger, check your session, then try again.',
                },
            };
        }
        const url = new URL('https://www.peakbagger.com/climber/ClimbListC.aspx');
        url.searchParams.set('cid', String(cid));
        url.searchParams.set('j', '-1');
        url.searchParams.set('y', '9999');
        url.searchParams.set('sort', 'AscentDate');
        return { ok: true, url: url.toString() };
    };

    const publicGithubStatus = (auth: GithubAuthRecord | null | undefined, settings: SettingsData) => ({
        enabled: settings.enableGithubBackup,
        auto: settings.autoGithubBackup,
        connected: !!(auth && auth.token && auth.repo && auth.repo.owner && auth.repo.name),
        hasToken: !!(auth && auth.token),
        account: (auth && auth.account) || null,
        repo: (auth && auth.repo) || null,
        installUrl: GithubAuth.INSTALL_URL,
        appUrl: GithubAuth.APP_URL,
        verificationUri: GithubAuth.VERIFICATION_URI,
    });
    const githubStatus = async () => {
        const auth = await GithubAuth.authStore.read();
        const settings = await Settings.get();
        const states = await ext.storage.local.get([SETTINGS_BACKUP_STATE_KEY, FAVORITES_BACKUP_STATE_KEY]);
        const settingsState = states[SETTINGS_BACKUP_STATE_KEY] as AutoBackupState | undefined;
        const favoritesState = states[FAVORITES_BACKUP_STATE_KEY] as AutoBackupState | undefined;
        return {
            ...publicGithubStatus(auth, settings),
            settingsBackupNeedsReview: settingsState?.needsReview === true,
            favoritesBackupNeedsReview: favoritesState?.needsReview === true,
        };
    };

    const supersededGithubAuth = () => ({
        phase: 'error' as const,
        code: 'superseded',
        message: 'The GitHub connection changed while this request was finishing. Review the current connection and try again.',
    });

    // Keep an existing choice only while it remains in the app installation.
    // New connections always go through repository inspection; auto-selecting a
    // sole repo would skip the populated-repository confirmation and collision
    // checks that make this write boundary safe.
    const reconcileDiscoveredRepo = async (
        repos: GithubBackupRepository[],
        snapshot: GithubAuthSnapshot,
    ): Promise<{ ok: true; snapshot: GithubAuthSnapshot } | { ok: false }> => {
        const selected = snapshot.auth?.repo;
        if (!selected) {
            return (await GithubAuth.authStore.isSnapshotCurrent(snapshot))
                ? { ok: true, snapshot }
                : { ok: false };
        }
        const stillGranted = repos.some(repo => repo.owner === selected.owner && repo.name === selected.name);
        if (stillGranted) {
            return (await GithubAuth.authStore.isSnapshotCurrent(snapshot))
                ? { ok: true, snapshot }
                : { ok: false };
        }
        const replacement: GithubAuthRecord = { ...snapshot.auth, repo: null, installationId: null };
        const result = await GithubAuth.authStore.replaceIfSnapshot(snapshot, replacement);
        return result.replaced ? { ok: true, snapshot: result.current } : { ok: false };
    };

    const sameImportedRepository = (
        candidate: GithubBackupRepository,
        requested: SettingsTransferGithubConnection['repository'],
    ): boolean => {
        if (requested.id != null) return candidate.id === requested.id;
        return candidate.owner?.toLocaleLowerCase('en-US') === requested.owner.toLocaleLowerCase('en-US')
            && candidate.name?.toLocaleLowerCase('en-US') === requested.name.toLocaleLowerCase('en-US');
    };

    // A portable settings file carries an opaque user token and the repository
    // identity that was previously selected. Re-prove both against GitHub and
    // run the ordinary repository inspection before the settings-file route is
    // allowed to replace any local store.
    const validateImportedConnection = async (
        connection: SettingsTransferGithubConnection,
    ): Promise<{ ok: true; auth: GithubAuthRecord } | { ok: false; error: PublicGithubError }> => {
        try {
            const { token, repository: requested } = connection;
            const [account, discovered] = await Promise.all([
                GithubAuth.fetchAccount({ fetch: netFetch, token }),
                GithubAuth.listBackupRepositories({ fetch: netFetch, token }),
            ]);
            const granted = discovered.repos.find(repo => sameImportedRepository(repo, requested));
            if (!granted) {
                throw new GithubErrors.GithubError(
                    GithubErrors.ERROR_CODES.NO_ACCESS,
                    'The exported GitHub repository is no longer granted to Better Peakbagger.',
                );
            }
            if (!granted.owner) {
                throw new TypeError('github client requires owner and repo');
            }
            const client = GithubClient.createGithubClient({
                fetch: netFetch,
                token,
                owner: granted.owner,
                repo: granted.name,
                branch: granted.defaultBranch || undefined,
            });
            const inspection = await client.inspectRepository();
            return {
                ok: true,
                auth: {
                    token,
                    tokenType: 'bearer',
                    scope: '',
                    grantedAt: new Date().toISOString(),
                    account,
                    repo: {
                        owner: granted.owner,
                        name: granted.name,
                        branch: inspection.branch,
                        id: (granted.id ?? null) as unknown as number | undefined,
                        fullName: granted.fullName || `${granted.owner}/${granted.name}`,
                    },
                    installationId: granted.installationId ?? null,
                },
            };
        } catch (error) {
            return {
                ok: false,
                error: GithubErrors.publicError(
                    error,
                    'The GitHub connection in this file could not be verified.',
                ),
            };
        }
    };

    const githubBeginAuth = async () => {
        const epoch = ++githubAuthEpoch;
        await mutateGithubAuthState(() => clearPendingGithubAuth());
        const flow = GithubAuth.createDeviceFlow({ fetch: netFetch });
        let code: Awaited<ReturnType<typeof flow.requestCode>>;
        try {
            code = await flow.requestCode();
        } catch (error) {
            if (epoch !== githubAuthEpoch) return { phase: 'idle' };
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
        if (epoch !== githubAuthEpoch) return { phase: 'idle' };
        const startedAt = now();
        const pending: PendingGithubAuth = {
            deviceCode: code.deviceCode,
            userCode: code.userCode,
            verificationUri: code.verificationUri,
            verificationUriComplete: code.verificationUriComplete,
            expiresIn: code.expiresIn,
            interval: Math.max(1, Number(code.interval) || 5),
            startedAt,
            expiresAt: startedAt + code.expiresIn * 1000,
            nextPollAt: startedAt + Math.max(1, Number(code.interval) || 5) * 1000,
        };
        const stored = await mutateGithubAuthState(async () => {
            if (epoch !== githubAuthEpoch) return false;
            await writePendingGithubAuth(pending);
            return epoch === githubAuthEpoch;
        });
        return stored ? publicGithubAuthState(pending) : { phase: 'idle' };
    };

    const githubPollAuth = async () => {
        const snapshot = await mutateGithubAuthState(async () => ({
            pending: await readPendingGithubAuth(),
            epoch: githubAuthEpoch,
        }));
        const { pending, epoch } = snapshot;
        if (!pending) return { phase: 'idle' };
        const authSnapshot = await GithubAuth.authStore.readSnapshot();
        if (now() > pending.expiresAt) {
            const cleared = await mutateGithubAuthState(async () => {
                if (epoch !== githubAuthEpoch) return false;
                const current = await readPendingGithubAuth();
                if (!samePendingGithubAuth(current, pending)) return false;
                await clearPendingGithubAuth();
                return true;
            });
            return cleared ? { phase: 'error', code: 'expired' } : { phase: 'idle' };
        }
        if (now() < pending.nextPollAt) return publicGithubAuthState(pending);

        const flow = GithubAuth.createDeviceFlow({ fetch: netFetch });
        try {
            const result = await flow.pollTokenOnce(pending);
            if (epoch !== githubAuthEpoch) return { phase: 'idle' };
            if (result.phase === 'pending' || result.phase === 'slow-down') {
                const interval = result.phase === 'slow-down'
                    ? Math.max(pending.interval + 5, result.interval)
                    : pending.interval;
                const next: PendingGithubAuth = { ...pending, interval, nextPollAt: now() + interval * 1000 };
                const stored = await mutateGithubAuthState(async () => {
                    if (epoch !== githubAuthEpoch) return false;
                    const current = await readPendingGithubAuth();
                    if (!samePendingGithubAuth(current, pending)) return false;
                    await writePendingGithubAuth(next);
                    return epoch === githubAuthEpoch;
                });
                return stored ? publicGithubAuthState(next) : { phase: 'idle' };
            }

            const cred = result.credential;
            let account: GithubAccount | null = null;
            try { account = await GithubAuth.fetchAccount({ fetch: netFetch, token: cred.token }); } catch { /* non-fatal */ }
            if (epoch !== githubAuthEpoch) return { phase: 'idle' };
            let repos: GithubBackupRepository[] = [];
            let installationCount = 0;
            try {
                const discovered = await GithubAuth.listBackupRepositories({ fetch: netFetch, token: cred.token });
                repos = discovered.repos;
                installationCount = discovered.installationCount;
            } catch { /* the user may not have installed yet; discover again later */ }
            if (epoch !== githubAuthEpoch) return { phase: 'idle' };

            // Claim the persisted device flow before the first credential
            // write. A second poll, a new flow, or Disconnect can then make
            // this response stale without letting it recreate local auth.
            const claimed = await mutateGithubAuthState(async () => {
                if (epoch !== githubAuthEpoch) return false;
                const current = await readPendingGithubAuth();
                if (!samePendingGithubAuth(current, pending)) return false;
                await clearPendingGithubAuth();
                return epoch === githubAuthEpoch;
            });
            if (!claimed) return { phase: 'idle' };

            if (epoch !== githubAuthEpoch) return { phase: 'idle' };
            const installed = await GithubAuth.authStore.replaceIfSnapshot(authSnapshot, {
                token: cred.token,
                tokenType: cred.tokenType || 'bearer',
                scope: cred.scope || '',
                grantedAt: new Date().toISOString(),
                account,
                repo: null,
                installationId: null,
            });
            if (!installed.replaced) return { phase: 'idle' };
            if (epoch !== githubAuthEpoch) return { phase: 'idle' };
            return { phase: 'authorized', account, repos, installationCount };
        } catch (error) {
            if (epoch !== githubAuthEpoch) return { phase: 'idle' };
            await mutateGithubAuthState(async () => {
                if (epoch !== githubAuthEpoch) return;
                const current = await readPendingGithubAuth();
                if (samePendingGithubAuth(current, pending)) await clearPendingGithubAuth();
            });
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
    };

    // Re-list repositories on demand — after the user returns from the install
    // page having granted (or changed) the selected repositories.
    const githubDiscoverRepos = async () => {
        const snapshot = await GithubAuth.authStore.readSnapshot();
        const token = snapshot.auth?.token;
        if (!token) return { phase: 'error', code: 'no-token' };
        try {
            const { repos, installationCount } = await GithubAuth.listBackupRepositories({ fetch: netFetch, token });
            const reconciliation = await reconcileDiscoveredRepo(repos, snapshot);
            if (!reconciliation.ok) return supersededGithubAuth();
            return { installationCount, repos, repo: reconciliation.snapshot.auth?.repo || null };
        } catch (error) {
            if (!(await GithubAuth.authStore.isSnapshotCurrent(snapshot))) {
                return supersededGithubAuth();
            }
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
    };

    const githubSelectRepo = async (message: GithubRoutesMessage) => {
        const r = message && message.repo && typeof message.repo === 'object'
            ? (message.repo as Record<string, unknown>)
            : null;
        if (!r || typeof r.owner !== 'string' || !r.owner || typeof r.name !== 'string' || !r.name) {
            return { error: 'invalid-repo' };
        }
        const snapshot = await GithubAuth.authStore.readSnapshot();
        if (message.confirmExisting && message.authorizationEpoch !== snapshot.epoch) {
            return supersededGithubAuth();
        }
        const token = snapshot.auth?.token;
        if (!token) return { connected: false, error: { code: 'no-token' } };
        const repoOwner = r.owner;
        const repoName = r.name;
        const requestedBranch = (typeof r.branch === 'string' && r.branch)
            || (typeof r.defaultBranch === 'string' && r.defaultBranch)
            || undefined;
        const client = GithubClient.createGithubClient({
            fetch: netFetch,
            token,
            owner: repoOwner,
            repo: repoName,
            branch: requestedBranch,
        });
        let inspection: Awaited<ReturnType<typeof client.inspectRepository>>;
        try {
            inspection = await client.inspectRepository();
        } catch (error) {
            if (!(await GithubAuth.authStore.isSnapshotCurrent(snapshot))) {
                return supersededGithubAuth();
            }
            return {
                connected: false,
                error: GithubErrors.publicError(error, 'Could not inspect the repository.'),
            };
        }
        if (!(await GithubAuth.authStore.isSnapshotCurrent(snapshot))) {
            return supersededGithubAuth();
        }
        if (inspection.kind === 'existing' && !message.confirmExisting) {
            return {
                connected: false,
                needsConfirmation: true,
                repo: r,
                inspection,
                authorizationEpoch: snapshot.epoch,
            };
        }
        const repoFullName = typeof r.fullName === 'string' && r.fullName
            ? r.fullName
            : `${repoOwner}/${repoName}`;
        const repoId = typeof r.id === 'number' ? r.id : null;
        const installationId = typeof r.installationId === 'number' ? r.installationId : null;
        const replacement: GithubAuthRecord = {
            ...snapshot.auth,
            repo: {
                owner: repoOwner,
                name: repoName,
                branch: inspection.branch,
                id: repoId as unknown as number | undefined,
                fullName: repoFullName,
            },
            installationId,
        };
        // Freeze this device's choices before the new connection can enable
        // any legacy automatic-transfer preferences inherited from sync.
        await Settings.migrate();
        const installed = await GithubAuth.authStore.replaceIfSnapshot(snapshot, replacement);
        if (!installed.replaced) return supersededGithubAuth();
        const settings = await Settings.get();
        return {
            ...publicGithubStatus(installed.current.auth, settings),
            inspection,
        };
    };

    const githubDisconnect = async () => {
        githubAuthEpoch += 1;
        await Promise.all([
            mutateGithubAuthState(() => clearPendingGithubAuth()),
            GithubAuth.authStore.clear(),
        ]);
        // Clearing the one local record removes the token, repository, and
        // derived account together while advancing its persisted generation.
        // Do not immediately re-read storage just to prove what the successful
        // replacement already established: a
        // follow-up read failure would make the UI report an ambiguous
        // disconnect even though the credential is gone.
        return {
            connected: false,
            hasToken: false,
            account: null,
            repo: null,
            installUrl: GithubAuth.INSTALL_URL,
            appUrl: GithubAuth.APP_URL,
            verificationUri: GithubAuth.VERIFICATION_URI,
        };
    };


    // The save-time snapshot from the ascentedit content script: keep it in
    // storage.session, keyed by identity and source tab, for the saved ascent
    // page to back up. The tab namespace prevents two simultaneous new-ascent
    // forms for the same climber/peak/date from overwriting one another before
    // Peakbagger has assigned either ascent an id.
    // Accepted only from a Peakbagger tab and only while the feature is enabled;
    // the cleanup alarm expires it on the 30-minute horizon.
    const storeBackupSnapshot = async (
        message: GithubRoutesMessage,
        sender: chrome.runtime.MessageSender,
    ) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, reason: 'forbidden' };
        if (!message || typeof message.key !== 'string' || !message.key
            || !message.snapshot || typeof message.snapshot !== 'object') {
            return { ok: false, reason: 'invalid' };
        }
        const settings = await Settings.get();
        if (!settings.enableGithubBackup) return { ok: false, reason: 'disabled' };
        const sourceTabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id! : null;
        const storageKey = sourceTabId == null ? message.key : `${message.key}|tab:${sourceTabId}`;
        await mutateMap<void, StoredSnapshotRecord>(SNAPSHOTS_KEY, snapshots => {
            snapshots[storageKey] = {
                identity: (message.identity as StoredSnapshotIdentity | undefined) || null,
                attemptId: typeof message.attemptId === 'string' ? message.attemptId : null,
                snapshot: message.snapshot as StoredBackupSnapshot,
                sourceTabId,
                generation: crypto.randomUUID(),
                savedAt: now(),
                expiresAt: now() + SNAPSHOT_TTL_MS,
            };
            const ordered = Object.entries(snapshots).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
            for (const [key] of ordered.slice(SNAPSHOT_LIMIT)) delete snapshots[key];
        });
        return { ok: true };
    };

    // Whether the saved ascent page should offer a backup: enabled and connected.
    // Content-script safe — it exposes no token, only the flags and repo name.
    const githubBackupStatus = async (sender: chrome.runtime.MessageSender) => {
        if (!isPeakbaggerSender(sender)) return { enabled: false, connected: false };
        const settings = await Settings.get();
        const auth = await GithubAuth.authStore.read();
        const repo = auth && auth.token && auth.repo && auth.repo.owner && auth.repo.name
            ? { fullName: auth.repo.fullName || `${auth.repo.owner}/${auth.repo.name}` }
            : null;
        return {
            enabled: !!settings.enableGithubBackup,
            auto: !!settings.autoGithubBackup,
            connected: !!repo,
            repo,
        };
    };

    const isAscentEditSender = (sender: chrome.runtime.MessageSender, ascentId: number): boolean => {
        if (!isPeakbaggerSender(sender)) return false;
        try {
            const url = new URL(sender.url || '');
            return /\/climber\/ascentedit\.aspx$/i.test(url.pathname)
                && positiveAscentId(url.searchParams.get('aid')) === ascentId;
        } catch { return false; }
    };

    const senderTabId = (sender: chrome.runtime.MessageSender | null | undefined): number | null =>
        Number.isInteger(sender?.tab?.id) ? (sender!.tab!.id as number) : null;
    const deletionRecord = async (ascentId: number): Promise<AscentDeleteIntentRecord | null> => {
        const intents = await readMap<AscentDeleteIntentRecord>(ASCENT_DELETE_INTENTS_KEY);
        const record = intents[String(ascentId)];
        return record && isFresh(record) ? record : null;
    };
    // One read for the whole batch. This runs twice per profile push (once as a
    // preflight, once inside the write queue), so a per-id read meant twenty
    // storage round trips to answer one question about ten ascents.
    const deletionBlocksBackup = async (ascentIds: readonly number[]): Promise<number | null> => {
        const intents = await readMap<AscentDeleteIntentRecord>(ASCENT_DELETE_INTENTS_KEY);
        for (const ascentId of ascentIds) {
            if (isFresh(intents[String(ascentId)])) return ascentId;
        }
        return null;
    };
    const clearAscentSnapshots = (ascentId: number) =>
        mutateMap<void, StoredSnapshotRecord>(SNAPSHOTS_KEY, snapshots => {
            for (const [key, record] of Object.entries(snapshots)) {
                if (positiveAscentId(record?.identity?.ascentId) === ascentId) delete snapshots[key];
            }
        });
    const deletionSettings = async (): Promise<
        | { settings: SettingsData; error?: undefined }
        | { error: { code: string; message: string }; settings?: undefined }
    > => {
        try {
            return { settings: await Settings.requireCurrent() };
        } catch {
            return {
                error: {
                    code: 'settings-unavailable',
                    message: 'Deletion settings could not be read. Reload the page and try again.',
                },
            };
        }
    };

    const connectedGithubClient = async ({
        requireEnabled = false,
        signal = null,
    }: {
        requireEnabled?: boolean;
        signal?: AbortSignal | null;
    } = {}): Promise<ConnectedGithubAccess> => {
        if (typeof resolveGithubAccess === 'function') {
            return resolveGithubAccess({ requireEnabled, signal });
        }
        if (requireEnabled) {
            let settings: SettingsData;
            try {
                settings = await Settings.requireCurrent();
            } catch {
                return {
                    error: {
                        code: 'settings-unavailable',
                        message: 'GitHub backup settings could not be read. Reload the page and try again.',
                    },
                };
            }
            if (!settings.enableGithubBackup) return { error: { code: 'disabled' } };
        }
        const snapshot = await GithubAuth.authStore.readSnapshot();
        const auth = snapshot.auth;
        const authorizationEpoch = snapshot.epoch;
        if (!auth || !auth.token) return { authorizationEpoch, error: { code: 'not-connected' } };
        if (!auth.repo || !auth.repo.owner || !auth.repo.name) {
            return { authorizationEpoch, error: { code: 'no-repo' } };
        }
        return {
            authorizationEpoch,
            repo: {
                owner: auth.repo.owner,
                name: auth.repo.name,
                branch: (typeof auth.repo.branch === 'string' && auth.repo.branch) || null,
            },
            client: GithubClient.createGithubClient({
                fetch: netFetch,
                token: auth.token,
                owner: auth.repo.owner,
                repo: auth.repo.name,
                branch: (typeof auth.repo.branch === 'string' && auth.repo.branch) || undefined,
                signal,
            }),
        };
    };

    // One individual-ascent operation can involve several Git reads, a queued
    // branch mutation, and conflict retry. Per-request deadlines release a
    // stalled socket, but without a deadline for the whole transaction a busy
    // queue or a sequence of merely-slow requests can leave the page waiting
    // forever. The parent signal also stops a queued client before it can begin
    // a late mutation after the page has already received a timeout.
    const runAscentGithubOperation = async <T>(operation: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
        const deadline = Deadline.createRequestDeadline(ASCENT_GITHUB_OPERATION_TIMEOUT_MS);
        try {
            return await deadline.run(operation(deadline.signal));
        } catch (error) {
            if (deadline.expired || Deadline.isTimeout(error)) {
                throw new GithubErrors.GithubError(
                    GithubErrors.ERROR_CODES.TIMEOUT,
                    'The GitHub ascent and TR backup operation took too long to complete.',
                    { cause: error },
                );
            }
            throw error;
        } finally {
            deadline.clear();
        }
    };

    // Every backup surface targets the same mutable branch, so writes are
    // serialized within this worker: an automatic save, a manual save, and a
    // profile batch cannot race one another between reading and updating the
    // branch head. External writers are still handled by the GitHub client's
    // bounded optimistic-concurrency retry.
    //
    // Root-file writes additionally merge. The settings and favorites automatic
    // backups share one alarm delay, so they arrive together; committing them
    // as one tree spends one round trip instead of two and leaves one commit
    // in the user's repository instead of two seconds apart.
    //
    // Root-file batches retain the connection accepted at submission. The queue
    // may merge only compatible scopes and rechecks that scope before writing.
    class GithubAccessError extends Error {
        access: ConnectedGithubFailure['error'];

        constructor(error: ConnectedGithubFailure['error']) {
            super((error && error.message) || 'No GitHub repository is connected.');
            this.name = 'GithubAccessError';
            this.access = error;
        }
    }
    const writeError = (error: unknown, fallback: string) => error instanceof GithubAccessError
        ? error.access
        : GithubErrors.publicError(error, fallback);

    const connectionScope = (access: {
        authorizationEpoch?: number;
        repo?: { owner?: string | null; name?: string | null; branch?: string | null } | null;
    } | null | undefined): string => JSON.stringify([
        access?.authorizationEpoch ?? null,
        access?.repo?.owner ?? null,
        access?.repo?.name ?? null,
        access?.repo?.branch ?? null,
    ]);

    const queuedGithubAccess = async (
        expected: ConnectedGithubAccess | string,
        options: { requireEnabled?: boolean; signal?: AbortSignal | null } = {},
    ): Promise<ConnectedGithubSuccess> => {
        const current = await connectedGithubClient(options);
        // A prerequisite failure can happen before the connection is read.
        // Preserve that actionable error instead of inventing a scope change.
        if (current.error && !Number.isSafeInteger(current.authorizationEpoch)) {
            throw new GithubAccessError(current.error);
        }
        const expectedScope = typeof expected === 'string' ? expected : connectionScope(expected);
        if (connectionScope(current) !== expectedScope) {
            throw new GithubAccessError({
                code: 'superseded',
                message: 'The GitHub connection changed before this action started. Review it and try again.',
            });
        }
        if (current.error) throw new GithubAccessError(current.error);
        return current;
    };

    const writeQueue = GithubWriteQueue.createGithubWriteQueue({
        commitFiles: async (files, message, scope) => {
            const access = await queuedGithubAccess(String(scope));
            return access.client.putRootFiles(files, message);
        },
    });

    // Phase one: intercept only Peakbagger's two native Delete submitters and
    // durably record intent before the destructive POST is allowed to proceed.
    // No GitHub mutation happens here.
    const storeAscentDeleteIntent = async (
        message: GithubRoutesMessage,
        sender: chrome.runtime.MessageSender,
    ) => {
        const ascentId = positiveAscentId(message?.aid);
        if (!ascentId || !isAscentEditSender(sender, ascentId)) {
            return { ok: false, error: { code: 'forbidden' } };
        }
        const deletionGate = await deletionSettings();
        if (deletionGate.error) return { ok: false, error: deletionGate.error };
        const settings = deletionGate.settings;
        if (!settings.enableGithubBackup || !settings.removeGithubBackupOnDelete) {
            return { ok: false, error: { code: 'disabled' } };
        }
        const access = await connectedGithubClient({ requireEnabled: true });
        if (access.error) return { ok: false, error: access.error };
        const tabId = senderTabId(sender);
        if (tabId == null) return { ok: false, error: { code: 'forbidden' } };

        await mutateMap<void, AscentDeleteIntentRecord>(ASCENT_DELETE_INTENTS_KEY, intents => {
            intents[String(ascentId)] = {
                aid: ascentId,
                sourceTabId: tabId,
                state: 'pending',
                createdAt: now(),
                expiresAt: now() + ASCENT_DELETE_TTL_MS,
            };
        });
        await clearAscentSnapshots(ascentId);
        return { ok: true };
    };

    // A same-tab My Ascents redirect can ask whether it has deletion work. The
    // aid is not proof; it is only the input to the complete-list confirmation
    // below, and completed tombstones remain private so stale backup work stays
    // blocked without repeating the deletion.
    const pendingAscentDeletions = async (sender: chrome.runtime.MessageSender) => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const deletionGate = await deletionSettings();
        if (deletionGate.error) return { ok: false, error: deletionGate.error };
        const settings = deletionGate.settings;
        if (!settings.enableGithubBackup || !settings.removeGithubBackupOnDelete) {
            return { ok: true, aids: [] };
        }
        const tabId = senderTabId(sender);
        const intents = await readMap<AscentDeleteIntentRecord>(ASCENT_DELETE_INTENTS_KEY);
        const aids = Object.values(intents)
            .filter(record => isFresh(record) && record.state === 'pending' && record.sourceTabId === tabId)
            .map(record => positiveAscentId(record.aid))
            .filter((id): id is number => id !== null);
        return { ok: true, aids: [...new Set(aids)] };
    };

    // Phase two: the isolated ClimbListC content script supplies the parsed,
    // complete all-years owner list. Recheck the signed-in owner in the worker,
    // then delete only when the intended aid is authoritatively absent.
    const confirmAscentDeletion = async (
        message: GithubRoutesMessage,
        sender: chrome.runtime.MessageSender,
    ) => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const ascentId = positiveAscentId(message?.aid);
        const climberId = positiveAscentId(message?.climberId);
        const listed = message?.allAscentIds;
        if (!ascentId || !climberId || message?.pageComplete !== true
            || !Array.isArray(listed) || listed.length > 100000
            || listed.some(value => !positiveAscentId(value))) {
            return { ok: false, error: { code: 'no-data' } };
        }

        const record = await deletionRecord(ascentId);
        if (!record || record.state !== 'pending' || record.sourceTabId !== senderTabId(sender)) {
            return { ok: false, error: { code: 'no-delete-intent' } };
        }
        const deletionGate = await deletionSettings();
        if (deletionGate.error) return { ok: false, error: deletionGate.error };
        const settings = deletionGate.settings;
        if (!settings.enableGithubBackup || !settings.removeGithubBackupOnDelete) {
            return { ok: false, error: { code: 'disabled' } };
        }
        let signedInId: number | null = null;
        try { signedInId = positiveAscentId(await peakbaggerLogin()); }
        catch (error) {
            const err = error && typeof error === 'object'
                ? (error as { code?: unknown; message?: unknown })
                : null;
            return {
                ok: false,
                error: {
                    source: 'peakbagger',
                    code: typeof err?.code === 'string' && err.code ? err.code : 'peakbagger-unavailable',
                    message: typeof err?.message === 'string' && err.message
                        ? err.message
                        : 'Could not confirm the signed-in Peakbagger account.',
                },
            };
        }
        if (signedInId !== climberId) {
            return {
                ok: false,
                error: {
                    source: 'peakbagger',
                    code: 'identity-mismatch',
                    message: 'The complete ascent list does not belong to the signed-in Peakbagger account.',
                },
            };
        }

        if (listed.some(value => Number(value) === ascentId)) {
            await mutateMap<void, AscentDeleteIntentRecord>(ASCENT_DELETE_INTENTS_KEY, intents => {
                delete intents[String(ascentId)];
            });
            return { ok: true, confirmed: false, reason: 'still-present' };
        }

        const expectedAccess = await connectedGithubClient({ requireEnabled: true });
        if (expectedAccess.error) return { ok: false, error: expectedAccess.error };
        try {
            const result = await writeQueue.run(async () => {
                const access = await queuedGithubAccess(expectedAccess, { requireEnabled: true });
                return access.client.deleteAscentBackup(ascentId);
            });
            await clearAscentSnapshots(ascentId);
            await mutateMap<void, AscentDeleteIntentRecord>(ASCENT_DELETE_INTENTS_KEY, intents => {
                const current = intents[String(ascentId)];
                if (!current) return;
                intents[String(ascentId)] = {
                    ...current,
                    state: 'completed',
                    completedAt: now(),
                    expiresAt: now() + ASCENT_DELETE_TTL_MS,
                };
            });
            return { ok: true, confirmed: true, result };
        } catch (error) {
            return {
                ok: false,
                error: writeError(error, 'The deleted ascent could not be removed from GitHub.'),
            };
        }
    };

    const ignoredSync = createClimberListSync({
        storage: ext.storage.local,
        store: ignoredStore || createIgnoredStore({ storage: ext.storage.local }),
        writeQueue,
        getAccess: connectedGithubClient,
        alarms: ext.alarms,
        now,
    });

    // Profile backup preflight adds the repository's ascent-folder leaves to
    // the ordinary status. This stays a dedicated message so viewing a saved
    // ascent never pays for GitHub tree reads.
    const githubProfileBackupStatus = async (sender: chrome.runtime.MessageSender) => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const status = await githubBackupStatus(sender);
        if (!status.enabled || !status.connected) return { ok: true, ...status, folders: [] };
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, ...status, error: access.error };
        try {
            return { ok: true, ...status, folders: await access.client.getAscentFolders() };
        } catch (error) {
            return { ok: false, ...status, error: GithubErrors.publicError(error, 'Could not read the backup repository.') };
        }
    };

    // The options page needs one durable answer to "did anything get backed
    // up?" without receiving ascent identities or the repository tree. Count
    // only marker-validated backup folders and keep this route extension-only.
    const githubAscentBackupSummary = async () => {
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            const folders = await access.client.getAscentFolders();
            return { ok: true, count: folders.length };
        } catch (error) {
            return {
                ok: false,
                error: GithubErrors.publicError(error, 'Could not check the existing ascent and TR backups.'),
            };
        }
    };

    // Merge the pending save-time snapshot with the saved ascent page's fields.
    // The saved page is authoritative for the identity and the fields it renders
    // (aid, date, suffix, peak name/elevation/location); the snapshot supplies
    // the fields the page does not (the entered numbers) and the resolved report.
    const mergeBackupSnapshot = (
        snap: StoredBackupSnapshot | null | undefined,
        page: unknown = {},
        { pageComplete = false }: { pageComplete?: boolean } = {},
    ) => {
        const p = page && typeof page === 'object' ? (page as Record<string, unknown>) : {};
        const base = snap && typeof snap === 'object' ? snap : null;
        if (!base && !p.ascent && !p.peak) return null;
        const baseAscent = base?.ascent && typeof base.ascent === 'object' ? base.ascent : {};
        const ascent: Record<string, unknown> = { ...(!pageComplete && base ? baseAscent : {}) };
        const pAscent = p.ascent && typeof p.ascent === 'object' ? (p.ascent as Record<string, unknown>) : {};
        if (pageComplete) {
            // A parsed edit form is the complete persisted record. Copy explicit
            // blanks too so a field the user cleared does not survive from the
            // pending save-time snapshot.
            for (const [key, value] of Object.entries(pAscent)) {
                if (value !== undefined) ascent[key] = value;
            }
        } else {
            if (pAscent.id != null) ascent.id = pAscent.id;
            if (pAscent.date) ascent.date = pAscent.date;
            if (typeof pAscent.suffix === 'string' && pAscent.suffix) ascent.suffix = pAscent.suffix;
        }
        const peak: Record<string, unknown> = { ...(base && base.peak ? base.peak : {}) };
        const pPeak = p.peak && typeof p.peak === 'object' ? (p.peak as Record<string, unknown>) : {};
        for (const [key, value] of Object.entries(pPeak)) {
            if (value != null && value !== '') peak[key] = value;
        }
        const snapMarkdown = base && base.report && typeof base.report.markdown === 'string' ? base.report.markdown : '';
        const pReport = p.report && typeof p.report === 'object' ? (p.report as Record<string, unknown>) : null;
        const pageMarkdown = pReport && typeof pReport.markdown === 'string' ? pReport.markdown : '';
        const report = { markdown: base ? snapMarkdown : pageMarkdown };
        return {
            ascent,
            peak,
            report,
            backup: { ...(base && base.backup ? base.backup : {}) },
        };
    };

    // Find the pending snapshot for a saved ascent page. A positive ascent id is
    // stable across documents, so one unique id match may follow a cross-tab
    // navigation. A new ascent has no id at save time: peak+date is not unique,
    // and is therefore usable only in the exact tab that recorded the snapshot.
    // Ambiguity preserves every candidate and falls back to the complete edit-
    // form read instead of guessing which exact report Markdown belongs here.
    const findSnapshotForPage = async (page: unknown, sender: chrome.runtime.MessageSender) => {
        const snapshots = await readMap<StoredSnapshotRecord>(SNAPSHOTS_KEY);
        const entries = Object.entries(snapshots)
            .filter(([, record]) => isFresh(record))
            .map(([key, record]) => ({ key, record }))
            .sort((a, b) => (b.record.savedAt || 0) - (a.record.savedAt || 0));
        const idOf = (e: { record: StoredSnapshotRecord }): StoredSnapshotIdentity => e.record.identity || {};
        const p = page && typeof page === 'object'
            ? (page as { ascent?: { id?: unknown; date?: unknown }; peak?: { id?: unknown } })
            : null;
        const ascentId = positiveAscentId(p?.ascent?.id);
        const peakId = p && p.peak ? p.peak.id : null;
        const date = p && p.ascent ? p.ascent.date : null;
        const sourceTabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id! : null;
        if (ascentId) {
            const idMatches = entries.filter(entry =>
                positiveAscentId(idOf(entry).ascentId) === ascentId);
            const sameTab = sourceTabId == null ? null : idMatches.find(entry =>
                entry.record.sourceTabId === sourceTabId);
            const unique = sameTab || (idMatches.length === 1 ? idMatches[0] : null);
            if (unique) return unique;
        }
        if (sourceTabId == null || peakId == null || !date) return null;
        return entries.find(entry => entry.record.sourceTabId === sourceTabId
            && positiveAscentId(idOf(entry).ascentId) == null
            && idOf(entry).peakId === peakId
            && idOf(entry).date === date) || null;
    };

    const confirmedSnapshotForPage = async (page: unknown, sender: chrome.runtime.MessageSender) => {
        const found = await findSnapshotForPage(page, sender);
        const submitted = found?.record.snapshot?.report?.submitted;
        const p = page && typeof page === 'object'
            ? (page as { report?: { submitted?: unknown } })
            : null;
        const persisted = p?.report?.submitted;
        return found?.record.attemptId && typeof submitted === 'string'
            && typeof persisted === 'string'
            && submitted.replace(/\r\n?/g, '\n') === persisted.replace(/\r\n?/g, '\n')
            ? found : null;
    };

    const consumeSnapshot = (found: { key: string; record: StoredSnapshotRecord } | null | undefined) =>
        mutateMap<void, StoredSnapshotRecord>(SNAPSHOTS_KEY, snapshots => {
            if (found?.record.generation && snapshots[found.key]?.generation === found.record.generation) {
                delete snapshots[found.key];
            }
        });

    // Token-free, read-only freshness preflight for the individual ascent
    // surface. The content script supplies the complete persisted edit-form
    // identity, avoiding the display page's best-effort date. No snapshot data
    // crosses the boundary.
    const preflightAscentBackup = async (
        message: GithubRoutesMessage,
        sender: chrome.runtime.MessageSender,
    ) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, fresh: false, error: { code: 'forbidden' } };
        const status = await githubBackupStatus(sender);
        if (!status.enabled) return { ok: false, fresh: false, error: { code: 'disabled' } };
        if (!status.connected) return { ok: false, fresh: false, error: { code: 'not-connected' } };
        if (!message || !message.pageComplete || !message.page) {
            return { ok: false, fresh: false, error: { code: 'no-data' } };
        }
        return { ok: true, fresh: !!(await confirmedSnapshotForPage(message.page, sender)) };
    };

    // Push one saved ascent to the connected repository as a single commit. The
    // token is read here and never leaves the worker. Fails closed when the
    // feature is off, disconnected, or the sender is not a Peakbagger tab.
    const backupAscent = async (message: GithubRoutesMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        if (!message?.auto && !(await trustedActions?.consumeGrant(
            message,
            sender,
            TrustedActions.ACTIONS.ASCENT_BACKUP,
            { oneUse: true },
        ))) {
            return { ok: false, error: { code: 'activation-required' } };
        }
        try {
            return await runAscentGithubOperation(async signal => {
                const expectedAccess = await connectedGithubClient({ requireEnabled: true, signal });
                if (expectedAccess.error) return { ok: false, error: expectedAccess.error };

                const found = message.pageComplete
                    ? await confirmedSnapshotForPage(message.page, sender) : null;
                // Automatic backup fires on every saved-ascent page load, so it must push
                // only right after a save — i.e. when a matching pending snapshot exists.
                // Without one (an old ascent merely being viewed) it declines quietly so
                // it never re-pushes on a revisit; the manual button is still offered.
                if (message.auto && !found) return { ok: false, error: { code: 'no-fresh-save' } };
                // Without a pending save snapshot, only a complete owner edit-form read
                // is safe to commit. A sparse display-page payload would erase fields an
                // existing backup already holds.
                if (!found && !message.pageComplete) return { ok: false, error: { code: 'no-data' } };
                const snapshot = mergeBackupSnapshot(found && found.record.snapshot, message.page, {
                    pageComplete: !!message.pageComplete,
                });
                if (!snapshot || snapshot.ascent.id == null) return { ok: false, error: { code: 'no-data' } };
                const ascentId = positiveAscentId(snapshot.ascent.id);
                if (!ascentId) return { ok: false, error: { code: 'no-data' } };
                if (await deletionBlocksBackup([ascentId])) {
                    return {
                        ok: false,
                        error: {
                            code: 'ascent-delete-pending',
                            message: 'This ascent was deleted from Peakbagger, so its GitHub backup was not recreated.',
                        },
                    };
                }
                snapshot.backup = {
                    ...(snapshot.backup || {}),
                    syncedAt: new Date().toISOString(),
                    extensionVersion: (ext.runtime?.getManifest ? ext.runtime.getManifest().version : undefined)
                        || (snapshot.backup && snapshot.backup.extensionVersion)
                        || '',
                };

                const result = await writeQueue.run(async () => {
                    const access = await queuedGithubAccess(expectedAccess, {
                        requireEnabled: true,
                        signal,
                    });
                    if (await deletionBlocksBackup([ascentId])) {
                        throw Object.assign(new Error('This ascent has a pending or completed deletion.'), {
                            code: 'ascent-delete-pending',
                        });
                    }
                    return access.client.pushAscentBackup(snapshot as AscentBackupSnapshot, { gpx: message.gpx });
                });
                // The snapshot has served its purpose; drop it so a later view of the
                // same page does not re-push from stale data.
                if (found) await consumeSnapshot(found);
                return { ok: true, result };
            });
        } catch (error) {
            return { ok: false, error: writeError(error, 'The backup failed.') };
        }
    };

    // Passive, read-only comparison for an owner ascent page. It accepts only
    // the same complete edit-form snapshot that a manual backup would write,
    // so an incomplete page can never be labelled current from a sparse view.
    const checkAscentBackup = async (message: GithubRoutesMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        if (!message || !message.pageComplete) return { ok: false, error: { code: 'no-data' } };
        try {
            return await runAscentGithubOperation(async signal => {
                const access = await connectedGithubClient({ requireEnabled: true, signal });
                if (access.error) return { ok: false, error: access.error };
                const found = await confirmedSnapshotForPage(message.page, sender);
                const snapshot = mergeBackupSnapshot(found?.record.snapshot, message.page, { pageComplete: true });
                if (!snapshot || snapshot.ascent.id == null) return { ok: false, error: { code: 'no-data' } };
                const current = await access.client.isAscentBackupCurrent(
                    snapshot as AscentBackupSnapshot,
                    { gpx: message.gpx },
                );
                // A timed-out write has an unknown outcome. Only this explicit
                // reconciliation path may consume its save-time snapshot, and
                // only after GitHub proves that the complete payload landed.
                if (current && message.reconcile === true) {
                    if (found) await consumeSnapshot(found);
                }
                return { ok: true, current };
            });
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'Could not check the existing backup.') };
        }
    };

    // A profile batch is one ordered branch mutation containing up to ten
    // independently identity-checked ascents. The content script never sees
    // the token, and a malformed entry rejects the entire batch before GitHub
    // receives anything.
    const backupProfileBatch = async (message: GithubRoutesMessage, sender: chrome.runtime.MessageSender) => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        if (!(await trustedActions?.consumeGrant(
            message,
            sender,
            TrustedActions.ACTIONS.PROFILE_BACKUP,
        ))) {
            return { ok: false, error: { code: 'activation-required' } };
        }
        const rawEntries = message && message.entries;
        if (!Array.isArray(rawEntries) || rawEntries.length === 0 || rawEntries.length > PROFILE_BACKUP_BATCH_LIMIT) {
            return { ok: false, error: { code: 'no-data' } };
        }
        const seen = new Set<number>();
        const entries: { snapshot: AscentBackupSnapshot & { backup?: Record<string, unknown> }; gpx?: unknown }[] = [];
        for (const rawEntry of rawEntries) {
            if (!rawEntry || typeof rawEntry !== 'object') return { ok: false, error: { code: 'no-data' } };
            const candidate = rawEntry as { aid?: unknown; snapshot?: unknown; gpx?: unknown };
            const snapshot = candidate.snapshot && typeof candidate.snapshot === 'object'
                ? (candidate.snapshot as AscentBackupSnapshot & { backup?: Record<string, unknown> })
                : null;
            const ascentId = snapshot && snapshot.ascent ? Number(snapshot.ascent.id) : NaN;
            if (!Number.isFinite(ascentId) || ascentId <= 0 || ascentId !== Number(candidate.aid) || seen.has(ascentId)) {
                return { ok: false, error: { code: 'no-data' } };
            }
            seen.add(ascentId);
            entries.push({ snapshot: snapshot!, gpx: candidate.gpx });
        }
        const expectedAccess = await connectedGithubClient({ requireEnabled: true });
        if (expectedAccess.error) return { ok: false, error: expectedAccess.error };
        const deletedAscentId = await deletionBlocksBackup([...seen]);
        if (deletedAscentId) {
            return {
                ok: false,
                error: {
                    code: 'ascent-delete-pending',
                    message: `Ascent ${deletedAscentId} was deleted from Peakbagger and cannot be backed up again.`,
                },
            };
        }

        const version = (ext.runtime?.getManifest ? ext.runtime.getManifest().version : undefined) || '';
        for (const entry of entries) {
            entry.snapshot.backup = {
                ...(entry.snapshot.backup || {}),
                syncedAt: new Date().toISOString(),
                extensionVersion: version,
            };
        }
        try {
            const result = await writeQueue.run(async () => {
                const access = await queuedGithubAccess(expectedAccess, { requireEnabled: true });
                const blocked = await deletionBlocksBackup([...seen]);
                if (blocked) {
                    throw Object.assign(new Error(`Ascent ${blocked} has a pending or completed deletion.`), {
                        code: 'ascent-delete-pending',
                    });
                }
                return access.client.pushAscentBackups(entries.map(entry => ({
                    snapshot: entry.snapshot,
                    gpx: entry.gpx,
                })));
            });
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: writeError(error, 'The backup failed.') };
        }
    };

    // Debounced, signature-gated automatic backup shared by the settings and
    // favorites paths. Replacing a named alarm gives us trailing-edge debounce
    // that survives MV3 worker teardown; fire() rechecks every gate so stale or
    // spurious alarms are harmless.
    const createAutoBackup = ({
        alarmName,
        stateKey,
        path,
        commitMessage,
        enabled,
        build,
    }: {
        alarmName: string;
        stateKey: string;
        path: string;
        commitMessage: string;
        enabled: () => Promise<boolean>;
        build: () => Promise<{ text: string; signature: string }>;
    }) => {
        const readState = async (): Promise<AutoBackupState | null> =>
            ((await ext.storage.local.get(stateKey))[stateKey] as AutoBackupState | undefined) || null;
        let stateTail: Promise<unknown> = Promise.resolve();
        const updateState = (change: (state: AutoBackupState | null) => AutoBackupState | null | Promise<AutoBackupState | null>) => {
            const operation = stateTail.then(async () => {
                const next = await change(await readState());
                if (next) await ext.storage.local.set({ [stateKey]: next });
            });
            stateTail = operation.catch(() => {});
            return operation;
        };
        const markSynced = (signature: string, access: ConnectedGithubSuccess) => updateState(async () => {
            const current = await connectedGithubClient();
            if (current.error || connectionScope(current) !== connectionScope(access)) return null;
            return { signature, scope: connectionScope(access), syncedAt: new Date().toISOString() };
        });

        const put = async (
            access: ConnectedGithubSuccess,
            { text, signature }: { text: string; signature: string },
            review: GuardRootBackupInput['review'],
            automatic = false,
        ) => {
            const scope = connectionScope(access);
            return writeQueue.putFile({
                path,
                content: text,
                message: commitMessage,
                scope,
                verify: async remoteText => {
                    await queuedGithubAccess(scope);
                    if (automatic && !(await enabled())) throw new GithubAccessError({ code: 'disabled' });
                    if (remoteText === undefined) return; // pre-ref ownership check
                    let remoteSignature: string | null = null;
                    if (remoteText !== null) {
                        const parsed = path === Transfer.BACKUP_PATH
                            ? Transfer.parse(remoteText)
                            : Favorites.parseBackup(remoteText);
                        if (!parsed.ok) {
                            throw new GithubAccessError({
                                code: 'backup-invalid',
                                message: 'The existing backup is invalid or newer. It was not replaced.',
                            });
                        }
                        remoteSignature = 'settings' in parsed
                            ? Transfer.signature(parsed.settings, parsed.customLayers)
                            : Favorites.backupSignature(parsed.favorites);
                    }
                    guardRootBackup({
                        path,
                        localSignature: signature,
                        remoteSignature,
                        scope,
                        baseline: await readState(),
                        review,
                    });
                },
            });
        };

        const schedule = () => {
            if (!ext.alarms) return;
            ext.alarms.create(alarmName, {
                delayInMinutes: AUTO_BACKUP_DELAY_MINUTES, periodInMinutes: AUTO_BACKUP_WATCHDOG_MINUTES,
            });
            // A fresh change grants a fresh retry budget.
            void updateState(state => state?.attempts ? { ...state, attempts: 0 } : null).catch(() => {});
        };

        const startWatchdog = async () => {
            if (!ext.alarms) return;
            const alarm = ext.alarms.get ? await ext.alarms.get(alarmName) : null;
            if (!alarm || alarm.periodInMinutes !== AUTO_BACKUP_WATCHDOG_MINUTES) {
                ext.alarms.create(alarmName, {
                    delayInMinutes: AUTO_BACKUP_DELAY_MINUTES, periodInMinutes: AUTO_BACKUP_WATCHDOG_MINUTES,
                });
            }
        };

        const fire = async () => {
            if (!(await enabled())) return;
            const access = await connectedGithubClient();
            if (access.error) return;
            // Read the persisted record before anything that can throw. When
            // build() failed with `state` still unread, the catch below wrote a
            // bare retry counter over the stored signature and syncedAt, which
            // both lost the last-backed-up timestamp and defeated the
            // unchanged-content check on the following run.
            let state: AutoBackupState | null = null;
            try {
                state = await readState();
            } catch {
                // An unreadable retry record is not worth abandoning the backup
                // for; treat it as absent and let the write settle it.
            }
            try {
                const { text, signature } = await build();
                if (state?.scope === connectionScope(access) && state.signature === signature) return;
                const result = await put(access, { text, signature }, null, true);
                // A newer write to this path won the batch, so this signature
                // does not describe what the repository now holds.
                if (!result.superseded) await markSynced(signature, access);
            } catch (error) {
                const err = error && typeof error === 'object' ? (error as { code?: unknown }) : null;
                if (err?.code === 'backup-review') {
                    await updateState(latest => ({ ...latest, needsReview: true }));
                    return;
                }
                // Silent bounded retry; the manual buttons remain the loud path.
                const retry = { attempts: null as number | null };
                await updateState(async latest => {
                    const current = await connectedGithubClient();
                    const scope = connectionScope(access);
                    if (current.error || connectionScope(current) !== scope) return null;
                    retry.attempts = (latest?.attemptScope === scope ? latest.attempts || 0 : 0) + 1;
                    return { ...(latest || state || {}), attempts: retry.attempts, attemptScope: scope };
                });
                if (retry.attempts != null && retry.attempts <= AUTO_BACKUP_MAX_RETRIES) {
                    ext.alarms?.create(alarmName, {
                        delayInMinutes: AUTO_BACKUP_RETRY_MINUTES, periodInMinutes: AUTO_BACKUP_WATCHDOG_MINUTES,
                    });
                }
            }
        };

        return { schedule, fire, markSynced, startWatchdog, put };
    };

    const buildSettingsBackup = async () => {
        let settings: SettingsData;
        let layerBackup: CustomLayerBackup | undefined;
        try {
            settings = await Settings.requireCurrent({ includeLegacy: true });
            if (customLayers) layerBackup = customLayerBackup(await customLayers.snapshot());
        } catch (cause) {
            console.error('Better Peakbagger: settings backup read failed', cause);
            throw PublicErrors.exception(
                'settings-unavailable',
                'Settings could not be read, so no backup was changed.',
                { cause },
            );
        }
        const payload = Transfer.buildPayload(settings, {
            extensionVersion: (ext.runtime?.getManifest ? ext.runtime.getManifest().version : undefined) || '',
            exportedAt: new Date().toISOString(),
            ...(layerBackup ? { customLayers: layerBackup } : {}),
        });
        return { text: Transfer.serialize(payload), signature: Transfer.signature(settings, layerBackup) };
    };

    const settingsAutoBackup = createAutoBackup({
        alarmName: SETTINGS_BACKUP_ALARM,
        stateKey: SETTINGS_BACKUP_STATE_KEY,
        path: Transfer.BACKUP_PATH,
        commitMessage: 'Back up settings',
        enabled: async () => (await Settings.requireCurrent().catch(() => null))?.autoSettingsBackup === true,
        build: buildSettingsBackup,
    });

    const buildFavoritesBackup = async () => {
        const stored = await ext.storage.local.get(Favorites.FAVORITES_KEY);
        const favorites = Favorites.cleanFavorites(stored[Favorites.FAVORITES_KEY]);
        const payload = Favorites.buildBackupPayload(favorites, { exportedAt: new Date().toISOString() });
        return {
            text: Favorites.serializeBackup(payload),
            signature: Favorites.backupSignature(favorites),
        };
    };

    const favoritesAutoBackup = createAutoBackup({
        alarmName: FAVORITES_BACKUP_ALARM,
        stateKey: FAVORITES_BACKUP_STATE_KEY,
        path: FAVORITE_CLIMBERS_BACKUP_PATH,
        commitMessage: 'Back up favorite climbers',
        enabled: async () => (await Settings.requireCurrent().catch(() => null))?.autoFavoritesBackup === true,
        build: buildFavoritesBackup,
    });

    const backupSettings = async (message: GithubRoutesMessage = {}) => {
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            const { text, signature } = await buildSettingsBackup();
            const result = await settingsAutoBackup.put(
                access,
                { text, signature },
                message.review as GuardRootBackupInput['review'],
            );
            if (!result.superseded) await settingsAutoBackup.markSynced(signature, access);
            return { ok: true, result: { ...result, signature, repo: `${access.repo.owner}/${access.repo.name}` } };
        } catch (error) {
            const err = error && typeof error === 'object' ? (error as { code?: unknown; review?: unknown }) : null;
            if (err?.code === 'backup-review') return { ok: false, error: { code: err.code }, review: err.review };
            if (PublicErrors.isPublic(error)) return { ok: false, error: PublicErrors.expose(error) };
            return { ok: false, error: writeError(error, 'The settings backup failed.') };
        }
    };

    const restoreSettings = async () => {
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            return { ok: true, content: await access.client.readRootFile(Transfer.BACKUP_PATH) };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The settings backup could not be read.') };
        }
    };

    // The worker owns serialization for both manual and automatic backups; the
    // options page still owns restore validation and reversible replacement.
    const backupFavorites = async (message: GithubRoutesMessage = {}) => {
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            // Build inside the try, like backupSettings: a storage read that
            // throws here must still answer with this route's { ok, error }
            // contract rather than rejecting into the worker's generic handler,
            // which replies in the unrelated { phase: 'error' } shape.
            const { text, signature } = await buildFavoritesBackup();
            const result = await favoritesAutoBackup.put(
                access,
                { text, signature },
                message.review as GuardRootBackupInput['review'],
            );
            if (!result.superseded) await favoritesAutoBackup.markSynced(signature, access);
            return { ok: true, result: { ...result, signature, repo: `${access.repo.owner}/${access.repo.name}` } };
        } catch (error) {
            const err = error && typeof error === 'object' ? (error as { code?: unknown; review?: unknown }) : null;
            if (err?.code === 'backup-review') return { ok: false, error: { code: err.code }, review: err.review };
            return { ok: false, error: writeError(error, 'The favorites backup failed.') };
        }
    };

    const restoreFavorites = async () => {
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            return { ok: true, content: await access.client.readRootFile(FAVORITE_CLIMBERS_BACKUP_PATH) };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The favorites backup could not be read.') };
        }
    };

    // ---- Photo-library metadata recovery ----------------------------------

    // Keep unrelated worker routes bootable in constrained environments that
    // do not expose extension-page URL resolution. Photo messages still fail
    // closed there; production browsers provide runtime.getURL().
    // Compare the protocol and host outright rather than trusting `origin`:
    // only special schemes are specified to produce one, so an extension URL's
    // origin is browser-defined and serializes as "null" in a spec-strict
    // parser — which would let another extension's identically-pathed page
    // through this gate.
    const packagedPage = (page: string) => {
        const base = typeof ext.runtime?.getURL === 'function' ? ext.runtime.getURL(page) : null;
        return (sender: chrome.runtime.MessageSender | null | undefined): boolean => {
            if (!base) return false;
            try {
                const actual = new URL(sender?.url || '');
                const expected = new URL(base);
                return actual.protocol === expected.protocol
                    && actual.host === expected.host
                    && actual.origin === expected.origin
                    && actual.pathname === expected.pathname;
            } catch { return false; }
        };
    };
    const isClimberListPage = packagedPage('options/favorites.html');
    const ignoredListAction = (message: GithubRoutesMessage, sender: chrome.runtime.MessageSender) => {
        if (!packagedPage('options/options.html')(sender) && !isClimberListPage(sender)) {
            return { ok: false, error: { code: 'forbidden', message: 'Open Climber lists in Settings.' } };
        }
        return message.action === 'status'
            ? ignoredSync.status()
            : ignoredSync.action(message as IgnoredSyncActionMessage);
    };
    const isPhotoPage = packagedPage('photos/photos.html');
    const isOptionsPage = packagedPage('options/options.html');
    // Backup and restore are reachable from both extension-owned surfaces:
    // Settings is where every other GitHub backup lives, and the library is
    // where the user is standing when a photo changes. Announcing a catalog
    // change stays with the photo page or trusted worker report-photo mutations.
    const isPhotoBackupPage = (sender: chrome.runtime.MessageSender | null | undefined): boolean =>
        isPhotoPage(sender) || isOptionsPage(sender);
    const automaticPhotoBackupEnabled = async (): Promise<boolean> =>
        (await photoBackupSettings.requireCurrent().catch(() => null))?.autoPhotoLibraryBackup === true;
    const readPhotoBackupState = async (): Promise<PhotoBackupStateRecord | null> =>
        ((await ext.storage.local.get(PHOTO_BACKUP_STATE_KEY))[PHOTO_BACKUP_STATE_KEY] as PhotoBackupStateRecord | undefined) || null;
    const sameRepo = (
        left: { owner?: string; name?: string; branch?: string | null } | null | undefined,
        right: { owner?: string; name?: string; branch?: string | null } | null | undefined,
    ): boolean => !!left && !!right
        && left.owner === right.owner
        && left.name === right.name
        && (left.branch || null) === (right.branch || null);
    const photoTimestamp = (): string => new Date(now()).toISOString();

    const withPhotoStore = async <T>(
        operation: (store: Awaited<ReturnType<typeof PhotoStore.createPhotoStore>>) => Promise<T>,
    ): Promise<T> => {
        const store = await createPhotoStore();
        try { return await operation(store); }
        finally { store.close(); }
    };

    const buildPhotoLibraryBackup = async () => withPhotoStore(async store => {
        const snapshot = await store.listBackupBundles();
        const payload = PhotoBackup.buildPayload({
            ...snapshot,
            exportedAt: photoTimestamp(),
            extensionVersion: ext.runtime?.getManifest?.().version || '',
        });
        try {
            const prepared = await PhotoBackup.prepare(payload);
            return {
                ...prepared,
                revisions: snapshot.revisions,
                generation: snapshot.catalog.generation,
                confirmedGeneration: snapshot.catalog.confirmedGeneration,
            };
        } catch (error) {
            if (error instanceof PhotoBackup.PhotoBackupCapacityError) {
                Object.assign(error, { generation: snapshot.catalog.generation });
            }
            throw error;
        }
    });

    // Every record carries the same backup stamp, so rewriting one whose stamp
    // already matches is a pure cost — and this runs on every backup, including
    // the failure path. Only the records that would actually change are put.
    const sameBackupStamp = (
        photo: { backup?: { state?: string; signature?: string | null; backedUpAt?: string | null; commitUrl?: string | null } },
        next: { state: string; signature: string | null; backedUpAt: string | null; commitUrl: string | null },
    ): boolean => {
        const current = photo && photo.backup;
        return !!current
            && current.state === next.state
            && (current.signature ?? null) === next.signature
            && (current.commitUrl ?? null) === next.commitUrl
            // backedUpAt is a timestamp; matching presence is what matters.
            && (current.backedUpAt == null) === (next.backedUpAt == null);
    };

    const markPhotoCatalogBackup = async ({
        state,
        signature = null,
        commitUrl = null,
        revisions = null,
    }: {
        state: string;
        signature?: string | null;
        commitUrl?: string | null;
        revisions?: Record<string, number> | null;
    }) => {
        return withPhotoStore(async store => {
            const photos = await store.listPhotos({ includeDeleted: true });
            const backup = {
                state,
                signature,
                backedUpAt: ['current', 'restored'].includes(state) ? photoTimestamp() : null,
                commitUrl,
            };
            const observed = revisions || Object.fromEntries(photos.map(photo => [
                photo.localId,
                photo.revision,
            ]));
            const localIds = photos
                .filter(photo => !sameBackupStamp(photo, backup))
                .filter(photo => Object.hasOwn(observed, photo.localId))
                .map(photo => photo.localId);
            return store.updatePhotoBackups({
                localIds,
                expectedRevisions: observed,
                backup,
            });
        });
    };

    class PhotoBackupError extends Error {
        code: string;
        conflictCount?: number;

        constructor(code: string, message: string, details: { conflictCount?: number } = {}) {
            super(message);
            this.name = 'PhotoBackupError';
            this.code = code;
            Object.assign(this, details);
        }
    }

    const parseRemotePhotoBackup = (text: string | null | undefined): PhotoBackupPayload => {
        if (text == null) {
            return PhotoBackup.buildPayload({
                exportedAt: photoTimestamp(),
                extensionVersion: ext.runtime?.getManifest?.().version || '',
            });
        }
        const parsed = PhotoBackup.parse(text);
        if (!parsed.ok) {
            throw new PhotoBackupError(
                'invalid-photo-backup',
                parsed.reason === 'newer-version'
                    ? 'This photo-library backup was created by a newer Better Peakbagger version.'
                    : 'The repository’s photo-library.json is not a valid photo backup.',
            );
        }
        return parsed.payload;
    };

    const publicPhotoBackupError = (error: unknown, fallback: string) => {
        if (error instanceof PhotoBackupError) {
            return {
                code: error.code,
                message: error.message,
                ...(Number.isInteger(error.conflictCount) ? { conflictCount: error.conflictCount } : {}),
            };
        }
        if (error instanceof PhotoBackup.PhotoBackupCapacityError) {
            return {
                code: error.code,
                message: error.message,
                ...(Number.isSafeInteger(error.actualBytes) ? { actualBytes: error.actualBytes } : {}),
                ...(Number.isSafeInteger(error.maxBytes) ? { maxBytes: error.maxBytes } : {}),
            };
        }
        return writeError(error, fallback);
    };

    const photoBackupStatus = async (_message: GithubRoutesMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPhotoBackupPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const [status, state, catalog] = await Promise.all([
            githubStatus(),
            readPhotoBackupState(),
            withPhotoStore(store => store.getCatalogState()),
        ]);
        // The identity this backup state is about, plus the display name the
        // library header renders. Deliberately not the stored record: the
        // installation id and repository id are account plumbing no page needs.
        const repo = status.repo ? {
            owner: status.repo.owner,
            name: status.repo.name,
            branch: (typeof status.repo.branch === 'string' && status.repo.branch) || null,
            fullName: status.repo.fullName || `${status.repo.owner}/${status.repo.name}`,
        } : null;
        return {
            ok: true,
            connected: status.connected,
            // The narrowed identity, not the stored record: this route answers
            // "which repository is this backup state about", and the page has
            // no use for the installation id or cached full name.
            repo,
            auto: (await photoBackupSettings.get()).autoPhotoLibraryBackup,
            state: state && sameRepo(state.repo, repo) ? {
                ...state,
                catalogGeneration: catalog.generation,
                confirmedGeneration: catalog.confirmedGeneration,
                reconciliationPending: state.reconciliationPending === true
                    || state.generation !== catalog.confirmedGeneration
                    || catalog.generation !== catalog.confirmedGeneration,
            } : null,
        };
    };

    const backupPhotoLibrary = async ({
        automatic = false,
        sender = null,
    }: {
        automatic?: boolean;
        sender?: chrome.runtime.MessageSender | null;
    } = {}): Promise<BackupPhotoLibraryResult> => {
        if (!automatic && !isPhotoBackupPage(sender)) {
            return { ok: false, error: { code: 'forbidden' } };
        }
        // The GitHub branch queue owns the complete operation, not just the
        // remote mutation. A second manual request or automatic alarm cannot
        // snapshot the catalog until the first request has reconciled its
        // confirmed commit back into local state.
        return writeQueue.run(async (): Promise<BackupPhotoLibraryResult> => {
            const access = await connectedGithubClient();
            if (access.error) return { ok: false, error: access.error };
            let local: Awaited<ReturnType<typeof buildPhotoLibraryBackup>> | undefined;
            let state: PhotoBackupStateRecord | null = null;
            let remoteConfirmed = false;
            try {
                [local, state] = await Promise.all([buildPhotoLibraryBackup(), readPhotoBackupState()]);
                if (!state?.reconciliationPending
                    && state?.signature === local.signature
                    && state?.generation === local.generation
                    && local.confirmedGeneration === local.generation
                    && sameRepo(state.repo, access.repo)) {
                    return { ok: true, current: true, signature: local.signature, unchanged: true };
                }
                const mergeBox: { committed: Extract<PhotoBackupMergeResult, { ok: true }> | null } = {
                    committed: null,
                };
                const result = await access.client.updateRootFile(
                    PhotoBackup.BACKUP_PATH,
                    async remoteText => {
                        const remote = parseRemotePhotoBackup(remoteText);
                        const merged = await PhotoBackup.mergePayloads(local!.payload, remote, {
                            exportedAt: photoTimestamp(),
                            extensionVersion: ext.runtime?.getManifest?.().version || '',
                            baseSignature: sameRepo(state?.repo, access.repo) ? (state?.signature ?? null) : null,
                            baseSignatureVersion: state?.signatureVersion || 1,
                        });
                        if (!merged.ok) {
                            throw new PhotoBackupError(
                                'photo-backup-conflict',
                                'Backup conflict. Review the photo library before replacing either version.',
                                { conflictCount: merged.conflicts.length },
                            );
                        }
                        mergeBox.committed = merged;
                        return merged.signature === merged.remoteSignature && remoteText != null
                            ? remoteText
                            : merged.prepared.text;
                    },
                    'Back up photo library',
                    { maxBytes: PhotoBackup.MAX_BYTES },
                );
                remoteConfirmed = true;
                const committed = mergeBox.committed;
                const signature = committed?.signature || local.signature;
                const syncedAt = photoTimestamp();
                const commitUrl = result.commitUrl || state?.commitUrl || null;
                const stateRecord: PhotoBackupStateRecord = {
                    signature,
                    signatureVersion: 2,
                    generation: local.generation,
                    revisions: local.revisions,
                    syncedAt,
                    commitUrl,
                    repo: access.repo,
                    attempts: 0,
                    reconciliationPending: true,
                };
                // Journal the confirmed remote state before touching individual
                // records. A worker restart or partial IndexedDB failure can
                // then retry idempotently without calling the commit a failure.
                let stateFailure: unknown = null;
                let catalogFailure: unknown = null;
                try {
                    await ext.storage.local.set({ [PHOTO_BACKUP_STATE_KEY]: stateRecord });
                } catch (error) {
                    stateFailure = error;
                }

                try {
                    const confirmedGeneration = local.generation;
                    const confirmedRevisions = local.revisions;
                    await withPhotoStore(store => store.confirmCatalogBackup({
                        generation: confirmedGeneration,
                        signature,
                        revisions: confirmedRevisions,
                        commitUrl,
                        backedUpAt: syncedAt,
                    }));
                } catch (error) {
                    catalogFailure = error;
                }

                let reconciliation: { conflicts: string[] } | null = null;
                let reconciliationFailure: unknown = null;
                try {
                    reconciliation = await markPhotoCatalogBackup({
                        state: 'current',
                        signature,
                        commitUrl,
                        revisions: local.revisions,
                    });
                } catch (error) {
                    reconciliationFailure = error;
                }
                const conflicts = reconciliation?.conflicts || [];
                const reconciliationPending = !!(
                    catalogFailure || reconciliationFailure || conflicts.length);
                try {
                    await ext.storage.local.set({
                        [PHOTO_BACKUP_STATE_KEY]: {
                            ...stateRecord,
                            reconciliationPending,
                        },
                    });
                    stateFailure = null;
                } catch (error) {
                    stateFailure = error;
                }
                const pending = !!(
                    stateFailure || catalogFailure || reconciliationFailure || conflicts.length);
                return {
                    ok: true,
                    current: !pending,
                    reconciliationPending: pending,
                    signature,
                    result,
                    counts: committed?.counts || null,
                    ...(pending ? {
                        warning: {
                            code: 'photo-backup-reconciliation',
                            message: conflicts.length
                                ? 'The GitHub backup is safe, but newer local photo changes still need another backup.'
                                : 'The GitHub backup is safe, but local backup status could not be fully updated. Try again.',
                        },
                    } : {}),
                };
            } catch (error) {
                if (!remoteConfirmed) {
                    if (error instanceof PhotoBackup.PhotoBackupCapacityError) {
                        const capacityError = error as InstanceType<typeof PhotoBackup.PhotoBackupCapacityError> & {
                            generation?: number;
                        };
                        const previous = state || await readPhotoBackupState().catch(() => null);
                        await ext.storage.local.set({
                            [PHOTO_BACKUP_STATE_KEY]: {
                                ...(previous || {}),
                                capacityBlockedGeneration: capacityError.generation ?? local?.generation ?? null,
                                capacityActualBytes: capacityError.actualBytes,
                                capacityMaxBytes: capacityError.maxBytes,
                                attempts: 0,
                            },
                        }).catch(() => {});
                    } else {
                        await markPhotoCatalogBackup({ state: 'failed' }).catch(() => {});
                    }
                    return {
                        ok: false,
                        error: publicPhotoBackupError(error, 'The photo-library backup failed.'),
                    };
                }
                return {
                    ok: true,
                    current: false,
                    reconciliationPending: true,
                    warning: {
                        code: 'photo-backup-reconciliation',
                        message: 'The GitHub backup is safe, but local backup status could not be fully updated. Try again.',
                    },
                };
            }
        });
    };

    const previewPhotoLibraryRestore = async (
        _message: GithubRoutesMessage,
        sender: chrome.runtime.MessageSender,
    ) => {
        if (!isPhotoBackupPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            const remoteText = await access.client.readRootFile(PhotoBackup.BACKUP_PATH, {
                maxBytes: PhotoBackup.MAX_BYTES,
            });
            if (remoteText == null) {
                return { ok: false, error: { code: 'not-found', message: 'No photo-library backup was found.' } };
            }
            const remote = parseRemotePhotoBackup(remoteText);
            const [local, state, remoteSignature] = await Promise.all([
                buildPhotoLibraryBackup(),
                readPhotoBackupState(),
                PhotoBackup.signature(remote),
            ]);
            const merged = await PhotoBackup.mergePayloads(local.payload, remote, {
                exportedAt: photoTimestamp(),
                extensionVersion: ext.runtime?.getManifest?.().version || '',
                baseSignature: sameRepo(state?.repo, access.repo) ? (state?.signature ?? null) : null,
                baseSignatureVersion: state?.signatureVersion || 1,
            });
            return {
                ok: true,
                signature: remoteSignature,
                counts: merged.counts,
                conflicts: merged.ok ? [] : merged.conflicts.map(value => value.localId),
                remotePhotos: remote.photos.length,
                remoteTombstones: remote.tombstones.length,
            };
        } catch (error) {
            return {
                ok: false,
                error: publicPhotoBackupError(error, 'The photo-library backup could not be read.'),
            };
        }
    };

    const restorePhotoLibrary = async (message: GithubRoutesMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPhotoBackupPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const expectedSignature = typeof message?.signature === 'string'
            && /^[0-9a-f]{64}$/.test(message.signature)
            ? message.signature
            : null;
        if (!expectedSignature) return { ok: false, error: { code: 'invalid-restore' } };
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            const remoteText = await access.client.readRootFile(PhotoBackup.BACKUP_PATH, {
                maxBytes: PhotoBackup.MAX_BYTES,
            });
            if (remoteText == null) throw new PhotoBackupError('not-found', 'No photo-library backup was found.');
            const remote = parseRemotePhotoBackup(remoteText);
            const remoteSignature = await PhotoBackup.signature(remote);
            if (remoteSignature !== expectedSignature) {
                throw new PhotoBackupError(
                    'restore-changed',
                    'The GitHub backup changed after the preview. Review it again before restoring.',
                );
            }
            const [local, state] = await Promise.all([
                buildPhotoLibraryBackup(),
                readPhotoBackupState(),
            ]);
            const merged = await PhotoBackup.mergePayloads(local.payload, remote, {
                exportedAt: photoTimestamp(),
                extensionVersion: ext.runtime?.getManifest?.().version || '',
                baseSignature: sameRepo(state?.repo, access.repo) ? (state?.signature ?? null) : null,
                baseSignatureVersion: state?.signatureVersion || 1,
                conflictPolicy: message.keepLocalConflicts ? 'keep-local' : 'stop',
            });
            if (!merged.ok) {
                return {
                    ok: false,
                    error: {
                        code: 'photo-backup-conflict',
                        message: 'Choose whether to keep the local versions of conflicting photos.',
                        conflictCount: merged.conflicts.length,
                    },
                };
            }
            const records = merged.payload.photos
                .map(record => PhotoBackup.restoreRecord(record, {
                    signature: remoteSignature,
                    restoredAt: photoTimestamp(),
                }))
                .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
            await withPhotoStore(store => store.applyRestore({
                records,
                tombstones: merged.payload.tombstones,
                expectedRevisions: local.revisions,
            }));
            const restoredSnapshot = await buildPhotoLibraryBackup();
            const restoredCurrent = restoredSnapshot.signature === remoteSignature;
            if (restoredCurrent) {
                await withPhotoStore(store => store.confirmCatalogBackup({
                    generation: restoredSnapshot.generation,
                    signature: remoteSignature,
                    revisions: restoredSnapshot.revisions,
                    backedUpAt: photoTimestamp(),
                }));
            }
            await ext.storage.local.set({
                [PHOTO_BACKUP_STATE_KEY]: {
                    signature: remoteSignature,
                    generation: restoredSnapshot.generation,
                    revisions: restoredSnapshot.revisions,
                    restoredAt: photoTimestamp(),
                    commitUrl: null,
                    repo: access.repo,
                    attempts: 0,
                    reconciliationPending: !restoredCurrent,
                },
            });
            return {
                ok: true,
                counts: merged.counts,
                keptLocalConflicts: merged.conflicts.length,
            };
        } catch (error) {
            return {
                ok: false,
                error: publicPhotoBackupError(error, 'The photo-library backup could not be restored.'),
            };
        }
    };

    const armPhotoBackup = (delayInMinutes: number) => ext.alarms?.create(PHOTO_BACKUP_ALARM, {
        delayInMinutes,
        periodInMinutes: AUTO_BACKUP_WATCHDOG_MINUTES,
    });

    const schedulePhotoLibraryBackup = async () => {
        if (await automaticPhotoBackupEnabled() && ext.alarms) armPhotoBackup(AUTO_BACKUP_DELAY_MINUTES);
    };

    const photoLibraryChanged = async (_message: GithubRoutesMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPhotoPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        await schedulePhotoLibraryBackup();
        return { ok: true };
    };

    // The last gate value this worker acted on, persisted so an MV3 teardown
    // between the toggle and the next settings write cannot turn a rising edge
    // into a level and re-arm the scan on every subsequent write.
    const schedulePhotoBackupOnEnable = async (enabled: boolean) => {
        let previous: unknown = null;
        try {
            previous = (await ext.storage.local.get(PHOTO_BACKUP_GATE_KEY))[PHOTO_BACKUP_GATE_KEY] ?? null;
        } catch {
            // An unreadable gate record is treated as "not seen yet": a
            // redundant first scan is better than a backup that never starts.
        }
        if (previous === enabled) {
            if (enabled && ext.alarms?.get) {
                const alarm = await ext.alarms.get(PHOTO_BACKUP_ALARM);
                if (!alarm || alarm.periodInMinutes !== AUTO_BACKUP_WATCHDOG_MINUTES) {
                    armPhotoBackup(AUTO_BACKUP_DELAY_MINUTES);
                }
            }
            return;
        }
        await ext.storage.local.set({ [PHOTO_BACKUP_GATE_KEY]: enabled });
        if (enabled && ext.alarms) {
            armPhotoBackup(AUTO_BACKUP_DELAY_MINUTES);
        } else if (!enabled && ext.alarms?.clear) {
            await ext.alarms.clear(PHOTO_BACKUP_ALARM);
        }
    };

    const startPhotoBackupWatchdog = async () => {
        if (!ext.alarms) return;
        const alarm = ext.alarms.get ? await ext.alarms.get(PHOTO_BACKUP_ALARM) : null;
        if (!alarm || alarm.periodInMinutes !== AUTO_BACKUP_WATCHDOG_MINUTES) {
            // Startup must not consume a settings read that belongs to a
            // privacy or preservation transaction. The inexpensive alarm can
            // always exist; firePhotoAutoBackup checks the opt-in before any
            // catalog or GitHub work.
            armPhotoBackup(AUTO_BACKUP_WATCHDOG_MINUTES);
        }
    };

    const firePhotoAutoBackup = async () => {
        if (!await automaticPhotoBackupEnabled()) return;
        const [catalog, previousState] = await Promise.all([
            withPhotoStore(store => store.getCatalogState()),
            readPhotoBackupState(),
        ]);
        if (previousState?.capacityBlockedGeneration === catalog.generation) return;
        const result = await backupPhotoLibrary({ automatic: true });
        if ((result.ok && !result.reconciliationPending)
            || (!result.ok && ['photo-backup-conflict', 'photo-backup-too-large'].includes(result.error.code))
            || !ext.alarms) return;
        const state = await readPhotoBackupState();
        const attempts = ((state && state.attempts) || 0) + 1;
        await ext.storage.local.set({ [PHOTO_BACKUP_STATE_KEY]: { ...(state || {}), attempts } });
        if (attempts <= AUTO_BACKUP_MAX_RETRIES) {
            armPhotoBackup(AUTO_BACKUP_RETRY_MINUTES);
        }
    };

    const startAutomaticBackups = async () => {
        await settingsAutoBackup.startWatchdog();
        await favoritesAutoBackup.startWatchdog();
        await startPhotoBackupWatchdog();
    };


    const routeTable = createGithubRouteTable({
        PEAKBAGGER_MY_ASCENTS: extensionPage(() => peakbaggerMyAscents()),
        GITHUB_AUTH_STATUS: extensionPage(() => githubStatus(), [...climberPages, 'photos/photos.html']),
        GITHUB_AUTH_BEGIN: extensionPage(() => githubBeginAuth()),
        GITHUB_AUTH_STATE: extensionPage(() => githubPollAuth()),
        GITHUB_AUTH_DISCOVER: extensionPage(() => githubDiscoverRepos()),
        GITHUB_AUTH_SELECT_REPO: extensionPage(message => githubSelectRepo(message)),
        GITHUB_AUTH_DISCONNECT: extensionPage(() => githubDisconnect()),
        GITHUB_BACKUP_SNAPSHOT: peakbaggerPage((message, sender) => storeBackupSnapshot(message, sender)),
        GITHUB_BACKUP_STATUS: peakbaggerPage((_message, sender) => githubBackupStatus(sender)),
        GITHUB_ASCENT_BACKUP_PREFLIGHT: peakbaggerPage((message, sender) => preflightAscentBackup(message, sender)),
        GITHUB_CHECK_ASCENT_BACKUP: peakbaggerPage((message, sender) => checkAscentBackup(message, sender)),
        GITHUB_BACKUP_ASCENT: peakbaggerPage((message, sender) => backupAscent(message, sender)),
        GITHUB_ASCENT_DELETE_INTENT: peakbaggerPage((message, sender) => storeAscentDeleteIntent(message, sender)),
        GITHUB_ASCENT_DELETE_PENDING: peakbaggerPage((_message, sender) => pendingAscentDeletions(sender)),
        GITHUB_ASCENT_DELETE_CONFIRM: peakbaggerPage((message, sender) => confirmAscentDeletion(message, sender)),
        GITHUB_ASCENT_BACKUP_SUMMARY: extensionPage(() => githubAscentBackupSummary()),
        GITHUB_BACKUP_PROFILE_STATUS: peakbaggerPage((_message, sender) => githubProfileBackupStatus(sender)),
        GITHUB_BACKUP_PROFILE_BATCH: peakbaggerPage((message, sender) => backupProfileBatch(message, sender)),
        GITHUB_IGNORED_LIST: extensionPage(ignoredListAction, climberPages),
        GITHUB_FAVORITES_BACKUP: extensionPage(message => backupFavorites(message), climberPages),
        GITHUB_FAVORITES_RESTORE: extensionPage(() => restoreFavorites(), climberPages),
        GITHUB_SETTINGS_BACKUP: extensionPage(message => backupSettings(message)),
        GITHUB_SETTINGS_RESTORE: extensionPage(() => restoreSettings()),
        GITHUB_PHOTOS_STATUS: extensionPage((message, sender) => photoBackupStatus(message, sender), photoPages),
        GITHUB_PHOTOS_BACKUP: extensionPage((_message, sender) => backupPhotoLibrary({ sender }), photoPages),
        GITHUB_PHOTOS_RESTORE_PREVIEW: extensionPage((message, sender) => previewPhotoLibraryRestore(message, sender), photoPages),
        GITHUB_PHOTOS_RESTORE: extensionPage((message, sender) => restorePhotoLibrary(message, sender), photoPages),
        GITHUB_PHOTOS_CHANGED: extensionPage((message, sender) => photoLibraryChanged(message, sender), ['photos/photos.html']),
    });
    const { handlers } = routeTable;

    const cleanup = async (cutoff: number) => {
        await mutateMap<void, StoredSnapshotRecord>(SNAPSHOTS_KEY, snapshots => {
            Object.entries(snapshots).forEach(([key, record]) => {
                if (!record || (record.expiresAt ?? 0) <= cutoff) delete snapshots[key];
            });
        });
        await mutateMap<void, AscentDeleteIntentRecord>(ASCENT_DELETE_INTENTS_KEY, intents => {
            Object.entries(intents).forEach(([key, record]) => {
                if (!record || record.expiresAt <= cutoff) delete intents[key];
            });
        });
    };

    const onStorageChanged = (changes: Record<string, unknown>, area: string) => {
        if (area !== 'local') return;
        const connectionChanged = !!(changes[GithubAuth.STORAGE_KEY] || changes[GithubAuth.EPOCH_KEY]);
        if (connectionChanged) ignoredSync.connectionChanged();
        if (changes[Ignored.IGNORED_KEY]) void ignoredSync.localChanged().catch(() => {});
        const layersChanged = !!(changes[CUSTOM_REGISTRY_KEY] || changes[CUSTOM_PREFERENCES_KEY]);
        if (!connectionChanged && !changes[Favorites.FAVORITES_KEY] && !layersChanged) return;
        void Settings.requireCurrent().then(settings => {
            if ((connectionChanged || layersChanged) && settings.autoSettingsBackup) settingsAutoBackup.schedule();
            if ((connectionChanged || changes[Favorites.FAVORITES_KEY]) && settings.autoFavoritesBackup) favoritesAutoBackup.schedule();
            if (connectionChanged && settings.autoPhotoLibraryBackup) armPhotoBackup(AUTO_BACKUP_DELAY_MINUTES);
        }).catch(() => {});
    };

    const onSettingsChanged = (currentSettings: SettingsData) => {
        if (currentSettings.autoSettingsBackup) settingsAutoBackup.schedule();
        if (currentSettings.autoFavoritesBackup) favoritesAutoBackup.schedule();
        // Settings and favorites are free to nudge on every settings write:
        // fire() compares a cheap in-memory signature and returns. The photo
        // library has no such summary — deciding whether it changed means
        // reading every record out of IndexedDB and hashing the payload — so
        // nudging it here made an unrelated write like toggling dark mode scan
        // the whole library. The library announces its own changes through
        // GITHUB_PHOTOS_CHANGED; a settings write only has to catch the one
        // case that announcement cannot, which is the toggle being switched on.
        void schedulePhotoBackupOnEnable(currentSettings.autoPhotoLibraryBackup === true);
    };

    const onAlarm = (name: string) => {
        const ignoredOperation = ignoredSync.onAlarm(name);
        if (ignoredOperation) return ignoredOperation;
        if (name === SETTINGS_BACKUP_ALARM) return settingsAutoBackup.fire();
        if (name === FAVORITES_BACKUP_ALARM) return favoritesAutoBackup.fire();
        if (name === PHOTO_BACKUP_ALARM) return firePhotoAutoBackup();
        return undefined;
    };

    return {
        handlers,
        cleanup,
        onStorageChanged,
        onSettingsChanged,
        onAlarm,
        startPhotoBackupWatchdog,
        startAutomaticBackups,
        schedulePhotoLibraryBackup,
        startIgnoredSync: ignoredSync.start,
        validateImportedConnection,
        isExtensionOnly: routeTable.isExtensionOnly,
        isPhotoPage,
    };
}
