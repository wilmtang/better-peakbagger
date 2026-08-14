// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — bounded OpenFreeMap style acquisition and normalization.

import { requestDeadline as Deadline } from '../net/request-deadline.js';
import { boundedText as BoundedText } from '../net/bounded-text.js';

const DEFAULT_TIMEOUT_MS = 10000;
const STYLE_MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER_ORIGIN = 'https://tiles.openfreemap.org';
const MAX_SOURCES = 16;
const MAX_LAYERS = 512;
const MAX_URL_LENGTH = 4096;
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_TYPES = new Set(['vector', 'raster']);
const LAYER_TYPES = new Set([
    'background', 'fill', 'line', 'symbol', 'circle', 'heatmap',
    'fill-extrusion', 'raster', 'hillshade',
]);
const STYLE_STRUCTURE_LIMITS = Object.freeze({
    maxDepth: 32,
    maxNodes: 250000,
    maxArrayItems: MAX_LAYERS,
    maxObjectKeys: 2048,
    maxStringChars: MAX_URL_LENGTH,
});

const validId = value => typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && ID_PATTERN.test(value);

const providerUrl = (value, { templates = [] } = {}) => {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.origin !== PROVIDER_ORIGIN || url.protocol !== 'https:'
        || url.username || url.password || url.hash) return null;
    if (!templates.every(template => value.includes(`{${template}}`))) return null;
    return value;
};

const finiteZoom = value => Number.isFinite(value) && value >= 0 && value <= 24 ? value : null;

const normalizeSource = source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || !SOURCE_TYPES.has(source.type)) return null;
    const normalized = { type: source.type };
    if (source.url != null) {
        const url = providerUrl(source.url);
        if (!url) return null;
        normalized.url = url;
    }
    if (source.tiles != null) {
        if (!Array.isArray(source.tiles) || source.tiles.length < 1 || source.tiles.length > 8) return null;
        normalized.tiles = source.tiles.map(tile => providerUrl(tile, { templates: ['z', 'x', 'y'] }));
        if (normalized.tiles.some(tile => !tile)) return null;
    }
    if (!normalized.url && !normalized.tiles) return null;
    for (const key of ['minzoom', 'maxzoom']) {
        if (source[key] != null) {
            const zoom = finiteZoom(source[key]);
            if (zoom == null) return null;
            normalized[key] = zoom;
        }
    }
    if (normalized.minzoom != null && normalized.maxzoom != null
        && normalized.minzoom > normalized.maxzoom) return null;
    if (source.tileSize != null) {
        if (!Number.isInteger(source.tileSize) || source.tileSize < 128 || source.tileSize > 1024) return null;
        normalized.tileSize = source.tileSize;
    }
    if (source.scheme != null) {
        if (source.scheme !== 'xyz' && source.scheme !== 'tms') return null;
        normalized.scheme = source.scheme;
    }
    if (source.attribution != null) {
        if (typeof source.attribution !== 'string' || source.attribution.length > 2048) return null;
        normalized.attribution = source.attribution;
    }
    if (source.bounds != null) {
        if (!Array.isArray(source.bounds) || source.bounds.length !== 4
            || !source.bounds.every(Number.isFinite)) return null;
        normalized.bounds = [...source.bounds];
    }
    return normalized;
};

const normalizeLayer = (layer, sources) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)
        || !validId(layer.id) || !LAYER_TYPES.has(layer.type)) return null;
    const requiresSource = layer.type !== 'background';
    if (requiresSource && (!validId(layer.source) || !sources.has(layer.source))) return null;
    if (!requiresSource && layer.source != null) return null;
    const normalized = { id: layer.id, type: layer.type };
    if (requiresSource) normalized.source = layer.source;
    if (layer['source-layer'] != null) {
        if (!validId(layer['source-layer'])) return null;
        normalized['source-layer'] = layer['source-layer'];
    }
    for (const key of ['minzoom', 'maxzoom']) {
        if (layer[key] != null) {
            const zoom = finiteZoom(layer[key]);
            if (zoom == null) return null;
            normalized[key] = zoom;
        }
    }
    if (normalized.minzoom != null && normalized.maxzoom != null
        && normalized.minzoom > normalized.maxzoom) return null;
    if (layer.filter != null) {
        if (!Array.isArray(layer.filter)) return null;
        normalized.filter = structuredClone(layer.filter);
    }
    for (const key of ['layout', 'paint']) {
        if (layer[key] != null) {
            if (!layer[key] || typeof layer[key] !== 'object' || Array.isArray(layer[key])) return null;
            normalized[key] = structuredClone(layer[key]);
        }
    }
    return normalized;
};

const normalizeStyle = style => {
    if (!style || style.version !== 8 || !style.sources || typeof style.sources !== 'object'
        || Array.isArray(style.sources) || !Array.isArray(style.layers)) return null;
    const sourceEntries = Object.entries(style.sources);
    if (sourceEntries.length > MAX_SOURCES || style.layers.length > MAX_LAYERS) return null;
    const sources = {};
    for (const [id, source] of sourceEntries) {
        if (!validId(id) || Object.hasOwn(sources, id)) return null;
        const normalized = normalizeSource(source);
        if (!normalized) return null;
        sources[id] = normalized;
    }
    const sourceIds = new Set(Object.keys(sources));
    const layerIds = new Set();
    const layers = [];
    for (const layer of style.layers) {
        if (layerIds.has(layer?.id)) return null;
        const normalized = normalizeLayer(layer, sourceIds);
        if (!normalized) return null;
        layerIds.add(normalized.id);
        layers.push(normalized);
    }
    const normalized = { version: 8, sources, layers };
    if (style.glyphs != null) {
        const glyphs = providerUrl(style.glyphs, { templates: ['fontstack', 'range'] });
        if (!glyphs) return null;
        normalized.glyphs = glyphs;
    }
    if (style.sprite != null) {
        const sprite = providerUrl(style.sprite);
        if (!sprite) return null;
        normalized.sprite = sprite;
    }
    return normalized;
};

const isStyleDocument = style => normalizeStyle(style) !== null;

const createVectorStyleLoader = ({
    styleUrl,
    fetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
    const requestedUrl = providerUrl(styleUrl);
    if (!requestedUrl) throw new TypeError('vector style loader requires an OpenFreeMap style URL');
    let pending = null;

    const request = async () => {
        const deadline = Deadline.createRequestDeadline(timeoutMs);
        try {
            const response = await deadline.run(fetch(requestedUrl, {
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                signal: deadline.signal,
            }));
            if (!response || !response.ok) {
                throw new Error(`Vector style request failed (${response && response.status})`);
            }
            if (!providerUrl(response.url)) throw new Error('Vector style redirected outside OpenFreeMap');
            const text = await deadline.run(BoundedText.readBoundedResponseText(response, {
                maxBytes: STYLE_MAX_BYTES,
                signal: deadline.signal,
                label: 'Vector style response',
            }));
            let style;
            try { style = JSON.parse(text); } catch { throw new Error('Unexpected vector style JSON'); }
            try {
                BoundedText.assertBoundedStructure(style, {
                    ...STYLE_STRUCTURE_LIMITS,
                    label: 'Vector style structure',
                });
            } catch (error) {
                if (BoundedText.isLimitError(error)) throw new Error('Vector style exceeds its structure budget');
                throw error;
            }
            const normalized = normalizeStyle(style);
            if (!normalized) throw new Error('Unexpected vector style shape');
            return normalized;
        } finally {
            deadline.clear();
        }
    };

    return {
        load: () => {
            if (!pending) {
                pending = request();
                pending.catch(() => { pending = null; });
            }
            return pending;
        },
    };
};

export const terrainStyle = {
    DEFAULT_TIMEOUT_MS,
    STYLE_MAX_BYTES,
    PROVIDER_ORIGIN,
    MAX_SOURCES,
    MAX_LAYERS,
    MAX_ID_LENGTH,
    STYLE_STRUCTURE_LIMITS,
    providerUrl,
    normalizeStyle,
    createVectorStyleLoader,
    isStyleDocument,
};
