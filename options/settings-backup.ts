// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — settings file transfer and GitHub backup controls.

import { createBackupReview } from './backup-review.ts';
import { settings as S } from '../src/settings/settings.ts';
import { settingsTransfer as Transfer, type CustomLayerBackup, type SettingsParseFailureReason } from '../src/settings/settings-transfer.ts';
import { githubError as GithubError } from '../src/github/github-error-copy.ts';
import { runtimeMessage as RuntimeMessage, type RuntimeMessageResponse } from '../src/ui/runtime-message.ts';
import { boundedText as BoundedText } from '../src/net/bounded-text.ts';
import { GITHUB_ORIGINS, hasGithubPermission, observeGithubAccess } from './github.ts';
import { optionsUtils as OptionsUtils, type FlashOptions, type RepoStatus } from './options-utils.ts';
import { GARMIN_PERMISSION } from '../src/garmin/garmin-api.ts';
import { CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY, readCustomRegistry } from '../src/maps/custom-overlay-schema.js';
import { customLayerBackup } from '../src/maps/custom-overlay-transfer.js';
import type { Settings, SettingsPatch } from './settings-patch-route.ts';

interface PendingImport {
    settings: Record<string, unknown>;
    successMessage: string;
    returnFocus: HTMLElement;
    fileContent: string | null;
    includesGithubConnection: boolean;
    requestsGarminAccess: boolean;
}

interface ShowConfirmationOptions {
    fileContent?: string | null;
    includesApiKeys?: boolean;
    includesGithubConnection?: boolean;
    includesGarminKey?: boolean;
    requestsGarminAccess?: boolean;
    customLayerCount?: number | null;
    includesPrivateMaps?: boolean;
}

interface SettingsGithubStatus extends RepoStatus {
    connected?: boolean;
    permissionGranted: boolean;
    settingsBackupNeedsReview?: boolean;
}

interface GithubBackupResult {
    repo: string;
    signature: string;
    superseded?: boolean;
    commitUrl?: string;
}

interface BackupReviewPayload {
    path?: string;
    [key: string]: unknown;
}

interface SettingsFileExportResponse extends RuntimeMessageResponse {
    content?: unknown;
    exportedAt?: unknown;
}

interface SettingsFileImportResponse extends RuntimeMessageResponse {
    apiKeysImported?: boolean;
    error?: {
        code?: string;
        source?: string;
        message?: string;
    };
}

interface SettingsGithubAuthStatusResponse extends RuntimeMessageResponse, RepoStatus {
    connected?: boolean;
    settingsBackupNeedsReview?: boolean;
}

interface SettingsGithubBackupResponse extends RuntimeMessageResponse {
    review?: BackupReviewPayload;
    result?: GithubBackupResult;
}

interface SettingsGithubRestoreResponse extends RuntimeMessageResponse {
    content?: string | null;
}

export interface SettingsBackupOptions {
    extensionApi: typeof chrome;
    flash: (msg?: string, options?: FlashOptions) => unknown;
    save: (patch: SettingsPatch) => Promise<Settings>;
    refreshCredentials?: () => unknown;
}

export interface SettingsBackupOwner {
    populate(settings?: Settings | null): void;
}

const SETTINGS_STORAGE_KEY = S.STORAGE_KEY;

const invalidFileMessage = (reason: SettingsParseFailureReason | string): string => {
    if (reason === 'newer-version') {
        return 'This settings file was made by a newer version of the extension.';
    }
    if (reason === 'too-large') {
        return 'That file is too large. Choose a Better Peakbagger settings export.';
    }
    if (reason === 'too-complex') {
        return 'That file is too complex. Choose a Better Peakbagger settings export.';
    }
    return 'That is not a Better Peakbagger settings file.';
};

export function initSettingsBackup({
    extensionApi,
    flash,
    save,
    refreshCredentials = async () => {},
}: SettingsBackupOptions): SettingsBackupOwner {
    const exportEl = document.getElementById('settings-backup-export') as HTMLButtonElement;
    const importEl = document.getElementById('settings-backup-import') as HTMLButtonElement;
    const fileEl = document.getElementById('settings-backup-file') as HTMLInputElement;
    const exportCredentialsEl = document.getElementById('settings-backup-export-credentials') as HTMLInputElement;
    const confirmationEl = document.getElementById('settings-backup-confirmation') as HTMLElement;
    const confirmationActionEl = document.getElementById('settings-backup-confirmation-action') as HTMLElement;
    const confirmationNameEl = document.getElementById('settings-backup-confirmation-name') as HTMLElement;
    const confirmationDetailEl = document.getElementById('settings-backup-confirmation-detail') as HTMLElement;
    const confirmEl = document.getElementById('settings-backup-confirm') as HTMLButtonElement;
    const cancelEl = document.getElementById('settings-backup-cancel') as HTMLButtonElement;
    const githubStatusEl = document.getElementById('settings-backup-github-status') as HTMLElement;
    const githubActionsEl = document.getElementById('settings-backup-github-actions') as HTMLElement;
    const githubBackupEl = document.getElementById('settings-backup-github-backup') as HTMLButtonElement;
    const githubRestoreEl = document.getElementById('settings-backup-github-restore') as HTMLButtonElement;
    const autoBackupEl = document.getElementById('settings-backup-auto') as HTMLInputElement;
    if (OptionsUtils.logMissingElements('settings backup', {
        'settings-backup-export': exportEl,
        'settings-backup-import': importEl,
        'settings-backup-file': fileEl,
        'settings-backup-export-credentials': exportCredentialsEl,
        'settings-backup-confirmation': confirmationEl,
        'settings-backup-confirmation-action': confirmationActionEl,
        'settings-backup-confirmation-name': confirmationNameEl,
        'settings-backup-confirmation-detail': confirmationDetailEl,
        'settings-backup-confirm': confirmEl,
        'settings-backup-cancel': cancelEl,
        'settings-backup-github-status': githubStatusEl,
        'settings-backup-github-actions': githubActionsEl,
        'settings-backup-github-backup': githubBackupEl,
        'settings-backup-github-restore': githubRestoreEl,
        'settings-backup-auto': autoBackupEl,
    })) {
        return { populate() {} };
    }

    let pendingImport: PendingImport | null = null;
    let githubStatus: SettingsGithubStatus | null = null;
    let githubRevision = 0;
    let githubBusy = false;
    let githubOperation: string | null = null;
    let githubBackupResult: GithubBackupResult | null = null;
    let settingsSignature: string | null = Transfer.signature({});
    let currentSettings: Partial<Settings> | Record<string, unknown> = {};
    let layerBackup: CustomLayerBackup | null | undefined;
    let layerRead = 0;

    const send = RuntimeMessage.bind(extensionApi);

    const repoName = (): string => OptionsUtils.githubRepoName(githubStatus);

    const hideConfirmation = ({ restoreFocus = confirmationEl.contains(document.activeElement) } = {}): void => {
        const returnFocus = pendingImport?.returnFocus;
        pendingImport = null;
        confirmationEl.hidden = true;
        confirmationNameEl.textContent = '';
        confirmationDetailEl.textContent = '';
        OptionsUtils.setButtonBusy(confirmEl, false);
        OptionsUtils.setButtonBusy(cancelEl, false);
        confirmationEl.removeAttribute('aria-busy');
        if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    };

    const showConfirmation = (
        name: string,
        settings: Record<string, unknown>,
        successMessage = 'Settings imported',
        returnFocus: HTMLElement = importEl,
        {
            fileContent = null,
            includesApiKeys = false,
            includesGithubConnection = false,
            includesGarminKey = false,
            requestsGarminAccess = false,
            customLayerCount = null,
            includesPrivateMaps = false,
        }: ShowConfirmationOptions = {},
    ): void => {
        pendingImport = {
            settings,
            successMessage,
            returnFocus,
            fileContent,
            includesGithubConnection,
            requestsGarminAccess,
        };
        const restoring = returnFocus === githubRestoreEl;
        confirmationActionEl.textContent = restoring ? 'Restore' : 'Import';
        confirmEl.textContent = restoring ? 'Restore settings' : 'Import settings';
        confirmationNameEl.textContent = name;
        confirmationDetailEl.textContent = includesApiKeys && includesGithubConnection
            ? 'Replaces your current settings, saved API keys, and GitHub connection.'
            : includesGithubConnection
                ? 'Replaces your current settings and GitHub connection.'
                : includesApiKeys
                    ? 'Replaces your current settings and saved API keys.'
                    : 'Replaces your current settings.';
        if (includesGarminKey) {
            confirmationDetailEl.textContent += requestsGarminAccess
                ? ' Includes a Garmin key, which will be checked before replacing your connection and enabling Garmin drafts on this device.'
                : ' Removes your Garmin key while keeping your drafts.';
        }
        if (customLayerCount !== null) {
            confirmationDetailEl.textContent += ` Replaces custom layers with ${customLayerCount} saved ${customLayerCount === 1 ? 'layer' : 'layers'}. Existing map selections turn off.`;
        }
        if (includesPrivateMaps) {
            confirmationDetailEl.textContent += ' Includes private map URLs and request parameters. Loading still requires provider access and a fresh map approval.';
        }
        confirmationEl.hidden = false;
        if (document.activeElement === returnFocus) confirmEl.focus();
    };

    exportEl.addEventListener('click', async () => {
        const response = await send<SettingsFileExportResponse>({
            type: 'SETTINGS_FILE_EXPORT',
            includeCredentials: exportCredentialsEl.checked,
        });
        if (!response?.ok || typeof response.content !== 'string') {
            flash(response?.error?.message || 'Settings could not be exported. Try again.', { error: true });
            return;
        }
        const exportedAt = typeof response.exportedAt === 'string'
            ? response.exportedAt
            : new Date().toISOString();
        const blob = new Blob([response.content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = Object.assign(document.createElement('a'), {
            href: url,
            download: `better-peakbagger-settings-${exportedAt.slice(0, 10)}.json`,
        });
        link.click();
        URL.revokeObjectURL(url);
        // A credential export is a per-file decision, never a standing one.
        exportCredentialsEl.checked = false;
    });

    importEl.addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', async () => {
        const file = fileEl.files && fileEl.files[0];
        fileEl.value = '';
        if (!file) return;
        hideConfirmation({ restoreFocus: false });
        let text: string;
        try {
            text = await BoundedText.readBoundedBlobText(file, {
                maxBytes: Transfer.IMPORT_MAX_BYTES,
                label: 'Settings file',
            });
        } catch (error) {
            if (BoundedText.isLimitError(error)) {
                flash(invalidFileMessage('too-large'), { error: true });
                return;
            }
            flash('That settings file could not be read.', { error: true });
            return;
        }
        const parsed = Transfer.parse(text);
        if (!parsed.ok) {
            flash(invalidFileMessage(parsed.reason), { error: true });
            return;
        }
        showConfirmation(
            file.name || 'Selected settings file',
            parsed.settings,
            'Settings imported',
            importEl,
            {
                fileContent: text,
                includesApiKeys: Object.hasOwn(parsed, 'apiKeys'),
                includesGithubConnection: Object.hasOwn(parsed, 'githubConnection'),
                includesGarminKey: Object.hasOwn(parsed.apiKeys || {}, 'garmin'),
                requestsGarminAccess: typeof parsed.apiKeys?.garmin === 'string',
                customLayerCount: parsed.customLayers?.sources.length ?? null,
                includesPrivateMaps: !!parsed.privateCustomLayers?.length,
            },
        );
    });

    cancelEl.addEventListener('click', () => {
        if (confirmationEl.getAttribute('aria-busy') !== 'true') hideConfirmation();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || confirmationEl.hidden
            || confirmationEl.getAttribute('aria-busy') === 'true') return;
        event.preventDefault();
        hideConfirmation();
    });
    confirmEl.addEventListener('click', async () => {
        if (!pendingImport || confirmationEl.getAttribute('aria-busy') === 'true') return;
        const pending = pendingImport;
        OptionsUtils.setButtonBusy(confirmEl, true);
        OptionsUtils.setButtonBusy(cancelEl, true);
        confirmationEl.setAttribute('aria-busy', 'true');
        try {
            if (pending.fileContent != null) {
                const origins = [
                    ...(pending.includesGithubConnection ? GITHUB_ORIGINS : []),
                    ...(pending.requestsGarminAccess ? [GARMIN_PERMISSION] : []),
                ];
                if (origins.length) {
                    let granted = false;
                    try {
                        granted = !!(await extensionApi.permissions?.request?.({ origins }));
                    } catch { granted = false; }
                    if (!granted) {
                        flash(pending.requestsGarminAccess
                            ? 'Garmin access was not granted, so nothing was imported.'
                            : 'GitHub access was not granted, so nothing was imported.', { error: true });
                        throw new Error('github-permission-denied');
                    }
                }
                const response = await send<SettingsFileImportResponse>({
                    type: 'SETTINGS_FILE_IMPORT',
                    content: pending.fileContent,
                });
                if (!response?.ok) {
                    flash(response?.error?.source === 'github'
                        ? GithubError.message(response.error)
                        : response?.error?.message || 'Settings could not be imported. Try again.', { error: true });
                    throw new Error(response?.error?.code || 'settings-file-import-failed');
                }
                await Promise.all([refreshCredentials(), refreshGithub()]);
                if (response.apiKeysImported) document.dispatchEvent(new Event('bpb:credentials-imported'));
            } else {
                await save(pending.settings as SettingsPatch);
            }
            hideConfirmation();
            flash(pending.successMessage);
        } catch {
            // Keep the parsed import in memory so a transient storage failure
            // can be retried without making the user select/download it again.
            OptionsUtils.setButtonBusy(confirmEl, false);
            OptionsUtils.setButtonBusy(cancelEl, false);
            confirmationEl.removeAttribute('aria-busy');
        }
    });

    const renderGithub = (): void => {
        const connected = githubStatus?.permissionGranted && githubStatus?.connected === true;
        // The checkbox now covers the ImgBB key as well, which needs no GitHub
        // connection, so it stays available whether or not GitHub is connected.
        // An export with nothing saved to include is simply credential-free.
        const showBackupResult = connected
            && !githubBackupResult?.superseded
            && githubBackupResult?.repo === repoName()
            && githubBackupResult?.signature === settingsSignature;
        githubActionsEl.hidden = !connected;
        const autoBackupRowEl = autoBackupEl.closest<HTMLElement>('.backup-automatic');
        if (autoBackupRowEl) autoBackupRowEl.hidden = !connected;
        OptionsUtils.setButtonBusy(githubBackupEl, githubBusy);
        OptionsUtils.setButtonBusy(githubRestoreEl, githubBusy);
        autoBackupEl.disabled = githubBusy;
        githubStatusEl.classList.remove('is-success');
        githubStatusEl.textContent = '';
        if (githubBusy) {
            githubStatusEl.textContent = githubOperation === 'backup'
                ? 'Backing up settings to GitHub…'
                : 'Working with GitHub…';
        } else if (showBackupResult) {
            githubStatusEl.classList.add('is-success');
            githubStatusEl.textContent = 'Settings backed up ✓';
            if (githubBackupResult?.commitUrl) {
                githubStatusEl.append(' ', Object.assign(document.createElement('a'), {
                    href: githubBackupResult.commitUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    textContent: 'View commit',
                }));
            }
        } else if (connected) {
            githubStatusEl.textContent = githubStatus?.settingsBackupNeedsReview
                ? 'GitHub has a different backup. Review before replacing it.'
                : githubBackupResult?.repo === repoName()
                    ? 'Newer changes need backup.'
                    : `Stored as settings.json in ${repoName()}.`;
        } else {
            githubStatusEl.textContent = 'Connect GitHub above to back up settings.';
        }
    };

    const refreshGithub = async (): Promise<void> => {
        const revision = ++githubRevision;
        const [status, permissionGranted] = await Promise.all([
            send<SettingsGithubAuthStatusResponse>({ type: 'GITHUB_AUTH_STATUS' }),
            hasGithubPermission(extensionApi),
        ]);
        if (revision !== githubRevision) return;
        githubStatus = { ...(status || {}), permissionGranted };
        renderGithub();
    };

    const withGithubBusy = (operation: () => unknown): Promise<void> => OptionsUtils.withBusy({
        isBusy: () => githubBusy,
        setBusy: value => { githubBusy = value; renderGithub(); },
    }, operation);

    const backupReview = createBackupReview({
        anchor: githubBackupEl,
        submit: review => backupSettings(review),
    });
    const backupSettings = async (review: unknown = null): Promise<void> => {
        if (githubBusy) return;
        githubOperation = 'backup';
        try {
            await withGithubBusy(async () => {
                const response = await send<SettingsGithubBackupResponse>({
                    type: 'GITHUB_SETTINGS_BACKUP',
                    ...(review ? { review } : {}),
                });
                if (!response?.ok) {
                    githubBackupResult = null;
                    if (response?.review?.path === Transfer.BACKUP_PATH) backupReview.show(response.review);
                    flash(GithubError.message(response?.error), { error: true });
                    return;
                }
                const result = response.result;
                if (typeof result?.repo !== 'string' || typeof result?.signature !== 'string') {
                    githubBackupResult = null;
                    flash('The backup could not be confirmed. Try again.', { error: true });
                    return;
                }
                githubBackupResult = result;
                flash(result.superseded || result.signature !== settingsSignature
                    ? 'Newer changes need backup.' : `Settings backed up to ${result.repo}`);
                backupReview.clear();
            });
        } finally {
            githubOperation = null;
            renderGithub();
        }
    };
    githubBackupEl.addEventListener('click', () => { void backupSettings(); });

    githubRestoreEl.addEventListener('click', () => withGithubBusy(async () => {
        const response = await send<SettingsGithubRestoreResponse>({ type: 'GITHUB_SETTINGS_RESTORE' });
        if (!response?.ok) {
            flash(GithubError.message(response?.error), { error: true });
            return;
        }
        if (response.content == null) {
            flash(`No settings backup found in ${repoName()}.`, { error: true });
            return;
        }
        const parsed = Transfer.parse(response.content);
        if (!parsed.ok) {
            flash(invalidFileMessage(parsed.reason), { error: true });
            return;
        }
        showConfirmation(
            `settings.json from ${repoName()}`,
            parsed.settings,
            `Settings restored from ${repoName()}`,
            githubRestoreEl,
            parsed.customLayers ? {
                fileContent: Transfer.serialize(Transfer.buildPayload(parsed.settings, { customLayers: parsed.customLayers })),
                customLayerCount: parsed.customLayers.sources.length,
            } : {},
        );
    }));

    autoBackupEl.addEventListener('change', () => {
        void save({ autoSettingsBackup: autoBackupEl.checked });
    });

    window.addEventListener('focus', () => { void refreshGithub(); });
    const refreshLayers = async (): Promise<void> => {
        const revision = ++layerRead;
        try {
            const stored = await extensionApi.storage.local.get([CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY]) as Record<string, unknown>;
            const registry = readCustomRegistry(stored[CUSTOM_REGISTRY_KEY]);
            if (!registry) throw new Error('Custom layers unavailable.');
            const value = customLayerBackup({
                registry,
                preferences: (stored[CUSTOM_PREFERENCES_KEY] as Record<string, unknown> | undefined) || {},
            });
            if (revision !== layerRead) return;
            layerBackup = value;
        } catch {
            if (revision !== layerRead) return;
            layerBackup = null;
        }
        settingsSignature = layerBackup ? Transfer.signature(currentSettings, layerBackup) : null;
        renderGithub();
    };
    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area === 'sync' && changes[SETTINGS_STORAGE_KEY]) void refreshGithub();
            if (area === 'local' && changes.bpbSettingsBackupState) void refreshGithub();
            if (area === 'local' && (changes[CUSTOM_REGISTRY_KEY] || changes[CUSTOM_PREFERENCES_KEY])) void refreshLayers();
        });
    }
    observeGithubAccess(extensionApi, () => { void refreshGithub(); });

    let painted = false;
    return {
        populate(settings) {
            currentSettings = settings || {};
            settingsSignature = layerBackup
                ? Transfer.signature(currentSettings, layerBackup)
                : layerBackup === null
                    ? null
                    : Transfer.signature(currentSettings);
            autoBackupEl.checked = settings?.autoSettingsBackup === true;
            renderGithub();
            if (!painted) {
                painted = true;
                void refreshGithub();
                void refreshLayers();
            }
        },
    };
}
