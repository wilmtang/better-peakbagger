// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settingsSchema as Schema } from '../settings/settings-schema.ts';
import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { cancelResponseBody, rateLimitError } from '../net/rate-limit.js';
import { SNOW_DEPTH_SERVICE, SNOW_DEPTH_BOUNDS } from './snow-depth.js';
import { landCoverage, AB_LAND_SERVICE } from './canadian-land.js';

export interface InspectionPoint { latitude: number; longitude: number; x: number; y: number; }
export interface LayerLegendEntry { label: string; color?: string; image?: string; value?: string; }
export interface LayerStatus {
    legend?: string; legendEntries?: LayerLegendEntry[]; retryAt?: number; permission?: boolean;
    pending?: boolean; error?: boolean; partial?: boolean; saved?: boolean; overflow?: boolean;
    unavailable?: boolean; uncovered?: boolean; retry?: boolean; message?: string; count?: number;
    capturePending?: boolean; captureError?: boolean; analysisTime?: number; metadataError?: boolean; metadataPending?: boolean;
    captures?: { id: string; label: string; title?: string }[]; capture?: string;
    guidanceKeys?: string[]; fires?: unknown[];
}
export interface LayerControlModel {
    state?: unknown; landTypes?: unknown; statuses?: Record<string, LayerStatus>;
    zoom?: number; coverage?: Record<string, boolean>; theme?: string; available?: string[];
}
export interface LayerInspectionContext {
    state: ReturnType<typeof Schema.mapOverlayState>; landTypes: string[];
    statuses: Record<string, LayerStatus>; zoom: number; coverage: Record<string, boolean>;
}
interface InspectionSource { at(point: InspectionPoint): LayerInspectionContext | null; }
const sources = new WeakMap<Document, Set<InspectionSource>>();
const subscribers = new WeakMap<Document, Set<() => void>>();

export function registerLayerInspection(doc: Document, source: InspectionSource) {
    if (!sources.has(doc)) sources.set(doc, new Set());
    sources.get(doc)!.add(source);
    return () => sources.get(doc)?.delete(source);
}
export function inspectionContext(doc: Document, point: InspectionPoint): LayerInspectionContext | null {
    for (const source of [...sources.get(doc) || []].reverse()) {
        const context = source.at(point); if (context) return context;
    }
    return null;
}
export function subscribeLayerInspection(doc: Document, callback: () => void) {
    if (!subscribers.has(doc)) subscribers.set(doc, new Set());
    subscribers.get(doc)!.add(callback);
    return () => subscribers.get(doc)?.delete(callback);
}
export function notifyLayerInspection(doc: Document) { subscribers.get(doc)?.forEach(callback => callback()); }

export interface LayerReading { value: string; detail: string; }
export interface InspectableMapLayer {
    readonly id: string;
    readonly label: string;
    applicable(context: LayerInspectionContext, point: InspectionPoint): boolean;
    rightClick(point: InspectionPoint, context: LayerInspectionContext, signal: AbortSignal): Promise<LayerReading>;
}
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
const validPoint = (point: InspectionPoint) => Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
    && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
const unavailable = (detail: string): LayerReading => ({ value: 'Unavailable', detail });

abstract class QueryLayer implements InspectableMapLayer {
    abstract readonly id: string;
    abstract readonly label: string;
    private retryAt = 0;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;
    constructor(fetchImpl: typeof fetch, timeoutMs = 8000) { this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; }
    applicable(context: LayerInspectionContext, point: InspectionPoint) {
        const state = context.state[this.id];
        return !!state?.enabled && state.opacity > 0 && context.coverage[this.id] !== false && validPoint(point) && (this.id === 'snow' ? context.zoom : Math.round(context.zoom)) >= 8;
    }
    abstract rightClick(point: InspectionPoint, context: LayerInspectionContext, signal: AbortSignal): Promise<LayerReading>;
    protected async json(url: URL, context: LayerInspectionContext, signal: AbortSignal, point: InspectionPoint): Promise<JsonRecord> {
        if (Math.max(this.retryAt, context.statuses[this.id]?.retryAt || 0) > Date.now()) throw new Error('Service busy');
        if (!this.applicable(context, point)) throw new Error('Layer is not applicable');
        const deadline = requestDeadline.createRequestDeadline(this.timeoutMs);
        let rejectCancel: (reason: Error) => void = () => {};
        const cancelled = new Promise<never>((_, reject) => { rejectCancel = reject; });
        const abort = () => { deadline.abort(); rejectCancel(new DOMException('Cancelled.', 'AbortError')); };
        const run = <T>(promise: Promise<T>): Promise<T> => deadline.run(Promise.race([promise, cancelled]));
        signal.addEventListener('abort', abort, { once: true });
        let response: Response | undefined;
        try {
            signal.throwIfAborted();
            const received: Response = await run(this.fetchImpl(url.href, {
                signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-cache',
            }));
            response = received;
            signal.throwIfAborted();
            if (response.status === 429) {
                this.retryAt = rateLimitError(this.label, response).retryAt || Date.now() + 300000;
                throw new Error('Service busy');
            }
            if (!response.ok || !/json|text\/plain/i.test(response.headers.get('content-type') || '')) throw new Error('Point data unavailable');
            const result: unknown = JSON.parse(await run(readBoundedResponseText(response,
                { maxBytes: 65536, signal: deadline.signal, label: 'Layer point information' })));
            signal.throwIfAborted();
            const data = record(result);
            if (data.error || data.exceededTransferLimit) throw new Error('Incomplete point data');
            return data;
        } finally { cancelResponseBody(response); deadline.clear(); signal.removeEventListener('abort', abort); }
    }
}

export function snowDepthPointReading(value: unknown, legend: LayerLegendEntry[]): LayerReading {
    const data = record(value);
    const results = Array.isArray(data.results) ? data.results.filter(item => record(item).layerId === 3) : [];
    if (results.length !== 1) return unavailable('NOAA ArcGIS · no depth estimate at this point');
    const attributes = record(record(results[0]).attributes), index = numeric(attributes['Classify.Class value']);
    // Read the actual displayed renderer class. Service Pixel Value is not an
    // independently verified inch measurement and must never be labelled as one.
    if (index === null || !Number.isInteger(index) || index < 0 || index >= legend.length
        || !/^\d+(?:\.\d+)?–\d+(?:\.\d+)? in$/.test(legend[index].label)) return unavailable('NOAA ArcGIS · no depth estimate at this point');
    return { value: legend[index].label, detail: 'NOAA NOHRSC ArcGIS · modeled depth band, about 1 km resolution' };
}
export class SnowDepthLayer extends QueryLayer {
    readonly id = 'snow'; readonly label = 'Snow depth';
    override applicable(context: LayerInspectionContext, point: InspectionPoint) {
        return super.applicable(context, point) && point.longitude >= SNOW_DEPTH_BOUNDS[0] && point.longitude <= SNOW_DEPTH_BOUNDS[2]
            && point.latitude >= SNOW_DEPTH_BOUNDS[1] && point.latitude <= SNOW_DEPTH_BOUNDS[3];
    }
    async rightClick(point: InspectionPoint, context: LayerInspectionContext, signal: AbortSignal) {
        const url = new URL(`${SNOW_DEPTH_SERVICE}/identify`);
        for (const [key, value] of Object.entries({ geometry: `${point.longitude},${point.latitude}`, geometryType: 'esriGeometryPoint',
            sr: '4326', layers: 'all:3', tolerance: '0', mapExtent: [point.longitude - .01, point.latitude - .01, point.longitude + .01, point.latitude + .01].join(','),
            imageDisplay: '256,256,96', returnGeometry: 'false', f: 'json' })) url.searchParams.set(key, value);
        const result = await this.json(url, context, signal, point);
        return snowDepthPointReading(result, context.statuses.snow?.legendEntries || []);
    }
}
export class PublicLandLayer extends QueryLayer {
    readonly id = 'land'; readonly label = 'Public lands';
    override applicable(context: LayerInspectionContext, point: InspectionPoint) { return super.applicable(context, point) && context.landTypes.length > 0; }
    async rightClick(point: InspectionPoint, context: LayerInspectionContext, signal: AbortSignal) {
        const coverage = landCoverage([point.longitude - .00001, point.latitude - .00001, point.longitude + .00001, point.latitude + .00001]);
        if (!coverage.includes('us')) {
            if (!coverage.includes('ab')) return unavailable(coverage.includes('bc')
                ? 'ParcelMap BC point inspection is unavailable; the overlay’s optional image access is not a parcel query grant.'
                : 'No parcel point coverage here. Clear areas do not establish private ownership or access rights.');
            const selected = new Set(Schema.mapLandTypes(context.landTypes));
            const classes = [['CROWN', 'Provincial'], ['LOC', 'Municipal']].filter(([type]) => selected.has(type));
            if (!classes.length) return { value: 'No selected type', detail: 'Alberta regional parcels · selected land types only' };
            const url = new URL(`${AB_LAND_SERVICE}/query`);
            for (const [key, value] of Object.entries({ geometry: `${point.longitude},${point.latitude}`, geometryType: 'esriGeometryPoint',
                inSR: '4326', spatialRel: 'esriSpatialRelIntersects', where: `crownclass IN (${classes.map(([, owner]) => `'${owner}'`).join(',')})`,
                outFields: 'crownclass', returnGeometry: 'false', resultRecordCount: '8', f: 'json' })) url.searchParams.set(key, value);
            const data = await this.json(url, context, signal, point);
            if (!Array.isArray(data.features) || data.features.length > 8) return unavailable('Alberta regional parcels · invalid parcel response');
            const owners = [...new Set(data.features.map(feature => record(record(feature).attributes).crownclass)
                .filter(owner => classes.some(([, value]) => value === owner)))];
            return { value: owners.length ? owners.length > 1 ? 'Crown / municipal' : owners[0] === 'Provincial' ? 'Crown land' : 'Municipal' : 'No mapped parcel',
                detail: 'Alberta regional parcel ownership · partial coverage; ownership does not establish access or camping rights.' };
        }
        const url = new URL('https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/0/query');
        const selected = new Set(Schema.mapLandTypes(context.landTypes));
        const predicates = [...selected].filter(type => ['FED', 'STAT', 'LOC', 'TRIB'].includes(type)).map(type =>
            type === 'LOC' ? "Own_Type IN ('LOC','DIST')" : type === 'FED' ? "(Own_Type='FED' AND (Mang_Name NOT IN ('BLM','USFS') OR Mang_Name IS NULL))" : `Own_Type='${type}'`);
        for (const type of ['BLM', 'USFS']) if (selected.has(type)) predicates.push(`(Own_Type='FED' AND Mang_Name='${type}')`);
        if (!predicates.length) return { value: 'No selected type', detail: 'USGS PAD-US · selected land types only' };
        for (const [key, value] of Object.entries({ geometry: `${point.longitude},${point.latitude}`, geometryType: 'esriGeometryPoint',
            inSR: '4326', spatialRel: 'esriSpatialRelIntersects', where: predicates.join(' OR '), outFields: 'Own_Type,Mang_Name,Unit_Nm',
            returnGeometry: 'false', resultRecordCount: '8', f: 'json' })) url.searchParams.set(key, value);
        const data = await this.json(url, context, signal, point);
        if (!Array.isArray(data.features) || data.features.length > 8) return unavailable('USGS PAD-US · invalid parcel response');
        const categories = new Set<string>(), names: string[] = [];
        for (const feature of data.features) {
            const a = record(record(feature).attributes), owner = a.Own_Type, manager = a.Mang_Name;
            const type = owner === 'FED' && (manager === 'BLM' || manager === 'USFS') ? manager : owner === 'DIST' ? 'LOC' : owner;
            if (typeof type !== 'string' || !selected.has(type)) continue;
            categories.add(({ FED: 'Other federal', STAT: 'State', LOC: 'Local / district', TRIB: 'Tribal' } as Record<string, string>)[type] || type);
            if (typeof a.Unit_Nm === 'string') names.push(a.Unit_Nm.slice(0, 120));
        }
        return { value: categories.size ? categories.size > 1 ? `${categories.size} land types` : [...categories][0] : 'No mapped parcel',
            detail: `USGS PAD-US 4.1 · ${[...categories].join(' · ') || 'No selected parcel'}${names.length ? ' · ' + names.slice(0, 2).join(' · ') : ''}. Ownership does not establish access or camping rights.` };
    }
}
export class SlopeLayer extends QueryLayer {
    readonly id = 'slope'; readonly label = 'Slope angle';
    async rightClick(point: InspectionPoint, context: LayerInspectionContext, signal: AbortSignal) {
        const url = new URL('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/identify');
        for (const [key, value] of Object.entries({ geometry: `${point.longitude},${point.latitude}`, geometryType: 'esriGeometryPoint',
            sr: '4326', renderingRule: JSON.stringify({ rasterFunction: 'Slope Degrees' }), returnGeometry: 'false', returnCatalogItems: 'false', f: 'json' })) url.searchParams.set(key, value);
        const data = await this.json(url, context, signal, point), angle = numeric(data.value);
        return angle !== null && angle >= 0 && angle <= 90 ? { value: `≈ ${angle.toFixed(1)}°`, detail: 'USGS 3DEP · ground slope estimate, not an avalanche forecast' }
            : unavailable('USGS 3DEP · no slope estimate at this point');
    }
}
export const POINT_INSPECTION_DECISIONS = Object.freeze({
    snow: 'query', land: 'query', slope: 'query',
    sentinel: 'Imagery has no scalar point value; capture details are in Overlays.',
    snotel: 'Station markers have their own observation popups.',
    wildfire: 'Incident markers and perimeters have their own reported-data popups.',
});
export function createInspectionLayers(fetchImpl: typeof fetch): InspectableMapLayer[] {
    return [new SnowDepthLayer(fetchImpl), new PublicLandLayer(fetchImpl), new SlopeLayer(fetchImpl)];
}
