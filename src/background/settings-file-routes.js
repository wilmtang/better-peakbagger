// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — exact-options-page manual settings file transfer.

import { settings as Settings } from '../settings/settings.js';
import { settingsTransfer as Transfer } from '../settings/settings-transfer.js';
import { imgbbAuth as ImgbbAuth } from '../photos/imgbb-auth.js';
import { githubAuth as GithubAuth } from '../github/github-auth.js';

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

const connectionPayload = auth => {
    if (!auth?.token || !auth?.repo?.owner || !auth?.repo?.name) {
        throw new Error('No complete GitHub connection is available to export.');
    }
    return {
        token: auth.token,
        repository: {
            owner: auth.repo.owner,
            name: auth.repo.name,
            ...(Number.isSafeInteger(auth.repo.id) && auth.repo.id > 0 ? { id: auth.repo.id } : {}),
        },
    };
};

export function createSettingsFileRoutes({
    ext,
    settings = Settings,
    keyStore = ImgbbAuth.keyStore,
    authStore = GithubAuth.authStore,
    verifyGithubConnection,
} = {}) {
    if (!ext || !settings?.requireCurrent || !settings?.applyPatch || !keyStore?.read
        || !authStore?.read || !authStore?.replace || typeof verifyGithubConnection !== 'function') {
        throw new TypeError('settings file routes require extension and storage dependencies');
    }
    const isOptionsPage = exactPackagedPage(ext, 'options/options.html');

    const exportFile = async (message, sender) => {
        if (!isOptionsPage(sender)) return forbidden();
        const includeGithubConnection = message?.includeGithubConnection === true;
        try {
            const [currentSettings, imgbb, auth] = await Promise.all([
                settings.requireCurrent(),
                keyStore.read(),
                includeGithubConnection ? authStore.read() : null,
            ]);
            const payload = Transfer.buildPayload(currentSettings, {
                extensionVersion: ext.runtime.getManifest().version,
                exportedAt: new Date().toISOString(),
                apiKeys: { imgbb: imgbb?.key || null },
                ...(includeGithubConnection ? { githubConnection: connectionPayload(auth) } : {}),
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
                    message: includeGithubConnection
                        ? 'Settings, API keys, and the GitHub connection could not be read, so no export was created.'
                        : 'Settings and API keys could not be read, so no export was created.',
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

        const importsApiKeys = Object.hasOwn(parsed, 'apiKeys');
        const importsGithubConnection = Object.hasOwn(parsed, 'githubConnection');
        let importedGithubAuth = null;
        if (importsGithubConnection) {
            try {
                const verification = await verifyGithubConnection(parsed.githubConnection);
                if (!verification?.ok || !verification.auth) {
                    return {
                        ok: false,
                        error: {
                            source: 'github',
                            code: verification?.error?.code || 'unknown',
                            message: verification?.error?.message
                                || 'The GitHub connection in this file could not be verified.',
                            ...(verification?.error?.status == null
                                ? {} : { status: verification.error.status }),
                            ...(verification?.error?.retryAfterSeconds == null
                                ? {} : { retryAfterSeconds: verification.error.retryAfterSeconds }),
                        },
                    };
                }
                importedGithubAuth = verification.auth;
            } catch (error) {
                console.error('Better Peakbagger: imported GitHub connection validation failed', error);
                return {
                    ok: false,
                    error: {
                        source: 'github',
                        code: 'unknown',
                        message: 'The GitHub connection in this file could not be verified.',
                    },
                };
            }
        }

        let previousSettings;
        let previousImgbb;
        let previousGithubAuth;
        try {
            [previousSettings, previousImgbb, previousGithubAuth] = await Promise.all([
                settings.requireCurrent(),
                keyStore.read(),
                importsGithubConnection ? authStore.read() : null,
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

        let settingsWritten = false;
        let apiKeysWritten = false;
        let githubWritten = false;
        try {
            const importedSettings = await settings.applyPatch(parsed.settings);
            settingsWritten = true;
            if (importsApiKeys) {
                await replaceImgbbKey(keyStore, parsed.apiKeys.imgbb);
                apiKeysWritten = true;
            }
            if (importsGithubConnection) {
                await authStore.replace(importedGithubAuth);
                githubWritten = true;
            }
            return {
                ok: true,
                settings: importedSettings,
                apiKeysImported: importsApiKeys,
                githubConnectionImported: importsGithubConnection,
            };
        } catch (error) {
            console.error('Better Peakbagger: settings file import failed', error);
            let rollbackFailed = false;
            if (importsGithubConnection && (githubWritten || settingsWritten)) {
                try {
                    await authStore.replace(previousGithubAuth);
                } catch (rollbackError) {
                    rollbackFailed = true;
                    console.error('Better Peakbagger: GitHub connection import rollback failed', rollbackError);
                }
            }
            if (importsApiKeys && (apiKeysWritten || settingsWritten)) {
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
            if (settingsWritten) {
                try {
                    await settings.applyPatch(previousSettings);
                } catch (rollbackError) {
                    rollbackFailed = true;
                    console.error('Better Peakbagger: settings import rollback failed', rollbackError);
                }
            }
            return {
                ok: false,
                error: {
                    code: rollbackFailed ? 'rollback-failed' : 'import-failed',
                    message: rollbackFailed
                        ? 'Import could not be completed. Reload Settings and check your settings and connections.'
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
