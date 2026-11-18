// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    CUSTOM_LIMITS,
    customUrl,
    readCustomSource,
    type CustomGeometryKind,
    type CustomManualField,
    type CustomSource,
    type CustomSourceKind,
    type CustomStyleRule,
    type CustomZoomOriginSource,
} from './custom-overlay-schema.ts';

export interface CustomSourceUrlInference {
    format: 'template' | 'tilejson';
    kind: CustomSourceKind | null;
}

export interface ResolveCustomSourceOptions {
    manualFields?: readonly CustomManualField[];
    detectKind?: boolean;
    styleAuto?: boolean;
    inspect?: boolean;
    refresh?: unknown;
}

export interface ResolvedCustomSource {
    source: CustomSource;
    origins: string[];
    layers: string[];
}

// URL hints are local only: never search for metadata or sample arbitrary tiles.
export function inferCustomSourceUrl(value: string): CustomSourceUrlInference | null {
    try {
        const template = /\{[zxy]\}/.test(value);
        if (!customUrl(value, template)) return null;
        const path = new URL(value).pathname.toLowerCase();
        return {
            format: template ? 'template' : 'tilejson',
            kind: template
                ? /\.(?:mvt|pbf)$/.test(path) ? 'mvt' : /\.(?:png|jpe?g|webp)$/.test(path) ? 'raster' : null
                : /\.geojson$/.test(path) ? 'geojson' : null,
        };
    } catch { return null; }
}

export const defaultCustomRules = (
    sourceLayer = '',
    geometries: readonly CustomGeometryKind[] = ['point', 'line', 'polygon'],
): CustomStyleRule[] => geometries.map(geometry => ({
    sourceLayer,
    geometry,
    color: '#26734d',
    width: 2,
    radius: 5,
    fillOpacity: .3,
}));

// Shared by the CORS client and Settings-only private check. Only bounded source
// fields are returned; arbitrary provider properties are never forwarded.
export function resolveCustomSourceDocument(
    input: CustomSource,
    data: unknown,
    options: ResolveCustomSourceOptions = {},
): ResolvedCustomSource {
    const manual = new Set<string>(options.manualFields || input.source.manualFields || []);
    const automatic = options.detectKind === true;
    if (!data || typeof data !== 'object' || Array.isArray(data) || (data as { version?: unknown }).version === 8) {
        throw new Error('Use TileJSON, GeoJSON or a tile template; full map styles are unsupported.');
    }
    const rawData = data as Record<string, unknown>;
    if (rawData.type === 'FeatureCollection' && (automatic || input.kind === 'geojson')) {
        if (rawData.crs || !Array.isArray(rawData.features) || rawData.features.length > CUSTOM_LIMITS.features) {
            throw new Error('Invalid or oversized GeoJSON.');
        }
        const geometries = [...new Set(rawData.features.map((feature): CustomGeometryKind | null => {
            const type = (feature as { geometry?: { type?: unknown } } | null | undefined)?.geometry?.type;
            if (typeof type !== 'string') return null;
            return /^(?:Multi)?Point$/.test(type) ? 'point'
                : /^(?:Multi)?LineString$/.test(type) ? 'line'
                    : /^(?:Multi)?Polygon$/.test(type) ? 'polygon' : null;
        }).filter((entry): entry is CustomGeometryKind => entry !== null))];
        const dataUrl = input.kind === 'geojson' ? input.source.dataUrl : input.source.metadataUrl;
        const source = readCustomSource({
            ...input,
            kind: 'geojson',
            source: {
                dataUrl,
                bounds: !manual.has('bounds') && (rawData.bbox as { length?: unknown } | null | undefined)?.length === 4
                    ? rawData.bbox : input.source.bounds,
                ...(input.source.manualFields && { manualFields: input.source.manualFields }),
            },
            appearance: {
                ...input.appearance,
                rules: options.styleAuto || !input.appearance.rules.length
                    ? defaultCustomRules('', geometries.length ? geometries : undefined) : input.appearance.rules,
            },
        });
        if (!source) throw new Error('Invalid GeoJSON source settings.');
        return { source, origins: [], layers: [] };
    }
    if (input.kind === 'geojson' && !automatic) throw new Error('Use a GeoJSON FeatureCollection for this source type.');
    if (typeof rawData.tilejson !== 'string' || !/^([23])\./.test(rawData.tilejson)
        || !Array.isArray(rawData.tiles) || !rawData.tiles.length || rawData.tiles.length > 4
        || rawData.tiles.some(url => !customUrl(url, true))) {
        throw new Error('Use a TileJSON 2/3 document or GeoJSON FeatureCollection.');
    }
    const tiles = rawData.tiles as string[];
    if (rawData.vector_layers != null && (!Array.isArray(rawData.vector_layers) || rawData.vector_layers.length > 32
        || rawData.vector_layers.some(layer => {
            const candidate = layer as { id?: unknown } | null | undefined;
            return typeof candidate?.id !== 'string' || !candidate.id || candidate.id.length > 128 || /[\u0000-\u001f\u007f]/.test(candidate.id);
        }))) {
        throw new Error('Invalid vector source layers.');
    }
    const layers = [...new Set(((rawData.vector_layers as Array<{ id: string }> | undefined) || []).map(layer => layer.id))];
    let kind: CustomSourceKind | null = input.kind;
    if (automatic) {
        const hints = [...new Set(tiles.map(url => inferCustomSourceUrl(url)?.kind).filter((entry): entry is CustomSourceKind => Boolean(entry)))];
        const format = typeof rawData.format === 'string' ? rawData.format : '';
        kind = rawData.vector_layers != null || /^(?:pbf|mvt)$/.test(format) ? 'mvt'
            : /^(?:png|jpe?g|webp)$/.test(format) ? 'raster' : hints.length === 1 ? hints[0] : null;
        if (!kind) throw new Error('The source does not identify its tile type. Choose Source type in Advanced.');
    }
    const origins = [...new Set(tiles.map(url => new URL(url).origin))];
    const source: Record<string, unknown> = { ...input.source, tiles };
    if (!manual.has('scheme')) source.scheme = rawData.scheme || 'xyz';
    if (!manual.has('tile-size') && kind === 'raster' && (rawData.tileSize === 256 || rawData.tileSize === 512)) source.tileSize = rawData.tileSize;
    if (kind === 'raster') source.tileSize ??= 256;
    const maxDefault = rawData.tilejson.startsWith('3.') ? 30 : 22;
    source.metadataZoom = {
        min: rawData.minzoom ?? 0,
        max: rawData.maxzoom ?? maxDefault,
        minDeclared: rawData.minzoom != null,
        maxDeclared: rawData.maxzoom != null,
    };
    let zoomOrigin = input.kind !== 'geojson' ? input.source.zoomOrigin : undefined;
    for (const [field, key] of [['minNativeZoom', 'min'], ['maxNativeZoom', 'max']] as const) {
        const rawZoom = rawData[`${key}zoom`];
        const value = rawZoom ?? (key === 'min' ? 0 : maxDefault);
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 30) throw new Error('Invalid source zoom range.');
        if (zoomOrigin?.[key] !== 'manual') {
            source[field] = Math.min(CUSTOM_LIMITS.zoom, value);
            zoomOrigin = { ...zoomOrigin, [key]: rawZoom == null ? 'default' : 'metadata' } as {
                min: CustomZoomOriginSource;
                max: CustomZoomOriginSource;
            };
        }
    }
    if (zoomOrigin) source.zoomOrigin = zoomOrigin;
    const minZoom = rawData.minzoom as number | null | undefined;
    const maxZoom = rawData.maxzoom as number | null | undefined;
    if (minZoom != null && minZoom > CUSTOM_LIMITS.zoom || minZoom != null && maxZoom != null && minZoom > maxZoom) {
        throw new Error('Source zoom range is unsupported.');
    }
    if (!manual.has('bounds') && rawData.bounds) source.bounds = rawData.bounds;
    let rules = input.appearance.rules;
    if (kind === 'raster') rules = [];
    else if (options.styleAuto || !rules.length) rules = defaultCustomRules(layers.length === 1 ? layers[0] : '__choose_layer__');
    else if (layers.length === 1) rules = rules.map(rule => !rule.sourceLayer || rule.sourceLayer === '__choose_layer__' ? { ...rule, sourceLayer: layers[0] } : rule);
    const normalized = readCustomSource({
        ...input,
        kind,
        source,
        approvedOrigins: [...new Set([...input.approvedOrigins, ...origins])],
        appearance: { ...input.appearance, rules },
    });
    if (!normalized) throw new Error('Invalid source metadata.');
    return { source: normalized, origins: origins.filter(origin => !input.approvedOrigins.includes(origin)), layers };
}
