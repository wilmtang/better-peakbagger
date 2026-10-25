// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { overlayBounds } from './map-overlay-providers.js';
export const WILDFIRE_MIN_ZOOM = 7;
export const WILDFIRE_SOURCE = 'https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824';
export const WILDFIRE_LEGEND = 'NIFC/WFIGS · Current US reported locations and mapped perimeters. Reports may lag; check official closures. Canada is not supported yet.';
export const WILDFIRE_LIMITS = Object.freeze({ pageSize: 500, pages: 4, pageBytes: 4 * 1024 * 1024, bytes: 12 * 1024 * 1024, vertices: 100000 });
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) : '';
const uuid = value => {
    if (typeof value !== 'string') return null;
    const text = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
    return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(text) ? text.toLowerCase() : null;
};
const date = value => Number.isFinite(value) && value >= 946684800000 && value <= 4102444800000 ? value : null;
const amount = (value, max) => Number.isFinite(value) && value >= 0 && value <= max ? value : null;
export const wildfireError = (code, message) => Object.assign(new Error(message), { code });
export function wildfireBoxes(value) {
    const bounds = overlayBounds(value); if (!bounds) throw wildfireError('invalid', 'Invalid fire viewport.');
    const [west, south, east, north] = bounds;
    const start = ((west + 180) % 360 + 360) % 360 - 180, end = start + east - west;
    return end <= 180 ? [[start, south, end, north]] : [[start, south, 180, north], [-180, south, end - 360, north]];
}
export function readWildfireFeature(feature, kind, budget) {
    const invalid = () => { throw wildfireError('invalid-response', 'The fire service returned invalid data.'); };
    const p = feature?.properties, geometry = feature?.geometry;
    if (feature?.type !== 'Feature' || !p || !Number.isSafeInteger(p.OBJECTID) || p.OBJECTID < 1 || p[kind === 'incidents' ? 'IncidentTypeCategory' : 'attr_IncidentTypeCategory'] !== 'WF') invalid();
    const coordinate = point => {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) invalid();
        if (++budget.vertices > WILDFIRE_LIMITS.vertices) throw wildfireError('overflow', 'Too much fire detail. Zoom in.');
        return [point[0], point[1]];
    };
    const ring = value => {
        if (!Array.isArray(value) || value.length < 4 || value.length > WILDFIRE_LIMITS.vertices) invalid();
        const points = value.map(coordinate), first = points[0], last = points.at(-1);
        if (first[0] !== last[0] || first[1] !== last[1] || points.some((point, index) => index > 0 && Math.abs(point[0] - points[index - 1][0]) > 180)) invalid();
        return points;
    };
    const polygon = value => {
        if (!Array.isArray(value) || !value.length || value.length > 1000) invalid();
        const rings = value.map(ring), outer = rings[0];
        if (new Set(outer.map(point => point.join(','))).size < 3) invalid();
        const inside = point => {
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
    let normalized;
    if (kind === 'incidents' && geometry?.type === 'Point') normalized = { type: 'Point', coordinates: coordinate(geometry.coordinates) };
    else if (kind === 'perimeters' && geometry?.type === 'Polygon') normalized = { type: 'Polygon', coordinates: polygon(geometry.coordinates) };
    else if (kind === 'perimeters' && geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.length <= 1000)
        normalized = { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon) };
    else invalid();
    const incident = kind === 'incidents', a = uuid(p.poly_IRWINID), b = uuid(p.attr_IrwinID);
    const properties = { id: `nifc:${incident ? 'incident' : 'perimeter'}:${p.OBJECTID}`, objectId: p.OBJECTID,
        fireId: incident ? uuid(p.IrwinID) : a && b && a !== b ? null : a || b,
        name: clean(incident ? p.IncidentName : p.poly_IncidentName) || 'Unnamed reported fire',
        incidentUpdated: date(incident ? p.ModifiedOnDateTime_dt : p.attr_ModifiedOnDateTime_dt),
        perimeterObserved: incident ? null : date(p.poly_PolygonDateTime), perimeterEdited: incident ? null : date(p.poly_DateCurrent),
        acres: amount(incident ? p.IncidentSize : p.poly_GISAcres, 100000000), contained: amount(incident ? p.PercentContained : p.attr_PercentContained, 100) };
    return { type: 'Feature', id: properties.id, properties, geometry: normalized };
}
// Typed metadata only; geometry and provider URLs never cross the map bridge.
export function readWildfireRecords(value) {
    if (!Array.isArray(value) || value.length > 4000) return [];
    const seen = new Set();
    return value.filter(record => typeof record?.id === 'string' && record.id.length <= 40 && /^nifc:(incident|perimeter):\d+$/.test(record.id) && !seen.has(record.id) && seen.add(record.id)).map(record => ({
        id: record.id, name: clean(record.name) || 'Unnamed reported fire', incidentUpdated: date(record.incidentUpdated),
        perimeterObserved: date(record.perimeterObserved), perimeterEdited: date(record.perimeterEdited),
        acres: amount(record.acres, 100000000), contained: amount(record.contained, 100), hasPerimeter: record.hasPerimeter === true,
    }));
}
export function wildfireRecords(incidents, perimeters) {
    const records = incidents.map(feature => ({ ...feature.properties, hasPerimeter: false }));
    const owners = new Map();
    for (const record of records) if (record.fireId) owners.set(record.fireId, [...(owners.get(record.fireId) || []), record]);
    for (const feature of perimeters) {
        const p = feature.properties, matches = p.fireId && owners.get(p.fireId);
        if (matches?.length === 1) {
            const record = matches[0], previous = record.hasPerimeter; record.hasPerimeter = true;
            record.perimeterObserved = !previous ? p.perimeterObserved : record.perimeterObserved && p.perimeterObserved ? Math.min(record.perimeterObserved, p.perimeterObserved) : null;
            record.perimeterEdited = Math.max(record.perimeterEdited || 0, p.perimeterEdited || 0) || null;
        } else records.push({ ...p, hasPerimeter: true });
    }
    return readWildfireRecords(records).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// Leaflet projects raw longitudes; choose the same wrapped world as the map.
// This is a renderer copy, never a change to normalized provider geometry.
export function wildfireWorldCopy(feature, longitude) {
    const shift = first => 360 * Math.round((longitude - first[0]) / 360);
    const move = (points, offset) => points.map(point => [point[0] + offset, point[1]]);
    const polygon = rings => { const offset = shift(rings[0][0]); return rings.map(ring => move(ring, offset)); };
    const g = feature.geometry;
    const coordinates = g.type === 'Point' ? [g.coordinates[0] + shift(g.coordinates), g.coordinates[1]]
        : g.type === 'Polygon' ? polygon(g.coordinates) : g.coordinates.map(polygon);
    return { ...feature, geometry: { type: g.type, coordinates } };
}
