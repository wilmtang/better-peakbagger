// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the Favorite climbers GitHub backup surface.
//
// This is the Backup & sync counterpart to the favorite-climbers list. The two
// used to be one controller that reparented a single confirmation element
// between the list and this section; now the list lives on its own page, so a
// cross-document element cannot be shared. Restore is therefore self-contained
// here: it reads the current list from storage to show its diff, replaces it
// through the same worker mutation the list uses (guarded by an expected
// signature, so a concurrent edit on the list page is rejected rather than
// clobbered), and offers its own 6-second undo. The list page, if open, redraws
// itself from the resulting storage change.

import { createBackupReview } from './backup-review.ts';
import { favoriteClimbers as F, type FavoriteClimbersList } from '../src/favorites/favorite-climbers.ts';
import { githubError as GithubError } from '../src/github/github-error-copy.ts';
import type { RootBackupReview } from '../src/github/root-backup-guard.ts';
import { STORAGE_KEY as SETTINGS_STORAGE_KEY, type SettingsData } from '../src/settings/settings.ts';
import { runtimeMessage as RuntimeMessage, type RuntimeMessageResponse } from '../src/ui/runtime-message.ts';
import { hasGithubPermission, observeGithubAccess } from './github.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';

const UNDO_MS = 6000;

export interface FavoritesBackupFlashOptions {
    error?: boolean;
}

export interface InitFavoritesBackupOptions {
    extensionApi?: typeof chrome;
    flash?: (message?: string, options?: FavoritesBackupFlashOptions) => unknown;
    save?: (patch: Partial<SettingsData>) => Promise<unknown>;
}

export interface FavoritesBackupController {
    populate(settings?: Partial<SettingsData> | null): void;
}

interface GithubRepoInfo {
    fullName?: string;
    owner?: string;
    name?: string;
}

interface GithubAuthStatus extends RuntimeMessageResponse {
    connected?: boolean;
    repo?: GithubRepoInfo | null;
    favoritesBackupNeedsReview?: boolean;
}

interface GithubBackupStatus extends GithubAuthStatus {
    permissionGranted: boolean;
}

interface FavoritesBackupResult {
    repo: string;
    signature: string;
    commitUrl?: string;
    superseded?: boolean;
}

interface FavoritesBackupResponse extends RuntimeMessageResponse {
    ok?: boolean;
    result?: Partial<FavoritesBackupResult>;
    review?: RootBackupReview;
}

interface FavoritesRestoreResponse extends RuntimeMessageResponse {
    ok?: boolean;
    content?: unknown;
}

interface FavoritesMutateResponse extends RuntimeMessageResponse {
    ok?: boolean;
    favorites?: unknown;
    signature?: string;
    error?: {
        code?: string;
        message?: string;
    };
}

interface PendingRestore {
    replacement: FavoriteClimbersList;
    repo: string;
    favoritesSignature: string;
}

interface PendingUndo {
    snapshot: FavoriteClimbersList;
    timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    appliedSignature: string | undefined;
}

export const initFavoritesBackup = ({
    extensionApi,
    flash = () => {},
    save = async () => {},
}: InitFavoritesBackupOptions = {}): FavoritesBackupController => {
    const store = extensionApi?.storage?.local;
    const statusEl = document.getElementById('favorites-github-status') as HTMLElement;
    const actionsEl = document.getElementById('favorites-github-actions') as HTMLElement;
    const backupEl = document.getElementById('favorites-backup') as HTMLButtonElement;
    const restoreEl = document.getElementById('favorites-restore') as HTMLButtonElement;
    const autoBackupEl = document.getElementById('favorites-auto-backup') as HTMLInputElement;
    const confirmationEl = document.getElementById('favorites-restore-confirmation') as HTMLElement;
    const confirmationTitleEl = document.getElementById('favorites-restore-confirmation-title') as HTMLElement;
    const confirmationImpactEl = document.getElementById('favorites-restore-confirmation-impact') as HTMLElement;
    const confirmationSummaryEl = document.getElementById('favorites-restore-confirmation-summary') as HTMLElement;
    const cancelEl = document.getElementById('favorites-restore-cancel') as HTMLButtonElement;
    const confirmEl = document.getElementById('favorites-restore-confirm') as HTMLButtonElement;
    const undoEl = document.getElementById('favorites-restore-undo') as HTMLElement;
    const undoButtonEl = document.getElementById('favorites-restore-undo-button') as HTMLButtonElement;

    if (!extensionApi || !store || OptionsUtils.logMissingElements('favorite climbers backup', {
        'favorites-github-status': statusEl,
        'favorites-github-actions': actionsEl,
        'favorites-backup': backupEl,
        'favorites-restore': restoreEl,
        'favorites-auto-backup': autoBackupEl,
        'favorites-restore-confirmation': confirmationEl,
        'favorites-restore-confirmation-title': confirmationTitleEl,
        'favorites-restore-confirmation-impact': confirmationImpactEl,
        'favorites-restore-confirmation-summary': confirmationSummaryEl,
        'favorites-restore-cancel': cancelEl,
        'favorites-restore-confirm': confirmEl,
        'favorites-restore-undo': undoEl,
        'favorites-restore-undo-button': undoButtonEl,
    })) return { populate() {} };

    const send = RuntimeMessage.bind(extensionApi);

    let favorites: FavoriteClimbersList = F.cleanFavorites(null);
    let githubStatus: GithubBackupStatus | null = null;
    let githubBusy = false;
    let githubRevision = 0;
    let backupResult: FavoritesBackupResult | null = null;
    let pending: PendingRestore | null = null;
    let pendingBusy = false;
    let pendingUndo: PendingUndo | null = null;

    const signatureOf = (): string => F.backupSignature(favorites);
    const githubRepoName = (): string => OptionsUtils.githubRepoName(githubStatus);

    const renderGithub = (): void => {
        const connected = !!(githubStatus?.permissionGranted && githubStatus?.connected);
        const showBackupResult = connected
            && !backupResult?.superseded
            && backupResult?.repo === githubRepoName()
            && backupResult?.signature === signatureOf();
        actionsEl.hidden = false;
        backupEl.disabled = restoreEl.disabled = !connected;
        OptionsUtils.setButtonBusy(backupEl, githubBusy);
        OptionsUtils.setButtonBusy(restoreEl, githubBusy);
        autoBackupEl.disabled = githubBusy || !connected;
        statusEl.classList.remove('is-success');
        statusEl.textContent = '';
        if (githubBusy) {
            statusEl.textContent = 'Working with GitHub…';
        } else if (showBackupResult) {
            statusEl.classList.add('is-success');
            statusEl.textContent = 'Favorites backed up ✓';
            if (backupResult?.commitUrl) {
                statusEl.append(' ', Object.assign(document.createElement('a'), {
                    href: backupResult.commitUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    textContent: 'View commit',
                }));
            }
        } else if (connected) {
            statusEl.textContent = githubStatus?.favoritesBackupNeedsReview ? 'GitHub has a different backup. Review before replacing it.' : backupResult?.repo === githubRepoName()
                ? 'Newer changes need backup.' : `Backs up to ${githubRepoName()}`;
        } else {
            statusEl.textContent = 'Connect GitHub above to back up your custom favorites.';
        }
    };

    const refreshGithubStatus = async (): Promise<void> => {
        const revision = ++githubRevision;
        const [status, permissionGranted] = await Promise.all([
            send<GithubAuthStatus>({ type: 'GITHUB_AUTH_STATUS' }),
            hasGithubPermission(extensionApi),
        ]);
        if (revision !== githubRevision) return;
        githubStatus = { ...(status || {}), permissionGranted };
        renderGithub();
    };

    const renderUndo = (): void => { undoEl.hidden = !pendingUndo; };

    const setConfirmBusy = (busy: boolean): void => {
        pendingBusy = busy;
        OptionsUtils.setButtonBusy(cancelEl, busy);
        OptionsUtils.setButtonBusy(confirmEl, busy);
        githubBusy = busy;
        renderGithub();
        if (busy) {
            confirmationEl.setAttribute('aria-busy', 'true');
        } else {
            confirmationEl.removeAttribute('aria-busy');
        }
    };

    const dismissConfirmation = ({ restoreFocus = false }: { restoreFocus?: boolean } = {}): boolean => {
        if (pendingBusy) return false;
        pending = null;
        confirmationEl.hidden = true;
        if (restoreFocus && !restoreEl.disabled) restoreEl.focus();
        return true;
    };

    const showConfirmation = (replacement: FavoriteClimbersList, repo: string, { focus = true }: { focus?: boolean } = {}): void => {
        const { added, removed } = F.membershipChanges(favorites.entries, replacement.entries);
        const addedNoun = added === 1 ? 'favorite' : 'favorites';
        const removedNoun = removed === 1 ? 'favorite' : 'favorites';
        confirmationTitleEl.textContent = 'Restore favorites from backup?';
        confirmationImpactEl.textContent =
            `${added} ${addedNoun} will be added. ${removed} custom ${removedNoun} will be removed.`;
        confirmationSummaryEl.textContent =
            ` The list will match the backup from ${repo}. You can undo for 6 seconds after replacement.`;
        pending = { replacement: F.cleanFavorites(replacement), repo, favoritesSignature: signatureOf() };
        confirmationEl.hidden = false;
        if (focus) cancelEl.focus();
    };

    const mutate = async (mutation: Record<string, unknown>): Promise<FavoritesMutateResponse> => {
        const response = await send<FavoritesMutateResponse>({ type: F.MUTATION_MESSAGE_TYPE, mutation });
        if (response?.favorites) {
            favorites = F.cleanFavorites(response.favorites);
            renderGithub();
        }
        if (!response?.ok) {
            throw Object.assign(
                new Error(response?.error?.message || 'Favorite climbers are unavailable. Try again.'),
                { code: response?.error?.code || 'unavailable' },
            );
        }
        return response;
    };

    const beginReplacement = async (next: FavoriteClimbersList, expectedSignature: string): Promise<boolean> => {
        const superseded = pendingUndo;
        const record: PendingUndo = { snapshot: favorites, timer: undefined, appliedSignature: undefined };
        try {
            const response = await mutate({ kind: 'replace', favorites: next, expectedSignature });
            record.appliedSignature = response.signature;
        } catch (error) {
            const err = error as { code?: unknown; message?: unknown } | null | undefined;
            flash((err?.code === 'stale' || err?.code === 'list-conflict') && typeof err.message === 'string'
                ? err.message
                : "Couldn't update favorites", { error: true });
            return false;
        }
        if (superseded) globalThis.clearTimeout(superseded.timer);
        record.timer = globalThis.setTimeout(() => {
            if (pendingUndo === record) pendingUndo = null;
            renderUndo();
        }, UNDO_MS);
        pendingUndo = record;
        renderUndo();
        return true;
    };

    const undoReplacement = async (): Promise<void> => {
        if (!pendingUndo) return;
        const record = pendingUndo;
        try {
            await mutate({ kind: 'replace', favorites: record.snapshot, expectedSignature: record.appliedSignature });
            globalThis.clearTimeout(record.timer);
            pendingUndo = null;
            renderUndo();
            flash('Custom favorites restored');
        } catch (error) {
            const err = error as { code?: unknown; message?: unknown } | null | undefined;
            flash((err?.code === 'stale' || err?.code === 'list-conflict') && typeof err.message === 'string'
                ? err.message
                : "Couldn't restore favorites", { error: true });
        }
    };

    const withGithubBusy = (operation: () => Promise<void>): Promise<void> => OptionsUtils.withBusy({
        isBusy: () => githubBusy,
        setBusy: (value: boolean) => { githubBusy = value; renderGithub(); },
    }, operation);

    const backupReview = createBackupReview<RootBackupReview>({ anchor: backupEl, submit: review => backupFavorites(review) });
    const backupFavorites = (review: RootBackupReview | null = null): Promise<void> => withGithubBusy(async () => {
        const response = await send<FavoritesBackupResponse>({ type: 'GITHUB_FAVORITES_BACKUP', ...(review ? { review } : {}) });
        if (!response?.ok) {
            if (response?.review?.path === 'favorite-climbers.json') backupReview.show(response.review);
            flash(GithubError.message(response?.error), { error: true });
            return;
        }
        const result = response.result;
        if (!result || typeof result.repo !== 'string' || typeof result.signature !== 'string') {
            backupResult = null;
            flash('The backup could not be confirmed. Try again.', { error: true });
            return;
        }
        const confirmedResult: FavoritesBackupResult = {
            ...result,
            repo: result.repo,
            signature: result.signature,
        };
        backupResult = confirmedResult;
        flash(confirmedResult.superseded || confirmedResult.signature !== signatureOf()
            ? 'Newer changes need backup.' : `Favorites backed up to ${confirmedResult.repo}`);
        backupReview.clear();
    });

    const restoreFavorites = (): Promise<void> => withGithubBusy(async () => {
        const response = await send<FavoritesRestoreResponse>({ type: 'GITHUB_FAVORITES_RESTORE' });
        if (!response?.ok) {
            flash(GithubError.message(response?.error), { error: true });
            return;
        }
        if (response.content == null) {
            flash(`No favorites backup found in ${githubRepoName()}.`, { error: true });
            return;
        }
        const parsed = typeof response.content === 'string'
            ? F.parseBackup(response.content)
            : { ok: false as const };
        if (!parsed.ok) {
            flash('This favorites backup is not valid or uses a newer format.', { error: true });
            return;
        }
        showConfirmation(parsed.favorites, githubRepoName(), { focus: document.activeElement === restoreEl });
    });

    const readFavorites = async (): Promise<void> => {
        try {
            const values = await store.get([F.FAVORITES_KEY]);
            favorites = F.cleanFavorites(values[F.FAVORITES_KEY]);
            renderGithub();
            // A list edit that lands under an open confirmation refreshes its
            // numbers rather than acting on a stale diff.
            if (pending && !pendingBusy) showConfirmation(pending.replacement, pending.repo, { focus: false });
        } catch { /* the list page surfaces its own read failure */ }
    };

    backupEl.addEventListener('click', () => { void backupFavorites(); });
    restoreEl.addEventListener('click', () => { void restoreFavorites(); });
    autoBackupEl.addEventListener('change', () => {
        void save({ autoFavoritesBackup: autoBackupEl.checked });
    });
    cancelEl.addEventListener('click', () => {
        if (pendingBusy) return;
        dismissConfirmation({ restoreFocus: true });
    });
    confirmEl.addEventListener('click', () => {
        if (!pending || pendingBusy) return;
        if (pending.favoritesSignature !== signatureOf()) {
            showConfirmation(pending.replacement, pending.repo);
            return;
        }
        const { replacement, repo, favoritesSignature } = pending;
        setConfirmBusy(true);
        void beginReplacement(replacement, favoritesSignature)
            .then(changed => {
                // Clear busy before moving focus: a disabled button cannot hold
                // it, so on a failed write the retry target would be skipped.
                setConfirmBusy(false);
                if (changed) {
                    dismissConfirmation({ restoreFocus: confirmationEl.contains(document.activeElement) });
                    flash(`Favorites restored from ${repo}`);
                }
            })
            .finally(() => setConfirmBusy(false));
    });
    undoButtonEl.addEventListener('click', () => { void undoReplacement(); });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || confirmationEl.hidden || pendingBusy) return;
        event.preventDefault();
        dismissConfirmation({ restoreFocus: true });
    });

    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[F.FAVORITES_KEY]) void readFavorites();
            if (area === 'local' && changes.bpbFavoritesBackupState) void refreshGithubStatus();
            if (area === 'sync' && changes[SETTINGS_STORAGE_KEY]) void refreshGithubStatus();
        });
    }
    observeGithubAccess(extensionApi, () => { void refreshGithubStatus(); });

    void readFavorites();
    void refreshGithubStatus();

    return {
        populate(settings) {
            autoBackupEl.checked = settings?.autoFavoritesBackup === true;
            void refreshGithubStatus();
        },
    };
};
