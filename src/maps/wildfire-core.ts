// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { overlayBounds } from './map-overlay-providers.ts';

export type WildfireKind = 'incidents' | 'perimeters';
export type WildfireErrorCode = 'invalid' | 'invalid-response' | 'overflow' | 'service' | 'rate-limit';

export interface WildfireError extends Error {
    code: WildfireErrorCode | string;
    retryAt?: number;
}

export interface WildfireBudget {
    bytes?: number;
    vertices: number;
    nesting?: number;
}

export type WildfirePosition = [number, number];
export type WildfireRing = WildfirePosition[];
export type WildfirePolygonCoordinates = WildfireRing[];
export type WildfireMultiPolygonCoordinates = WildfirePolygonCoordinates[];

export type WildfireGeometry =
    | { type: 'Point'; coordinates: WildfirePosition }
    | { type: 'Polygon'; coordinates: WildfirePolygonCoordinates }
    | { type: 'MultiPolygon'; coordinates: WildfireMultiPolygonCoordinates };

export interface WildfireFeatureProperties {
    id: string;
    objectId: number;
    fireId: string | null;
    name: string;
    incidentUpdated: number | null;
    perimeterObserved: number | null;
    perimeterEdited: number | null;
    acres: number | null;
    contained: number | null;
}

export type WildfireFeature = {
    type: 'Feature';
    id: string;
    properties: WildfireFeatureProperties;
    geometry: WildfireGeometry;
};

export interface WildfireRecord {
    id: string;
    name: string;
    incidentUpdated: number | null;
    perimeterObserved: number | null;
    perimeterEdited: number | null;
    acres: number | null;
    contained: number | null;
    hasPerimeter: boolean;
}

export interface WildfireFeatureLike {
    id?: unknown;
    properties?: unknown;
    [field: string]: unknown;
}

interface WorkingWildfireRecord {
    id?: unknown;
    fireId?: string | null;
    name?: unknown;
    incidentUpdated?: unknown;
    perimeterObserved?: number | null;
    perimeterEdited?: number | null;
    acres?: unknown;
    contained?: unknown;
    hasPerimeter: boolean;
}

export const WILDFIRE_MIN_ZOOM = 7;
export const WILDFIRE_SOURCE = 'https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824';
export const WILDFIRE_LEGEND = 'NIFC/WFIGS · Current US reported locations and mapped perimeters. Reports may lag; check official closures. Canada is not supported yet.';
export const WILDFIRE_LIMITS = Object.freeze({ pageSize: 500, pages: 4, pageBytes: 4 * 1024 * 1024, bytes: 12 * 1024 * 1024, vertices: 100000 });

const clean = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) : '';
const uuid = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const text = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
    return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(text) ? text.toLowerCase() : null;
};
const date = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 946684800000 && value <= 4102444800000 ? value : null;
const amount = (value: unknown, max: number): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

export const wildfireError = (code: WildfireErrorCode | string, message: string): WildfireError =>
    Object.assign(new Error(message), { code });

export function wildfireBoxes(value: unknown): [number, number, number, number][] {
    const bounds = overlayBounds(value); if (!bounds) throw wildfireError('invalid', 'Invalid fire viewport.');
    const [west, south, east, north] = bounds;
    const start = ((west + 180) % 360 + 360) % 360 - 180, end = start + east - west;
    return end <= 180 ? [[start, south, end, north]] : [[start, south, 180, north], [-180, south, end - 360, north]];
}

export function readWildfireFeature(feature: unknown, kind: WildfireKind | string, budget: WildfireBudget): WildfireFeature {
    const invalid = (): never => { throw wildfireError('invalid-response', 'The fire service returned invalid data.'); };
    const candidate = feature && typeof feature === 'object' ? feature as { type?: unknown; properties?: unknown; geometry?: unknown } : null;
    const p = candidate?.properties && typeof candidate.properties === 'object' ? candidate.properties as Record<string, unknown> : null;
    const geometry = candidate?.geometry && typeof candidate.geometry === 'object' ? candidate.geometry as { type?: unknown; coordinates?: unknown } : null;
    if (candidate?.type !== 'Feature' || !p || typeof p.OBJECTID !== 'number' || !Number.isSafeInteger(p.OBJECTID) || p.OBJECTID < 1
        || p[kind === 'incidents' ? 'IncidentTypeCategory' : 'attr_IncidentTypeCategory'] !== 'WF') invalid();
    const objectId = p!.OBJECTID as number;
    const coordinate = (point: unknown): WildfirePosition => {
        if (!Array.isArray(point) || point.length !== 2 || !point.every((item): item is number => typeof item === 'number' && Number.isFinite(item))
            || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) invalid();
        const coords = point as number[];
        if (++budget.vertices > WILDFIRE_LIMITS.vertices) throw wildfireError('overflow', 'Too much fire detail. Zoom in.');
        return [coords[0], coords[1]];
    };
    const ring = (value: unknown): WildfireRing => {
        if (!Array.isArray(value) || value.length < 4 || value.length > WILDFIRE_LIMITS.vertices) invalid();
        const points = (value as unknown[]).map(coordinate), first = points[0], last = points.at(-1)!;
        if (first[0] !== last[0] || first[1] !== last[1] || points.some((point, index) => index > 0 && Math.abs(point[0] - points[index - 1][0]) > 180)) invalid();
        return points;
    };
    const polygon = (value: unknown): WildfirePolygonCoordinates => {
        if (!Array.isArray(value) || !value.length || value.length > 1000) invalid();
        const rings = (value as unknown[]).map(ring), outer = rings[0];
        if (new Set(outer.map(point => point.join(','))).size < 3) invalid();
        const inside = (point: WildfirePosition): boolean => {
            let found = false;
            for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
                const [x, y] = outer[i], [px, py] = outer[j];
                if ((y > point[1]) !== (py > point[1]) && point[0] < (px - x) * (point[1] - y) / (py - y) + x) found = !found;
            }
            return found;
        };
        budget.nesting = (budget.nesting || 0) + (rings.length - 1) * outer.length;
        if (budget.nesting > WILDFIRE_LIMITS.vertices * 4) throw wildfireError('overflow', 'Too much fire detail. Zoom in.');
        if (rings.slice(1).some(hole => !inside(hole[0]))) invalid();
        return rings; // Preserve disjoint parts and holes without repairing them.
    };
    let normalized: WildfireGeometry;
    if (kind === 'incidents' && geometry?.type === 'Point') normalized = { type: 'Point', coordinates: coordinate(geometry.coordinates) };
    else if (kind === 'perimeters' && geometry?.type === 'Polygon') normalized = { type: 'Polygon', coordinates: polygon(geometry.coordinates) };
    else if (kind === 'perimeters' && geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.length <= 1000)
        normalized = { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon) };
    else return invalid();
    const incident = kind === 'incidents', a = uuid(p!.poly_IRWINID), b = uuid(p!.attr_IrwinID);
    const properties: WildfireFeatureProperties = {
        id: `nifc:${incident ? 'incident' : 'perimeter'}:${objectId}`,
        objectId,
        fireId: incident ? uuid(p!.IrwinID) : a && b && a !== b ? null : a || b,
        name: clean(incident ? p!.IncidentName : p!.poly_IncidentName) || 'Unnamed reported fire',
        incidentUpdated: date(incident ? p!.ModifiedOnDateTime_dt : p!.attr_ModifiedOnDateTime_dt),
        perimeterObserved: incident ? null : date(p!.poly_PolygonDateTime),
        perimeterEdited: incident ? null : date(p!.poly_DateCurrent),
        acres: amount(incident ? p!.IncidentSize : p!.poly_GISAcres, 100000000),
        contained: amount(incident ? p!.PercentContained : p!.attr_PercentContained, 100),
    };
    return { type: 'Feature', id: properties.id, properties, geometry: normalized };
}

// Typed metadata only; geometry and provider URLs never cross the map bridge.
export function readWildfireRecords(value: unknown): WildfireRecord[] {
    if (!Array.isArray(value) || value.length > 4000) return [];
    const seen = new Set<string>();
    return (value as unknown[])
        .filter((record): record is Record<string, unknown> & { id: string } => {
            if (!record || typeof record !== 'object') return false;
            const id = (record as { id?: unknown }).id;
            return typeof id === 'string' && id.length <= 40 && /^nifc:(incident|perimeter):\d+$/.test(id) && !seen.has(id) && Boolean(seen.add(id));
        })
        .map(record => ({
            id: record.id,
            name: clean(record.name) || 'Unnamed reported fire',
            incidentUpdated: date(record.incidentUpdated),
            perimeterObserved: date(record.perimeterObserved),
            perimeterEdited: date(record.perimeterEdited),
            acres: amount(record.acres, 100000000),
            contained: amount(record.contained, 100),
            hasPerimeter: record.hasPerimeter === true,
        }));
}

export function wildfireRecords(incidents: readonly WildfireFeatureLike[], perimeters: readonly WildfireFeatureLike[]): WildfireRecord[] {
    const records: WorkingWildfireRecord[] = incidents.map(feature => {
        const props = feature.properties && typeof feature.properties === 'object' ? feature.properties as Record<string, unknown> : {};
        return { ...props, hasPerimeter: false };
    });
    const owners = new Map<string, WorkingWildfireRecord[]>();
    for (const record of records) if (typeof record.fireId === 'string' && record.fireId) {
        owners.set(record.fireId, [...(owners.get(record.fireId) || []), record]);
    }
    for (const feature of perimeters) {
        const p = (feature.properties && typeof feature.properties === 'object' ? feature.properties : {}) as Partial<WildfireFeatureProperties>;
        const matches = p.fireId ? owners.get(p.fireId) : undefined;
        if (matches?.length === 1) {
            const record = matches[0], previous = record.hasPerimeter; record.hasPerimeter = true;
            record.perimeterObserved = !previous ? (p.perimeterObserved ?? null)
                : record.perimeterObserved && p.perimeterObserved ? Math.min(record.perimeterObserved, p.perimeterObserved) : null;
            record.perimeterEdited = Math.max(record.perimeterEdited || 0, p.perimeterEdited || 0) || null;
        } else records.push({ ...p, hasPerimeter: true });
    }
    return readWildfireRecords(records).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// Leaflet projects raw longitudes; choose the same wrapped world as the map.
// This is a renderer copy, never a change to normalized provider geometry.
export function wildfireWorldCopy(feature: WildfireFeature, longitude: number): WildfireFeature {
    const shift = (first: WildfirePosition): number => 360 * Math.round((longitude - first[0]) / 360);
    const move = (points: WildfireRing, offset: number): WildfireRing => points.map(point => [point[0] + offset, point[1]]);
    const polygon = (rings: WildfirePolygonCoordinates): WildfirePolygonCoordinates => {
        const offset = shift(rings[0][0]);
        return rings.map(ring => move(ring, offset));
    };
    const g = feature.geometry;
    if (g.type === 'Point') {
        return { ...feature, geometry: { type: 'Point', coordinates: [g.coordinates[0] + shift(g.coordinates), g.coordinates[1]] } };
    }
    if (g.type === 'Polygon') {
        return { ...feature, geometry: { type: 'Polygon', coordinates: polygon(g.coordinates) } };
    }
    return { ...feature, geometry: { type: 'MultiPolygon', coordinates: g.coordinates.map(polygon) } };
}
