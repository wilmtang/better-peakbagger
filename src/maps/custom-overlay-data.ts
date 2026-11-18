// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { CUSTOM_LIMITS } from './custom-overlay-schema.js';

type Point2D = [number, number];
type Ring2D = Point2D[];

export type CustomGeoJsonGeometry =
    | { type: 'Point'; coordinates: Point2D }
    | { type: 'MultiPoint'; coordinates: Point2D[] }
    | { type: 'LineString'; coordinates: Ring2D }
    | { type: 'MultiLineString'; coordinates: Ring2D[] }
    | { type: 'Polygon'; coordinates: Ring2D[] }
    | { type: 'MultiPolygon'; coordinates: Ring2D[][] };

export interface CustomGeoJsonFeature {
    type: 'Feature';
    properties: Record<string, never>;
    geometry: CustomGeoJsonGeometry | null;
}

export interface CustomGeoJsonCollection {
    type: 'FeatureCollection';
    features: CustomGeoJsonFeature[];
}

export interface CustomTileTransform {
    scale: number;
    x: number;
    y: number;
}

export interface CustomMvtFeature {
    layer: string;
    type: number;
    paths: Ring2D[];
}

export interface CustomMvtResult {
    features: CustomMvtFeature[];
    data: ArrayBuffer;
}

export interface CustomParseRequest {
    kind: string;
    bytes: ArrayBuffer;
    layers?: string[];
    transform?: CustomTileTransform;
}

const invalid = (): never => { throw new Error('Invalid or oversized vector data.'); };

function assertValid(condition: unknown): asserts condition {
    if (!condition) invalid();
}

export function readCustomGeoJSON(value: unknown): CustomGeoJsonCollection {
    assertValid(value && typeof value === 'object');
    const rawCollection = value as { type?: unknown; crs?: unknown; features?: unknown };
    assertValid(rawCollection.type === 'FeatureCollection' && !rawCollection.crs
        && Array.isArray(rawCollection.features) && rawCollection.features.length <= CUSTOM_LIMITS.features);
    let count = 0;
    const position = (coordinate: unknown): Point2D => {
        assertValid(++count <= CUSTOM_LIMITS.vertices && Array.isArray(coordinate)
            && coordinate.length >= 2 && coordinate.length <= 3
            && coordinate.every(Number.isFinite) && Math.abs(coordinate[0]) <= 180 && Math.abs(coordinate[1]) <= 85.051129);
        return [coordinate[0] as number, coordinate[1] as number];
    };
    const line = (coordinates: unknown, ring = false): Ring2D => {
        assertValid(Array.isArray(coordinates) && coordinates.length >= (ring ? 4 : 2));
        const next = coordinates.map(position);
        assertValid(!next.some((point: Point2D, i: number) => i && Math.abs(point[0] - next[i - 1][0]) > 180));
        const last = next.at(-1)!;
        assertValid(!ring || !next[0].some((v: number, i: number) => v !== last[i]));
        return next;
    };
    const polygon = (coordinates: unknown): Ring2D[] => {
        assertValid(Array.isArray(coordinates) && coordinates.length > 0);
        return coordinates.map((points: unknown) => line(points, true));
    };
    const geometry = (raw: unknown): CustomGeoJsonGeometry | null => {
        if (raw === null) return null;
        assertValid(raw && typeof raw === 'object');
        const candidate = raw as { type?: unknown; crs?: unknown; coordinates?: unknown };
        assertValid(!candidate.crs && Array.isArray(candidate.coordinates));
        const coordinates = candidate.coordinates;
        switch (candidate.type) {
        case 'Point': return { type: 'Point', coordinates: position(coordinates) };
        case 'MultiPoint': return { type: 'MultiPoint', coordinates: coordinates.map(position) };
        case 'LineString': return { type: 'LineString', coordinates: line(coordinates) };
        case 'MultiLineString': return { type: 'MultiLineString', coordinates: coordinates.map((points: unknown) => line(points)) };
        case 'Polygon': return { type: 'Polygon', coordinates: polygon(coordinates) };
        case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: coordinates.map(polygon) };
        default: return invalid();
        }
    };
    return {
        type: 'FeatureCollection',
        features: rawCollection.features.map((item: unknown): CustomGeoJsonFeature => {
            assertValid(item && typeof item === 'object');
            const feature = item as { type?: unknown; geometry?: unknown };
            assertValid(feature.type === 'Feature' && Object.hasOwn(feature, 'geometry'));
            return { type: 'Feature', properties: {}, geometry: geometry(feature.geometry) };
        }),
    };
}

// Clip in normalized tile coordinates. Ring winding and hole order are retained.
const clipRing = (input: Ring2D): Ring2D => {
    let points = input;
    const edges: readonly [0 | 1, number, boolean][] = [[0, 0, true], [0, 1, false], [1, 0, true], [1, 1, false]];
    for (const [axis, bound, greater] of edges) {
        const next: Ring2D = [];
        const inside = (point: Point2D) => greater ? point[axis] >= bound : point[axis] <= bound;
        for (let i = 0; i < points.length; i++) {
            const a = points[(i + points.length - 1) % points.length], b = points[i], ia = inside(a), ib = inside(b);
            if (ia !== ib) {
                const ratio = (bound - a[axis]) / (b[axis] - a[axis]);
                next.push([a[0] + ratio * (b[0] - a[0]), a[1] + ratio * (b[1] - a[1])]);
            }
            if (ib) next.push(b);
        }
        points = next;
    }
    if (points.length < 3) return [];
    const last = points.at(-1)!;
    if (points[0].some((value, i) => value !== last[i])) points.push(points[0]);
    return points;
};

const clipLine = (input: Ring2D): Ring2D[] => {
    const paths: Ring2D[] = [];
    let path: Ring2D = [];
    for (let i = 1; i < input.length; i++) {
        const a = input[i - 1], b = input[i], dx = b[0] - a[0], dy = b[1] - a[1];
        let low = 0, high = 1;
        for (const [p, q] of [[-dx, a[0]], [dx, 1 - a[0]], [-dy, a[1]], [dy, 1 - a[1]]] as const) {
            if (p === 0) { if (q < 0) high = -1; }
            else if (p < 0) low = Math.max(low, q / p);
            else high = Math.min(high, q / p);
        }
        if (low > high) {
            if (path.length) paths.push(path);
            path = [];
            continue;
        }
        const start: Point2D = [a[0] + dx * low, a[1] + dy * low];
        const end: Point2D = [a[0] + dx * high, a[1] + dy * high];
        const last = path.at(-1);
        if (last && last.some((value, axis) => Math.abs(value - start[axis]) > 1e-9)) {
            paths.push(path);
            path = [];
        }
        if (!path.length) path.push(start);
        path.push(end);
    }
    if (path.length) paths.push(path);
    return paths;
};

export function readCustomMVT(
    bytes: ArrayBuffer,
    layers: readonly string[],
    transform: CustomTileTransform = { scale: 1, x: 0, y: 0 },
): CustomMvtResult {
    assertValid(bytes.byteLength <= CUSTOM_LIMITS.mvt && Array.isArray(layers) && layers.length <= CUSTOM_LIMITS.rules);
    const tile = new VectorTile(new PbfReader(new Uint8Array(bytes)));
    assertValid(Object.keys(tile.layers).length <= 32);
    const features: CustomMvtFeature[] = [];
    const encoded = Object.create(null) as Record<string, { features: { type: number; geometry: unknown; tags: Record<string, never> }[] }>;
    let count = 0, vertices = 0;
    for (const [name, layer] of Object.entries(tile.layers)) {
        assertValid(name.length <= 128 && Number.isSafeInteger(layer.extent) && layer.extent >= 1 && layer.extent <= 65536
            && (count += layer.length) <= CUSTOM_LIMITS.features);
        if (!layers.includes(name)) continue;
        encoded[name] = { features: [] };
        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            assertValid([1, 2, 3].includes(feature.type) && Object.keys(feature.properties).length <= 128
                && JSON.stringify(feature.properties).length <= 16384);
            let paths: Ring2D[] = feature.loadGeometry().map(ring => ring.map((point): Point2D => {
                assertValid(++vertices <= CUSTOM_LIMITS.vertices && Number.isFinite(point.x) && Number.isFinite(point.y)
                    && point.x >= -layer.extent && point.x < 2 * layer.extent && point.y >= -layer.extent && point.y < 2 * layer.extent);
                return [point.x / layer.extent * transform.scale - transform.x, point.y / layer.extent * transform.scale - transform.y];
            }));
            if (transform.scale !== 1) {
                if (feature.type === 1) paths = paths.map(path => path.filter(point => point.every(value => value >= 0 && value <= 1))).filter(path => path.length);
                else if (feature.type === 2) paths = paths.flatMap(clipLine);
                else paths = paths.map(clipRing).filter(path => path.length);
            }
            if (!paths.length) continue;
            features.push({ layer: name, type: feature.type, paths });
            const geometry = paths.map(ring => ring.map(point => point.map(value => Math.round(value * 4096))));
            encoded[name].features.push({ type: feature.type, geometry: feature.type === 1 ? geometry.flat() : geometry, tags: {} });
        }
    }
    const data = fromGeojsonVt(encoded as unknown as Parameters<typeof fromGeojsonVt>[0], { version: 2, extent: 4096 });
    assertValid(data.byteLength <= CUSTOM_LIMITS.mvt);
    return { features, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer };
}

export function parseCustomData({ kind, bytes, layers = [], transform }: CustomParseRequest): CustomGeoJsonCollection | CustomMvtResult {
    assertValid(bytes instanceof ArrayBuffer && bytes.byteLength <= (kind === 'geojson' ? CUSTOM_LIMITS.geojson : CUSTOM_LIMITS.mvt));
    if (kind === 'geojson') return readCustomGeoJSON(JSON.parse(new TextDecoder().decode(bytes)));
    if (kind === 'mvt') return readCustomMVT(bytes, layers, transform);
    return invalid();
}
