// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — settings file transfer and GitHub backup controls.

import { settings as S } from '../src/settings/settings.js';
import { settingsTransfer as Transfer } from '../src/settings/settings-transfer.js';

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
    if (!exportEl || !importEl || !fileEl || !confirmationEl || !confirmationNameEl
        || !confirmEl || !cancelEl) {
        return { populate() {} };
    }

    let pendingImport = null;

    const hideConfirmation = () => {
        pendingImport = null;
        confirmationEl.hidden = true;
        confirmationNameEl.textContent = '';
    };

    const showConfirmation = (name, settings) => {
        pendingImport = settings;
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
        const settings = pendingImport;
        hideConfirmation();
        await save(settings);
        flash('Settings imported');
    });

    return { populate() {} };
}
