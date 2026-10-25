// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.js';
import { WILDFIRE_LIMITS as limits, wildfireBoxes, readWildfireFeature, wildfireError } from './wildfire-core.js';
const sources = {
    incidents: { service: 'Incident_Locations', where: "IncidentTypeCategory='WF'", fields: 'OBJECTID,IncidentTypeCategory,IrwinID,IncidentName,IncidentSize,PercentContained,ModifiedOnDateTime_dt' },
    perimeters: { service: 'Interagency_Perimeters', where: "attr_IncidentTypeCategory='WF'", fields: 'OBJECTID,attr_IncidentTypeCategory,poly_IRWINID,attr_IrwinID,poly_IncidentName,poly_GISAcres,poly_DateCurrent,poly_PolygonDateTime,attr_ModifiedOnDateTime_dt,attr_PercentContained' },
};
export function wildfireQuery(kind, bounds, offset = 0) {
    const source = sources[kind]; if (!source || !Number.isInteger(offset) || offset < 0 || offset >= limits.pages * limits.pageSize) throw wildfireError('invalid', 'Invalid fire request.');
    if (wildfireBoxes(bounds).length !== 1) throw wildfireError('invalid', 'Split wrapped fire requests first.');
    const url = new URL(`https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_${source.service}_Current/FeatureServer/0/query`);
    Object.entries({ f: 'geojson', where: source.where, outFields: source.fields, geometry: bounds.join(','), geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects', inSR: 4326, outSR: 4326, returnGeometry: true, returnZ: false, returnM: false,
        orderByFields: 'OBJECTID ASC', resultRecordCount: limits.pageSize, resultOffset: offset }).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.href;
}
export async function fetchWildfireComponent(kind, bounds, { fetchImpl = globalThis.fetch, signal, budget = { bytes: 0, vertices: 0 }, timeoutMs = 20000 } = {}) {
    const deadline = requestDeadline.createRequestDeadline(timeoutMs), features = [], seen = new Set();
    let rejectCancel, response;
    const cancellation = new Promise((_, reject) => { rejectCancel = reject; }); cancellation.catch(() => {});
    const cancel = () => { deadline.abort(); rejectCancel(new DOMException('Cancelled.', 'AbortError')); };
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const run = promise => deadline.run(Promise.race([promise, cancellation]));
    try {
        if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
        let totalPages = 0;
        for (const box of wildfireBoxes(bounds)) {
            let last = 0;
            for (let offset = 0; ;) {
                if (++totalPages > limits.pages) throw wildfireError('overflow', 'Too many reported fires. Zoom in.');
                let retried = false, pageComplete = false, received = 0;
                while (true) {
                    response = await run(fetchImpl(wildfireQuery(kind, box, offset), { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }));
                    if (response.status === 429) { const error = rateLimitError('NIFC', response); error.retryAt ||= Date.now() + 300000; throw error; }
                    if ([502, 503, 504].includes(response.status) && !retried) { cancelResponseBody(response); retried = true; continue; }
                    if (!response.ok) throw wildfireError('service', 'Fire reports could not be loaded.');
                    if (!/json/i.test(response.headers.get('content-type') || '')) throw wildfireError('invalid-response', 'Invalid fire response.');
                    const text = await run(readBoundedResponseText(response, { maxBytes: limits.pageBytes, signal: deadline.signal, label: 'Fire response' }));
                    budget.bytes += new TextEncoder().encode(text).byteLength;
                    if (budget.bytes > limits.bytes) throw wildfireError('overflow', 'Too much fire detail. Zoom in.');
                    let body; try { body = JSON.parse(text); } catch { throw wildfireError('invalid-response', 'Invalid fire response.'); }
                    if (body.error) {
                        if (body.error.code === 429) throw Object.assign(wildfireError('rate-limit', 'Fire service is busy.'), { retryAt: Date.now() + 300000 });
                        throw wildfireError('service', 'Fire reports could not be loaded.');
                    }
                    if (body.crs && !['EPSG:4326', 'urn:ogc:def:crs:OGC:1.3:CRS84'].includes(body.crs.properties?.name)) throw wildfireError('invalid-response', 'Unexpected fire coordinate system.');
                    if (body.type !== 'FeatureCollection' || !Array.isArray(body.features) || body.features.length > limits.pageSize) throw wildfireError('invalid-response', 'Invalid fire collection.');
                    received = body.features.length;
                    const more = body.exceededTransferLimit === true || body.properties?.exceededTransferLimit === true;
                    if (more && !body.features.length) throw wildfireError('invalid-response', 'Incomplete fire reports.');
                    for (const raw of body.features) {
                        const feature = readWildfireFeature(raw, kind, budget), id = feature.properties.objectId;
                        if (id <= last) throw wildfireError('invalid-response', 'Fire reports changed while loading. Retry.');
                        last = id;
                        if (!seen.has(feature.id)) { seen.add(feature.id); features.push(feature); }
                    }
                    cancelResponseBody(response); response = null;
                    pageComplete = !more && body.features.length < limits.pageSize;
                    // A full page without a truncation flag needs an empty/short
                    // confirmation page; never infer completeness from its size.
                    break;
                }
                if (pageComplete) break;
                offset += received;
            }
        }
        if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
        return features;
    } finally { cancelResponseBody(response); deadline.clear(); signal?.removeEventListener('abort', cancel); }
}
