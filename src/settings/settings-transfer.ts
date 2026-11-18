// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure settings backup payload helpers.

import { settingsSchema as Schema } from './settings-schema.ts';
import { imgbbClient as ImgbbClient } from '../photos/imgbb-client.ts';
import { boundedText as BoundedText } from '../net/bounded-text.ts';
import { cleanGarminKey } from '../garmin/garmin-api.ts';
import { readCustomLayerBackup, readPrivateLayerFile } from '../maps/custom-overlay-transfer.ts';

const KIND = 'better-peakbagger-settings';
const SCHEMA_VERSION = 7;
const BACKUP_PATH = 'settings.json';
const API_KEY_NAMES = Object.freeze(['imgbb', 'garmin'] as const);
const IMPORT_MAX_BYTES = 1024 * 1024;
const IMPORT_STRUCTURE_LIMITS = Object.freeze({
    maxDepth: 12,
    maxNodes: 5000,
    maxArrayItems: 256,
    maxObjectKeys: 512,
    maxStringChars: 8192,
});

export type SettingsTransferApiKeys = {
    imgbb?: string | null;
    garmin?: string | null;
};

export type SettingsTransferGithubConnection = {
    token: string;
    repository: {
        owner: string;
        name: string;
        id?: number;
    };
};

export type CustomLayerBackup = NonNullable<ReturnType<typeof readCustomLayerBackup>>;
export type PrivateLayerFile = NonNullable<ReturnType<typeof readPrivateLayerFile>>;

export type SettingsTransferPayload = {
    kind: typeof KIND;
    schemaVersion: typeof SCHEMA_VERSION;
    exportedAt: unknown;
    extensionVersion: string;
    settings: Record<string, unknown>;
    customLayers?: CustomLayerBackup;
    privateCustomLayers?: PrivateLayerFile;
    apiKeys?: SettingsTransferApiKeys;
    githubConnection?: SettingsTransferGithubConnection;
};

export type BuildSettingsPayloadOptions = {
    extensionVersion?: string;
    exportedAt?: unknown;
    apiKeys?: unknown;
    githubConnection?: unknown;
    customLayers?: unknown;
    privateCustomLayers?: unknown;
};

export type SettingsParseFailureReason =
    | 'not-json'
    | 'too-large'
    | 'too-complex'
    | 'wrong-kind'
    | 'newer-version'
    | 'no-settings'
    | 'invalid-custom-layers'
    | 'invalid-api-keys'
    | 'invalid-github-connection';

export type SettingsParseResult =
    | { ok: false; reason: SettingsParseFailureReason }
    | {
        ok: true;
        settings: Record<string, unknown>;
        customLayers?: CustomLayerBackup;
        privateCustomLayers?: PrivateLayerFile;
        apiKeys?: SettingsTransferApiKeys;
        githubConnection?: SettingsTransferGithubConnection;
    };

// Schema.clean() intentionally preserves unknown keys. Transfer payloads do
// not: they contain only the settings this extension version understands.
const pick = (settings: unknown): Record<string, unknown> => {
    const cleaned = Schema.clean(settings) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of Schema.PORTABLE_KEYS) picked[key] = cleaned[key];
    // Exports are explicit: importing onto a device with legacy local order
    // must not reinterpret an unconfigured source preference as that old order.
    picked.betaPeakFilterOrder ??= [...Schema.PEAK_FILTER_ORDER];
    picked.betaPersonalFilterOrder ??= [...Schema.PERSONAL_FILTER_ORDER];
    return picked;
};

const cleanApiKeys = (value: unknown): SettingsTransferApiKeys | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const result: SettingsTransferApiKeys = {};
    for (const name of API_KEY_NAMES) {
        if (!Object.hasOwn(record, name)) continue;
        if (record[name] === null) result[name] = null;
        else {
            const cleaned = name === 'imgbb' ? ImgbbClient.cleanKey(record[name]) : cleanGarminKey(record[name]);
            if (!cleaned) return null;
            result[name] = cleaned;
        }
    }
    return Object.keys(result).length ? result : null;
};

const cleanGithubPart = (
    value: unknown,
    { max = 255, slash = false }: { max?: number; slash?: boolean } = {},
): string | null => {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || value.length > max || /\s|[\u0000-\u001f\u007f]/.test(value)
        || (!slash && /[\\/]/.test(value))) return null;
    return value;
};

// A GitHub user access token is opaque: token prefixes and lengths may change,
// so the file boundary rejects whitespace/control characters and unreasonable
// sizes without pretending to validate a GitHub-managed format. Import still
// has to prove the token and selected repository against GitHub before storing
// either one.
const cleanGithubConnection = (value: unknown): SettingsTransferGithubConnection | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const token = cleanGithubPart(record.token, { max: 2048, slash: true });
    const repository = record.repository;
    if (!token || token.length < 8 || !repository || typeof repository !== 'object'
        || Array.isArray(repository)) return null;
    const repo = repository as Record<string, unknown>;
    const owner = cleanGithubPart(repo.owner);
    const name = cleanGithubPart(repo.name);
    if (!owner || !name || owner === '.' || owner === '..' || name === '.' || name === '..') return null;
    const cleaned: SettingsTransferGithubConnection = { token, repository: { owner, name } };
    if (repo.id != null) {
        if (typeof repo.id !== 'number' || !Number.isSafeInteger(repo.id) || repo.id <= 0) return null;
        cleaned.repository.id = repo.id;
    }
    return cleaned;
};

// Credential fields are opt-in so GitHub settings backups keep their
// established credential-free contract. Manual file export passes API keys
// (including explicit nulls) and a complete GitHub connection only after the
// user selects the single sensitive-file option.
const buildPayload = (settings: unknown, {
    extensionVersion = '', exportedAt, apiKeys, githubConnection, customLayers, privateCustomLayers,
}: BuildSettingsPayloadOptions = {}): SettingsTransferPayload => {
    const payload: SettingsTransferPayload = {
        kind: KIND,
        schemaVersion: SCHEMA_VERSION,
        exportedAt,
        extensionVersion,
        settings: pick(settings)
    };
    if (customLayers !== undefined) {
        const cleanedCustomLayers = readCustomLayerBackup(customLayers);
        if (!cleanedCustomLayers) throw new TypeError('Custom layers backup is invalid.');
        payload.customLayers = cleanedCustomLayers;
    }
    if (privateCustomLayers !== undefined) {
        const cleanedPrivateLayers = readPrivateLayerFile(privateCustomLayers, payload.customLayers);
        if (!cleanedPrivateLayers) throw new TypeError('Private map settings file is invalid.');
        payload.privateCustomLayers = cleanedPrivateLayers;
    }
    if (apiKeys !== undefined) {
        const cleaned = cleanApiKeys(apiKeys);
        if (!cleaned) throw new TypeError('Settings transfer API keys are invalid.');
        payload.apiKeys = cleaned;
    }
    if (githubConnection !== undefined) {
        const cleaned = cleanGithubConnection(githubConnection);
        if (!cleaned) throw new TypeError('Settings transfer GitHub connection is invalid.');
        payload.githubConnection = cleaned;
    }
    return payload;
};

const serialize = (payload: unknown): string => `${JSON.stringify(payload, null, 2)}\n`;

const parse = (text: unknown): SettingsParseResult => {
    if (typeof text !== 'string') return { ok: false, reason: 'not-json' };
    if (BoundedText.encodedByteLength(text) > IMPORT_MAX_BYTES) {
        return { ok: false, reason: 'too-large' };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'not-json' };
    }
    try {
        BoundedText.assertBoundedStructure(parsed, {
            ...IMPORT_STRUCTURE_LIMITS,
            label: 'Settings import structure',
        });
    } catch (error) {
        if (BoundedText.isLimitError(error)) return { ok: false, reason: 'too-complex' };
        throw error;
    }
    const record = parsed as Record<string, unknown> | null;
    if (!record || typeof record !== 'object' || record.kind !== KIND) {
        return { ok: false, reason: 'wrong-kind' };
    }
    if (typeof record.schemaVersion !== 'number'
        || !Number.isInteger(record.schemaVersion)
        || record.schemaVersion > SCHEMA_VERSION) {
        return { ok: false, reason: 'newer-version' };
    }
    if (!record.settings || typeof record.settings !== 'object' || Array.isArray(record.settings)) {
        return { ok: false, reason: 'no-settings' };
    }
    const result: Extract<SettingsParseResult, { ok: true }> = { ok: true, settings: pick(record.settings) };
    if (record.schemaVersion >= 6 && Object.hasOwn(record, 'customLayers')) {
        const customLayers = readCustomLayerBackup(record.customLayers);
        if (!customLayers) return { ok: false, reason: 'invalid-custom-layers' };
        result.customLayers = customLayers;
    }
    if (Object.hasOwn(record, 'privateCustomLayers')) {
        if (record.schemaVersion < 7) return { ok: false, reason: 'invalid-custom-layers' };
        const privateCustomLayers = readPrivateLayerFile(record.privateCustomLayers, result.customLayers);
        if (!privateCustomLayers) return { ok: false, reason: 'invalid-custom-layers' };
        result.privateCustomLayers = privateCustomLayers;
    }
    if (Object.hasOwn(record, 'apiKeys')) {
        const apiKeys = cleanApiKeys(record.apiKeys);
        if (!apiKeys) return { ok: false, reason: 'invalid-api-keys' };
        result.apiKeys = apiKeys;
    }
    if (Object.hasOwn(record, 'githubConnection')) {
        if (record.schemaVersion < 3) return { ok: false, reason: 'invalid-github-connection' };
        const githubConnection = cleanGithubConnection(record.githubConnection);
        if (!githubConnection) return { ok: false, reason: 'invalid-github-connection' };
        result.githubConnection = githubConnection;
    }
    return result;
};

// Export time and extension version are metadata, not part of the content
// identity used to skip an unchanged automatic backup.
const signature = (settings: unknown, customLayers?: unknown): string => {
    if (customLayers === undefined) return JSON.stringify(pick(settings));
    const layers = readCustomLayerBackup(customLayers);
    if (!layers) throw new TypeError('Custom layers backup is invalid.');
    if (!layers.sources.length) return JSON.stringify(pick(settings));
    return JSON.stringify({ settings: pick(settings), customLayers: layers });
};

export const settingsTransfer = {
    KIND,
    SCHEMA_VERSION,
    BACKUP_PATH,
    API_KEY_NAMES,
    IMPORT_MAX_BYTES,
    IMPORT_STRUCTURE_LIMITS,
    buildPayload,
    serialize,
    parse,
    signature
};
