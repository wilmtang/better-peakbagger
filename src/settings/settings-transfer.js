// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure settings backup payload helpers.

import { settingsSchema as Schema } from './settings-schema.js';
import { imgbbClient as ImgbbClient } from '../photos/imgbb-client.js';

const KIND = 'better-peakbagger-settings';
const SCHEMA_VERSION = 2;
const BACKUP_PATH = 'settings.json';
const API_KEY_NAMES = Object.freeze(['imgbb']);

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

// `apiKeys` is opt-in so GitHub settings backups keep their established
// credential-free contract. Manual file export passes the complete object,
// including an explicit null when no key is configured.
const buildPayload = (settings, { extensionVersion = '', exportedAt, apiKeys } = {}) => {
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
    return payload;
};

const serialize = payload => `${JSON.stringify(payload, null, 2)}\n`;

const parse = text => {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'not-json' };
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
    buildPayload,
    serialize,
    parse,
    signature
};
