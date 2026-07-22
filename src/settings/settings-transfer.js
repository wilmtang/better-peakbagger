// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure settings backup payload helpers.

import { settingsSchema as Schema } from './settings-schema.js';

const KIND = 'better-peakbagger-settings';
const SCHEMA_VERSION = 1;
const BACKUP_PATH = 'settings.json';

// Schema.clean() intentionally preserves unknown keys. Transfer payloads do
// not: they contain only the settings this extension version understands.
const pick = settings => {
    const cleaned = Schema.clean(settings);
    const picked = {};
    for (const key of Object.keys(Schema.DEFAULTS)) picked[key] = cleaned[key];
    return picked;
};

const buildPayload = (settings, { extensionVersion = '', exportedAt }) => ({
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    extensionVersion,
    settings: pick(settings)
});

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
    return { ok: true, settings: pick(parsed.settings) };
};

// Export time and extension version are metadata, not part of the content
// identity used to skip an unchanged automatic backup.
const signature = settings => JSON.stringify(pick(settings));

export const settingsTransfer = {
    KIND,
    SCHEMA_VERSION,
    BACKUP_PATH,
    buildPayload,
    serialize,
    parse,
    signature
};
