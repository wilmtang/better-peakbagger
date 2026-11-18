// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const CUSTOM_REGISTRY_KEY = 'bpbCustomMapOverlaysV1';
export const CUSTOM_PREFERENCES_KEY = 'bpbCustomMapOverlayPreferencesV1';
export const CUSTOM_LIMITS = Object.freeze({
    sources: 20,
    active: 3,
    url: 4096,
    registry: 262144,
    metadata: 262144,
    raster: 4194304,
    mvt: 2097152,
    geojson: 5242880,
    features: 10000,
    vertices: 100000,
    rules: 16,
    zoom: 22,
    deadline: 15000,
});

export type CustomSourceKind = 'raster' | 'mvt' | 'geojson';
export type CustomTileScheme = 'xyz' | 'tms';
export type CustomZoomOriginSource = 'metadata' | 'manual' | 'default';
export type CustomManualField = 'scheme' | 'tile-size' | 'bounds';
export type CustomGeometryKind = 'point' | 'line' | 'polygon';
export type CustomBounds = [number, number, number, number];

export interface CustomZoomOrigin {
    min: CustomZoomOriginSource;
    max: CustomZoomOriginSource;
}

export interface CustomMetadataZoom {
    min: number;
    max: number;
    minDeclared: boolean;
    maxDeclared: boolean;
}

export interface CustomStyleRule {
    geometry: CustomGeometryKind;
    color: string;
    width: number;
    radius: number;
    fillOpacity: number;
    sourceLayer?: string;
}

export interface CustomAttribution {
    text: string;
    url?: string;
}

export interface CustomAppearance {
    opacity: number;
    rules: CustomStyleRule[];
}

export interface CustomGeoJsonSourceConfig {
    dataUrl: string;
    bounds: CustomBounds | null;
    manualFields?: CustomManualField[];
}

export interface CustomRasterSourceConfig {
    tiles: string[];
    metadataUrl?: string;
    scheme: CustomTileScheme;
    minNativeZoom: number;
    maxNativeZoom: number;
    zoomOrigin: CustomZoomOrigin;
    metadataZoom?: CustomMetadataZoom;
    tileSize: 256 | 512;
    bounds: CustomBounds | null;
    manualFields?: CustomManualField[];
}

export interface CustomMvtSourceConfig {
    tiles: string[];
    metadataUrl?: string;
    scheme: CustomTileScheme;
    minNativeZoom: number;
    maxNativeZoom: number;
    zoomOrigin: CustomZoomOrigin;
    metadataZoom?: CustomMetadataZoom;
    bounds: CustomBounds | null;
    manualFields?: CustomManualField[];
}

interface CustomSourceBase {
    id: string;
    revision: number;
    name: string;
    privateRequests?: true;
    approvedOrigins: string[];
    attribution: CustomAttribution;
    appearance: CustomAppearance;
}

export interface CustomGeoJsonSource extends CustomSourceBase {
    kind: 'geojson';
    source: CustomGeoJsonSourceConfig;
}

export interface CustomRasterSource extends CustomSourceBase {
    kind: 'raster';
    source: CustomRasterSourceConfig;
}

export interface CustomMvtSource extends CustomSourceBase {
    kind: 'mvt';
    source: CustomMvtSourceConfig;
}

export type CustomTiledSource = CustomRasterSource | CustomMvtSource;
export type CustomSource = CustomGeoJsonSource | CustomRasterSource | CustomMvtSource;

export interface CustomRegistry {
    schemaVersion: 1;
    revision: number;
    sources: CustomSource[];
    generation?: number;
}

export interface CustomSelectionItem {
    id: string;
    sourceRevision: number;
    enabled: boolean;
}

export const customId = (value: unknown): value is string =>
    typeof value === 'string' && /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const finite = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export function customUrl(value: unknown, tiled = false): string | null {
    if (!text(value, CUSTOM_LIMITS.url)) return null;
    const tokens = [...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
    if (tiled ? !['z', 'x', 'y'].every(token => tokens.includes(token)) || tokens.some(token => !['z', 'x', 'y'].includes(token)) : tokens.length) return null;
    try {
        const parsed = new URL(value.replaceAll(/\{[zxy]\}/g, '0'));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
            || !parsed.hostname.includes('.') || parsed.hostname.endsWith('.') || /(?:^localhost$|\.localhost$|\.local$|\.internal$|\.test$|\.invalid$)/i.test(parsed.hostname)
            || /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.includes(':') || parsed.hostname.includes('[')) return null;
        return value;
    } catch { return null; }
}

export function customBounds(value: unknown): CustomBounds | null {
    if (value == null) return null;
    if (!Array.isArray(value) || value.length !== 4
        || !value.every((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
        || value[0] < -180 || value[2] > 180 || value[0] >= value[2]
        || value[1] < -85.051129 || value[3] > 85.051129 || value[1] >= value[3]) throw new Error('Use west, south, east, north bounds within Web Mercator.');
    return [value[0], value[1], value[2], value[3]];
}

const color = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);

export function readCustomSource(value: unknown): CustomSource | null {
    if (!object(value) || !customId(value.id) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
        || !text(value.name, 80) || !value.name.trim()
        || (value.kind !== 'raster' && value.kind !== 'mvt' && value.kind !== 'geojson')
        || !object(value.source)) return null;
    try {
        const id = value.id;
        const revision = value.revision;
        const name = value.name.trim();
        const kind = value.kind;
        const raw = value.source;
        const source: Record<string, unknown> = {};
        let endpoints: string[];

        if (kind === 'geojson') {
            const dataUrl = customUrl(raw.dataUrl);
            if (!dataUrl) return null;
            source.dataUrl = dataUrl;
            endpoints = [dataUrl];
        } else {
            if (!Array.isArray(raw.tiles) || raw.tiles.length > 4) return null;
            const tiles: string[] = [];
            for (const tile of raw.tiles) {
                const validTile = customUrl(tile, true);
                if (!validTile) return null;
                tiles.push(validTile);
            }
            let metadataUrl: string | undefined;
            if (raw.metadataUrl != null) {
                const validMetadataUrl = customUrl(raw.metadataUrl);
                if (!validMetadataUrl) return null;
                metadataUrl = validMetadataUrl;
            }
            if (!tiles.length && !metadataUrl) return null;
            source.tiles = tiles;
            if (metadataUrl) source.metadataUrl = metadataUrl;
            if ((raw.scheme !== 'xyz' && raw.scheme !== 'tms')
                || typeof raw.minNativeZoom !== 'number' || typeof raw.maxNativeZoom !== 'number'
                || !Number.isInteger(raw.minNativeZoom) || !Number.isInteger(raw.maxNativeZoom)
                || !finite(raw.minNativeZoom, 0, CUSTOM_LIMITS.zoom) || !finite(raw.maxNativeZoom, raw.minNativeZoom, CUSTOM_LIMITS.zoom)) return null;
            const rawZoomOrigin = object(raw.zoomOrigin) ? raw.zoomOrigin : null;
            const zoomOriginEntry = (key: 'min' | 'max'): CustomZoomOriginSource => {
                const entry = rawZoomOrigin?.[key];
                return entry === 'metadata' || entry === 'manual' || entry === 'default' ? entry : 'default';
            };
            Object.assign(source, {
                scheme: raw.scheme,
                minNativeZoom: raw.minNativeZoom,
                maxNativeZoom: raw.maxNativeZoom,
                zoomOrigin: { min: zoomOriginEntry('min'), max: zoomOriginEntry('max') },
            });
            if (raw.metadataZoom != null) {
                if (typeof raw.metadataZoom !== 'object') return null;
                const rawMetadataZoom = raw.metadataZoom as { min?: unknown; max?: unknown; minDeclared?: unknown; maxDeclared?: unknown };
                if (typeof rawMetadataZoom.min !== 'number' || typeof rawMetadataZoom.max !== 'number'
                    || !Number.isInteger(rawMetadataZoom.min) || !Number.isInteger(rawMetadataZoom.max)
                    || !finite(rawMetadataZoom.min, 0, 30) || !finite(rawMetadataZoom.max, rawMetadataZoom.min, 30)) return null;
                source.metadataZoom = {
                    min: rawMetadataZoom.min,
                    max: rawMetadataZoom.max,
                    minDeclared: rawMetadataZoom.minDeclared === true,
                    maxDeclared: rawMetadataZoom.maxDeclared === true,
                };
            }
            if (kind === 'raster') {
                if (raw.tileSize !== 256 && raw.tileSize !== 512) return null;
                source.tileSize = raw.tileSize;
            }
            endpoints = [...tiles, ...(metadataUrl ? [metadataUrl] : [])];
        }

        source.bounds = customBounds(raw.bounds);
        if (raw.manualFields != null) {
            if (!Array.isArray(raw.manualFields) || raw.manualFields.length > 3 || new Set(raw.manualFields).size !== raw.manualFields.length) return null;
            const manualFields: CustomManualField[] = [];
            for (const key of raw.manualFields) {
                if (key !== 'scheme' && key !== 'tile-size' && key !== 'bounds') return null;
                manualFields.push(key);
            }
            source.manualFields = manualFields;
        }

        const rawOrigins = value.approvedOrigins;
        if (!Array.isArray(rawOrigins) || rawOrigins.length > 4 || new Set(rawOrigins).size !== rawOrigins.length) return null;
        const origins: string[] = [];
        for (const origin of rawOrigins) {
            const validOrigin = customUrl(origin);
            if (!validOrigin || new URL(validOrigin).origin !== validOrigin) return null;
            origins.push(validOrigin);
        }
        if (endpoints.some(endpoint => !origins.includes(new URL(endpoint).origin))) return null;
        if (value.privateRequests === true && (origins.length !== 1 || origins[0] !== 'https://relay.bpb.example'
            || endpoints.some(endpoint => {
                const prefix = `https://relay.bpb.example/${id}/`;
                return !endpoint.startsWith(prefix) || !/^[1-9]\d*\/(?:metadata|data|tile\/\{z\}\/\{x\}\/\{y\})$/.test(endpoint.slice(prefix.length));
            }))) return null;

        const rawAttribution = (value.attribution && typeof value.attribution === 'object' ? value.attribution : {}) as Record<string, unknown>;
        const attributionText = (rawAttribution.text as unknown) || '';
        if (!text(attributionText, 600)) return null;
        const attributionUrl = rawAttribution.url ? customUrl(rawAttribution.url) : undefined;
        if (rawAttribution.url && !attributionUrl) return null;

        const appearance = value.appearance;
        if (!object(appearance) || !finite(appearance.opacity, 0, 100) || !Array.isArray(appearance.rules) || appearance.rules.length > CUSTOM_LIMITS.rules) return null;
        const rules: CustomStyleRule[] = [];
        for (const rule of appearance.rules) {
            if (!object(rule) || (rule.geometry !== 'point' && rule.geometry !== 'line' && rule.geometry !== 'polygon') || !color(rule.color)) return null;
            const width = rule.width ?? 2;
            const radius = rule.radius ?? 5;
            const fillOpacity = rule.fillOpacity ?? .3;
            if (!finite(width, .5, 12) || !finite(radius, 1, 16) || !finite(fillOpacity, 0, 1)) return null;
            if (kind === 'mvt' && (!text(rule.sourceLayer, 128) || !rule.sourceLayer)) return null;
            rules.push({
                geometry: rule.geometry,
                color: rule.color,
                width,
                radius,
                fillOpacity,
                ...(kind === 'mvt' ? { sourceLayer: rule.sourceLayer as string } : {}),
            });
        }
        if (kind !== 'raster' && !rules.length || kind === 'raster' && rules.length) return null;

        const normalizedBase = {
            id,
            revision,
            name,
            ...(value.privateRequests === true ? { privateRequests: true as const } : {}),
            approvedOrigins: origins,
            attribution: { text: attributionText, ...(attributionUrl ? { url: attributionUrl } : {}) },
            appearance: { opacity: appearance.opacity, rules },
        };
        if (kind === 'geojson') return { ...normalizedBase, kind, source: source as unknown as CustomGeoJsonSourceConfig };
        if (kind === 'raster') return { ...normalizedBase, kind, source: source as unknown as CustomRasterSourceConfig };
        return { ...normalizedBase, kind, source: source as unknown as CustomMvtSourceConfig };
    } catch { return null; }
}

export function readCustomRegistry(value: unknown): CustomRegistry | null {
    if (value === undefined) return { schemaVersion: 1, revision: 0, sources: [] };
    if (!object(value) || value.schemaVersion !== 1 || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.sources) || value.sources.length > CUSTOM_LIMITS.sources) return null;
    const sources: CustomSource[] = [];
    for (const item of value.sources) {
        const source = readCustomSource(item);
        if (!source) return null;
        sources.push(source);
    }
    if (new Set(sources.map(source => source.id)).size !== sources.length
        || new TextEncoder().encode(JSON.stringify(value)).length > CUSTOM_LIMITS.registry) return null;
    if (value.generation != null && (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 0)) return null;
    return {
        schemaVersion: 1,
        revision: value.revision,
        sources,
        ...(value.generation == null ? {} : { generation: value.generation as number }),
    };
}

export function readCustomSelection(value: unknown): CustomSelectionItem[] {
    if (!Array.isArray(value) || value.length > CUSTOM_LIMITS.active) return [];
    const result: CustomSelectionItem[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const candidate = item as { id?: unknown; sourceRevision?: unknown; enabled?: unknown } | null | undefined;
        if (!customId(candidate?.id) || typeof candidate?.sourceRevision !== 'number'
            || !Number.isSafeInteger(candidate.sourceRevision) || candidate.sourceRevision < 1
            || seen.has(candidate.id)) return [];
        seen.add(candidate.id);
        result.push({ id: candidate.id, sourceRevision: candidate.sourceRevision, enabled: candidate.enabled === true });
    }
    return result;
}

export const customOverlaySchema = Object.freeze({
    limits: CUSTOM_LIMITS,
    source: readCustomSource,
    registry: readCustomRegistry,
    selection: readCustomSelection,
    url: customUrl,
});
