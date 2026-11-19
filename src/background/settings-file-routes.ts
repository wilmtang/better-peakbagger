// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — exact-options-page manual settings file transfer.

import { settings as Settings, type SettingsData } from '../settings/settings.ts';
import {
    settingsTransfer as Transfer,
    type SettingsParseResult,
    type SettingsTransferGithubConnection,
} from '../settings/settings-transfer.ts';
import { imgbbAuth as ImgbbAuth, type ImgbbAuthRecord, type ImgbbKeyStore } from '../photos/imgbb-auth.ts';
import { githubAuth as GithubAuth, type GithubAuthRecord, type GithubAuthSnapshot } from '../github/github-auth.ts';
import { storageValue as StorageValue } from '../storage/storage-value.ts';
import {
    customLayerBackup,
    type CustomLayerSnapshot,
    type PrivateLayerEntry,
} from '../maps/custom-overlay-transfer.ts';

export interface SettingsFileSender {
    url?: string;
}

export interface SettingsFileExt {
    runtime: {
        getURL(path: string): string;
        getManifest(): { version?: string };
    };
}

export interface SettingsFileSettingsStore {
    requireCurrent(options?: { includeLegacy?: boolean }): Promise<SettingsData>;
    applyPatch(patch: unknown, options?: { onlyIfUnset?: boolean; migration?: boolean }): Promise<SettingsData>;
    replaceIfCurrent(expected: unknown, replacement: unknown): Promise<{ replaced: boolean; current: SettingsData }>;
    clean(value: unknown): SettingsData;
}

export interface SettingsFileAuthStore {
    read(): Promise<GithubAuthRecord | null>;
    readSnapshot(): Promise<GithubAuthSnapshot>;
    replaceIfSnapshot(
        expected: GithubAuthSnapshot | null | undefined,
        replacement: GithubAuthRecord | null | undefined,
    ): Promise<{ replaced: boolean; current: GithubAuthSnapshot }>;
}

export interface SettingsFileCustomLayerSnapshot extends CustomLayerSnapshot {
    privateSources?: PrivateLayerEntry[];
}

export interface SettingsFileCustomLayersStore {
    snapshot(options?: { includePrivate?: boolean }): Promise<SettingsFileCustomLayerSnapshot>;
    replaceIfCurrent(
        expected: SettingsFileCustomLayerSnapshot,
        replacement: unknown,
    ): Promise<{ replaced: boolean; current: SettingsFileCustomLayerSnapshot }>;
}

export interface SettingsFileGarminConnection {
    key: string | null;
}

export interface SettingsFileGarminSnapshot {
    epoch: number;
    connection: SettingsFileGarminConnection | null;
}

export interface SettingsFileGarminAdapter {
    readSnapshot(): Promise<SettingsFileGarminSnapshot>;
    verifyImportedKey(
        key: string | null,
        previous: SettingsFileGarminSnapshot,
    ): Promise<SettingsFileGarminConnection | null>;
    replaceIfSnapshot(
        expected: SettingsFileGarminSnapshot,
        replacement: SettingsFileGarminConnection | null,
    ): Promise<{ replaced: boolean }>;
}

export interface VerifiedGithubConnectionError {
    code?: string;
    message?: string;
    status?: number | null;
    retryAfterSeconds?: number | null;
}

export type VerifyGithubConnectionResult =
    | { ok: true; auth: GithubAuthRecord }
    | { ok: false; error?: VerifiedGithubConnectionError };

export interface CreateSettingsFileRoutesOptions {
    ext: SettingsFileExt;
    settings?: SettingsFileSettingsStore;
    keyStore?: Pick<ImgbbKeyStore, 'read' | 'replace' | 'replaceIfCurrent'>;
    authStore?: SettingsFileAuthStore;
    verifyGithubConnection: (connection: SettingsTransferGithubConnection) => Promise<VerifyGithubConnectionResult>;
    garmin?: SettingsFileGarminAdapter | null;
    customLayers?: SettingsFileCustomLayersStore | null;
}

export type StoreTransferState =
    | 'not-written'
    | 'not-requested'
    | 'committed'
    | 'conflicted'
    | 'rolled-back'
    | 'rollback-failed';

export interface ImportStoreStates {
    settings: StoreTransferState;
    imgbb: StoreTransferState;
    github: StoreTransferState;
    customLayers?: StoreTransferState;
    garmin?: StoreTransferState;
}

export type SettingsFileMessage = Record<string, unknown>;

const EXPORT_TYPE = 'SETTINGS_FILE_EXPORT';
const IMPORT_TYPE = 'SETTINGS_FILE_IMPORT';

const forbidden = () => ({
    ok: false as const,
    error: { code: 'forbidden', message: 'Open Settings to transfer settings.' },
});

const exactPackagedPage = (ext: SettingsFileExt, page: string) => {
    if (typeof ext?.runtime?.getURL !== 'function') return () => false;
    const expected = new URL(ext.runtime.getURL(page));
    return (sender: SettingsFileSender | null | undefined): boolean => {
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
const connectionPayload = (auth: GithubAuthRecord | null | undefined): SettingsTransferGithubConnection | null => {
    if (!auth?.token || !auth?.repo?.owner || !auth?.repo?.name) return null;
    const repoId = auth.repo.id;
    return {
        token: auth.token,
        repository: {
            owner: auth.repo.owner,
            name: auth.repo.name,
            ...(typeof repoId === 'number' && Number.isSafeInteger(repoId) && repoId > 0 ? { id: repoId } : {}),
        },
    };
};

export function createSettingsFileRoutes({
    ext,
    settings = Settings,
    keyStore = ImgbbAuth.keyStore,
    authStore = GithubAuth.authStore,
    verifyGithubConnection,
    garmin = null,
    customLayers = null,
}: CreateSettingsFileRoutesOptions = {} as CreateSettingsFileRoutesOptions) {
    if (!ext || !settings?.requireCurrent || !settings?.applyPatch || !settings?.replaceIfCurrent
        || !settings?.clean || !keyStore?.read || !keyStore?.replace || !keyStore?.replaceIfCurrent
        || !authStore?.read || !authStore?.readSnapshot || !authStore?.replaceIfSnapshot
        || typeof verifyGithubConnection !== 'function') {
        throw new TypeError('settings file routes require extension and storage dependencies');
    }
    const isOptionsPage = exactPackagedPage(ext, 'options/options.html');
    let importQueue: Promise<unknown> = Promise.resolve();
    const serializeImport = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = importQueue.then(operation, operation);
        importQueue = pending.catch(() => {});
        return pending;
    };

    const storeStates = ({
        importsApiKeys,
        importsGithubConnection,
    }: {
        importsApiKeys: boolean;
        importsGithubConnection: boolean;
    }): ImportStoreStates => ({
        settings: 'not-written',
        imgbb: importsApiKeys ? 'not-written' : 'not-requested',
        github: importsGithubConnection ? 'not-written' : 'not-requested',
    });

    // Manual files include complete map configurations, including parameters.
    // Account credentials retain their separate opt-in. GitHub backup uses
    // ordinary public-only snapshots, never this exact-Settings-page route.
    const exportFile = async (message: SettingsFileMessage, sender: SettingsFileSender) => {
        if (!isOptionsPage(sender)) return forbidden();
        const includeCredentials = message?.includeCredentials === true;
        try {
            const [currentSettings, imgbb, auth, garminSnapshot, layerSnapshot] = await Promise.all([
                settings.requireCurrent({ includeLegacy: true }),
                includeCredentials ? keyStore.read() : null,
                includeCredentials ? authStore.read() : null,
                includeCredentials && garmin ? garmin.readSnapshot() : null,
                customLayers ? customLayers.snapshot({ includePrivate: true }) : null,
            ]);
            const connection = includeCredentials ? connectionPayload(auth) : null;
            const payload = Transfer.buildPayload(currentSettings, {
                extensionVersion: ext.runtime.getManifest().version || '',
                exportedAt: new Date().toISOString(),
                ...(layerSnapshot ? { customLayers: customLayerBackup(layerSnapshot) } : {}),
                ...(layerSnapshot?.privateSources?.length ? { privateCustomLayers: layerSnapshot.privateSources } : {}),
                ...(includeCredentials ? {
                    apiKeys: {
                        imgbb: imgbb?.key || null,
                        ...(garmin ? { garmin: garminSnapshot?.connection?.key || null } : {}),
                    },
                } : {}),
                ...(connection ? { githubConnection: connection } : {}),
            });
            return {
                ok: true as const,
                content: Transfer.serialize(payload),
                exportedAt: payload.exportedAt as string,
            };
        } catch (error) {
            console.error('Better Peakbagger: settings file export read failed', error);
            return {
                ok: false as const,
                error: {
                    code: 'settings-unavailable',
                    message: includeCredentials
                        ? 'Settings and saved credentials could not be read, so no export was created.'
                        : 'Settings could not be read, so no export was created.',
                },
            };
        }
    };

    const importParsed = async (parsed: Extract<SettingsParseResult, { ok: true }>) => {
        const importsApiKeys = Object.hasOwn(parsed.apiKeys || {}, 'imgbb');
        const importsGarmin = Object.hasOwn(parsed.apiKeys || {}, 'garmin');
        const importsGithubConnection = Object.hasOwn(parsed, 'githubConnection');
        const stores = storeStates({ importsApiKeys, importsGithubConnection });
        const importsLayers = Object.hasOwn(parsed, 'customLayers');
        if (importsLayers) stores.customLayers = 'not-written';
        let previousLayers: SettingsFileCustomLayerSnapshot | null | undefined;
        let installedLayers: SettingsFileCustomLayerSnapshot | undefined;
        let previousGarmin: SettingsFileGarminSnapshot | null | undefined;
        let installedGarmin: SettingsFileGarminConnection | null | undefined;
        let garminAttempted = false;
        // Capture intent before provider validation yields to newer user edits.
        // The stores still commit independently through their conditional APIs.
        if (importsGarmin) stores.garmin = 'not-written';
        let previousSettings: SettingsData;
        let previousImgbb: ImgbbAuthRecord | null;
        let previousGithubSnapshot: GithubAuthSnapshot | null;
        try {
            [previousSettings, previousImgbb, previousGithubSnapshot, previousLayers, previousGarmin] = await Promise.all([
                settings.requireCurrent({ includeLegacy: true }),
                keyStore.read(),
                importsGithubConnection ? authStore.readSnapshot() : null,
                importsLayers ? customLayers?.snapshot({ includePrivate: true }) : null,
                importsGarmin ? garmin?.readSnapshot() : null,
            ]);
            if (importsLayers && !previousLayers) throw new Error('Custom layers store unavailable.');
        } catch (error) {
            console.error('Better Peakbagger: settings file import read failed', error);
            return {
                ok: false as const,
                error: {
                    code: 'settings-unavailable',
                    message: 'Current settings could not be read, so nothing was imported.',
                },
                stores,
            };
        }

        if (importsGarmin) {
            try {
                if (!garmin || !previousGarmin) throw new Error();
                installedGarmin = await garmin.verifyImportedKey(parsed.apiKeys?.garmin ?? null, previousGarmin);
            } catch {
                return {
                    ok: false as const,
                    error: {
                        source: 'garmin',
                        code: 'garmin-validation',
                        message: 'The Garmin key in this file could not be verified. Allow Garmin access and check the key; nothing was imported.',
                    },
                    stores,
                };
            }
        }
        let importedGithubAuth: GithubAuthRecord | null = null;
        if (importsGithubConnection) {
            try {
                const verification = await verifyGithubConnection(parsed.githubConnection!);
                if (!verification?.ok || !verification.auth) {
                    const verifyError = verification && !verification.ok ? verification.error : undefined;
                    return {
                        ok: false as const,
                        error: {
                            source: 'github',
                            code: verifyError?.code || 'unknown',
                            message: verifyError?.message
                                || 'The GitHub connection in this file could not be verified.',
                            ...(verifyError?.status == null
                                ? {} : { status: verifyError.status }),
                            ...(verifyError?.retryAfterSeconds == null
                                ? {} : { retryAfterSeconds: verifyError.retryAfterSeconds }),
                        },
                        stores,
                    };
                }
                importedGithubAuth = verification.auth;
            } catch (error) {
                console.error('Better Peakbagger: imported GitHub connection validation failed', error);
                return {
                    ok: false as const,
                    error: {
                        source: 'github',
                        code: 'unknown',
                        message: 'The GitHub connection in this file could not be verified.',
                    },
                    stores,
                };
            }
        }

        const installedSettings = settings.clean({ ...previousSettings, ...parsed.settings });
        const installedImgbb: ImgbbAuthRecord | null = importsApiKeys && parsed.apiKeys?.imgbb ? {
            key: parsed.apiKeys.imgbb,
            savedAt: new Date().toISOString(),
        } : null;
        const installedGithubSnapshot: GithubAuthSnapshot | null = importsGithubConnection && previousGithubSnapshot ? {
            auth: importedGithubAuth,
            epoch: previousGithubSnapshot.epoch + 1,
        } : null;
        const attempted = { settings: false, imgbb: false, github: false, customLayers: false };
        try {
            if (importsGarmin && garmin && previousGarmin && installedGarmin !== undefined) {
                garminAttempted = true;
                const result = await garmin.replaceIfSnapshot(previousGarmin, installedGarmin);
                if (!result.replaced) throw new Error('Garmin connection changed during import.');
                stores.garmin = 'committed';
            }
            attempted.settings = true;
            const replacement = await settings.replaceIfCurrent(previousSettings, installedSettings);
            if (!replacement.replaced) {
                attempted.settings = false;
                stores.settings = 'conflicted';
                throw new Error('Settings changed during import.');
            }
            const importedSettings = replacement.current;
            stores.settings = 'committed';
            if (importsLayers && customLayers && previousLayers) {
                attempted.customLayers = true;
                const layerReplacement = await customLayers.replaceIfCurrent(previousLayers, {
                    ...parsed.customLayers,
                    privateSources: parsed.privateCustomLayers || [],
                });
                if (!layerReplacement.replaced) {
                    attempted.customLayers = false;
                    stores.customLayers = 'conflicted';
                    throw new Error('Custom layers changed during import.');
                }
                installedLayers = layerReplacement.current;
                stores.customLayers = 'committed';
            }
            if (importsApiKeys) {
                attempted.imgbb = true;
                const keyReplacement = await keyStore.replaceIfCurrent(previousImgbb, installedImgbb);
                if (!keyReplacement.replaced) {
                    attempted.imgbb = false;
                    stores.imgbb = 'conflicted';
                    throw new Error('ImgBB credentials changed during import.');
                }
                stores.imgbb = 'committed';
            }
            if (importsGithubConnection) {
                attempted.github = true;
                const result = await authStore.replaceIfSnapshot(
                    previousGithubSnapshot,
                    importedGithubAuth,
                );
                if (!result.replaced) {
                    throw Object.assign(
                        new Error('GitHub authorization changed during settings import.'),
                        { code: 'github-auth-conflict' },
                    );
                }
                stores.github = 'committed';
            }
            return {
                ok: true as const,
                settings: importedSettings,
                apiKeysImported: importsApiKeys || importsGarmin,
                githubConnectionImported: importsGithubConnection,
                stores,
            };
        } catch (error) {
            console.error('Better Peakbagger: settings file import failed', error);
            const restore = async <T>(
                name: 'imgbb' | 'customLayers' | 'settings',
                store: { replaceIfCurrent(expected: T, replacement: T): Promise<{ replaced: boolean; current: unknown }> },
                installed: T,
                previous: T,
            ) => {
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
            if (garminAttempted && garmin && previousGarmin && installedGarmin !== undefined) {
                try {
                    const restored = await garmin.replaceIfSnapshot(
                        { epoch: previousGarmin.epoch + 1, connection: installedGarmin },
                        previousGarmin.connection,
                    );
                    stores.garmin = restored.replaced ? 'rolled-back' : 'conflicted';
                } catch { stores.garmin = 'rollback-failed'; }
            }
            if (attempted.github && installedGithubSnapshot && previousGithubSnapshot) {
                try {
                    const result = await authStore.replaceIfSnapshot(
                        installedGithubSnapshot,
                        previousGithubSnapshot.auth,
                    );
                    if (result.replaced) stores.github = 'rolled-back';
                    else if (StorageValue.same(result.current.auth, previousGithubSnapshot.auth)
                        && result.current.epoch === previousGithubSnapshot.epoch) {
                        stores.github = 'not-written';
                    } else stores.github = 'conflicted';
                } catch (rollbackError) {
                    stores.github = 'rollback-failed';
                    console.error('Better Peakbagger: github import rollback failed', rollbackError);
                }
            }
            if (attempted.imgbb) await restore('imgbb', keyStore, installedImgbb, previousImgbb);
            if (attempted.customLayers) {
                if (installedLayers && customLayers && previousLayers) {
                    await restore('customLayers', customLayers, installedLayers, previousLayers);
                } else stores.customLayers = 'rollback-failed'; // A rejected storage write may have committed; never claim a clean rollback.
            }
            if (attempted.settings) {
                await restore('settings', settings, installedSettings, previousSettings);
            }
            const rollbackFailed = Object.values(stores).includes('rollback-failed');
            const conflicted = Object.values(stores).includes('conflicted');
            return {
                ok: false as const,
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

    const importFile = async (message: SettingsFileMessage, sender: SettingsFileSender) => {
        if (!isOptionsPage(sender)) return forbidden();
        const parsed = Transfer.parse(message?.content);
        if (!parsed.ok) {
            return {
                ok: false as const,
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
};
