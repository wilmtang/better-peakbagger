// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — settings file transfer and GitHub backup controls.

import { settings as S } from '../src/settings/settings.js';
import { settingsTransfer as Transfer } from '../src/settings/settings-transfer.js';
import { STORAGE_KEY as GITHUB_AUTH_STORAGE_KEY } from '../src/github/github-auth.js';
import { githubError as GithubError } from '../src/github/github-error-copy.js';
import { runtimeMessage as RuntimeMessage } from '../src/ui/runtime-message.js';
import { hasGithubPermission } from './github.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

const SETTINGS_STORAGE_KEY = S.STORAGE_KEY;

const invalidFileMessage = reason => reason === 'newer-version'
    ? 'This settings file was made by a newer version of the extension.'
    : 'That is not a Better Peakbagger settings file.';

export function initSettingsBackup({ extensionApi, flash, save }) {
    const exportEl = document.getElementById('settings-backup-export');
    const importEl = document.getElementById('settings-backup-import');
    const fileEl = document.getElementById('settings-backup-file');
    const confirmationEl = document.getElementById('settings-backup-confirmation');
    const confirmationNameEl = document.getElementById('settings-backup-confirmation-name');
    const confirmEl = document.getElementById('settings-backup-confirm');
    const cancelEl = document.getElementById('settings-backup-cancel');
    const githubStatusEl = document.getElementById('settings-backup-github-status');
    const githubActionsEl = document.getElementById('settings-backup-github-actions');
    const githubBackupEl = document.getElementById('settings-backup-github-backup');
    const githubRestoreEl = document.getElementById('settings-backup-github-restore');
    const autoBackupEl = document.getElementById('settings-backup-auto');
    if (OptionsUtils.logMissingElements('settings backup', {
        'settings-backup-export': exportEl,
        'settings-backup-import': importEl,
        'settings-backup-file': fileEl,
        'settings-backup-confirmation': confirmationEl,
        'settings-backup-confirmation-name': confirmationNameEl,
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

    let pendingImport = null;
    let githubStatus = null;
    let githubBusy = false;
    let githubOperation = null;
    let githubBackupResult = null;
    let settingsSignature = Transfer.signature({});

    const send = RuntimeMessage.bind(extensionApi);

    const repoName = () => OptionsUtils.githubRepoName(githubStatus);

    const hideConfirmation = () => {
        pendingImport = null;
        confirmationEl.hidden = true;
        confirmationNameEl.textContent = '';
    };

    const showConfirmation = (name, settings, successMessage = 'Settings imported') => {
        pendingImport = { settings, successMessage };
        confirmationNameEl.textContent = name;
        confirmationEl.hidden = false;
        confirmEl.focus();
    };

    exportEl.addEventListener('click', async () => {
        const settings = await S.get();
        const payload = Transfer.buildPayload(settings, {
            extensionVersion: extensionApi.runtime.getManifest().version,
            exportedAt: new Date().toISOString()
        });
        const blob = new Blob([Transfer.serialize(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = Object.assign(document.createElement('a'), {
            href: url,
            download: `better-peakbagger-settings-${payload.exportedAt.slice(0, 10)}.json`
        });
        link.click();
        URL.revokeObjectURL(url);
    });

    importEl.addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', async () => {
        const file = fileEl.files && fileEl.files[0];
        fileEl.value = '';
        if (!file) return;
        let text;
        try {
            text = await file.text();
        } catch {
            flash('That settings file could not be read.');
            return;
        }
        const parsed = Transfer.parse(text);
        if (!parsed.ok) {
            hideConfirmation();
            flash(invalidFileMessage(parsed.reason));
            return;
        }
        showConfirmation(file.name || 'Selected settings file', parsed.settings);
    });

    cancelEl.addEventListener('click', hideConfirmation);
    confirmEl.addEventListener('click', async () => {
        if (!pendingImport) return;
        const pending = pendingImport;
        hideConfirmation();
        await save(pending.settings);
        flash(pending.successMessage);
    });

    const renderGithub = () => {
        const connected = githubStatus?.permissionGranted && githubStatus?.connected === true;
        const showBackupResult = connected
            && githubBackupResult?.repo === repoName()
            && githubBackupResult?.signature === settingsSignature;
        githubActionsEl.hidden = !connected;
        githubBackupEl.disabled = githubBusy;
        githubRestoreEl.disabled = githubBusy;
        autoBackupEl.disabled = githubBusy;
        githubStatusEl.classList.remove('settings-backup-github-success');
        githubStatusEl.textContent = '';
        if (githubBusy) {
            githubStatusEl.textContent = githubOperation === 'backup'
                ? 'Backing up settings to GitHub…'
                : 'Working with GitHub…';
        } else if (showBackupResult) {
            githubStatusEl.classList.add('settings-backup-github-success');
            githubStatusEl.textContent = 'Settings backed up ✓';
            if (githubBackupResult.commitUrl) {
                githubStatusEl.append(' ', Object.assign(document.createElement('a'), {
                    href: githubBackupResult.commitUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    textContent: 'View commit',
                }));
            }
        } else if (connected) {
            githubStatusEl.textContent = `Stored as settings.json in ${repoName()}.`;
        } else {
            githubStatusEl.textContent = 'Connect GitHub above to back up settings.';
        }
    };

    const refreshGithub = async () => {
        const [status, permissionGranted] = await Promise.all([
            send({ type: 'GITHUB_AUTH_STATUS' }),
            hasGithubPermission(extensionApi),
        ]);
        githubStatus = { ...(status || {}), permissionGranted };
        renderGithub();
    };

    const withGithubBusy = operation => OptionsUtils.withBusy({
        isBusy: () => githubBusy,
        setBusy: value => { githubBusy = value; renderGithub(); },
    }, operation);

    githubBackupEl.addEventListener('click', () => {
        const requestedRepo = repoName();
        const requestedSignature = settingsSignature;
        githubOperation = 'backup';
        void withGithubBusy(async () => {
            const response = await send({ type: 'GITHUB_SETTINGS_BACKUP' });
            if (!response?.ok) {
                githubBackupResult = null;
                flash(GithubError.message(response?.error));
                return;
            }
            githubBackupResult = {
                ...(response.result || {}),
                repo: requestedRepo,
                signature: requestedSignature,
            };
            flash(`Settings backed up to ${requestedRepo}`);
        }).finally(() => {
            githubOperation = null;
            renderGithub();
        });
    });

    githubRestoreEl.addEventListener('click', () => withGithubBusy(async () => {
        const response = await send({ type: 'GITHUB_SETTINGS_RESTORE' });
        if (!response?.ok) {
            flash(GithubError.message(response?.error));
            return;
        }
        if (response.content == null) {
            flash(`No settings backup found in ${repoName()}.`);
            return;
        }
        const parsed = Transfer.parse(response.content);
        if (!parsed.ok) {
            flash(invalidFileMessage(parsed.reason));
            return;
        }
        showConfirmation(`settings.json from ${repoName()}`, parsed.settings,
            `Settings restored from ${repoName()}`);
    }));

    autoBackupEl.addEventListener('change', () => {
        void save({ autoSettingsBackup: autoBackupEl.checked });
    });

    window.addEventListener('focus', () => { void refreshGithub(); });
    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[GITHUB_AUTH_STORAGE_KEY]) void refreshGithub();
            if (area === 'sync' && changes[SETTINGS_STORAGE_KEY]) void refreshGithub();
        });
    }

    let painted = false;
    return {
        populate(settings) {
            settingsSignature = Transfer.signature(settings || {});
            autoBackupEl.checked = settings?.autoSettingsBackup === true;
            renderGithub();
            if (!painted) {
                painted = true;
                void refreshGithub();
            }
        }
    };
}
