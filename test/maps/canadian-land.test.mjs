// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BC_LAND_RENDERER, albertaLandTileUrl, drawAlbertaLand, landCoverage } from '../../src/maps/canadian-land.js';
import { publicLandTileSources, publicLandInfo } from '../../src/maps/map-overlay-providers.js';

const tile = (longitude, latitude, z = 12) => ({ z, x: Math.floor((longitude + 180) / 360 * 2 ** z), y: Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** z) });
const polygon = (objectid = 1, crownclass = 'Provincial') => ({ attributes: { objectid, crownclass }, geometry: { rings: [[[0, 0], [128, 0], [128, 128], [0, 0]]] } });
const response = (features = [polygon()], extra = {}) => new Response(JSON.stringify({ spatialReference: { wkid: 3857 }, features, ...extra }));
const setup = () => {
    const calls = [];
    const context = { beginPath: () => calls.push('begin'), moveTo: (...xy) => calls.push(['move', ...xy]), lineTo: (...xy) => calls.push(['line', ...xy]), closePath() {}, fill(mode) { calls.push(['fill', mode, this.fillStyle]); } };
    return { calls, context, bbox: [0, 0, 256, 256], signal: new AbortController().signal };
};
test('Canadian sources select BC/Alberta records and leave unsupported places clear', async () => {
    assert.deepEqual(publicLandTileSources(tile(-124, 54)).map(source => source.provider), ['bc']);
    assert.deepEqual(publicLandTileSources(tile(-114.5, 51.5)).map(source => source.provider), ['ab']);
    assert.deepEqual(publicLandTileSources(tile(-112, 55)), [], 'unsupported northern/eastern Alberta never triggers an empty service request');
    assert.deepEqual(publicLandTileSources(tile(-115.57, 51.18)).map(source => source.provider), ['ab'], 'a Banff view does not request BC permission');
    assert.deepEqual(publicLandTileSources(tile(-121.7, 46.8)).map(source => source.provider), ['us']);
    assert.deepEqual(publicLandTileSources(tile(-80, 55)), []);
    assert.deepEqual(landCoverage([236, 53, 237, 54]), ['bc']);
    const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
    assert.ok(manifest.optional_host_permissions.includes('https://maps.gov.bc.ca/*'));
    assert.ok(!manifest.host_permissions.some(host => /\.bc\.ca/.test(host)), 'BC access is never silently persistent');
});
test('BC paints explicit ownership only, never untitled, mixed, private or unclassified land', () => {
    assert.equal(BC_LAND_RENDERER.field1, 'OWNER_TYPE');
    assert.equal(BC_LAND_RENDERER.defaultSymbol.style, 'esriSFSNull');
    assert.deepEqual(BC_LAND_RENDERER.uniqueValueInfos.map(item => item.value), ['Crown Provincial', 'Federal', 'Crown Agency', 'Local Government', 'First Nations']);
    const url = new URL(publicLandTileSources(tile(-124, 54))[0].url);
    assert.equal(url.hostname, 'maps.gov.bc.ca');
    assert.deepEqual(JSON.parse(url.searchParams.get('dynamicLayers'))[0].drawingInfo.renderer, BC_LAND_RENDERER);
    assert.match(publicLandInfo([-125, 53, -124, 54]).legend, /partial/);
    assert.deepEqual(publicLandInfo([-125, 53, -124, 54]).guidanceKeys, ['bc']);
    assert.deepEqual(publicLandInfo([-112, 54, -111, 55]).legendEntries.map(item => item.label), ['Crown land', 'Municipal']);
});
test('Alberta queries contain only local tile bounds and ownership classes', () => {
    const url = new URL(albertaLandTileUrl([0, 0, 256, 256], 500));
    assert.equal(url.hostname, 'geospatial.alberta.ca');
    assert.equal(url.searchParams.get('where'), "crownclass IN ('Provincial','Municipal')");
    assert.equal(url.searchParams.get('outFields'), 'objectid,crownclass');
    assert.equal(url.searchParams.get('outSR'), '3857');
    assert.equal(url.searchParams.get('resultOffset'), '500');
    assert.equal(url.searchParams.get('resultRecordCount'), '500');
});
test('Alberta polygon rendering preserves holes and excludes private classes', async () => {
    const state = setup();
    const publicParcel = polygon(); publicParcel.geometry.rings.push([[16, 16], [32, 16], [32, 32], [16, 16]]);
    await drawAlbertaLand({ ...state, fetchImpl: async () => response([publicParcel, polygon(2, 'Private'), polygon(3, 'Municipal')]) });
    assert.deepEqual(state.calls.filter(call => call[0] === 'fill'), [['fill', 'evenodd', 'rgb(230,159,0)'], ['fill', 'evenodd', 'rgb(174,133,150)']]);
    assert.deepEqual(state.calls.find(call => call[0] === 'move'), ['move', 0, 256]);
});
test('Alberta fails closed on incomplete paging, repeated identities and invalid geometry', async () => {
    for (const data of [
        response([polygon()], { exceededTransferLimit: true }),
        response([polygon(), polygon()]),
        response([polygon()], { spatialReference: { wkid: 4326 } }),
        response([{ ...polygon(), geometry: { rings: [[[0, 0], [1, 1], [2, 2], [Infinity, 0]]] } }]),
    ]) await assert.rejects(drawAlbertaLand({ ...setup(), fetchImpl: async () => data }));
});
test('Alberta pages ordered parcels with bounded count and carries cancellation into transport', async () => {
    const requests = [], state = setup();
    await drawAlbertaLand({ ...state, fetchImpl: async (url, options) => {
        requests.push([new URL(url).searchParams.get('resultOffset'), options]);
        return requests.length === 1 ? response(Array.from({ length: 500 }, (_, i) => polygon(i + 1)), { exceededTransferLimit: true }) : response([polygon(501)]);
    } });
    assert.deepEqual(requests.map(request => request[0]), ['0', '500']);
    assert.ok(requests.every(([, options]) => options.credentials === 'omit' && options.referrerPolicy === 'no-referrer'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(drawAlbertaLand({ ...setup(), signal: controller.signal, fetchImpl: () => assert.fail('cancelled requests never start') }), { name: 'AbortError' });
});
