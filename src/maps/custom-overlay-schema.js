// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const CUSTOM_REGISTRY_KEY = 'bpbCustomMapOverlaysV1';
export const CUSTOM_PREFERENCES_KEY = 'bpbCustomMapOverlayPreferencesV1';
export const CUSTOM_LIMITS = Object.freeze({ sources: 20, active: 3, url: 4096, registry: 262144,
    metadata: 262144, raster: 4194304, mvt: 2097152, geojson: 5242880,
    features: 10000, vertices: 100000, rules: 16, zoom: 22, deadline: 15000 });
export const customId = value => typeof value === 'string' && /^custom:[0-9a-f-]{36}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function customUrl(value, tiled = false) {
    if (!text(value, CUSTOM_LIMITS.url)) return null;
    const tokens = [...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
    if (tiled ? !['z', 'x', 'y'].every(token => tokens.includes(token)) || tokens.some(token => !['z', 'x', 'y'].includes(token)) : tokens.length) return null;
    try {
        const parsed = new URL(value.replaceAll(/\{[zxy]\}/g, '0'));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
            || !parsed.hostname.includes('.') || /(?:^localhost$|\.localhost$|\.local$|\.internal$|\.test$|\.invalid$)/i.test(parsed.hostname)
            || /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.includes(':') || parsed.hostname.includes('[')) return null;
        return value;
    } catch { return null; }
}
export function customBounds(value) {
    if (value == null) return null;
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
        || value[0] < -180 || value[2] > 180 || value[0] >= value[2]
        || value[1] < -85.051129 || value[3] > 85.051129 || value[1] >= value[3]) throw new Error('Use west, south, east, north bounds within Web Mercator.');
    return [...value];
}
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
export function readCustomSource(value) {
    if (!object(value) || !customId(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1
        || !text(value.name, 80) || !value.name.trim() || !['raster', 'mvt', 'geojson'].includes(value.kind) || !object(value.source)) return null;
    try {
        const raw = value.source, source = {};
        if (value.kind === 'geojson') {
            if (!customUrl(raw.dataUrl)) return null;
            source.dataUrl = raw.dataUrl;
        } else {
            if (!Array.isArray(raw.tiles) || raw.tiles.length > 4 || raw.tiles.some(tile => !customUrl(tile, true))) return null;
            if (raw.metadataUrl != null && !customUrl(raw.metadataUrl)) return null;
            if (!raw.tiles.length && !raw.metadataUrl) return null;
            source.tiles = [...raw.tiles];
            if (raw.metadataUrl) source.metadataUrl = raw.metadataUrl;
            if (!['xyz', 'tms'].includes(raw.scheme) || !Number.isInteger(raw.minNativeZoom) || !Number.isInteger(raw.maxNativeZoom)
                || !finite(raw.minNativeZoom, 0, CUSTOM_LIMITS.zoom) || !finite(raw.maxNativeZoom, raw.minNativeZoom, CUSTOM_LIMITS.zoom)) return null;
            Object.assign(source, { scheme: raw.scheme, minNativeZoom: raw.minNativeZoom, maxNativeZoom: raw.maxNativeZoom,
                zoomOrigin: Object.fromEntries(['min', 'max'].map(key => [key, ['metadata', 'manual', 'default'].includes(raw.zoomOrigin?.[key]) ? raw.zoomOrigin[key] : 'default'])) });
            if (value.kind === 'raster') { if (![256, 512].includes(raw.tileSize)) return null; source.tileSize = raw.tileSize; }
        }
        source.bounds = customBounds(raw.bounds);
        const origins = value.approvedOrigins;
        if (!Array.isArray(origins) || origins.length > 4 || new Set(origins).size !== origins.length
            || origins.some(origin => !customUrl(origin) || new URL(origin).origin !== origin)) return null;
        const endpoints = value.kind === 'geojson' ? [source.dataUrl] : source.tiles;
        if (endpoints.some(endpoint => !origins.includes(new URL(endpoint).origin))) return null;
        const attribution = value.attribution || {};
        if (!text(attribution.text || '', 600) || attribution.url && !customUrl(attribution.url)) return null;
        const appearance = value.appearance;
        if (!object(appearance) || !finite(appearance.opacity, 0, 100) || !Array.isArray(appearance.rules) || appearance.rules.length > CUSTOM_LIMITS.rules) return null;
        const rules = [];
        for (const rule of appearance.rules) {
            if (!object(rule) || !['point', 'line', 'polygon'].includes(rule.geometry) || !color(rule.color)
                || !finite(rule.width ?? 2, .5, 12) || !finite(rule.radius ?? 5, 1, 16) || !finite(rule.fillOpacity ?? .3, 0, 1)) return null;
            if (value.kind === 'mvt' && (!text(rule.sourceLayer, 128) || !rule.sourceLayer)) return null;
            rules.push({ geometry: rule.geometry, color: rule.color, width: rule.width ?? 2, radius: rule.radius ?? 5,
                fillOpacity: rule.fillOpacity ?? .3, ...(value.kind === 'mvt' ? { sourceLayer: rule.sourceLayer } : {}) });
        }
        if (value.kind !== 'raster' && !rules.length || value.kind === 'raster' && rules.length) return null;
        return { id: value.id, revision: value.revision, name: value.name.trim(), kind: value.kind, source,
            approvedOrigins: [...origins], attribution: { text: attribution.text || '', ...(attribution.url ? { url: attribution.url } : {}) },
            appearance: { opacity: appearance.opacity, rules } };
    } catch { return null; }
}
export function readCustomRegistry(value) {
    if (value === undefined) return { schemaVersion: 1, revision: 0, sources: [] };
    if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.sources) || value.sources.length > CUSTOM_LIMITS.sources) return null;
    const sources = value.sources.map(readCustomSource);
    if (sources.some(source => !source) || new Set(sources.map(source => source.id)).size !== sources.length
        || new TextEncoder().encode(JSON.stringify(value)).length > CUSTOM_LIMITS.registry) return null;
    return { schemaVersion: 1, revision: value.revision, sources };
}
export function readCustomSelection(value) {
    if (!Array.isArray(value) || value.length > CUSTOM_LIMITS.active) return [];
    if (value.some(item => !customId(item?.id) || !Number.isSafeInteger(item.sourceRevision) || item.sourceRevision < 1)
        || new Set(value.map(item => item.id)).size !== value.length) return [];
    return value.map(item => ({ id: item.id, sourceRevision: item.sourceRevision, enabled: item.enabled === true }));
}
export const customOverlaySchema = Object.freeze({ limits: CUSTOM_LIMITS, source: readCustomSource,
    registry: readCustomRegistry, selection: readCustomSelection, url: customUrl });
