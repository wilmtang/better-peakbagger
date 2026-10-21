// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOPE_BANDS, SLOPE_RULE, LAND_CLASSES, LAND_RENDERER, overlayTileUrl, tileBounds, overlayBounds, viewportStations } from '../../src/maps/map-overlay-providers.js';

test('slope classification uses the service degree template with exact inclusive lower boundaries', () => {
    const remap = SLOPE_RULE.rasterFunctionArguments.Raster.rasterFunctionArguments;
    assert.equal(remap.Raster.rasterFunction, 'Slope Degrees');
    assert.equal(remap.AllowUnmatched, false);
    assert.deepEqual(remap.InputRanges, [20, 30, 30, 35, 35, 40, 40, 45, 45, 91]);
    for (const [value, expected] of [[0, -1], [19.99, -1], [20, 0], [29.99, 0], [30, 1], [35, 2], [40, 3], [45, 4], [90, 4]]) {
        assert.equal(SLOPE_BANDS.findIndex(band => value >= band.from && value < band.to), expected);
    }
    assert.deepEqual(SLOPE_RULE.rasterFunctionArguments.Colormap, SLOPE_BANDS.map((band, i) => [i + 1, ...band.color]));
});
test('ownership colors only explicit fee ownership, leaving all unclassified areas transparent', () => {
    assert.equal(LAND_RENDERER.field1, 'Own_Type');
    assert.equal(LAND_RENDERER.defaultSymbol.style, 'esriSFSNull');
    assert.deepEqual(LAND_RENDERER.uniqueValueInfos.map(item => item.value), ['FED', 'STAT', 'LOC', 'DIST', 'TRIB']);
    const url = new URL(overlayTileUrl('land', { z: 10, x: 163, y: 359 }));
    assert.equal(url.hostname, 'edits.nationalmap.gov');
    assert.equal(url.searchParams.get('transparent'), 'true');
    assert.deepEqual(JSON.parse(url.searchParams.get('dynamicLayers')).find(layer => layer.id === 0).drawingInfo.renderer, LAND_RENDERER);
    assert.throws(() => overlayTileUrl('private', { z: 1, x: 0, y: 0 }));
});
test('tiles wrap at the dateline and viewport station selection does not silently truncate', () => {
    assert.deepEqual(tileBounds({ z: 3, x: -1, y: 1 }), tileBounds({ z: 3, x: 7, y: 1 }));
    assert.throws(() => tileBounds({ z: 3, x: 0, y: 8 }));
    assert.equal(overlayBounds([-180, -90, 180, 90]), null);
    assert.equal(overlayBounds([-2000, 0, -1990, 10]), null);
    assert.deepEqual(overlayBounds([170, 50, -170, 60]), [170, 50, 190, 60]);
    const stations = Array.from({ length: 51 }, (_, i) => ({ id: i, longitude: -179, latitude: 51 }));
    assert.equal(viewportStations(stations, [170, 50, 190, 60]).length, 51);
    assert.equal(viewportStations(stations, [170, 52, 190, 60]).length, 0);
});

test('BLM-managed federal fee land has its own color without marking unknown land public', () => {
    const classes = new Map(LAND_CLASSES.map(category => [category.value, category]));
    assert.equal(classes.get('BLM')?.label, 'BLM');
    assert.notDeepEqual(classes.get('BLM').color, classes.get('FED').color);
    assert.equal(classes.get('FED').label, 'Other federal');
    const layers = JSON.parse(new URL(overlayTileUrl('land', { z: 10, x: 163, y: 359 })).searchParams.get('dynamicLayers'));
    const blm = layers.find(layer => layer.definitionExpression === "Own_Type = 'FED' AND Mang_Name = 'BLM'");
    assert.ok(blm, 'management is explicit; ownership alone does not establish current BLM management');
    assert.equal(blm.source.mapLayerId, 0, 'fee polygons, never proclamation boundaries');
    assert.deepEqual(blm.drawingInfo.renderer.symbol.color, [...classes.get('BLM').color, 255]);
    assert.equal(layers.indexOf(blm), 0, 'ArcGIS draws the first dynamic layer on top');
    const other = layers.find(layer => layer.id === 0);
    assert.deepEqual(other.drawingInfo.renderer, LAND_RENDERER);
    assert.equal(LAND_RENDERER.defaultSymbol.style, 'esriSFSNull');
    assert.ok(!LAND_RENDERER.uniqueValueInfos.some(item => ['PVT', 'UNK', 'BLM'].includes(item.value)));
});

test('BLM and USFS lead the land palette with distinct saturated colors and agency filters', () => {
    const classes = new Map(LAND_CLASSES.map(category => [category.value, category]));
    assert.deepEqual(LAND_CLASSES.slice(0, 2).map(category => category.value), ['BLM', 'USFS']);
    assert.deepEqual(classes.get('BLM').color, [230, 159, 0]);
    assert.deepEqual(classes.get('USFS').color, [0, 114, 178]);
    const layers = JSON.parse(new URL(overlayTileUrl('land', { z: 10, x: 163, y: 359 })).searchParams.get('dynamicLayers'));
    assert.equal(layers.length, 3, 'two agency passes and the ownership fallback share one export');
    for (const [index, agency] of ['BLM', 'USFS'].entries()) {
        assert.equal(layers[index].definitionExpression, `Own_Type = 'FED' AND Mang_Name = '${agency}'`);
        assert.equal(layers[index].source.mapLayerId, 0, 'fee land, never broad administrative boundaries');
        assert.deepEqual(layers[index].drawingInfo.renderer.symbol.color, [...classes.get(agency).color, 255]);
        assert.ok(!LAND_RENDERER.uniqueValueInfos.some(item => item.value === agency));
    }
    assert.equal(LAND_RENDERER.defaultSymbol.style, 'esriSFSNull');
    const saturation = color => (Math.max(...color) - Math.min(...color)) / Math.max(...color);
    for (const category of LAND_CLASSES) {
        assert.ok(['BLM', 'USFS'].includes(category.value) ? saturation(category.color) > 0.9 : saturation(category.color) < 0.35,
            `${category.label} keeps the requested visual priority`);
    }
});
