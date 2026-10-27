// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUSTOM_LIMITS, customUrl, readCustomSource } from './custom-overlay-schema.js';

// URL hints are local only: never search for metadata or sample arbitrary tiles.
export function inferCustomSourceUrl(value) {
    try {
        const template = /\{[zxy]\}/.test(value);
        if (!customUrl(value, template)) return null;
        const path = new URL(value).pathname.toLowerCase();
        return { format: template ? 'template' : 'tilejson', kind: template
            ? /\.(?:mvt|pbf)$/.test(path) ? 'mvt' : /\.(?:png|jpe?g|webp)$/.test(path) ? 'raster' : null
            : /\.geojson$/.test(path) ? 'geojson' : null };
    } catch { return null; }
}
export const defaultCustomRules = (sourceLayer = '', geometries = ['point', 'line', 'polygon']) => geometries.map(geometry => ({
    sourceLayer, geometry, color: '#26734d', width: 2, radius: 5, fillOpacity: .3,
}));

// Shared by the CORS client and Settings-only private check. Only bounded source
// fields are returned; arbitrary provider properties are never forwarded.
export function resolveCustomSourceDocument(input, data, options = {}) {
    const manual = new Set(options.manualFields || []), automatic = options.detectKind === true;
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.version === 8) throw new Error('Use TileJSON, GeoJSON or a tile template; full map styles are unsupported.');
    if (data.type === 'FeatureCollection' && (automatic || input.kind === 'geojson')) {
        if (data.crs || !Array.isArray(data.features) || data.features.length > CUSTOM_LIMITS.features) throw new Error('Invalid or oversized GeoJSON.');
        const geometries = [...new Set(data.features.map(feature => {
            const type = feature?.geometry?.type;
            return /^(?:Multi)?Point$/.test(type) ? 'point' : /^(?:Multi)?LineString$/.test(type) ? 'line' : /^(?:Multi)?Polygon$/.test(type) ? 'polygon' : null;
        }).filter(Boolean))];
        const source = readCustomSource({ ...input, kind: 'geojson', source: {
            dataUrl: input.source.dataUrl || input.source.metadataUrl,
            bounds: !manual.has('bounds') && data.bbox?.length === 4 ? data.bbox : input.source.bounds,
        }, appearance: { ...input.appearance, rules: options.styleAuto || !input.appearance.rules.length
            ? defaultCustomRules('', geometries.length ? geometries : undefined) : input.appearance.rules } });
        if (!source) throw new Error('Invalid GeoJSON source settings.');
        return { source, origins: [], layers: [] };
    }
    if (input.kind === 'geojson' && !automatic) throw new Error('Use a GeoJSON FeatureCollection for this source type.');
    if (!/^([23])\./.test(data.tilejson) || !Array.isArray(data.tiles) || !data.tiles.length || data.tiles.length > 4
        || data.tiles.some(url => !customUrl(url, true))) throw new Error('Use a TileJSON 2/3 document or GeoJSON FeatureCollection.');
    if (data.vector_layers != null && (!Array.isArray(data.vector_layers) || data.vector_layers.length > 32
        || data.vector_layers.some(layer => typeof layer?.id !== 'string' || !layer.id || layer.id.length > 128 || /[\u0000-\u001f\u007f]/.test(layer.id)))) throw new Error('Invalid vector source layers.');
    const layers = [...new Set((data.vector_layers || []).map(layer => layer.id))];
    let kind = input.kind;
    if (automatic) {
        const hints = [...new Set(data.tiles.map(url => inferCustomSourceUrl(url)?.kind).filter(Boolean))];
        kind = data.vector_layers != null || /^(?:pbf|mvt)$/.test(data.format) ? 'mvt'
            : /^(?:png|jpe?g|webp)$/.test(data.format) ? 'raster' : hints.length === 1 ? hints[0] : null;
        if (!kind) throw new Error('The source does not identify its tile type. Choose Source type in Advanced.');
    }
    const origins = [...new Set(data.tiles.map(url => new URL(url).origin))], source = { ...input.source, tiles: data.tiles };
    if (!manual.has('scheme')) source.scheme = data.scheme || 'xyz';
    if (!manual.has('tile-size') && kind === 'raster' && [256, 512].includes(data.tileSize)) source.tileSize = data.tileSize;
    if (kind === 'raster') source.tileSize ??= 256;
    const maxDefault = data.tilejson.startsWith('3.') ? 30 : 22;
    source.metadataZoom = { min: data.minzoom ?? 0, max: data.maxzoom ?? maxDefault, minDeclared: data.minzoom != null, maxDeclared: data.maxzoom != null };
    for (const [field, key] of [['minNativeZoom', 'min'], ['maxNativeZoom', 'max']]) {
        const value = data[`${key}zoom`] ?? (key === 'min' ? 0 : maxDefault);
        if (!Number.isInteger(value) || value < 0 || value > 30) throw new Error('Invalid source zoom range.');
        if (source.zoomOrigin?.[key] !== 'manual') {
            source[field] = Math.min(CUSTOM_LIMITS.zoom, value);
            source.zoomOrigin = { ...source.zoomOrigin, [key]: data[`${key}zoom`] == null ? 'default' : 'metadata' };
        }
    }
    if (data.minzoom > CUSTOM_LIMITS.zoom || data.minzoom > data.maxzoom) throw new Error('Source zoom range is unsupported.');
    if (!manual.has('bounds') && data.bounds) source.bounds = data.bounds;
    let rules = input.appearance.rules;
    if (kind === 'raster') rules = [];
    else if (options.styleAuto || !rules.length) rules = defaultCustomRules(layers.length === 1 ? layers[0] : '__choose_layer__');
    else if (layers.length === 1) rules = rules.map(rule => !rule.sourceLayer || rule.sourceLayer === '__choose_layer__' ? { ...rule, sourceLayer: layers[0] } : rule);
    const normalized = readCustomSource({ ...input, kind, source, approvedOrigins: [...new Set([...input.approvedOrigins, ...origins])], appearance: { ...input.appearance, rules } });
    if (!normalized) throw new Error('Invalid source metadata.');
    return { source: normalized, origins: origins.filter(origin => !input.approvedOrigins.includes(origin)), layers };
}
