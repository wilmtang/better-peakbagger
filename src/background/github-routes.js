// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settings as Settings } from '../settings/settings.js';
import { settingsTransfer as Transfer } from '../settings/settings-transfer.js';
import { favoriteClimbers as Favorites } from '../favorites/favorite-climbers.js';
import { photoBackup as PhotoBackup } from '../photos/photo-backup.js';
import { photoLibrary as Library } from '../photos/photo-library.js';
import { photoStore as PhotoStore } from '../photos/photo-store.js';
import { githubAuth as GithubAuth } from '../github/github-auth.js';
import { githubClient as GithubClient } from '../github/github-client.js';
import { githubErrors as GithubErrors } from '../github/github-errors.js';
import { githubWriteQueue as GithubWriteQueue } from '../github/github-write-queue.js';
import { publicErrors as PublicErrors } from './public-errors.js';

const GITHUB_AUTH_PENDING_KEY = 'bpbGithubAuthPending';
const FAVORITE_CLIMBERS_BACKUP_PATH = 'favorite-climbers.json';
const SETTINGS_BACKUP_ALARM = 'bpb-settings-backup';
const SETTINGS_BACKUP_STATE_KEY = 'bpbSettingsBackupState';
const FAVORITES_BACKUP_ALARM = 'bpb-favorites-backup';
const FAVORITES_BACKUP_STATE_KEY = 'bpbFavoritesBackupState';
const PHOTO_BACKUP_ALARM = 'bpb-photo-library-backup';
const PHOTO_BACKUP_STATE_KEY = 'bpbPhotoLibraryBackupState';
const AUTO_BACKUP_DELAY_MINUTES = 1;
const AUTO_BACKUP_RETRY_MINUTES = 10;
const AUTO_BACKUP_MAX_RETRIES = 2;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_LIMIT = 10;
const PROFILE_BACKUP_BATCH_LIMIT = 10;
const ASCENT_DELETE_INTENTS_KEY = 'bpbGithubAscentDeleteIntents';
const ASCENT_DELETE_TTL_MS = 30 * 60 * 1000;

export function createGithubRoutes({
    ext,
    snapshotKey: SNAPSHOTS_KEY,
    storage,
    now,
    peakbaggerLogin,
    isPeakbaggerSender,
    isClimbListSender,
    isFresh,
    readMap,
    mutateMap,
    createPhotoStore = PhotoStore.createPhotoStore,
    resolveGithubAccess = null,
}) {
    // ---- GitHub ascent backup: auth + repository setup ---------------------
    //
    // The token lives only here (via GithubAuth.authStore over storage.local)
    // and is never returned to any page. The device-flow poll is driven in the
    // worker; the options page shows the user code and advances a persisted,
    // one-request-at-a-time poll through GITHUB_AUTH_STATE. Repo scoping happens
    // on GitHub's own install page, then discovery lists exactly what the token
    // can reach.

    const netFetch = (url, init) => fetch(url, init);
    const readPendingGithubAuth = async () => (await storage().get(GITHUB_AUTH_PENDING_KEY))[GITHUB_AUTH_PENDING_KEY] || null;
    const writePendingGithubAuth = pending => storage().set({ [GITHUB_AUTH_PENDING_KEY]: pending });
    const clearPendingGithubAuth = () => storage().remove(GITHUB_AUTH_PENDING_KEY);
    const publicGithubAuthState = pending => ({
        phase: 'polling',
        userCode: pending.userCode,
        verificationUri: pending.verificationUri,
        verificationUriComplete: pending.verificationUriComplete,
        expiresIn: pending.expiresIn,
        startedAt: pending.startedAt,
    });

    const peakbaggerMyAscents = async () => {
        let cid;
        try {
            cid = await peakbaggerLogin();
        } catch (error) {
            const peakbaggerFailure = error?.source === 'peakbagger';
            return {
                ok: false,
                error: {
                    ...(peakbaggerFailure ? { source: 'peakbagger' } : {}),
                    code: peakbaggerFailure && error.code ? error.code : 'peakbagger-unavailable',
                    message: peakbaggerFailure && error.message
                        ? error.message
                        : 'Could not reach Peakbagger. Check your connection, then try again.',
                },
            };
        }
        if (!cid) {
            return {
                ok: false,
                error: {
                    code: 'peakbagger-signed-out',
                    message: 'Peakbagger could not find a signed-in account. Sign in to Peakbagger, then try again.',
                },
            };
        }
        const url = new URL('https://www.peakbagger.com/climber/ClimbListC.aspx');
        url.searchParams.set('cid', cid);
        url.searchParams.set('j', '-1');
        url.searchParams.set('y', '9999');
        url.searchParams.set('sort', 'AscentDate');
        return { ok: true, url: url.toString() };
    };

    const githubStatus = async () => {
        const auth = await GithubAuth.authStore.read();
        const settings = await Settings.get();
        return {
            enabled: settings.enableGithubBackup,
            auto: settings.autoGithubBackup,
            connected: !!(auth && auth.token && auth.repo && auth.repo.owner && auth.repo.name),
            hasToken: !!(auth && auth.token),
            account: (auth && auth.account) || null,
            repo: (auth && auth.repo) || null,
            installUrl: GithubAuth.INSTALL_URL,
            appUrl: GithubAuth.APP_URL,
            verificationUri: GithubAuth.VERIFICATION_URI,
        };
    };

    // Keep an existing choice only while it remains in the app installation.
    // New connections always go through repository inspection; auto-selecting a
    // sole repo would skip the populated-repository confirmation and collision
    // checks that make this write boundary safe.
    const reconcileDiscoveredRepo = async repos => {
        const selected = await GithubAuth.authStore.getRepo();
        if (!selected) return;
        const stillGranted = repos.some(repo => repo.owner === selected.owner && repo.name === selected.name);
        if (stillGranted) return;
        await GithubAuth.authStore.setRepo(null);
        await GithubAuth.authStore.setInstallationId(null);
    };

    const githubBeginAuth = async () => {
        await clearPendingGithubAuth();
        const flow = GithubAuth.createDeviceFlow({ fetch: netFetch });
        let code;
        try {
            code = await flow.requestCode();
        } catch (error) {
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
        const startedAt = now();
        const pending = {
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
        await writePendingGithubAuth(pending);
        return publicGithubAuthState(pending);
    };

    const githubPollAuth = async () => {
        const pending = await readPendingGithubAuth();
        if (!pending) return { phase: 'idle' };
        if (now() > pending.expiresAt) {
            await clearPendingGithubAuth();
            return { phase: 'error', code: 'expired' };
        }
        if (now() < pending.nextPollAt) return publicGithubAuthState(pending);

        const flow = GithubAuth.createDeviceFlow({ fetch: netFetch });
        try {
            const result = await flow.pollTokenOnce(pending);
            if (result.phase === 'pending' || result.phase === 'slow-down') {
                const interval = result.phase === 'slow-down'
                    ? Math.max(pending.interval + 5, result.interval)
                    : pending.interval;
                const next = { ...pending, interval, nextPollAt: now() + interval * 1000 };
                await writePendingGithubAuth(next);
                return publicGithubAuthState(next);
            }

            const cred = result.credential;
            await GithubAuth.authStore.setCredential(cred);
            await GithubAuth.authStore.setRepo(null);
            await GithubAuth.authStore.setInstallationId(null);
            let account = null;
            try { account = await GithubAuth.fetchAccount({ fetch: netFetch, token: cred.token }); await GithubAuth.authStore.setAccount(account); } catch { /* non-fatal */ }
            let repos = [];
            let installationCount = 0;
            try {
                const discovered = await GithubAuth.listBackupRepositories({ fetch: netFetch, token: cred.token });
                repos = discovered.repos;
                installationCount = discovered.installationCount;
                await reconcileDiscoveredRepo(repos);
            } catch { /* the user may not have installed yet; discover again later */ }
            await clearPendingGithubAuth();
            return { phase: 'authorized', account, repos, installationCount };
        } catch (error) {
            await clearPendingGithubAuth();
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
    };

    // Re-list repositories on demand — after the user returns from the install
    // page having granted (or changed) the selected repositories.
    const githubDiscoverRepos = async () => {
        const token = await GithubAuth.authStore.getToken();
        if (!token) return { phase: 'error', code: 'no-token' };
        try {
            const { repos, installationCount } = await GithubAuth.listBackupRepositories({ fetch: netFetch, token });
            await reconcileDiscoveredRepo(repos);
            return { installationCount, repos, repo: await GithubAuth.authStore.getRepo() };
        } catch (error) {
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
    };

    const githubSelectRepo = async message => {
        const r = message && message.repo;
        if (!r || !r.owner || !r.name) return { error: 'invalid-repo' };
        const token = await GithubAuth.authStore.getToken();
        if (!token) return { connected: false, error: { code: 'no-token' } };
        const client = GithubClient.createGithubClient({
            fetch: netFetch,
            token,
            owner: r.owner,
            repo: r.name,
            branch: r.branch || r.defaultBranch || undefined,
        });
        let inspection;
        try {
            inspection = await client.inspectRepository();
        } catch (error) {
            return {
                connected: false,
                error: GithubErrors.publicError(error, 'Could not inspect the repository.'),
            };
        }
        if (inspection.kind === 'existing' && !message.confirmExisting) {
            return {
                connected: false,
                needsConfirmation: true,
                repo: r,
                inspection,
            };
        }
        await GithubAuth.authStore.setRepo({
            owner: r.owner,
            name: r.name,
            branch: inspection.branch,
            id: r.id ?? null,
            fullName: r.fullName || `${r.owner}/${r.name}`,
        });
        if (r.installationId != null) await GithubAuth.authStore.setInstallationId(r.installationId);
        return { ...(await githubStatus()), inspection };
    };

    const githubDisconnect = async () => {
        await clearPendingGithubAuth();
        await GithubAuth.authStore.clear();
        // Clearing the one local record removes the token, repository, and
        // derived account together. Do not immediately re-read that storage
        // just to prove what the successful remove already established: a
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
    const storeBackupSnapshot = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, reason: 'forbidden' };
        if (!message || !message.key || !message.snapshot) return { ok: false, reason: 'invalid' };
        const settings = await Settings.get();
        if (!settings.enableGithubBackup) return { ok: false, reason: 'disabled' };
        const sourceTabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
        const storageKey = sourceTabId == null ? message.key : `${message.key}|tab:${sourceTabId}`;
        await mutateMap(SNAPSHOTS_KEY, snapshots => {
            snapshots[storageKey] = {
                identity: message.identity || null,
                snapshot: message.snapshot,
                sourceTabId,
                savedAt: now(),
                expiresAt: now() + SNAPSHOT_TTL_MS,
            };
            const ordered = Object.entries(snapshots).sort((a, b) => b[1].savedAt - a[1].savedAt);
            for (const [key] of ordered.slice(SNAPSHOT_LIMIT)) delete snapshots[key];
        });
        return { ok: true };
    };

    // Whether the saved ascent page should offer a backup: enabled and connected.
    // Content-script safe — it exposes no token, only the flags and repo name.
    const githubBackupStatus = async sender => {
        if (!isPeakbaggerSender(sender)) return { enabled: false, connected: false };
        const settings = await Settings.get();
        const auth = await GithubAuth.authStore.read();
        const connected = !!(auth && auth.token && auth.repo && auth.repo.owner && auth.repo.name);
        return {
            enabled: !!settings.enableGithubBackup,
            auto: !!settings.autoGithubBackup,
            connected,
            repo: connected ? { fullName: auth.repo.fullName || `${auth.repo.owner}/${auth.repo.name}` } : null,
        };
    };

    const positiveAscentId = value => {
        if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    };

    const isAscentEditSender = (sender, ascentId) => {
        if (!isPeakbaggerSender(sender)) return false;
        try {
            const url = new URL(sender.url);
            return /\/climber\/ascentedit\.aspx$/i.test(url.pathname)
                && positiveAscentId(url.searchParams.get('aid')) === ascentId;
        } catch { return false; }
    };

    const senderTabId = sender => Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
    const deletionRecord = async ascentId => {
        const intents = await readMap(ASCENT_DELETE_INTENTS_KEY);
        const record = intents[String(ascentId)];
        return isFresh(record) ? record : null;
    };
    const deletionBlocksBackup = async ascentIds => {
        for (const ascentId of ascentIds) {
            if (await deletionRecord(ascentId)) return ascentId;
        }
        return null;
    };
    const clearAscentSnapshots = ascentId => mutateMap(SNAPSHOTS_KEY, snapshots => {
        for (const [key, record] of Object.entries(snapshots)) {
            if (positiveAscentId(record?.identity?.ascentId) === ascentId) delete snapshots[key];
        }
    });

    // Phase one: intercept only Peakbagger's two native Delete submitters and
    // durably record intent before the destructive POST is allowed to proceed.
    // No GitHub mutation happens here.
    const storeAscentDeleteIntent = async (message, sender) => {
        const ascentId = positiveAscentId(message?.aid);
        if (!ascentId || !isAscentEditSender(sender, ascentId)) {
            return { ok: false, error: { code: 'forbidden' } };
        }
        const settings = await Settings.get();
        if (!settings.enableGithubBackup || !settings.removeGithubBackupOnDelete) {
            return { ok: false, error: { code: 'disabled' } };
        }
        const access = await connectedGithubClient({ requireEnabled: true });
        if (access.error) return { ok: false, error: access.error };
        const tabId = senderTabId(sender);
        if (tabId == null) return { ok: false, error: { code: 'forbidden' } };

        await mutateMap(ASCENT_DELETE_INTENTS_KEY, intents => {
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
    const pendingAscentDeletions = async sender => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const settings = await Settings.get();
        if (!settings.enableGithubBackup || !settings.removeGithubBackupOnDelete) {
            return { ok: true, aids: [] };
        }
        const tabId = senderTabId(sender);
        const intents = await readMap(ASCENT_DELETE_INTENTS_KEY);
        const aids = Object.values(intents)
            .filter(record => isFresh(record) && record.state === 'pending' && record.sourceTabId === tabId)
            .map(record => positiveAscentId(record.aid))
            .filter(Boolean);
        return { ok: true, aids: [...new Set(aids)] };
    };

    // Phase two: the isolated ClimbListC content script supplies the parsed,
    // complete all-years owner list. Recheck the signed-in owner in the worker,
    // then delete only when the intended aid is authoritatively absent.
    const confirmAscentDeletion = async (message, sender) => {
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
        const settings = await Settings.get();
        if (!settings.enableGithubBackup || !settings.removeGithubBackupOnDelete) {
            return { ok: false, error: { code: 'disabled' } };
        }
        let signedInId = null;
        try { signedInId = positiveAscentId(await peakbaggerLogin()); }
        catch (error) {
            return {
                ok: false,
                error: {
                    source: 'peakbagger',
                    code: error?.code || 'peakbagger-unavailable',
                    message: error?.message || 'Could not confirm the signed-in Peakbagger account.',
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
            await mutateMap(ASCENT_DELETE_INTENTS_KEY, intents => { delete intents[String(ascentId)]; });
            return { ok: true, confirmed: false, reason: 'still-present' };
        }

        const access = await connectedGithubClient({ requireEnabled: true });
        if (access.error) return { ok: false, error: access.error };
        try {
            const result = await writeQueue.run(() => access.client.deleteAscentBackup(ascentId));
            await clearAscentSnapshots(ascentId);
            await mutateMap(ASCENT_DELETE_INTENTS_KEY, intents => {
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
                error: GithubErrors.publicError(error, 'The deleted ascent could not be removed from GitHub.'),
            };
        }
    };

    const connectedGithubClient = async ({ requireEnabled = false } = {}) => {
        if (typeof resolveGithubAccess === 'function') {
            return resolveGithubAccess({ requireEnabled });
        }
        if (requireEnabled && !(await Settings.get()).enableGithubBackup) {
            return { error: { code: 'disabled' } };
        }
        const auth = await GithubAuth.authStore.read();
        if (!auth || !auth.token) return { error: { code: 'not-connected' } };
        if (!auth.repo || !auth.repo.owner || !auth.repo.name) return { error: { code: 'no-repo' } };
        return {
            repo: {
                owner: auth.repo.owner,
                name: auth.repo.name,
                branch: auth.repo.branch || null,
            },
            client: GithubClient.createGithubClient({
                fetch: netFetch,
                token: auth.token,
                owner: auth.repo.owner,
                repo: auth.repo.name,
                branch: auth.repo.branch || undefined,
            }),
        };
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
    // The batch resolves the connection once, at commit time rather than at
    // submission, so a disconnect during the short collecting window fails as
    // the same route error a fail-fast check would have produced.
    class GithubAccessError extends Error {
        constructor(error) {
            super((error && error.message) || 'No GitHub repository is connected.');
            this.name = 'GithubAccessError';
            this.access = error;
        }
    }
    const writeError = (error, fallback) => error instanceof GithubAccessError
        ? error.access
        : GithubErrors.publicError(error, fallback);

    const writeQueue = GithubWriteQueue.createGithubWriteQueue({
        commitFiles: async (files, message) => {
            const access = await connectedGithubClient();
            if (access.error) throw new GithubAccessError(access.error);
            return access.client.putRootFiles(files, message);
        },
    });

    // Profile backup preflight adds the repository's ascent-folder leaves to
    // the ordinary status. This stays a dedicated message so viewing a saved
    // ascent never pays for GitHub tree reads.
    const githubProfileBackupStatus = async sender => {
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
                error: GithubErrors.publicError(error, 'Could not check the existing ascent backups.'),
            };
        }
    };

    // Merge the pending save-time snapshot with the saved ascent page's fields.
    // The saved page is authoritative for the identity and the fields it renders
    // (aid, date, suffix, peak name/elevation/location); the snapshot supplies
    // the fields the page does not (the entered numbers) and the resolved report.
    const mergeBackupSnapshot = (snap, page = {}, { pageComplete = false } = {}) => {
        const p = page && typeof page === 'object' ? page : {};
        const base = snap && typeof snap === 'object' ? snap : null;
        if (!base && !p.ascent && !p.peak) return null;
        const ascent = { ...(base ? base.ascent : {}) };
        const pAscent = p.ascent || {};
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
        const peak = { ...(base && base.peak ? base.peak : {}) };
        for (const [key, value] of Object.entries(p.peak || {})) {
            if (value != null && value !== '') peak[key] = value;
        }
        const snapMarkdown = base && base.report && typeof base.report.markdown === 'string' ? base.report.markdown : '';
        const pageMarkdown = p.report && typeof p.report.markdown === 'string' ? p.report.markdown : '';
        const report = { markdown: snapMarkdown || pageMarkdown };
        return { ascent, peak, report, backup: { ...(base ? base.backup : {}) } };
    };

    // Find the pending snapshot for a saved ascent page. A new ascent had no aid
    // when it was snapshotted, so match by ascent id first (re-saves/edits), then
    // by peak+date. A peak-only match can attach a different ascent's report and
    // fields, so absence of a precise match is handled by the complete edit-form
    // snapshot supplied by the individual backup surface.
    const findSnapshotForPage = async (page, sender) => {
        const snapshots = await readMap(SNAPSHOTS_KEY);
        const entries = Object.entries(snapshots)
            .filter(([, record]) => isFresh(record))
            .map(([key, record]) => ({ key, record }))
            .sort((a, b) => (b.record.savedAt || 0) - (a.record.savedAt || 0));
        const idOf = e => e.record.identity || {};
        const ascentId = page && page.ascent ? page.ascent.id : null;
        const peakId = page && page.peak ? page.peak.id : null;
        const date = page && page.ascent ? page.ascent.date : null;
        const sourceTabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
        const find = predicate => (sourceTabId == null ? null : entries.find(e => e.record.sourceTabId === sourceTabId && predicate(e)))
            || entries.find(predicate);
        let match = ascentId != null ? find(e => idOf(e).ascentId === ascentId) : null;
        if (!match && peakId != null && date) match = find(e => idOf(e).peakId === peakId && idOf(e).date === date);
        return match || null;
    };

    // Token-free, read-only freshness preflight for the individual ascent
    // surface. The content script supplies the complete persisted edit-form
    // identity, avoiding the display page's best-effort date. No snapshot data
    // crosses the boundary.
    const preflightAscentBackup = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, fresh: false, error: { code: 'forbidden' } };
        const status = await githubBackupStatus(sender);
        if (!status.enabled) return { ok: false, fresh: false, error: { code: 'disabled' } };
        if (!status.connected) return { ok: false, fresh: false, error: { code: 'not-connected' } };
        if (!message || !message.pageComplete || !message.page) {
            return { ok: false, fresh: false, error: { code: 'no-data' } };
        }
        return { ok: true, fresh: !!(await findSnapshotForPage(message.page, sender)) };
    };

    // Push one saved ascent to the connected repository as a single commit. The
    // token is read here and never leaves the worker. Fails closed when the
    // feature is off, disconnected, or the sender is not a Peakbagger tab.
    const backupAscent = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const access = await connectedGithubClient({ requireEnabled: true });
        if (access.error) return { ok: false, error: access.error };

        const found = await findSnapshotForPage(message.page, sender);
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
            return { ok: false, error: { code: 'ascent-delete-pending', message: 'This ascent was deleted from Peakbagger, so its GitHub backup was not recreated.' } };
        }
        snapshot.backup = {
            ...(snapshot.backup || {}),
            syncedAt: new Date().toISOString(),
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : (snapshot.backup && snapshot.backup.extensionVersion) || '',
        };

        try {
            const result = await writeQueue.run(async () => {
                if (await deletionBlocksBackup([ascentId])) {
                    const error = new Error('This ascent has a pending or completed deletion.');
                    error.code = 'ascent-delete-pending';
                    throw error;
                }
                return access.client.pushAscentBackup(snapshot, { gpx: message.gpx });
            });
            // The snapshot has served its purpose; drop it so a later view of the
            // same page does not re-push from stale data.
            if (found) await mutateMap(SNAPSHOTS_KEY, m => { delete m[found.key]; });
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The backup failed.') };
        }
    };

    // Passive, read-only comparison for an owner ascent page. It accepts only
    // the same complete edit-form snapshot that a manual backup would write,
    // so an incomplete page can never be labelled current from a sparse view.
    const checkAscentBackup = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const access = await connectedGithubClient({ requireEnabled: true });
        if (access.error) return { ok: false, error: access.error };
        if (!message || !message.pageComplete) return { ok: false, error: { code: 'no-data' } };
        const snapshot = mergeBackupSnapshot(null, message.page, { pageComplete: true });
        if (!snapshot || snapshot.ascent.id == null) return { ok: false, error: { code: 'no-data' } };
        try {
            return {
                ok: true,
                current: await access.client.isAscentBackupCurrent(snapshot, { gpx: message.gpx }),
            };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'Could not check the existing backup.') };
        }
    };

    // A profile batch is one ordered branch mutation containing up to ten
    // independently identity-checked ascents. The content script never sees
    // the token, and a malformed entry rejects the entire batch before GitHub
    // receives anything.
    const backupProfileBatch = async (message, sender) => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const entries = message && message.entries;
        if (!Array.isArray(entries) || entries.length === 0 || entries.length > PROFILE_BACKUP_BATCH_LIMIT) {
            return { ok: false, error: { code: 'no-data' } };
        }
        const seen = new Set();
        for (const entry of entries) {
            const ascentId = entry && entry.snapshot && entry.snapshot.ascent
                ? Number(entry.snapshot.ascent.id)
                : NaN;
            if (!Number.isFinite(ascentId) || ascentId <= 0 || ascentId !== Number(entry.aid) || seen.has(ascentId)) {
                return { ok: false, error: { code: 'no-data' } };
            }
            seen.add(ascentId);
        }
        const access = await connectedGithubClient({ requireEnabled: true });
        if (access.error) return { ok: false, error: access.error };
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

        const version = ext.runtime.getManifest ? ext.runtime.getManifest().version : '';
        for (const entry of entries) {
            entry.snapshot.backup = {
                ...(entry.snapshot.backup || {}),
                syncedAt: new Date().toISOString(),
                extensionVersion: version,
            };
        }
        try {
            const result = await writeQueue.run(async () => {
                const blocked = await deletionBlocksBackup([...seen]);
                if (blocked) {
                    const error = new Error(`Ascent ${blocked} has a pending or completed deletion.`);
                    error.code = 'ascent-delete-pending';
                    throw error;
                }
                return access.client.pushAscentBackups(entries.map(entry => ({
                    snapshot: entry.snapshot,
                    gpx: entry.gpx,
                })));
            });
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The backup failed.') };
        }
    };

    // Debounced, signature-gated automatic backup shared by the settings and
    // favorites paths. Replacing a named alarm gives us trailing-edge debounce
    // that survives MV3 worker teardown; fire() rechecks every gate so stale or
    // spurious alarms are harmless.
    const createAutoBackup = ({ alarmName, stateKey, path, commitMessage, enabled, build }) => {
        const readState = async () => (await ext.storage.local.get(stateKey))[stateKey] || null;
        const markSynced = signature => ext.storage.local.set({
            [stateKey]: { signature, syncedAt: new Date().toISOString() }
        });

        const schedule = () => {
            if (!ext.alarms) return;
            ext.alarms.create(alarmName, { delayInMinutes: AUTO_BACKUP_DELAY_MINUTES });
            // A fresh change grants a fresh retry budget.
            void readState().then(state => {
                if (state && state.attempts) {
                    return ext.storage.local.set({ [stateKey]: { ...state, attempts: 0 } });
                }
                return undefined;
            });
        };

        const fire = async () => {
            if (!(await enabled())) return;
            const access = await connectedGithubClient();
            if (access.error) return;
            let state = null;
            try {
                const { text, signature } = await build();
                state = await readState();
                if (state && state.signature === signature) return;
                const result = await writeQueue.putFile({ path, content: text, message: commitMessage });
                // A newer write to this path won the batch, so this signature
                // does not describe what the repository now holds.
                if (!result.superseded) await markSynced(signature);
            } catch {
                // Silent bounded retry; the manual buttons remain the loud path.
                const attempts = ((state && state.attempts) || 0) + 1;
                await ext.storage.local.set({ [stateKey]: { ...(state || {}), attempts } });
                if (attempts <= AUTO_BACKUP_MAX_RETRIES) {
                    ext.alarms.create(alarmName, { delayInMinutes: AUTO_BACKUP_RETRY_MINUTES });
                }
            }
        };

        return { schedule, fire, markSynced };
    };

    const buildSettingsBackup = async () => {
        let settings;
        try {
            settings = await Settings.requireCurrent();
        } catch (cause) {
            console.error('Better Peakbagger: settings backup read failed', cause);
            throw PublicErrors.exception(
                'settings-unavailable',
                'Settings could not be read, so no backup was changed.',
                { cause }
            );
        }
        const payload = Transfer.buildPayload(settings, {
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : '',
            exportedAt: new Date().toISOString()
        });
        return { text: Transfer.serialize(payload), signature: Transfer.signature(settings) };
    };

    const settingsAutoBackup = createAutoBackup({
        alarmName: SETTINGS_BACKUP_ALARM,
        stateKey: SETTINGS_BACKUP_STATE_KEY,
        path: Transfer.BACKUP_PATH,
        commitMessage: 'Back up settings',
        enabled: async () => (await Settings.get()).autoSettingsBackup,
        build: buildSettingsBackup
    });

    const buildFavoritesBackup = async () => {
        const stored = await ext.storage.local.get(Favorites.FAVORITES_KEY);
        const favorites = Favorites.cleanFavorites(stored[Favorites.FAVORITES_KEY]);
        const payload = Favorites.buildBackupPayload(favorites, { exportedAt: new Date().toISOString() });
        return {
            text: Favorites.serializeBackup(payload),
            signature: Favorites.backupSignature(favorites)
        };
    };

    const favoritesAutoBackup = createAutoBackup({
        alarmName: FAVORITES_BACKUP_ALARM,
        stateKey: FAVORITES_BACKUP_STATE_KEY,
        path: FAVORITE_CLIMBERS_BACKUP_PATH,
        commitMessage: 'Back up favorite climbers',
        enabled: async () => (await Settings.get()).autoFavoritesBackup,
        build: buildFavoritesBackup
    });

    const backupSettings = async () => {
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            const { text, signature } = await buildSettingsBackup();
            const result = await writeQueue.putFile({
                path: Transfer.BACKUP_PATH, content: text, message: 'Back up settings',
            });
            if (!result.superseded) await settingsAutoBackup.markSynced(signature);
            return { ok: true, result };
        } catch (error) {
            if (PublicErrors.isPublic(error)) {
                return { ok: false, error: PublicErrors.expose(error) };
            }
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
    const backupFavorites = async () => {
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        const { text, signature } = await buildFavoritesBackup();
        try {
            const result = await writeQueue.putFile({
                path: FAVORITE_CLIMBERS_BACKUP_PATH, content: text, message: 'Back up favorite climbers',
            });
            if (!result.superseded) await favoritesAutoBackup.markSynced(signature);
            return { ok: true, result };
        } catch (error) {
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
    const packagedPage = page => {
        const base = typeof ext.runtime?.getURL === 'function' ? ext.runtime.getURL(page) : null;
        return sender => {
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
    const isPhotoPage = packagedPage('photos/photos.html');
    const isOptionsPage = packagedPage('options/options.html');
    // Backup and restore are reachable from both extension-owned surfaces:
    // Settings is where every other GitHub backup lives, and the library is
    // where the user is standing when a photo changes. Announcing a catalog
    // change stays with the photo page, because that is the only page that
    // writes the catalog.
    const isPhotoBackupPage = sender => isPhotoPage(sender) || isOptionsPage(sender);
    const readPhotoBackupState = async () =>
        (await ext.storage.local.get(PHOTO_BACKUP_STATE_KEY))[PHOTO_BACKUP_STATE_KEY] || null;
    const sameRepo = (left, right) => !!left && !!right
        && left.owner === right.owner
        && left.name === right.name
        && (left.branch || null) === (right.branch || null);
    const photoTimestamp = () => new Date(now()).toISOString();

    const withPhotoStore = async operation => {
        const store = await createPhotoStore();
        try { return await operation(store); }
        finally { store.close(); }
    };

    const buildPhotoLibraryBackup = async () => withPhotoStore(async store => {
        const snapshot = await store.listBackupBundles();
        const payload = PhotoBackup.buildPayload({
            ...snapshot,
            exportedAt: photoTimestamp(),
            extensionVersion: ext.runtime.getManifest?.().version || '',
        });
        return {
            payload,
            signature: await PhotoBackup.signature(payload),
        };
    });

    const markPhotoCatalogBackup = async ({ state, signature = null, commitUrl = null }) => {
        await withPhotoStore(async store => {
            const photos = await store.listPhotos({ includeDeleted: true });
            await Promise.all(photos.map(photo => store.putPhoto(Library.cleanPhoto({
                ...photo,
                backup: {
                    state,
                    signature,
                    backedUpAt: ['current', 'restored'].includes(state) ? photoTimestamp() : null,
                    commitUrl,
                },
            }))));
        });
    };

    class PhotoBackupError extends Error {
        constructor(code, message, details = {}) {
            super(message);
            this.name = 'PhotoBackupError';
            this.code = code;
            Object.assign(this, details);
        }
    }

    const parseRemotePhotoBackup = text => {
        if (text == null) {
            return PhotoBackup.buildPayload({
                exportedAt: photoTimestamp(),
                extensionVersion: ext.runtime.getManifest?.().version || '',
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

    const publicPhotoBackupError = (error, fallback) => error instanceof PhotoBackupError
        ? {
            code: error.code,
            message: error.message,
            ...(Number.isInteger(error.conflictCount) ? { conflictCount: error.conflictCount } : {}),
        }
        : writeError(error, fallback);

    const photoBackupStatus = async (_message, sender) => {
        if (!isPhotoBackupPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const [status, state] = await Promise.all([githubStatus(), readPhotoBackupState()]);
        const repo = status.repo ? {
            owner: status.repo.owner,
            name: status.repo.name,
            branch: status.repo.branch || null,
        } : null;
        return {
            ok: true,
            connected: status.connected,
            repo: status.repo,
            auto: (await Settings.get()).autoPhotoLibraryBackup,
            state: state && sameRepo(state.repo, repo) ? state : null,
        };
    };

    const backupPhotoLibrary = async ({ automatic = false, sender = null } = {}) => {
        if (!automatic && !isPhotoBackupPage(sender)) {
            return { ok: false, error: { code: 'forbidden' } };
        }
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        let local;
        let state;
        try {
            [local, state] = await Promise.all([buildPhotoLibraryBackup(), readPhotoBackupState()]);
            if (automatic && state?.signature === local.signature && sameRepo(state.repo, access.repo)) {
                return { ok: true, current: true, signature: local.signature };
            }
            let committed = null;
            const result = await writeQueue.run(() => access.client.updateRootFile(
                PhotoBackup.BACKUP_PATH,
                async remoteText => {
                    const remote = parseRemotePhotoBackup(remoteText);
                    const merged = await PhotoBackup.mergePayloads(local.payload, remote, {
                        exportedAt: photoTimestamp(),
                        extensionVersion: ext.runtime.getManifest?.().version || '',
                        baseSignature: sameRepo(state?.repo, access.repo) ? state.signature : null,
                    });
                    if (!merged.ok) {
                        throw new PhotoBackupError(
                            'photo-backup-conflict',
                            'Backup conflict. Review the photo library before replacing either version.',
                            { conflictCount: merged.conflicts.length },
                        );
                    }
                    committed = merged;
                    const remoteSignature = await PhotoBackup.signature(remote);
                    return merged.signature === remoteSignature && remoteText != null
                        ? remoteText
                        : PhotoBackup.serialize(merged.payload);
                },
                'Back up photo library',
            ));
            const signature = committed?.signature || local.signature;
            const syncedAt = photoTimestamp();
            await ext.storage.local.set({
                [PHOTO_BACKUP_STATE_KEY]: {
                    signature,
                    syncedAt,
                    commitUrl: result.commitUrl || state?.commitUrl || null,
                    repo: access.repo,
                    attempts: 0,
                },
            });
            await markPhotoCatalogBackup({
                state: 'current',
                signature,
                commitUrl: result.commitUrl || state?.commitUrl || null,
            });
            return {
                ok: true,
                current: true,
                signature,
                result,
                counts: committed?.counts || null,
            };
        } catch (error) {
            await markPhotoCatalogBackup({ state: 'failed' }).catch(() => {});
            return {
                ok: false,
                error: publicPhotoBackupError(error, 'The photo-library backup failed.'),
            };
        }
    };

    const previewPhotoLibraryRestore = async (_message, sender) => {
        if (!isPhotoBackupPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            const remoteText = await access.client.readRootFile(PhotoBackup.BACKUP_PATH);
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
                extensionVersion: ext.runtime.getManifest?.().version || '',
                baseSignature: sameRepo(state?.repo, access.repo) ? state.signature : null,
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

    const restorePhotoLibrary = async (message, sender) => {
        if (!isPhotoBackupPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const expectedSignature = typeof message?.signature === 'string'
            && /^[0-9a-f]{64}$/.test(message.signature)
            ? message.signature
            : null;
        if (!expectedSignature) return { ok: false, error: { code: 'invalid-restore' } };
        const access = await connectedGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            const remoteText = await access.client.readRootFile(PhotoBackup.BACKUP_PATH);
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
                extensionVersion: ext.runtime.getManifest?.().version || '',
                baseSignature: sameRepo(state?.repo, access.repo) ? state.signature : null,
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
            const records = merged.payload.photos.map(record =>
                PhotoBackup.restoreRecord(record, {
                    signature: remoteSignature,
                    restoredAt: photoTimestamp(),
                }));
            await withPhotoStore(store => store.applyRestore({
                records,
                tombstones: merged.payload.tombstones,
            }));
            await ext.storage.local.set({
                [PHOTO_BACKUP_STATE_KEY]: {
                    signature: remoteSignature,
                    restoredAt: photoTimestamp(),
                    commitUrl: null,
                    repo: access.repo,
                    attempts: 0,
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

    const photoLibraryChanged = async (_message, sender) => {
        if (!isPhotoPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        if ((await Settings.get()).autoPhotoLibraryBackup && ext.alarms) {
            ext.alarms.create(PHOTO_BACKUP_ALARM, { delayInMinutes: AUTO_BACKUP_DELAY_MINUTES });
        }
        return { ok: true };
    };

    const firePhotoAutoBackup = async () => {
        if (!(await Settings.get()).autoPhotoLibraryBackup) return;
        const result = await backupPhotoLibrary({ automatic: true });
        if (result.ok || result.error?.code === 'photo-backup-conflict' || !ext.alarms) return;
        const state = await readPhotoBackupState();
        const attempts = ((state && state.attempts) || 0) + 1;
        await ext.storage.local.set({ [PHOTO_BACKUP_STATE_KEY]: { ...(state || {}), attempts } });
        if (attempts <= AUTO_BACKUP_MAX_RETRIES) {
            ext.alarms.create(PHOTO_BACKUP_ALARM, { delayInMinutes: AUTO_BACKUP_RETRY_MINUTES });
        }
    };


    const handlers = {
        PEAKBAGGER_MY_ASCENTS: () => peakbaggerMyAscents(),
        GITHUB_AUTH_STATUS: () => githubStatus(),
        GITHUB_AUTH_BEGIN: () => githubBeginAuth(),
        GITHUB_AUTH_STATE: () => githubPollAuth(),
        GITHUB_AUTH_DISCOVER: () => githubDiscoverRepos(),
        GITHUB_AUTH_SELECT_REPO: message => githubSelectRepo(message),
        GITHUB_AUTH_DISCONNECT: () => githubDisconnect(),
        GITHUB_BACKUP_SNAPSHOT: (message, sender) => storeBackupSnapshot(message, sender),
        GITHUB_BACKUP_STATUS: (_message, sender) => githubBackupStatus(sender),
        GITHUB_ASCENT_BACKUP_PREFLIGHT: (message, sender) => preflightAscentBackup(message, sender),
        GITHUB_CHECK_ASCENT_BACKUP: (message, sender) => checkAscentBackup(message, sender),
        GITHUB_BACKUP_ASCENT: (message, sender) => backupAscent(message, sender),
        GITHUB_ASCENT_DELETE_INTENT: (message, sender) => storeAscentDeleteIntent(message, sender),
        GITHUB_ASCENT_DELETE_PENDING: (_message, sender) => pendingAscentDeletions(sender),
        GITHUB_ASCENT_DELETE_CONFIRM: (message, sender) => confirmAscentDeletion(message, sender),
        GITHUB_ASCENT_BACKUP_SUMMARY: () => githubAscentBackupSummary(),
        GITHUB_BACKUP_PROFILE_STATUS: (_message, sender) => githubProfileBackupStatus(sender),
        GITHUB_BACKUP_PROFILE_BATCH: (message, sender) => backupProfileBatch(message, sender),
        GITHUB_FAVORITES_BACKUP: () => backupFavorites(),
        GITHUB_FAVORITES_RESTORE: () => restoreFavorites(),
        GITHUB_SETTINGS_BACKUP: () => backupSettings(),
        GITHUB_SETTINGS_RESTORE: () => restoreSettings(),
        GITHUB_PHOTOS_STATUS: (message, sender) => photoBackupStatus(message, sender),
        GITHUB_PHOTOS_BACKUP: (_message, sender) => backupPhotoLibrary({ sender }),
        GITHUB_PHOTOS_RESTORE_PREVIEW: (message, sender) => previewPhotoLibraryRestore(message, sender),
        GITHUB_PHOTOS_RESTORE: (message, sender) => restorePhotoLibrary(message, sender),
        GITHUB_PHOTOS_CHANGED: (message, sender) => photoLibraryChanged(message, sender),
    };

    const extensionOnly = new Set([
        'PEAKBAGGER_MY_ASCENTS',
        'GITHUB_ASCENT_BACKUP_SUMMARY',
        'GITHUB_FAVORITES_BACKUP',
        'GITHUB_FAVORITES_RESTORE',
        'GITHUB_SETTINGS_BACKUP',
        'GITHUB_SETTINGS_RESTORE',
        'GITHUB_PHOTOS_STATUS',
        'GITHUB_PHOTOS_BACKUP',
        'GITHUB_PHOTOS_RESTORE_PREVIEW',
        'GITHUB_PHOTOS_RESTORE',
        'GITHUB_PHOTOS_CHANGED',
    ]);

    const cleanup = async cutoff => {
        await mutateMap(SNAPSHOTS_KEY, snapshots => {
            Object.entries(snapshots).forEach(([key, record]) => {
                if (!record || record.expiresAt <= cutoff) delete snapshots[key];
            });
        });
        await mutateMap(ASCENT_DELETE_INTENTS_KEY, intents => {
            Object.entries(intents).forEach(([key, record]) => {
                if (!record || record.expiresAt <= cutoff) delete intents[key];
            });
        });
    };

    const onStorageChanged = (changes, area) => {
        if (area !== 'local' || !changes[Favorites.FAVORITES_KEY]) return;
        void Settings.get().then(settings => {
            if (settings.autoFavoritesBackup) favoritesAutoBackup.schedule();
        });
    };

    const onSettingsChanged = settings => {
        if (settings.autoSettingsBackup) settingsAutoBackup.schedule();
        if (settings.autoFavoritesBackup) favoritesAutoBackup.schedule();
        if (settings.autoPhotoLibraryBackup && ext.alarms) {
            ext.alarms.create(PHOTO_BACKUP_ALARM, { delayInMinutes: AUTO_BACKUP_DELAY_MINUTES });
        }
    };

    const onAlarm = name => {
        if (name === SETTINGS_BACKUP_ALARM) void settingsAutoBackup.fire();
        if (name === FAVORITES_BACKUP_ALARM) void favoritesAutoBackup.fire();
        if (name === PHOTO_BACKUP_ALARM) void firePhotoAutoBackup();
    };

    return {
        handlers,
        cleanup,
        onStorageChanged,
        onSettingsChanged,
        onAlarm,
        isExtensionOnly(type) {
            return extensionOnly.has(type)
                || (typeof type === 'string' && type.startsWith('GITHUB_AUTH_'));
        },
        isPhotoPage,
    };
}
