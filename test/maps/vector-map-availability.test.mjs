// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { vectorMapAvailability } from '../../src/maps/vector-map-availability.js';

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
