// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCustomRegistry } from './custom-overlay-schema.js';

// Definitions and opacity travel; local revisions, selections and previews do not.
export function readCustomLayerBackup(value) {
    if (!value || value.schemaVersion !== 1 || !value.preferences || typeof value.preferences !== 'object' || Array.isArray(value.preferences)) return null;
    const registry = readCustomRegistry({ schemaVersion: 1, revision: 0, sources: value.sources });
    if (!registry) return null;
    const preferences = {};
    for (const source of registry.sources) {
        const opacity = value.preferences[source.id] ?? source.appearance.opacity;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) return null;
        preferences[source.id] = opacity;
    }
    return { schemaVersion: 1, sources: registry.sources.map(source => ({ ...source, revision: 1 })), preferences };
}
export function customLayerBackup(snapshot) {
    const result = readCustomLayerBackup({ schemaVersion: 1, sources: snapshot.registry.sources, preferences: snapshot.preferences });
    if (!result) throw new Error('Saved custom layers could not be read.');
    return result;
}
