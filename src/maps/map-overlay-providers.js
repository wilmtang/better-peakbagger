// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

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
    land: '<a href="https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview">USGS PAD-US 4.1</a>',
};
export function tileBounds({ z, x, y }) {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 24 || y < 0 || y >= 2 ** z) throw new Error('Invalid overlay tile.');
    const n = 2 ** z, wrapped = (x % n + n) % n, span = 40075016.68557849 / n;
    return [-20037508.342789244 + wrapped * span, 20037508.342789244 - (y + 1) * span,
        -20037508.342789244 + (wrapped + 1) * span, 20037508.342789244 - y * span];
}
export function overlayTileUrl(id, coordinates) {
    const bbox = tileBounds(coordinates).join(',');
    let url;
    const params = { bbox, bboxSR: '3857', imageSR: '3857', size: '256,256', format: 'png32', f: 'image' };
    if (id === 'slope') {
        url = new URL('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage');
        params.renderingRule = JSON.stringify(SLOPE_RULE);
        params.interpolation = 'RSP_NearestNeighbor';
    } else if (id === 'land') {
        url = new URL('https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/export');
        params.transparent = 'true';
        // ArcGIS draws the first layer on top. All passes are one opaque image;
        // the map engine applies the user's opacity once, after composition.
        // Fee ownership plus manager avoids treating designation boundaries or
        // holdings managed by another agency as BLM/USFS-managed land.
        params.dynamicLayers = JSON.stringify([
            ...landAgencies.map((category, index) => ({ id: index + 1, source: { type: 'mapLayer', mapLayerId: 0 },
                definitionExpression: `Own_Type = 'FED' AND Mang_Name = '${category.value}'`,
                drawingInfo: { renderer: { type: 'simple', symbol: symbol(category.color) } } })),
            { id: 0, source: { type: 'mapLayer', mapLayerId: 0 }, drawingInfo: { renderer: LAND_RENDERER } },
        ]);
    } else throw new Error('Unknown overlay.');
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.href;
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
