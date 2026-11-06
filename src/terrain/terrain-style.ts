// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — bounded built-in vector style acquisition and normalization.

import { requestDeadline as Deadline } from '../net/request-deadline.js';
import { boundedText as BoundedText } from '../net/bounded-text.js';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.js';
import { VECTOR_BASEMAP, MAPTOOLKIT_BASEMAP, vectorProviderUrl } from '../maps/vector-basemap.ts';
import type { VectorBasemap } from '../maps/vector-basemap.ts';

export interface VectorSource {
    type: string; url?: string; tiles?: string[]; minzoom?: number; maxzoom?: number; tileSize?: number;
    encoding?: string; scheme?: string; attribution?: string; bounds?: number[];
}
export interface VectorLayer {
    id: string; type: string; source?: string; 'source-layer'?: string; minzoom?: number; maxzoom?: number;
    filter?: unknown[]; layout?: Record<string, unknown>; paint?: Record<string, unknown>;
}
export type VectorSprite = string | { id: string; url: string }[];
export interface VectorStyle {
    version: 8; sources: Record<string, VectorSource>; layers: VectorLayer[]; glyphs?: string;
    sprite?: VectorSprite; metadata?: Record<string, string>;
}
export interface VectorStyleLoaderOptions { styleUrl?: string; basemap?: VectorBasemap; fetch?: typeof globalThis.fetch; timeoutMs?: number; }
type StyleError = Error & { retryAt?: number | null; code?: string };

const DEFAULT_TIMEOUT_MS = 10000;
const STYLE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 16;
const MAX_LAYERS = 512;
const MAX_URL_LENGTH = 4096;
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_TYPES = new Set(['vector', 'raster', 'raster-dem']);
const LAYER_TYPES = new Set([
    'background', 'fill', 'line', 'symbol', 'circle', 'heatmap',
    'fill-extrusion', 'raster', 'hillshade', 'color-relief',
]);
const STYLE_STRUCTURE_LIMITS = Object.freeze({
    maxDepth: 32,
    maxNodes: 250000,
    maxArrayItems: MAX_LAYERS,
    maxObjectKeys: 2048,
    maxStringChars: MAX_URL_LENGTH,
});

const validId = (value: unknown): value is string => typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && ID_PATTERN.test(value);

const providerUrl = (value: unknown, { templates = [], basemap = VECTOR_BASEMAP }: { templates?: readonly string[]; basemap?: VectorBasemap } = {}) => vectorProviderUrl(value, basemap, { templates });

const finiteZoom = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 24 ? value : null;

// Each reader casts untrusted JSON to its expected shape; the checks below enforce it.
const normalizeSource = (input: unknown, basemap: VectorBasemap): VectorSource | null => {
    const source = input as VectorSource | null | undefined;
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || !SOURCE_TYPES.has(source.type)) return null;
    const normalized: VectorSource = { type: source.type };
    if (source.url != null) {
        const url = providerUrl(source.url, { basemap });
        if (!url) return null;
        normalized.url = url;
    }
    if (source.tiles != null) {
        if (!Array.isArray(source.tiles) || source.tiles.length < 1 || source.tiles.length > 8) return null;
        const tiles = source.tiles.map(tile => providerUrl(tile, { basemap, templates: ['z', 'x', 'y'] }));
        if (tiles.some(tile => !tile)) return null;
        normalized.tiles = tiles as string[];
    }
    if (!normalized.url && !normalized.tiles) return null;
    for (const key of ['minzoom', 'maxzoom'] as const) {
        if (source[key] != null) {
            const zoom = finiteZoom(source[key]);
            if (zoom == null) return null;
            normalized[key] = zoom;
        }
    }
    if (normalized.minzoom != null && normalized.maxzoom != null
        && normalized.minzoom > normalized.maxzoom) return null;
    if (source.tileSize != null) {
        if (!Number.isInteger(source.tileSize) || source.tileSize < 128 || source.tileSize > 8192) return null;
        normalized.tileSize = source.tileSize;
    }
    if (source.type === 'raster-dem') {
        if (source.encoding != null && !['terrarium', 'mapbox'].includes(source.encoding)) return null;
        if (source.encoding != null) normalized.encoding = source.encoding;
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

const normalizeLayer = (input: unknown, sources: ReadonlySet<string>): VectorLayer | null => {
    const layer = input as VectorLayer | null | undefined;
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)
        || !validId(layer.id) || !LAYER_TYPES.has(layer.type)) return null;
    const requiresSource = layer.type !== 'background';
    if (requiresSource && (!validId(layer.source) || !sources.has(layer.source))) return null;
    if (!requiresSource && layer.source != null) return null;
    const normalized: VectorLayer = { id: layer.id, type: layer.type };
    if (requiresSource) normalized.source = layer.source;
    if (layer['source-layer'] != null) {
        if (!validId(layer['source-layer'])) return null;
        normalized['source-layer'] = layer['source-layer'];
    }
    for (const key of ['minzoom', 'maxzoom'] as const) {
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
    for (const key of ['layout', 'paint'] as const) {
        if (layer[key] != null) {
            if (!layer[key] || typeof layer[key] !== 'object' || Array.isArray(layer[key])) return null;
            normalized[key] = structuredClone(layer[key]);
        }
    }
    return normalized;
};

const normalizeStyle = (input: unknown, { basemap = VECTOR_BASEMAP }: { basemap?: VectorBasemap } = {}): VectorStyle | null => {
    const style = input as (Omit<VectorStyle, 'metadata'> & { metadata?: Record<string, unknown> }) | null | undefined;
    if (!style || style.version !== 8 || !style.sources || typeof style.sources !== 'object'
        || Array.isArray(style.sources) || !Array.isArray(style.layers)) return null;
    const sourceEntries = Object.entries(style.sources);
    if (sourceEntries.length > MAX_SOURCES || style.layers.length > MAX_LAYERS) return null;
    const sources: Record<string, VectorSource> = {};
    for (const [id, source] of sourceEntries) {
        if (!validId(id) || Object.hasOwn(sources, id)) return null;
        const normalized = normalizeSource(source, basemap);
        if (!normalized) return null;
        sources[id] = normalized;
    }
    const sourceIds = new Set(Object.keys(sources));
    const layerIds = new Set<string>();
    const layers: VectorLayer[] = [];
    for (const layer of style.layers) {
        if (layerIds.has(layer?.id)) return null;
        const normalized = normalizeLayer(layer, sourceIds);
        if (!normalized) return null;
        layerIds.add(normalized.id);
        layers.push(normalized);
    }
    const normalized: VectorStyle = { version: 8, sources, layers };
    if (style.glyphs != null) {
        const glyphs = providerUrl(style.glyphs, { basemap, templates: ['fontstack', 'range'] });
        if (!glyphs) return null;
        normalized.glyphs = glyphs;
    }
    if (style.sprite != null) {
        if (Array.isArray(style.sprite)) {
            if (style.sprite.length > 16) return null;
            const seen = new Set<string>();
            const sprites: { id: string; url: string }[] = [];
            for (const item of style.sprite) {
                const url = providerUrl(item?.url, { basemap });
                if (!validId(item?.id) || seen.has(item.id) || !url) return null;
                seen.add(item.id); sprites.push({ id: item.id, url });
            }
            normalized.sprite = sprites;
        } else {
            const sprite = providerUrl(style.sprite, { basemap });
            if (!sprite) return null;
            normalized.sprite = sprite;
        }
    }
    const metadata: Record<string, string> = {};
    for (const key of ['copyright', 'license_url']) {
        const value = style.metadata?.[key];
        if (typeof value === 'string' && value.length <= 2048) metadata[key] = value;
    }
    if (Object.keys(metadata).length) normalized.metadata = metadata;
    return normalized;
};

// Adapt only the fixed Hiking provider, after validation. Its three soft
// hillshades use independent DEM zoom ladders; the detailed pass is sufficient
// in 2D, and 3D already shades its terrain mesh. Preserve water color-relief,
// contours, labels and icons, and avoid fetching metadata for orphan sources.
const renderingStyle = (style: VectorStyle, { basemap = VECTOR_BASEMAP, terrain = false }: { basemap?: VectorBasemap; terrain?: boolean } = {}): VectorStyle => {
    if (basemap !== MAPTOOLKIT_BASEMAP) return style;
    const layers = style.layers.filter(layer => layer.type !== 'hillshade'
        || !terrain && (style.sources[layer.source!]?.tileSize || 512) <= 512);
    const used = new Set(layers.map(layer => layer.source));
    return { ...style, layers, sources: Object.fromEntries(Object.entries(style.sources).filter(([id]) => used.has(id))) };
};

const createVectorStyleLoader = ({
    styleUrl,
    basemap = VECTOR_BASEMAP,
    fetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}: VectorStyleLoaderOptions = {}) => {
    const requestedUrl = providerUrl(styleUrl, { basemap });
    if (!requestedUrl) throw new TypeError('vector style loader requires an approved provider style URL');
    let pending: Promise<VectorStyle> | null = null;
    let limited: StyleError | null = null;

    const request = async () => {
        if ((limited?.retryAt ?? 0) > Date.now()) throw limited;
        const deadline = Deadline.createRequestDeadline(timeoutMs);
        let response: Response | undefined;
        try {
            response = await deadline.run(fetch(requestedUrl!, {
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                redirect: 'error',
                signal: deadline.signal,
            }));
            if (response?.status === 429) {
                limited = rateLimitError(basemap.provider, response);
                limited.retryAt ??= Date.now() + 300000;
                throw limited;
            }
            if (!response || !response.ok) {
                throw new Error(`Vector style request failed (${response && response.status})`);
            }
            if (!providerUrl(response.url, { basemap })) throw new Error('Vector style redirected outside its provider');
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
            const normalized = normalizeStyle(style, { basemap });
            if (!normalized) throw new Error('Unexpected vector style shape');
            return normalized;
        } finally {
            cancelResponseBody(response);
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
    MAX_SOURCES,
    MAX_ID_LENGTH,
    providerUrl,
    normalizeStyle,
    renderingStyle,
    createVectorStyleLoader,
};
