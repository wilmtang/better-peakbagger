// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — exact-options-page manual settings file transfer.

import { settings as Settings } from '../settings/settings.js';
import { settingsTransfer as Transfer } from '../settings/settings-transfer.js';
import { imgbbAuth as ImgbbAuth } from '../photos/imgbb-auth.js';
import { githubAuth as GithubAuth } from '../github/github-auth.js';
import { storageValue as StorageValue } from '../storage/storage-value.js';

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

// Null when there is no complete connection to export. Asking for credentials
// on an unconnected profile is not an error — the file simply has nothing to
// add — so the completeness test lives here rather than being repeated by the
// caller as a guard around an unreachable throw.
const connectionPayload = auth => {
    if (!auth?.token || !auth?.repo?.owner || !auth?.repo?.name) return null;
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
    if (!ext || !settings?.requireCurrent || !settings?.applyPatch || !settings?.replaceIfCurrent
        || !settings?.clean || !keyStore?.read || !keyStore?.replace || !keyStore?.replaceIfCurrent
        || !authStore?.read || !authStore?.replace || !authStore?.replaceIfCurrent
        || typeof verifyGithubConnection !== 'function') {
        throw new TypeError('settings file routes require extension and storage dependencies');
    }
    const isOptionsPage = exactPackagedPage(ext, 'options/options.html');
    let importQueue = Promise.resolve();
    const serializeImport = operation => {
        const pending = importQueue.then(operation, operation);
        importQueue = pending.catch(() => {});
        return pending;
    };

    const storeStates = ({ importsApiKeys, importsGithubConnection }) => ({
        settings: 'not-written',
        imgbb: importsApiKeys ? 'not-written' : 'not-requested',
        github: importsGithubConnection ? 'not-written' : 'not-requested',
    });

    // One credential decision covers the whole file. The ImgBB key used to ride
    // along unconditionally while the GitHub token needed a checkbox, so two
    // device-local secrets in the same unencrypted download had two different
    // consent models. Both are now opt-in, and an export nobody opted in for is
    // credential-free — which is what a settings file shared for troubleshooting
    // should be.
    const exportFile = async (message, sender) => {
        if (!isOptionsPage(sender)) return forbidden();
        const includeCredentials = message?.includeCredentials === true;
        try {
            const [currentSettings, imgbb, auth] = await Promise.all([
                settings.requireCurrent(),
                includeCredentials ? keyStore.read() : null,
                includeCredentials ? authStore.read() : null,
            ]);
            const connection = includeCredentials ? connectionPayload(auth) : null;
            const payload = Transfer.buildPayload(currentSettings, {
                extensionVersion: ext.runtime.getManifest().version,
                exportedAt: new Date().toISOString(),
                ...(includeCredentials ? { apiKeys: { imgbb: imgbb?.key || null } } : {}),
                ...(connection ? { githubConnection: connection } : {}),
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
                    message: includeCredentials
                        ? 'Settings and saved credentials could not be read, so no export was created.'
                        : 'Settings could not be read, so no export was created.',
                },
            };
        }
    };

    const importParsed = async parsed => {
        const importsApiKeys = Object.hasOwn(parsed, 'apiKeys');
        const importsGithubConnection = Object.hasOwn(parsed, 'githubConnection');
        const stores = storeStates({ importsApiKeys, importsGithubConnection });
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
                        stores,
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
                    stores,
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
                stores,
            };
        }

        const installedSettings = settings.clean({ ...previousSettings, ...parsed.settings });
        const installedImgbb = importsApiKeys && parsed.apiKeys.imgbb ? {
            key: parsed.apiKeys.imgbb,
            savedAt: new Date().toISOString(),
        } : null;
        const attempted = { settings: false, imgbb: false, github: false };
        try {
            attempted.settings = true;
            const importedSettings = await settings.applyPatch(parsed.settings);
            stores.settings = 'committed';
            if (importsApiKeys) {
                attempted.imgbb = true;
                await keyStore.replace(installedImgbb);
                stores.imgbb = 'committed';
            }
            if (importsGithubConnection) {
                attempted.github = true;
                await authStore.replace(importedGithubAuth);
                stores.github = 'committed';
            }
            return {
                ok: true,
                settings: importedSettings,
                apiKeysImported: importsApiKeys,
                githubConnectionImported: importsGithubConnection,
                stores,
            };
        } catch (error) {
            console.error('Better Peakbagger: settings file import failed', error);
            const restore = async (name, store, installed, previous) => {
                try {
                    const result = await store.replaceIfCurrent(installed, previous);
                    if (result.replaced) stores[name] = 'rolled-back';
                    else if (StorageValue.same(result.current, previous)) stores[name] = 'not-written';
                    else stores[name] = 'conflicted';
                } catch (rollbackError) {
                    stores[name] = 'rollback-failed';
                    console.error(`Better Peakbagger: ${name} import rollback failed`, rollbackError);
                }
            };
            if (attempted.github) {
                await restore('github', authStore, importedGithubAuth, previousGithubAuth);
            }
            if (attempted.imgbb) await restore('imgbb', keyStore, installedImgbb, previousImgbb);
            if (attempted.settings) {
                await restore('settings', settings, installedSettings, previousSettings);
            }
            const rollbackFailed = Object.values(stores).includes('rollback-failed');
            const conflicted = Object.values(stores).includes('conflicted');
            return {
                ok: false,
                error: {
                    code: rollbackFailed ? 'rollback-failed'
                        : conflicted ? 'rollback-conflict'
                            : 'import-failed',
                    message: rollbackFailed
                        ? 'Import stopped before it finished. Some imported changes may still be saved. Reload Settings and review your settings and connections.'
                        : conflicted
                            ? 'Import stopped before it finished. Newer changes were preserved. Reload Settings and review your settings and connections.'
                            : 'Settings could not be imported. The attempted changes were rolled back.',
                },
                stores,
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
        // Includes remote credential validation as well as local writes. A
        // second import therefore cannot validate an old world, then enter the
        // transaction after the first import has already changed it.
        return serializeImport(() => importParsed(parsed));
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
