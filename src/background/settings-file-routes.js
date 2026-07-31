// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — exact-options-page manual settings file transfer.

import { settings as Settings } from '../settings/settings.js';
import { settingsTransfer as Transfer } from '../settings/settings-transfer.js';
import { imgbbAuth as ImgbbAuth } from '../photos/imgbb-auth.js';

const EXPORT_TYPE = 'SETTINGS_FILE_EXPORT';
const IMPORT_TYPE = 'SETTINGS_FILE_IMPORT';

const forbidden = () => ({
    ok: false,
    error: { code: 'forbidden', message: 'Open Settings to transfer settings.' },
});

const exactPackagedPage = (ext, page) => {
    if (typeof ext?.runtime?.getURL !== 'function') return () => false;
    const expected = new URL(ext.runtime.getURL(page));
    return sender => {
        try {
            const actual = new URL(sender?.url || '');
            return actual.protocol === expected.protocol
                && actual.host === expected.host
                && actual.origin === expected.origin
                && actual.pathname === expected.pathname;
        } catch {
            return false;
        }
    };
};

const replaceImgbbKey = async (keyStore, key, savedAt = null) => {
    if (key) await keyStore.setKey(key, savedAt || new Date().toISOString());
    else await keyStore.clear();
};

export function createSettingsFileRoutes({
    ext,
    settings = Settings,
    keyStore = ImgbbAuth.keyStore,
} = {}) {
    if (!ext || !settings?.requireCurrent || !settings?.applyPatch || !keyStore?.read) {
        throw new TypeError('settings file routes require extension and storage dependencies');
    }
    const isOptionsPage = exactPackagedPage(ext, 'options/options.html');

    const exportFile = async (_message, sender) => {
        if (!isOptionsPage(sender)) return forbidden();
        try {
            const [currentSettings, imgbb] = await Promise.all([
                settings.requireCurrent(),
                keyStore.read(),
            ]);
            const payload = Transfer.buildPayload(currentSettings, {
                extensionVersion: ext.runtime.getManifest().version,
                exportedAt: new Date().toISOString(),
                apiKeys: { imgbb: imgbb?.key || null },
            });
            return {
                ok: true,
                content: Transfer.serialize(payload),
                exportedAt: payload.exportedAt,
            };
        } catch (error) {
            console.error('Better Peakbagger: settings file export read failed', error);
            return {
                ok: false,
                error: {
                    code: 'settings-unavailable',
                    message: 'Settings and API keys could not be read, so no export was created.',
                },
            };
        }
    };

    const importFile = async (message, sender) => {
        if (!isOptionsPage(sender)) return forbidden();
        const parsed = Transfer.parse(message?.content);
        if (!parsed.ok) {
            return {
                ok: false,
                error: { code: 'invalid-file', reason: parsed.reason },
            };
        }

        let previousSettings;
        let previousImgbb;
        try {
            [previousSettings, previousImgbb] = await Promise.all([
                settings.requireCurrent(),
                keyStore.read(),
            ]);
        } catch (error) {
            console.error('Better Peakbagger: settings file import read failed', error);
            return {
                ok: false,
                error: {
                    code: 'settings-unavailable',
                    message: 'Current settings could not be read, so nothing was imported.',
                },
            };
        }

        const importsApiKeys = Object.hasOwn(parsed, 'apiKeys');
        try {
            const importedSettings = await settings.applyPatch(parsed.settings);
            if (importsApiKeys) {
                await replaceImgbbKey(keyStore, parsed.apiKeys.imgbb);
            }
            return { ok: true, settings: importedSettings, apiKeysImported: importsApiKeys };
        } catch (error) {
            console.error('Better Peakbagger: settings file import failed', error);
            let rollbackFailed = false;
            try {
                await settings.applyPatch(previousSettings);
            } catch (rollbackError) {
                rollbackFailed = true;
                console.error('Better Peakbagger: settings import rollback failed', rollbackError);
            }
            if (importsApiKeys) {
                try {
                    await replaceImgbbKey(
                        keyStore,
                        previousImgbb?.key || null,
                        previousImgbb?.savedAt || null
                    );
                } catch (rollbackError) {
                    rollbackFailed = true;
                    console.error('Better Peakbagger: API key import rollback failed', rollbackError);
                }
            }
            return {
                ok: false,
                error: {
                    code: rollbackFailed ? 'rollback-failed' : 'import-failed',
                    message: rollbackFailed
                        ? 'Import could not be completed. Reload Settings and check your settings and ImgBB key.'
                        : 'Settings could not be imported. Nothing was changed.',
                },
            };
        }
    };

    return {
        handlers: {
            [EXPORT_TYPE]: exportFile,
            [IMPORT_TYPE]: importFile,
        },
    };
}

export const settingsFileRoutes = {
    EXPORT_TYPE,
    IMPORT_TYPE,
};
