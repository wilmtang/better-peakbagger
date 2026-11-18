// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCustomRegistry, readCustomSource, type CustomSource } from './custom-overlay-schema.ts';
import { publicPrivateSource, readPrivateParameters, type PrivateParameter } from './custom-overlay-private.ts';
import { storageValue as StorageValue } from '../storage/storage-value.ts';

export interface CustomLayerBackup {
    schemaVersion: 1;
    sources: CustomSource[];
    preferences: Record<string, number>;
}

export interface CustomLayerSnapshot {
    registry: { sources: readonly unknown[] };
    preferences?: Record<string, unknown>;
}

export interface PrivateLayerEntry {
    source: CustomSource;
    parameters: PrivateParameter[];
}

// Definitions and opacity travel; local revisions, selections and previews do not.
export function readCustomLayerBackup(value: unknown): CustomLayerBackup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as { schemaVersion?: unknown; preferences?: unknown; sources?: unknown };
    if (record.schemaVersion !== 1 || !record.preferences || typeof record.preferences !== 'object' || Array.isArray(record.preferences)) return null;
    const registry = readCustomRegistry({ schemaVersion: 1, revision: 0, sources: record.sources });
    if (!registry) return null;
    const rawPreferences = record.preferences as Record<string, unknown>;
    const preferences: Record<string, number> = {};
    for (const source of registry.sources) {
        const opacity = rawPreferences[source.id] ?? source.appearance.opacity;
        if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 100) return null;
        preferences[source.id] = opacity;
    }
    return { schemaVersion: 1, sources: registry.sources.map(source => ({ ...source, revision: 1 })), preferences };
}

export function customLayerBackup(snapshot: CustomLayerSnapshot): CustomLayerBackup {
    const result = readCustomLayerBackup({ schemaVersion: 1, sources: snapshot.registry.sources, preferences: snapshot.preferences });
    if (!result) throw new Error('Saved custom layers could not be read.');
    return result;
}

// Manual settings files alone carry private definitions. Require an exact
// match to their public descriptors for source identity and map settings.
// Provider URLs are validated separately: descriptors intentionally hide them.
// Import never supplies provider permission or map approval.
export function readPrivateLayerFile(
    value: unknown,
    customLayers?: { sources: readonly CustomSource[] } | null,
): PrivateLayerEntry[] | null {
    if (!Array.isArray(value) || !customLayers || value.length > customLayers.sources.length) return null;
    const ids = new Set<string>();
    const result: PrivateLayerEntry[] = [];
    try {
        for (const entry of value) {
            const candidate = entry as { source?: unknown; parameters?: unknown } | null | undefined;
            const source = readCustomSource(candidate?.source);
            if (!source || source.privateRequests || ids.has(source.id)) return null;
            const descriptor = customLayers.sources.find(item => item.id === source.id);
            if (!descriptor?.privateRequests || !StorageValue.same({ ...publicPrivateSource(source as Parameters<typeof publicPrivateSource>[0]), revision: 1 }, { ...descriptor, revision: 1 })) return null;
            const parameters = readPrivateParameters(candidate?.parameters);
            ids.add(source.id);
            result.push({ source, parameters });
        }
        return result;
    } catch { return null; }
}
