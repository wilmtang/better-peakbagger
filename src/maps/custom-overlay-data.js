// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { CUSTOM_LIMITS } from './custom-overlay-schema.js';

const invalid = () => { throw new Error('Invalid or oversized vector data.'); };
export function readCustomGeoJSON(value) {
    if (!value || value.type !== 'FeatureCollection' || value.crs || !Array.isArray(value.features) || value.features.length > CUSTOM_LIMITS.features) invalid();
    let count = 0;
    const position = coordinate => {
        if (++count > CUSTOM_LIMITS.vertices || !Array.isArray(coordinate) || coordinate.length < 2 || coordinate.length > 3
            || !coordinate.every(Number.isFinite) || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 85.051129) invalid();
        return coordinate.slice(0, 2);
    };
    const line = (coordinates, ring = false) => {
        if (!Array.isArray(coordinates) || coordinates.length < (ring ? 4 : 2)) invalid();
        const next = coordinates.map(position);
        if (next.some((point, i) => i && Math.abs(point[0] - next[i - 1][0]) > 180)) invalid();
        if (ring && next[0].some((v, i) => v !== next.at(-1)[i])) invalid();
        return next;
    };
    const polygon = coordinates => { if (!Array.isArray(coordinates) || !coordinates.length) invalid(); return coordinates.map(points => line(points, true)); };
    const geometry = raw => {
        if (raw === null) return null;
        if (!raw || raw.crs || !Array.isArray(raw.coordinates)) invalid();
        const coordinates = raw.coordinates;
        const readers = { Point: () => position(coordinates), MultiPoint: () => coordinates.map(position),
            LineString: () => line(coordinates), MultiLineString: () => coordinates.map(points => line(points)),
            Polygon: () => polygon(coordinates), MultiPolygon: () => coordinates.map(polygon) };
        if (!Object.hasOwn(readers, raw.type)) invalid();
        return { type: raw.type, coordinates: readers[raw.type]() };
    };
    return { type: 'FeatureCollection', features: value.features.map(feature => {
        if (!feature || feature.type !== 'Feature' || !Object.hasOwn(feature, 'geometry')) invalid();
        return { type: 'Feature', properties: {}, geometry: geometry(feature.geometry) };
    }) };
}
// Clip in normalized tile coordinates. Ring winding and hole order are retained.
const clipRing = input => {
    let points = input;
    for (const [axis, bound, greater] of [[0, 0, true], [0, 1, false], [1, 0, true], [1, 1, false]]) {
        const next = [], inside = point => greater ? point[axis] >= bound : point[axis] <= bound;
        for (let i = 0; i < points.length; i++) {
            const a = points[(i + points.length - 1) % points.length], b = points[i], ia = inside(a), ib = inside(b);
            if (ia !== ib) { const ratio = (bound - a[axis]) / (b[axis] - a[axis]); next.push([a[0] + ratio * (b[0] - a[0]), a[1] + ratio * (b[1] - a[1])]); }
            if (ib) next.push(b);
        }
        points = next;
    }
    if (points.length < 3) return [];
    if (points[0].some((value, i) => value !== points.at(-1)[i])) points.push(points[0]);
    return points;
};
const clipLine = input => {
    const paths = []; let path = [];
    for (let i = 1; i < input.length; i++) {
        const a = input[i - 1], b = input[i], dx = b[0] - a[0], dy = b[1] - a[1];
        let low = 0, high = 1;
        for (const [p, q] of [[-dx, a[0]], [dx, 1 - a[0]], [-dy, a[1]], [dy, 1 - a[1]]]) {
            if (p === 0) { if (q < 0) high = -1; }
            else if (p < 0) low = Math.max(low, q / p); else high = Math.min(high, q / p);
        }
        if (low > high) { if (path.length) paths.push(path); path = []; continue; }
        const start = [a[0] + dx * low, a[1] + dy * low], end = [a[0] + dx * high, a[1] + dy * high];
        if (path.length && path.at(-1).some((value, axis) => Math.abs(value - start[axis]) > 1e-9)) { paths.push(path); path = []; }
        if (!path.length) path.push(start); path.push(end);
    }
    if (path.length) paths.push(path); return paths;
};
export function readCustomMVT(bytes, layers, transform = { scale: 1, x: 0, y: 0 }) {
    if (bytes.byteLength > CUSTOM_LIMITS.mvt || !Array.isArray(layers) || layers.length > CUSTOM_LIMITS.rules) invalid();
    const tile = new VectorTile(new PbfReader(new Uint8Array(bytes)));
    if (Object.keys(tile.layers).length > 32) invalid();
    const features = [], encoded = Object.create(null); let count = 0, vertices = 0;
    for (const [name, layer] of Object.entries(tile.layers)) {
        if (name.length > 128 || !Number.isSafeInteger(layer.extent) || layer.extent < 1 || layer.extent > 65536 || (count += layer.length) > CUSTOM_LIMITS.features) invalid();
        if (!layers.includes(name)) continue;
        encoded[name] = { features: [] };
        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            if (![1, 2, 3].includes(feature.type) || Object.keys(feature.properties).length > 128 || JSON.stringify(feature.properties).length > 16384) invalid();
            let paths = feature.loadGeometry().map(ring => ring.map(point => {
                if (++vertices > CUSTOM_LIMITS.vertices || !Number.isFinite(point.x) || !Number.isFinite(point.y)
                    || point.x < -layer.extent || point.x >= 2 * layer.extent || point.y < -layer.extent || point.y >= 2 * layer.extent) invalid();
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
    const data = fromGeojsonVt(encoded, { version: 2, extent: 4096 });
    if (data.byteLength > CUSTOM_LIMITS.mvt) invalid();
    return { features, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}
export function parseCustomData({ kind, bytes, layers = [], transform }) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > (kind === 'geojson' ? CUSTOM_LIMITS.geojson : CUSTOM_LIMITS.mvt)) invalid();
    if (kind === 'geojson') return readCustomGeoJSON(JSON.parse(new TextDecoder().decode(bytes)));
    if (kind === 'mvt') return readCustomMVT(bytes, layers, transform);
    invalid();
}
