// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure settings backup payload helpers.

import { settingsSchema as Schema } from './settings-schema.js';
import { imgbbClient as ImgbbClient } from '../photos/imgbb-client.js';
import { boundedText as BoundedText } from '../net/bounded-text.js';

const KIND = 'better-peakbagger-settings';
const SCHEMA_VERSION = 3;
const BACKUP_PATH = 'settings.json';
const API_KEY_NAMES = Object.freeze(['imgbb']);
const IMPORT_MAX_BYTES = 1024 * 1024;
const IMPORT_STRUCTURE_LIMITS = Object.freeze({
    maxDepth: 12,
    maxNodes: 5000,
    maxArrayItems: 256,
    maxObjectKeys: 512,
    maxStringChars: 8192,
});

// Schema.clean() intentionally preserves unknown keys. Transfer payloads do
// not: they contain only the settings this extension version understands.
const pick = settings => {
    const cleaned = Schema.clean(settings);
    const picked = {};
    for (const key of Object.keys(Schema.DEFAULTS)) picked[key] = cleaned[key];
    return picked;
};

const cleanApiKeys = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Object.hasOwn(value, 'imgbb')) return null;
    if (value.imgbb == null) return { imgbb: null };
    const imgbb = ImgbbClient.cleanKey(value.imgbb);
    return imgbb ? { imgbb } : null;
};

const cleanGithubPart = (value, { max = 255, slash = false } = {}) => {
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
const cleanGithubConnection = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const token = cleanGithubPart(value.token, { max: 2048, slash: true });
    const repository = value.repository;
    if (!token || token.length < 8 || !repository || typeof repository !== 'object'
        || Array.isArray(repository)) return null;
    const owner = cleanGithubPart(repository.owner);
    const name = cleanGithubPart(repository.name);
    if (!owner || !name || owner === '.' || owner === '..' || name === '.' || name === '..') return null;
    const cleaned = { token, repository: { owner, name } };
    if (repository.id != null) {
        if (!Number.isSafeInteger(repository.id) || repository.id <= 0) return null;
        cleaned.repository.id = repository.id;
    }
    return cleaned;
};

// Credential fields are opt-in so GitHub settings backups keep their
// established credential-free contract. Manual file export always passes the
// API-key object (including an explicit null) and passes `githubConnection`
// only after the user selects the sensitive-file option.
const buildPayload = (settings, {
    extensionVersion = '', exportedAt, apiKeys, githubConnection,
} = {}) => {
    const payload = {
        kind: KIND,
        schemaVersion: SCHEMA_VERSION,
        exportedAt,
        extensionVersion,
        settings: pick(settings)
    };
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

const serialize = payload => `${JSON.stringify(payload, null, 2)}\n`;

const parse = text => {
    if (typeof text !== 'string') return { ok: false, reason: 'not-json' };
    if (BoundedText.encodedByteLength(text) > IMPORT_MAX_BYTES) {
        return { ok: false, reason: 'too-large' };
    }
    let parsed;
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
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== KIND) {
        return { ok: false, reason: 'wrong-kind' };
    }
    if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion > SCHEMA_VERSION) {
        return { ok: false, reason: 'newer-version' };
    }
    if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) {
        return { ok: false, reason: 'no-settings' };
    }
    const result = { ok: true, settings: pick(parsed.settings) };
    if (Object.hasOwn(parsed, 'apiKeys')) {
        const apiKeys = cleanApiKeys(parsed.apiKeys);
        if (!apiKeys) return { ok: false, reason: 'invalid-api-keys' };
        result.apiKeys = apiKeys;
    }
    if (Object.hasOwn(parsed, 'githubConnection')) {
        if (parsed.schemaVersion < 3) return { ok: false, reason: 'invalid-github-connection' };
        const githubConnection = cleanGithubConnection(parsed.githubConnection);
        if (!githubConnection) return { ok: false, reason: 'invalid-github-connection' };
        result.githubConnection = githubConnection;
    }
    return result;
};

// Export time and extension version are metadata, not part of the content
// identity used to skip an unchanged automatic backup.
const signature = settings => JSON.stringify(pick(settings));

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
