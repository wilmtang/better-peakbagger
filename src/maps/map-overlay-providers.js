// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CANADIAN_LAND_CLASSES, landCoverage, bcLandTileUrl, albertaLandTileUrl, intersectsLandBounds, regionCoverage, US_REGIONS, US_TERRITORY_BOUNDS } from './canadian-land.js';
import { SENTINEL_LATITUDES } from './sentinel-core.js';
import { settingsSchema as Schema } from '../settings/settings-schema.js';

export const OVERLAY_MIN_ZOOM = 8;
const SNOW_REGIONS = ['ak', 'az', 'ca', 'co', 'id', 'mt', 'nm', 'nv', 'or', 'sd', 'ut', 'wa', 'wy'].map(state => `us_${state}`);
// 3DEP includes lower-resolution Canada/Mexico/Central America/Caribbean data.
// These are conservative service envelopes, not a promise of data per pixel.
const SLOPE_BOUNDS = [[-180, 5, -50, 84], [172, 50, 180, 55], [-161, 18, -154, 23], ...US_TERRITORY_BOUNDS];
const intersectsWrapped = (bounds, extents) => {
    const shift = Math.floor(((bounds[0] + bounds[2]) / 2 + 180) / 360) * 360;
    return [-360, 0, 360].some(offset => extents.some(extent => intersectsLandBounds(
        [bounds[0] - shift + offset, bounds[1], bounds[2] - shift + offset, bounds[3]], extent)));
};
export function mapOverlayCoverage(value) {
    const bounds = overlayBounds(value); if (!bounds) return null; // Unknown is not evidence of no coverage.
    const longitudePadding = 0.55 / Math.max(0.08, Math.cos(Math.max(Math.abs(bounds[1]), Math.abs(bounds[3])) * Math.PI / 180));
    return {
        wildfire: regionCoverage(bounds, US_REGIONS),
        sentinel: bounds[3] >= SENTINEL_LATITUDES[0] && bounds[1] <= SENTINEL_LATITUDES[1],
        slope: intersectsWrapped(bounds, SLOPE_BOUNDS),
        land: landCoverage(bounds).length > 0,
        // Preserve nearby discovery across state/country borders within 50 km.
        snotel: regionCoverage(bounds, SNOW_REGIONS, 0.55, longitudePadding),
    };
}

// One color contract drives both the service request and the visible legend.
export const SLOPE_BANDS = Object.freeze([
    { from: 20, to: 30, color: [245, 220, 76] },
    { from: 30, to: 35, color: [240, 151, 48] },
    { from: 35, to: 40, color: [218, 67, 51] },
    { from: 40, to: 45, color: [151, 51, 126] },
    { from: 45, to: 91, color: [70, 45, 112] },
]);
export const SLOPE_RULE = {
    rasterFunction: 'Colormap', rasterFunctionArguments: {
        Colormap: SLOPE_BANDS.map((band, i) => [i + 1, ...band.color]),
        Raster: { rasterFunction: 'Remap', rasterFunctionArguments: {
            InputRanges: SLOPE_BANDS.flatMap(band => [band.from, band.to]),
            OutputValues: SLOPE_BANDS.map((_, i) => i + 1), AllowUnmatched: false,
            Raster: { rasterFunction: 'Slope Degrees' },
        } },
    },
};
export const LAND_CLASSES = Object.freeze([
    { value: 'BLM', label: 'BLM', color: [230, 159, 0] },
    { value: 'USFS', label: 'USFS', color: [0, 114, 178] },
    { value: 'FED', label: 'Other federal', color: [145, 145, 145] },
    { value: 'STAT', label: 'State', color: [151, 132, 166] },
    { value: 'LOC', label: 'Local', color: [174, 133, 150] },
    { value: 'DIST', label: 'District', color: [174, 133, 150] },
    { value: 'TRIB', label: 'Tribal', color: [105, 151, 131] },
]);
const landAgencies = LAND_CLASSES.filter(category => ['BLM', 'USFS'].includes(category.value));
const symbol = color => ({ type: 'esriSFS', style: 'esriSFSSolid', color: [...color, 255],
    outline: { type: 'esriSLS', style: 'esriSLSSolid', color: [...color, 255], width: 0.6 } });
export const LAND_RENDERER = { type: 'uniqueValue', field1: 'Own_Type',
    defaultSymbol: { type: 'esriSFS', style: 'esriSFSNull', outline: null },
    uniqueValueInfos: LAND_CLASSES.filter(category => !landAgencies.includes(category)).map(category => ({ value: category.value, label: category.label, symbol: symbol(category.color) })) };

export const OVERLAY_ATTRIBUTION = {
    slope: '<a href="https://www.usgs.gov/3d-elevation-program">USGS 3DEP</a>',
    land: '<a href="https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview">USGS PAD-US 4.1</a> · <a href="https://catalogue.data.gov.bc.ca/dataset/parcelmap-bc-parcel-fabric">ParcelMap BC</a> · <a href="https://geospatial.alberta.ca/arcgis/rest/services/Hosted/Land_use_owndership_NN_project/FeatureServer/10">Alberta Crown parcels</a>',
};
export function rasterTileStatus(id, activity) {
    const land = id === 'land';
    return { pending: activity.pending, error: activity.error, partial: activity.partial === true,
        permission: land && activity.permission === true, retryAt: land ? activity.retryAt || 0 : 0,
        ...(land ? { providerCooldowns: activity.providerCooldowns || {} } : {}),
        message: activity.permission ? activity.partial ? 'BC maps need access. Other land coverage is shown.' : 'Allow BC parcel maps.'
            : activity.error ? activity.partial ? land ? 'Some land coverage couldn’t load. Available coverage is shown.' : 'Some slope tiles couldn’t load. Available shading is still shown.'
                : land ? 'Land coverage couldn’t load. Try again.' : 'Slope shading couldn’t load. Try again.'
                : activity.pending ? land ? 'Loading public lands' : 'Loading slope shading' : '' };
}
export function tileBounds({ z, x, y }) {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 24 || y < 0 || y >= 2 ** z) throw new Error('Invalid overlay tile.');
    const n = 2 ** z, wrapped = (x % n + n) % n, span = 40075016.68557849 / n;
    return [-20037508.342789244 + wrapped * span, 20037508.342789244 - (y + 1) * span,
        -20037508.342789244 + (wrapped + 1) * span, 20037508.342789244 - y * span];
}
export function overlayTileUrl(id, coordinates, landTypes) {
    const bbox = tileBounds(coordinates).join(',');
    let url;
    const params = { bbox, bboxSR: '3857', imageSR: '3857', size: '256,256', format: 'png32', f: 'image' };
    if (id === 'slope') {
        url = new URL('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage');
        params.renderingRule = JSON.stringify(SLOPE_RULE);
        params.interpolation = 'RSP_NearestNeighbor';
    } else if (id === 'land') {
        const selected = Schema.mapLandTypes(landTypes);
        const owners = LAND_CLASSES.filter(category => !landAgencies.includes(category) && selected.includes(category.value === 'DIST' ? 'LOC' : category.value));
        url = new URL('https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/export');
        params.transparent = 'true';
        // ArcGIS draws the first layer on top. All passes are one opaque image;
        // the map engine applies the user's opacity once, after composition.
        // Fee ownership plus manager avoids treating designation boundaries or
        // holdings managed by another agency as BLM/USFS-managed land.
        params.dynamicLayers = JSON.stringify([
            ...landAgencies.filter(category => selected.includes(category.value)).map((category, index) => ({ id: index + 1, source: { type: 'mapLayer', mapLayerId: 0 },
                definitionExpression: `Own_Type = 'FED' AND Mang_Name = '${category.value}'`,
                drawingInfo: { renderer: { type: 'simple', symbol: symbol(category.color) } } })),
            { id: 0, source: { type: 'mapLayer', mapLayerId: 0 },
                // Otherwise deselected BLM/USFS parcels would reappear as gray
                // "Other federal" through the generic federal ownership pass.
                definitionExpression: owners.length ? `Own_Type IN (${owners.map(item => `'${item.value}'`).join(',')})`
                    + (selected.includes('FED') ? " AND (Own_Type <> 'FED' OR Mang_Name NOT IN ('BLM','USFS') OR Mang_Name IS NULL)" : '') : '1=0',
                drawingInfo: { renderer: { ...LAND_RENDERER, uniqueValueInfos: LAND_RENDERER.uniqueValueInfos.filter(item => owners.some(owner => owner.value === item.value)) } } },
        ]);
    } else throw new Error('Unknown overlay.');
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.href;
}

export function publicLandTileSources(coordinates, landTypes) {
    const bbox = tileBounds(coordinates), longitude = value => value / 20037508.342789244 * 180;
    const latitude = value => Math.atan(Math.sinh(value / 6378137)) * 180 / Math.PI;
    const geographic = [longitude(bbox[0]), latitude(bbox[1]), longitude(bbox[2]), latitude(bbox[3])];
    const selected = Schema.mapLandTypes(landTypes);
    const coverage = landCoverage(geographic).filter(provider => (provider === 'us' ? LAND_CLASSES : provider === 'bc' ? CANADIAN_LAND_CLASSES
        : CANADIAN_LAND_CLASSES.filter(item => ['CROWN', 'LOC'].includes(item.value))).some(item => selected.includes(item.value === 'DIST' ? 'LOC' : item.value)));
    return coverage.map(provider => ({ provider, bbox, kind: provider === 'ab' ? 'parcels' : 'raster',
        url: provider === 'us' ? overlayTileUrl('land', coordinates, selected) : provider === 'bc' ? bcLandTileUrl(bbox, selected) : albertaLandTileUrl(bbox, 0, selected) }));
}
export function publicLandInfo(bounds) {
    const coverage = landCoverage(bounds), us = coverage.includes('us'), bc = coverage.includes('bc'), ab = coverage.includes('ab');
    const classes = [...(us ? LAND_CLASSES.filter(item => item.value !== 'DIST') : []),
        ...CANADIAN_LAND_CLASSES.filter(item => (bc || ab && ['CROWN', 'LOC'].includes(item.value)) && (!us || !['FED', 'LOC'].includes(item.value)))];
    const names = [us && 'US PAD-US', bc && 'BC parcel records', ab && 'SW Alberta parcels'].filter(Boolean);
    return { legend: `${names.join(' · ') || 'No public-land coverage here'}. ${bc || ab ? 'Canadian coverage is partial. ' : ''}Clear areas are unknown. Ownership does not grant camping permission. Check local access and camping rules.`,
        uncovered: coverage.length === 0,
        legendEntries: classes.map(item => ({ value: item.value, label: item.value === 'LOC' && us ? 'Local / district' : item.label, color: `rgb(${item.color.join(',')})` })),
        guidanceKeys: [us && 'blm', bc && 'bc', ab && 'ab'].filter(Boolean) };
}

// Accept only a small geographic view, never a provider URL or an arbitrary query.
export function overlayBounds(value) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return null;
    const [west, south, east, north] = value;
    let width = east - west; if (width < 0) width += 360;
    if (south < -85.1 || north > 85.1 || south >= north || width <= 0 || width > 360 || Math.abs(west) > 1080 || Math.abs(east) > 1080) return null;
    return [west, south, west + width, north];
}
export function viewportStations(stations, bounds) {
    if (!overlayBounds(bounds)) return [];
    const [west, south, east, north] = bounds;
    return stations.filter(station => {
        const longitude = station.longitude + Math.ceil((west - station.longitude) / 360) * 360;
        return station.latitude >= south && station.latitude <= north && longitude >= west && longitude <= east;
    });
}
