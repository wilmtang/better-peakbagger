// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readBoundedResponseText } from '../net/bounded-text.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';
import regionData from './canadian-land-regions.json' with { type: 'json' };

export const BC_LAND_ORIGIN = 'https://maps.gov.bc.ca';
export const BC_LAND_PERMISSION = { origins: [`${BC_LAND_ORIGIN}/*`] };
export const AB_LAND_SERVICE = 'https://geospatial.alberta.ca/arcgis/rest/services/Hosted/Land_use_owndership_NN_project/FeatureServer/10';
export const CANADIAN_LAND_CLASSES = Object.freeze([
    { value: 'CROWN', label: 'Crown land', color: [230, 159, 0] },
    { value: 'FED', label: 'Federal', color: [145, 145, 145] },
    { value: 'AGENCY', label: 'Crown agency', color: [145, 145, 145] },
    { value: 'LOC', label: 'Municipal', color: [174, 133, 150] },
    { value: 'FIRST_NATIONS', label: 'First Nations', color: [105, 151, 131] },
]);
const color = id => CANADIAN_LAND_CLASSES.find(category => category.value === id).color;
const bcTypes = { 'Crown Provincial': 'CROWN', Federal: 'FED', 'Crown Agency': 'AGENCY', 'Local Government': 'LOC', 'First Nations': 'FIRST_NATIONS' };
export const BC_LAND_RENDERER = { type: 'uniqueValue', field1: 'OWNER_TYPE',
    defaultSymbol: { type: 'esriSFS', style: 'esriSFSNull', outline: null },
    uniqueValueInfos: Object.entries(bcTypes).map(([value, category]) => ({ value, symbol: {
        type: 'esriSFS', style: 'esriSFSSolid', color: [...color(category), 255],
        outline: { type: 'esriSLS', style: 'esriSLSSolid', color: [...color(category), 255], width: 0.6 },
    } })) };

export const LAND_COVERAGE = Object.freeze({
    bc: [-139.2, 48.2, -114, 60.1], ab: [-120, 49, -110, 60.1],
    us: [[-125, 17, -65, 49.5], [-180, 51, -129, 72], [172, 51, 180, 54], [-161, 18, -154, 23]],
});
// Published query extent of Alberta's regional ownership layer (WGS84).
export const ALBERTA_PARCEL_EXTENT = [-117.84844, 49.13891, -113.58162, 53.64552];
export const intersectsLandBounds = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const provinceRings = Object.fromEntries(Object.entries(regionData.regions).map(([province, rings]) => [province, rings.map(ring => ({ ring,
    bbox: [Math.min(...ring.map(point => point[0])), Math.min(...ring.map(point => point[1])), Math.max(...ring.map(point => point[0])), Math.max(...ring.map(point => point[1]))],
}))]));
const inRing = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};
const provinceIntersects = (bounds, province) => {
    // Conservative 0.05-degree padding avoids gaps at the coarse outline.
    // This selects services only; ownership always comes from parcel records.
    const b = [bounds[0] - 0.05, bounds[1] - 0.05, bounds[2] + 0.05, bounds[3] + 0.05];
    return provinceRings[province].some(({ ring, bbox }) => {
        if (!intersectsLandBounds(b, bbox)) return false;
        if ([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].some(([x, y]) => inRing(x, y, ring))) return true;
        return ring.some((point, i) => {
            const previous = ring[(i + ring.length - 1) % ring.length];
            return intersectsLandBounds(b, [Math.min(point[0], previous[0]), Math.min(point[1], previous[1]), Math.max(point[0], previous[0]), Math.max(point[1], previous[1])]);
        });
    });
};
export function landCoverage(bounds) {
    if (!bounds) return ['us'];
    const center = (bounds[0] + bounds[2]) / 2, shift = Math.floor((center + 180) / 360) * 360;
    const wrapped = [bounds[0] - shift, bounds[1], bounds[2] - shift, bounds[3]];
    return ['us', 'bc', 'ab'].filter(id => [-360, 0, 360].some(offset => {
        const candidate = [wrapped[0] + offset, wrapped[1], wrapped[2] + offset, wrapped[3]];
        return id === 'us' ? LAND_COVERAGE.us.some(extent => intersectsLandBounds(candidate, extent)) : provinceIntersects(candidate, id);
    }));
}
export function bcLandTileUrl(bbox) {
    const url = new URL(`${BC_LAND_ORIGIN}/arcgis/rest/services/whse/bcgw_pub_whse_cadastre/MapServer/export`);
    const params = { bbox: bbox.join(','), bboxSR: '3857', imageSR: '3857', size: '256,256', format: 'png32', f: 'image', transparent: 'true',
        dynamicLayers: JSON.stringify([{ id: 0, source: { type: 'mapLayer', mapLayerId: 0 }, minScale: 0, maxScale: 0,
            drawingInfo: { renderer: BC_LAND_RENDERER, showLabels: false } }]) };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value)); return url.href;
}

// Alberta's published layer is regional, not a province-wide ownership fabric.
// Fetch only ownership class and geometry, never owner names or addresses.
export function albertaLandTileUrl(bbox, offset = 0) {
    const url = new URL(`${AB_LAND_SERVICE}/query`);
    const params = { f: 'json', where: "crownclass IN ('Provincial','Municipal')", outFields: 'objectid,crownclass',
        geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects', inSR: '3857', outSR: '3857',
        returnGeometry: 'true', returnZ: 'false', returnM: 'false', maxAllowableOffset: String((bbox[2] - bbox[0]) / 512),
        orderByFields: 'objectid ASC', resultRecordCount: '500', resultOffset: String(offset) };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value)); return url.href;
}
export async function drawAlbertaLand({ context, bbox, fetchImpl, signal }) {
    const deadline = requestDeadline.createRequestDeadline();
    const abort = () => deadline.abort(); signal.addEventListener('abort', abort, { once: true });
    let vertices = 0; const seen = new Set(), span = bbox[2] - bbox[0];
    try {
        for (let page = 0; page < 4; page++) {
            if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
            const response = await deadline.run(fetchImpl(albertaLandTileUrl(bbox, page * 500), {
                signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
            }));
            if (response.status === 429) throw rateLimitError('Alberta map service', response);
            if (!response.ok) throw new Error('Alberta parcels unavailable.');
            const data = JSON.parse(await deadline.run(readBoundedResponseText(response, { maxBytes: 4 * 1024 * 1024, maxChars: 4 * 1024 * 1024, signal: deadline.signal })));
            if (data.error || ![3857, 102100].includes(data.spatialReference?.wkid) || !Array.isArray(data.features) || data.features.length > 500) throw new Error('Invalid Alberta parcels.');
            for (const feature of data.features) {
                const id = feature.attributes?.objectid, category = feature.attributes?.crownclass;
                if (!Number.isSafeInteger(id) || seen.has(id)) throw new Error('Invalid Alberta parcel identity.'); seen.add(id);
                if (!['Provincial', 'Municipal'].includes(category)) continue;
                const rings = feature.geometry?.rings;
                if (!Array.isArray(rings) || rings.length > 5000) throw new Error('Invalid Alberta parcel geometry.');
                context.beginPath();
                for (const ring of rings) {
                    if (!Array.isArray(ring) || ring.length < 4 || (vertices += ring.length) > 50000) throw new Error('Alberta parcels need a closer zoom.');
                    for (let i = 0; i < ring.length; i++) {
                        const point = ring[i];
                        if (!Array.isArray(point) || point.length !== 2 || !point.every(value => Number.isFinite(value) && Math.abs(value) <= 25000000)) throw new Error('Invalid Alberta parcel coordinate.');
                        const x = (point[0] - bbox[0]) / span * 256, y = (bbox[3] - point[1]) / span * 256;
                        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
                    }
                    context.closePath();
                }
                context.fillStyle = `rgb(${color(category === 'Provincial' ? 'CROWN' : 'LOC').join(',')})`; context.fill('evenodd');
            }
            if (data.exceededTransferLimit !== true) return;
            if (data.features.length !== 500) throw new Error('Incomplete Alberta parcels.');
        }
        throw new Error('Too many Alberta parcels. Zoom in.');
    } finally { signal.removeEventListener('abort', abort); deadline.clear(); }
}
