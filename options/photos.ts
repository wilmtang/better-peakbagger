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

import { githubError as GithubError } from '../src/github/github-error-copy.ts';
import { runtimeMessage as RuntimeMessage, type RuntimeMessageExtension } from '../src/ui/runtime-message.ts';
import {
    createPhotoBackupStatus,
    formatPhotoBackupStatus,
    type PhotoBackupStatusState,
} from '../src/photos/photo-backup-status.ts';
import {
    hasGithubPermission,
    observeGithubAccess,
    type GithubAccessExtensionApi,
    type GithubStatusRepo,
} from './github.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';

export type PhotoBackupExtensionApi = (GithubAccessExtensionApi & RuntimeMessageExtension) | typeof chrome;

export type PhotoBackupSettings = {
    autoPhotoLibraryBackup?: boolean;
};

export interface InitPhotoBackupOptions {
    extensionApi: PhotoBackupExtensionApi;
    flash: (message?: string, options?: { error?: boolean }) => unknown;
    save: (patch: PhotoBackupSettings) => Promise<unknown>;
}

export interface PhotoBackupOwner {
    populate(settings?: PhotoBackupSettings | null): void;
}

interface PhotoBackupError {
    code?: string;
    message?: string;
    conflictCount?: number;
}

interface GithubAuthStatusResponse extends GithubStatusRepo {
    connected?: boolean;
}

interface PhotoBackupStatusResponse {
    ok?: boolean;
    state?: PhotoBackupStatusState | null;
}

interface PhotoBackupMutationResponse {
    ok?: boolean;
    reconciliationPending?: boolean;
    warning?: { message?: string };
    error?: PhotoBackupError;
    keptLocalConflicts?: number;
}

interface PhotoRestorePreviewResponse {
    ok?: boolean;
    error?: PhotoBackupError;
    signature?: string;
    counts?: { update?: number };
    conflicts?: unknown[];
    remotePhotos?: number;
    remoteTombstones?: number;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function initPhotoBackup({ extensionApi, flash, save }: InitPhotoBackupOptions): PhotoBackupOwner {
    const statusEl = document.getElementById('photos-github-status');
    const actionsEl = document.getElementById('photos-github-actions');
    const backupEl = document.getElementById('photos-backup');
    const restoreEl = document.getElementById('photos-restore');
    const autoEl = document.getElementById('photos-auto-backup') as HTMLInputElement | null;
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
    }) || !statusEl || !actionsEl || !backupEl || !restoreEl || !autoEl
        || !confirmationEl || !confirmationTitleEl || !confirmationDetailEl
        || !confirmEl || !cancelEl) {
        return { populate() {} };
    }

    const send = RuntimeMessage.bind(extensionApi as RuntimeMessageExtension);
    const setStatus = createPhotoBackupStatus(statusEl);
    const photoBackupError = (error: PhotoBackupError | null | undefined): string =>
        error?.code === 'photo-backup-too-large' && typeof error.message === 'string'
            ? error.message
            : GithubError.message(error);
    let githubStatus: (GithubAuthStatusResponse & { permissionGranted: boolean }) | null = null;
    let githubRevision = 0;
    let backupState: PhotoBackupStatusState | null = null;
    let busy = false;
    let operation: 'backup' | 'preview' | 'restore' | null = null;
    let pendingRestore: { signature: string; conflicts: number } | null = null;

    const repoName = (): string => OptionsUtils.githubRepoName(githubStatus);

    const render = (): void => {
        const connected = Boolean(githubStatus?.permissionGranted && githubStatus?.connected === true);
        actionsEl.hidden = !connected;
        const autoRow = autoEl.closest<HTMLElement>('.backup-automatic');
        if (autoRow) autoRow.hidden = !connected;
        OptionsUtils.setButtonBusy(backupEl, busy);
        OptionsUtils.setButtonBusy(restoreEl, busy);
        autoEl.disabled = busy;
        if (busy) {
            setStatus(operation === 'backup'
                ? 'Backing up photo records to GitHub…'
                : operation === 'restore'
                    ? 'Restoring photo records…'
                    : 'Reading photo-library.json…');
            return;
        }
        if (!connected) {
            setStatus('Connect GitHub above to back up your photo library.');
            return;
        }
        const context = {
            state: backupState, auto: autoEl.checked, repository: repoName(),
        };
        setStatus(formatPhotoBackupStatus(context), context);
    };

    const refresh = async (): Promise<void> => {
        const revision = ++githubRevision;
        const [auth, permissionGranted, photos] = await Promise.all([
            send<GithubAuthStatusResponse>({ type: 'GITHUB_AUTH_STATUS' }),
            hasGithubPermission(extensionApi),
            send<PhotoBackupStatusResponse>({ type: 'GITHUB_PHOTOS_STATUS' }),
        ]);
        if (revision !== githubRevision) return;
        githubStatus = { ...(auth || {}), permissionGranted };
        backupState = photos?.ok ? (photos.state ?? null) : null;
        render();
    };

    const withBusy = (name: 'backup' | 'preview' | 'restore', run: () => Promise<void>): Promise<void> => {
        if (busy) return Promise.resolve();
        operation = name;
        return OptionsUtils.withBusy({
            isBusy: () => busy,
            setBusy: value => { busy = value; render(); },
        }, run).finally(() => {
            operation = null;
            render();
        });
    };

    const hideConfirmation = ({
        restoreFocus = confirmationEl.contains(document.activeElement),
    }: { restoreFocus?: boolean } = {}): void => {
        pendingRestore = null;
        confirmationEl.hidden = true;
        OptionsUtils.setButtonBusy(confirmEl, false);
        OptionsUtils.setButtonBusy(cancelEl, false);
        confirmationEl.removeAttribute('aria-busy');
        if (restoreFocus && restoreEl.isConnected) restoreEl.focus();
    };

    backupEl.addEventListener('click', () => void withBusy('backup', async () => {
        const response = await send<PhotoBackupMutationResponse>({ type: 'GITHUB_PHOTOS_BACKUP' });
        if (response?.ok) {
            await refresh();
            flash(response.reconciliationPending
                ? response.warning?.message || 'The GitHub backup is safe, but local backup status is not yet confirmed.'
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
        const preview = await send<PhotoRestorePreviewResponse>({ type: 'GITHUB_PHOTOS_RESTORE_PREVIEW' });
        if (!preview?.ok) {
            flash(preview?.error?.code === 'not-found'
                ? `No photo-library.json found in ${repoName()}.`
                : photoBackupError(preview?.error), { error: true });
            return;
        }
        const conflicts = preview.conflicts?.length || 0;
        pendingRestore = { signature: preview.signature || '', conflicts };
        confirmationTitleEl.textContent = `Restore ${plural(preview.remotePhotos ?? 0, 'photo record')} `
            + `from ${repoName()}?`;
        confirmationDetailEl.textContent = [
            `${plural(preview.counts?.update || 0, 'local record')} will be replaced, and `
                + `${plural(preview.remoteTombstones ?? 0, 'deletion')} applied.`,
            conflicts
                ? `${plural(conflicts, 'photo')} changed in both places; your local version is kept.`
                : '',
            'This restores records only. Original images and the links that delete a photo '
                + 'from ImgBB are not in the backup, and an annotation stays editable only where '
                + 'the original image is still on this device.',
        ].filter(Boolean).join(' ');
        confirmationEl.hidden = false;
        if (document.activeElement === restoreEl) confirmEl.focus();
    }));

    cancelEl.addEventListener('click', () => { if (!busy) hideConfirmation(); });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || confirmationEl.hidden
            || confirmationEl.getAttribute('aria-busy') === 'true') return;
        event.preventDefault();
        hideConfirmation();
    });

    confirmEl.addEventListener('click', () => {
        if (!pendingRestore || busy) return;
        const pending = pendingRestore;
        OptionsUtils.setButtonBusy(confirmEl, true);
        OptionsUtils.setButtonBusy(cancelEl, true);
        confirmationEl.setAttribute('aria-busy', 'true');
        void withBusy('restore', async () => {
            const response = await send<PhotoBackupMutationResponse>({
                type: 'GITHUB_PHOTOS_RESTORE',
                // The worker rereads the file and requires this exact
                // signature, so a repository that moved under the preview
                // stops instead of restoring something never shown.
                signature: pending.signature,
                keepLocalConflicts: pending.conflicts > 0,
            });
            if (!response?.ok) {
                OptionsUtils.setButtonBusy(confirmEl, false);
                OptionsUtils.setButtonBusy(cancelEl, false);
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
    observeGithubAccess(extensionApi, () => { void refresh(); });
    const storageOnChanged = extensionApi.storage?.onChanged as {
        addListener?: (listener: (changes: Record<string, unknown>, areaName: string) => void) => void;
    } | undefined;
    storageOnChanged?.addListener?.((changes, area) => {
        if (area === 'local' && changes.bpbPhotoLibraryBackupState && !busy) void refresh();
    });

    let painted = false;
    return {
        populate(settings?: PhotoBackupSettings | null) {
            autoEl.checked = settings?.autoPhotoLibraryBackup === true;
            render();
            if (!painted) {
                painted = true;
                void refresh();
            }
        },
    };
}
