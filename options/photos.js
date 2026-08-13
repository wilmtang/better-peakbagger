// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GitHub photo-library recovery controls in Settings.
//
// The worker owns the catalog snapshot, the semantic merge, and the write; this
// page only asks for them, exactly as the photo library does. Restore stays
// preview-first: the counts and the boundary have to be read before anything
// replaces a local record, so the confirmation is an in-page panel rather than
// a confirm() the browser can suppress.

import { STORAGE_KEY as GITHUB_AUTH_STORAGE_KEY } from '../src/github/github-auth.js';
import { githubError as GithubError } from '../src/github/github-error-copy.js';
import { runtimeMessage as RuntimeMessage } from '../src/ui/runtime-message.js';
import { hasGithubPermission } from './github.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function initPhotoBackup({ extensionApi, flash, save }) {
    const statusEl = document.getElementById('photos-github-status');
    const actionsEl = document.getElementById('photos-github-actions');
    const backupEl = document.getElementById('photos-backup');
    const restoreEl = document.getElementById('photos-restore');
    const autoEl = document.getElementById('photos-auto-backup');
    const confirmationEl = document.getElementById('photos-restore-confirmation');
    const confirmationTitleEl = document.getElementById('photos-restore-title');
    const confirmationDetailEl = document.getElementById('photos-restore-detail');
    const confirmEl = document.getElementById('photos-restore-confirm');
    const cancelEl = document.getElementById('photos-restore-cancel');
    if (OptionsUtils.logMissingElements('photo library backup', {
        'photos-github-status': statusEl,
        'photos-github-actions': actionsEl,
        'photos-backup': backupEl,
        'photos-restore': restoreEl,
        'photos-auto-backup': autoEl,
        'photos-restore-confirmation': confirmationEl,
        'photos-restore-title': confirmationTitleEl,
        'photos-restore-detail': confirmationDetailEl,
        'photos-restore-confirm': confirmEl,
        'photos-restore-cancel': cancelEl,
    })) {
        return { populate() {} };
    }

    const send = RuntimeMessage.bind(extensionApi);
    const photoBackupError = error => error?.code === 'photo-backup-too-large'
        && typeof error.message === 'string'
        ? error.message
        : GithubError.message(error);
    let githubStatus = null;
    let backupState = null;
    let busy = false;
    let operation = null;
    let pendingRestore = null;

    const repoName = () => OptionsUtils.githubRepoName(githubStatus);

    const backedUpAt = () => {
        const stamp = backupState?.syncedAt || backupState?.restoredAt;
        const time = stamp ? new Date(stamp) : null;
        return Number.isFinite(time?.getTime()) ? time.toLocaleString() : null;
    };

    const render = () => {
        const connected = githubStatus?.permissionGranted && githubStatus?.connected === true;
        actionsEl.hidden = !connected;
        backupEl.disabled = busy;
        restoreEl.disabled = busy;
        autoEl.disabled = busy;
        if (busy) {
            statusEl.textContent = operation === 'backup'
                ? 'Backing up photo records to GitHub…'
                : operation === 'restore'
                    ? 'Restoring photo records…'
                    : 'Reading photo-library.json…';
            return;
        }
        if (!connected) {
            statusEl.textContent = 'Connect GitHub above to back up your photo library.';
            return;
        }
        const when = backedUpAt();
        statusEl.textContent = backupState?.reconciliationPending
            ? `Backup reached ${repoName()} · local changes still need backup.`
            : when
                ? `${backupState?.syncedAt ? 'Backed up to' : 'Restored from'} ${repoName()} · ${when}`
                : `Ready to back up photo records to ${repoName()}.`;
    };

    const refresh = async () => {
        const [auth, permissionGranted, photos] = await Promise.all([
            send({ type: 'GITHUB_AUTH_STATUS' }),
            hasGithubPermission(extensionApi),
            send({ type: 'GITHUB_PHOTOS_STATUS' }),
        ]);
        githubStatus = { ...(auth || {}), permissionGranted };
        backupState = photos?.ok ? photos.state : null;
        if (photos?.ok) autoEl.checked = photos.auto === true;
        render();
    };

    const withBusy = (name, run) => {
        operation = name;
        return OptionsUtils.withBusy({
            isBusy: () => busy,
            setBusy: value => { busy = value; render(); },
        }, run).finally(() => {
            operation = null;
            render();
        });
    };

    const hideConfirmation = ({ restoreFocus = true } = {}) => {
        pendingRestore = null;
        confirmationEl.hidden = true;
        confirmEl.disabled = false;
        cancelEl.disabled = false;
        confirmationEl.removeAttribute('aria-busy');
        if (restoreFocus && restoreEl.isConnected) restoreEl.focus();
    };

    backupEl.addEventListener('click', () => void withBusy('backup', async () => {
        const response = await send({ type: 'GITHUB_PHOTOS_BACKUP' });
        if (response?.ok) {
            await refresh();
            flash(response.reconciliationPending
                ? response.warning?.message || 'The GitHub backup is safe, but local changes still need backup.'
                : `Photo records backed up to ${repoName()}`);
            return;
        }
        // A conflict is not a failed write: both sides changed the same record
        // and the merge stopped rather than guessing which one to keep.
        flash(response?.error?.code === 'photo-backup-conflict'
            ? `Backup conflict in ${plural(response.error.conflictCount || 1, 'photo record')}. `
                + 'Restore and review before backing up again.'
            : photoBackupError(response?.error), { error: true });
    }));

    restoreEl.addEventListener('click', () => void withBusy('preview', async () => {
        const preview = await send({ type: 'GITHUB_PHOTOS_RESTORE_PREVIEW' });
        if (!preview?.ok) {
            flash(preview?.error?.code === 'not-found'
                ? `No photo-library.json found in ${repoName()}.`
                : photoBackupError(preview?.error), { error: true });
            return;
        }
        const conflicts = preview.conflicts?.length || 0;
        pendingRestore = { signature: preview.signature, conflicts };
        confirmationTitleEl.textContent = `Restore ${plural(preview.remotePhotos, 'photo record')} `
            + `from ${repoName()}?`;
        confirmationDetailEl.textContent = [
            `${plural(preview.counts?.update || 0, 'local record')} will be replaced, and `
                + `${plural(preview.remoteTombstones, 'deletion')} applied.`,
            conflicts
                ? `${plural(conflicts, 'photo')} changed in both places; your local version is kept.`
                : '',
            'This restores records only. Original images and the links that delete a photo '
                + 'from ImgBB are not in the backup, and an annotation stays editable only where '
                + 'the original image is still on this device.',
        ].filter(Boolean).join(' ');
        confirmationEl.hidden = false;
        confirmEl.focus();
    }));

    cancelEl.addEventListener('click', () => hideConfirmation());
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || confirmationEl.hidden
            || confirmationEl.getAttribute('aria-busy') === 'true') return;
        event.preventDefault();
        hideConfirmation();
    });

    confirmEl.addEventListener('click', () => {
        if (!pendingRestore) return;
        const pending = pendingRestore;
        confirmEl.disabled = true;
        cancelEl.disabled = true;
        confirmationEl.setAttribute('aria-busy', 'true');
        void withBusy('restore', async () => {
            const response = await send({
                type: 'GITHUB_PHOTOS_RESTORE',
                // The worker rereads the file and requires this exact
                // signature, so a repository that moved under the preview
                // stops instead of restoring something never shown.
                signature: pending.signature,
                keepLocalConflicts: pending.conflicts > 0,
            });
            if (!response?.ok) {
                confirmEl.disabled = false;
                cancelEl.disabled = false;
                confirmationEl.removeAttribute('aria-busy');
                flash(photoBackupError(response?.error), { error: true });
                return;
            }
            hideConfirmation();
            await refresh();
            flash('Photo records restored. Original images were not restored.'
                + (response.keptLocalConflicts
                    ? ` Kept ${plural(response.keptLocalConflicts, 'local version')}.`
                    : ''));
        });
    });

    autoEl.addEventListener('change', () => {
        void save({ autoPhotoLibraryBackup: autoEl.checked });
    });

    window.addEventListener('focus', () => { void refresh(); });
    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[GITHUB_AUTH_STORAGE_KEY]) void refresh();
        });
    }

    let painted = false;
    return {
        populate(settings) {
            autoEl.checked = settings?.autoPhotoLibraryBackup === true;
            render();
            if (!painted) {
                painted = true;
                void refresh();
            }
        },
    };
}
