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

import { favoriteClimbers as F } from '../src/favorites/favorite-climbers.js';
import { STORAGE_KEY as GITHUB_AUTH_STORAGE_KEY } from '../src/github/github-auth.js';
import { githubError as GithubError } from '../src/github/github-error-copy.js';
import { STORAGE_KEY as SETTINGS_STORAGE_KEY } from '../src/settings/settings.js';
import { runtimeMessage as RuntimeMessage } from '../src/ui/runtime-message.js';
import { hasGithubPermission } from './github.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

const UNDO_MS = 6000;

export const initFavoritesBackup = ({ extensionApi, flash, save } = {}) => {
    const store = extensionApi?.storage?.local;
    const statusEl = document.getElementById('favorites-github-status');
    const actionsEl = document.getElementById('favorites-github-actions');
    const backupEl = document.getElementById('favorites-backup');
    const restoreEl = document.getElementById('favorites-restore');
    const autoBackupEl = document.getElementById('favorites-auto-backup');
    const confirmationEl = document.getElementById('favorites-restore-confirmation');
    const confirmationTitleEl = document.getElementById('favorites-restore-confirmation-title');
    const confirmationImpactEl = document.getElementById('favorites-restore-confirmation-impact');
    const confirmationSummaryEl = document.getElementById('favorites-restore-confirmation-summary');
    const cancelEl = document.getElementById('favorites-restore-cancel');
    const confirmEl = document.getElementById('favorites-restore-confirm');
    const undoEl = document.getElementById('favorites-restore-undo');
    const undoButtonEl = document.getElementById('favorites-restore-undo-button');

    if (!store || OptionsUtils.logMissingElements('favorite climbers backup', {
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

    let favorites = F.cleanFavorites(null);
    let githubStatus = null;
    let githubBusy = false;
    let githubRevision = 0;
    let backupResult = null;
    let pending = null;
    let pendingBusy = false;
    let pendingUndo = null;

    const signatureOf = () => F.backupSignature(favorites);
    const githubRepoName = () => OptionsUtils.githubRepoName(githubStatus);

    const renderGithub = () => {
        const connected = !!(githubStatus?.permissionGranted && githubStatus?.connected);
        const showBackupResult = connected
            && backupResult?.repo === githubRepoName()
            && backupResult?.signature === signatureOf();
        actionsEl.hidden = !connected;
        backupEl.disabled = githubBusy;
        restoreEl.disabled = githubBusy;
        autoBackupEl.disabled = githubBusy;
        statusEl.classList.remove('favorites-github-success');
        statusEl.textContent = '';
        if (githubBusy) {
            statusEl.textContent = 'Working with GitHub…';
        } else if (showBackupResult) {
            statusEl.classList.add('favorites-github-success');
            statusEl.textContent = 'Favorites backed up ✓';
            if (backupResult.commitUrl) {
                statusEl.append(' ', Object.assign(document.createElement('a'), {
                    href: backupResult.commitUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    textContent: 'View commit',
                }));
            }
        } else if (connected) {
            statusEl.textContent = `Your custom list is stored as favorite-climbers.json in ${githubRepoName()}.`;
        } else {
            statusEl.textContent = 'Connect GitHub above to back up your custom favorites.';
        }
    };

    const refreshGithubStatus = async () => {
        const revision = ++githubRevision;
        const [status, permissionGranted] = await Promise.all([
            send({ type: 'GITHUB_AUTH_STATUS' }),
            hasGithubPermission(extensionApi),
        ]);
        if (revision !== githubRevision) return;
        githubStatus = { ...(status || {}), permissionGranted };
        renderGithub();
    };

    const renderUndo = () => { undoEl.hidden = !pendingUndo; };

    const setConfirmBusy = busy => {
        pendingBusy = busy;
        cancelEl.disabled = busy;
        confirmEl.disabled = busy;
        githubBusy = busy;
        renderGithub();
        if (busy) {
            confirmationEl.setAttribute('aria-busy', 'true');
            confirmationEl.focus({ preventScroll: true });
        } else {
            confirmationEl.removeAttribute('aria-busy');
        }
    };

    const dismissConfirmation = ({ restoreFocus = false } = {}) => {
        if (pendingBusy) return false;
        pending = null;
        confirmationEl.hidden = true;
        if (restoreFocus && !restoreEl.disabled) restoreEl.focus();
        return true;
    };

    const showConfirmation = (replacement, repo, { focus = true } = {}) => {
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

    const mutate = async mutation => {
        const response = await send({ type: F.MUTATION_MESSAGE_TYPE, mutation });
        if (response?.favorites) {
            favorites = F.cleanFavorites(response.favorites);
            renderGithub();
        }
        if (!response?.ok) {
            const error = new Error(response?.error?.message || 'Favorite climbers are unavailable. Try again.');
            error.code = response?.error?.code || 'unavailable';
            throw error;
        }
        return response;
    };

    const beginReplacement = async (next, expectedSignature) => {
        const superseded = pendingUndo;
        const record = { snapshot: favorites, timer: null, appliedSignature: null };
        try {
            const response = await mutate({ kind: 'replace', favorites: next, expectedSignature });
            record.appliedSignature = response.signature;
        } catch (error) {
            flash(error.code === 'stale' ? error.message : "Couldn't update favorites", { error: true });
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

    const undoReplacement = async () => {
        if (!pendingUndo) return;
        const record = pendingUndo;
        try {
            await mutate({ kind: 'replace', favorites: record.snapshot, expectedSignature: record.appliedSignature });
            globalThis.clearTimeout(record.timer);
            pendingUndo = null;
            renderUndo();
            flash('Custom favorites restored');
        } catch (error) {
            flash(error.code === 'stale' ? error.message : "Couldn't restore favorites", { error: true });
        }
    };

    const withGithubBusy = operation => OptionsUtils.withBusy({
        isBusy: () => githubBusy,
        setBusy: value => { githubBusy = value; renderGithub(); },
    }, operation);

    const backupFavorites = () => withGithubBusy(async () => {
        const response = await send({ type: 'GITHUB_FAVORITES_BACKUP' });
        if (!response?.ok) {
            flash(GithubError.message(response?.error), { error: true });
            return;
        }
        backupResult = {
            ...(response.result || {}),
            repo: githubRepoName(),
            signature: signatureOf(),
        };
        flash(`Favorites backed up to ${githubRepoName()}`);
    });

    const restoreFavorites = () => withGithubBusy(async () => {
        const response = await send({ type: 'GITHUB_FAVORITES_RESTORE' });
        if (!response?.ok) {
            flash(GithubError.message(response?.error), { error: true });
            return;
        }
        if (response.content == null) {
            flash(`No favorites backup found in ${githubRepoName()}.`, { error: true });
            return;
        }
        const parsed = F.parseBackup(response.content);
        if (!parsed.ok) {
            flash('This favorites backup is not valid or uses a newer format.', { error: true });
            return;
        }
        showConfirmation(parsed.favorites, githubRepoName());
    });

    const readFavorites = async () => {
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
                    dismissConfirmation();
                    flash(`Favorites restored from ${repo}`);
                } else {
                    confirmEl.focus();
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
            if (area === 'local' && changes[GITHUB_AUTH_STORAGE_KEY]) void refreshGithubStatus();
            if (area === 'sync' && changes[SETTINGS_STORAGE_KEY]) void refreshGithubStatus();
        });
    }

    void readFavorites();
    void refreshGithubStatus();

    return {
        populate(settings) {
            autoBackupEl.checked = settings?.autoFavoritesBackup === true;
            void refreshGithubStatus();
        },
    };
};
