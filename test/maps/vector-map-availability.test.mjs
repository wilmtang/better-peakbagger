// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { vectorMapAvailability, vectorMapReadyToPublish } from '../../src/maps/vector-map-availability.js';

const manager = (ids, renderable) => ({ getIds: () => ids, getRenderableIds: () => renderable });
const map = tileManagers => ({ style: { tileManagers } });
test('settled failures have requested tiles but no usable viewport data', () => {
    assert.deepEqual(vectorMapAvailability(map({ base: manager(['failed-a', 'failed-b'], []) })), { requested: true, usable: false });
    assert.deepEqual(vectorMapAvailability(map({ base: { ...manager([], []), _sourceErrored: true, _sourceLoaded: false, used: true } })),
        { requested: true, usable: false }, 'Failed TileJSON cannot be mistaken for a valid empty viewport');
});
test('empty, partial and cached parent tiles remain usable without rendered features', () => {
    for (const id of ['valid-empty', 'partial', 'cached-parent']) assert.deepEqual(
        vectorMapAvailability(map({ base: manager([id, 'failed'], [id]) })), { requested: true, usable: true });
});
test('offscreen cache contents cannot make an empty viewport look usable', () => {
    const base = { ...manager(['failed'], []), offscreenCache: ['old-good-tile'] };
    assert.deepEqual(vectorMapAvailability(map({ base })), { requested: true, usable: false });
    assert.deepEqual(vectorMapAvailability(map({ base: manager([], []) })), { requested: false, usable: false }, 'No requested tiles is a valid out-of-coverage view');
    for (const flags of [{ _sourceErrored: true, _sourceLoaded: true }, { _sourceErrored: true, _sourceLoaded: false, used: false }]) {
        assert.deepEqual(vectorMapAvailability(map({ base: { ...manager([], []), ...flags } })), { requested: false, usable: false }, 'Old tile errors and unused sources do not turn an out-of-coverage view into an outage');
    }
});
test('any usable source preserves partial output and unsupported adapters fail explicitly', () => {
    assert.equal(vectorMapAvailability(map({ vector: manager(['failed'], []), raster: manager(['good'], ['good']) })).usable, true);
    for (const bad of [{}, map({ oldApi: {} }), map({ bad: manager(null, []) })]) assert.throws(() => vectorMapAvailability(bad), /availability/i);
});

test('progressive output requires vector data at the center, rather than only overscan or elevation tiles', () => {
    const tile = (z, x, y, type = 'vector') => ({ ...manager(['tile'], ['tile']), getSource: () => ({ type }),
        getTileByID: () => ({ tileID: { canonical: { z, x, y } } }) });
    const center = [5, 5];
    assert.equal(vectorMapAvailability(map({ outer: tile(3, 5, 3), dem: tile(0, 0, 0, 'raster-dem') }), { center }).usable, false);
    assert.equal(vectorMapAvailability(map({ emptyOrParent: tile(1, 1, 0) }), { center }).usable, true);
    assert.equal(vectorMapAvailability(map({ wrapped: tile(1, 0, 1) }), { center: [0, 180] }).usable, true);
    assert.equal(vectorMapAvailability(map({ southEdge: tile(1, 1, 1) }), { center: [-85.0511287, 5] }).usable, true);
});

test('elevation tiles alone never count as usable cartography', () => {
    const typed = (type, ids, renderable) => ({ ...manager(ids, renderable), getSource: () => ({ type }) });
    assert.deepEqual(vectorMapAvailability(map({ vector: typed('vector', ['failed'], []), dem: typed('raster-dem', ['dem'], ['dem']) })),
        { requested: true, usable: false }, 'A cartography outage stays an outage while the elevation provider is healthy');
    assert.deepEqual(vectorMapAvailability(map({ vector: typed('vector', [], []), dem: typed('raster-dem', ['failed'], []) })),
        { requested: false, usable: false }, 'A failed elevation tile outside vector coverage is not a cartography outage');
    assert.equal(vectorMapAvailability(map({ vector: typed('vector', ['good'], ['good']), dem: typed('raster-dem', ['failed'], []) })).usable, true);
});

test('a settled view publishes partial cartography even when its center tile failed', () => {
    const tile = (z, x, y, flags = {}) => ({ ...manager(['tile', 'failed-center'], ['tile']), getSource: () => ({ type: 'vector' }),
        getTileByID: () => ({ tileID: { canonical: { z, x, y } } }), ...flags });
    const outer = { base: tile(3, 5, 3) }, center = [5, 5];
    const state = (tileManagers, tilesLoaded, styleLoaded = true) => ({ ...map(tileManagers), areTilesLoaded: () => tilesLoaded, isStyleLoaded: () => styleLoaded });
    assert.equal(vectorMapReadyToPublish(state(outer, false), center), false, 'Overscan alone cannot hide the native map while the center is loading');
    assert.equal(vectorMapReadyToPublish(state(outer, true, false), center), false);
    assert.equal(vectorMapReadyToPublish(state(outer, true), center), true, 'Once settled, a failed center tile must not withhold its usable neighbors');
    assert.equal(vectorMapReadyToPublish(state({ base: tile(1, 1, 0) }, false), center), true, 'Center coverage still publishes while secondary tiles load');
    assert.equal(vectorMapReadyToPublish(state({ base: manager([], []) }, true), center), true, 'A settled out-of-coverage view is valid');
    assert.equal(vectorMapReadyToPublish(state({ base: manager(['failed'], []) }, true), center), false, 'A wholly failed view stays with the outage path');
});
