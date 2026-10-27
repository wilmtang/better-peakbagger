// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCustomRegistry, readCustomSource } from './custom-overlay-schema.js';
import { publicPrivateSource, readPrivateParameters } from './custom-overlay-private.js';
import { storageValue as StorageValue } from '../storage/storage-value.js';

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

// Manual settings files alone carry private definitions. Require an exact
// match to their public descriptors for source identity and map settings.
// Provider URLs are validated separately: descriptors intentionally hide them.
// Import never supplies provider permission or map approval.
export function readPrivateLayerFile(value, customLayers) {
    if (!Array.isArray(value) || !customLayers || value.length > customLayers.sources.length) return null;
    const ids = new Set(), result = [];
    try {
        for (const entry of value) {
            const source = readCustomSource(entry?.source);
            if (!source || source.privateRequests || ids.has(source.id)) return null;
            const descriptor = customLayers.sources.find(item => item.id === source.id);
            if (!descriptor?.privateRequests || !StorageValue.same({ ...publicPrivateSource(source), revision: 1 }, { ...descriptor, revision: 1 })) return null;
            const parameters = readPrivateParameters(entry.parameters);
            ids.add(source.id);result.push({ source, parameters });
        }
        return result;
    } catch { return null; }
}
