// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { terrainTiles } from '../../src/terrain/terrain-tiles.js';

const { lonToTileX, latToTileY, fitZoom, tilesForView } = terrainTiles;

// An independent reference for the slippy math: Math.asinh(tan) instead of the
// module's log(tan + sec). The two are equal for lat in (-90, 90), so agreement
// proves the module implements the standard Web Mercator tiling, not itself.
const refX = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const refY = (lat, z) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);

test('slippy tile math matches the standard Web Mercator tiling', () => {
    // Zoom 0 is a single world tile no matter the coordinate.
    assert.equal(lonToTileX(-121.8, 0), 0);
    assert.equal(latToTileY(48.7, 0), 0);

    // The prime meridian / equator origin sits at the centre tile boundary.
    assert.equal(lonToTileX(0, 14), 2 ** 13);
    assert.equal(latToTileY(0, 14), 2 ** 13);

    for (const z of [1, 8, 12, 14, 15]) {
        for (const [lat, lon] of [[48.7, -121.8], [47.6062, -122.3321], [-33.87, 151.21], [0.5, 0.5]]) {
            assert.equal(lonToTileX(lon, z), refX(lon, z), `x @ z${z} ${lat},${lon}`);
            assert.equal(latToTileY(lat, z), refY(lat, z), `y @ z${z} ${lat},${lon}`);
        }
    }
});

test('slippy tile coordinates clamp to the valid grid and mercator latitude limit', () => {
    for (const z of [1, 10, 15]) {
        const dimension = 2 ** z;
        // Longitude 180 lands exactly on the world's right edge; clamp inward.
        assert.equal(lonToTileX(180, z), dimension - 1);
        assert.equal(lonToTileX(-180, z), 0);
        // Latitudes past the mercator limit clamp to the top/bottom tile row.
        assert.equal(latToTileY(89, z), 0);
        assert.equal(latToTileY(-89, z), dimension - 1);
        // In-range coordinates stay strictly inside the grid.
        assert.ok(lonToTileX(121.8, z) < dimension && lonToTileX(121.8, z) >= 0);
        assert.ok(latToTileY(-48.7, z) < dimension && latToTileY(-48.7, z) >= 0);
    }
});

test('fitZoom mirrors the frame fitBounds for 512-px tiles', () => {
    // Width dominates when the viewport is very tall: halving/quartering the
    // longitude span raises the fit zoom by one/two levels (log2 of 2 and 4).
    const tall = { width: 512, height: 100000 };
    assert.ok(Math.abs(fitZoom({ minLat: -45, maxLat: 45, minLon: -90, maxLon: 90 }, tall, { padding: 0 }) - 1) < 1e-9);
    assert.ok(Math.abs(fitZoom({ minLat: -45, maxLat: 45, minLon: -90, maxLon: 0 }, tall, { padding: 0 }) - 2) < 1e-9);

    // The whole world fits a square viewport at zoom 0.
    assert.ok(Math.abs(fitZoom(
        { minLat: -85.0511287, maxLat: 85.0511287, minLon: -180, maxLon: 180 },
        { width: 512, height: 512 }, { padding: 0 }
    )) < 1e-6);

    // A degenerate (zero-span) bounds cannot compute a real zoom, so it clamps
    // to maxZoom instead of returning Infinity.
    assert.equal(fitZoom({ minLat: 47, maxLat: 47, minLon: -121, maxLon: -121 },
        { width: 800, height: 600 }, { padding: 46, maxZoom: 15.5 }), 15.5);
});

const inRange = tile => {
    const dimension = 2 ** tile.z;
    return tile.z >= 0 && tile.x >= 0 && tile.x < dimension && tile.y >= 0 && tile.y < dimension;
};

test('tilesForView covers a peak view at the target level plus its parent', () => {
    const tiles = tilesForView({ center: [47.0, -121.0], zoom: 13, viewport: { width: 800, height: 600 } });
    assert.ok(tiles.length > 0);
    assert.ok(tiles.every(inRange));
    const levels = [...new Set(tiles.map(tile => tile.z))].sort((a, b) => a - b);
    // Zoom 13 is below the 15.5 cap, so the target level is floor(13) with its
    // parent 12 — MapLibre paints ancestors while the target loads.
    assert.deepEqual(levels, [12, 13]);
    assert.ok(tiles.length <= 32);
    // The camera centre resolves to the expected tile at the target level.
    assert.ok(tiles.some(tile => tile.z === 13
        && tile.x === lonToTileX(-121.0, 13) && tile.y === latToTileY(47.0, 13)));
});

test('tilesForView covers a route bounds and honours the tile cap', () => {
    const bounds = { minLat: 48.7, minLon: -121.82, maxLat: 48.76, maxLon: -121.8 };
    const routeTiles = tilesForView({ bounds, viewport: { width: 1280, height: 800 } });
    assert.ok(routeTiles.length > 0 && routeTiles.every(inRange));
    // The bounds corners are covered at the target level.
    const target = Math.max(...routeTiles.map(tile => tile.z));
    assert.ok(routeTiles.some(tile => tile.z === target
        && tile.x === lonToTileX(-121.82, target) && tile.y === latToTileY(48.76, target)));

    // A dense, high-zoom view over a large viewport would exceed the cap at its
    // fit level, so the enumerator drops to a coarser level until it fits.
    const capped = tilesForView({ center: [0, 0], zoom: 15, viewport: { width: 4000, height: 4000 }, cap: 32 });
    assert.ok(capped.length > 0 && capped.length <= 32, `expected ≤ 32 tiles, got ${capped.length}`);
    assert.ok(Math.max(...capped.map(tile => tile.z)) < 15, 'the level was lowered to fit the cap');
    assert.ok(capped.every(inRange));
});

test('tilesForView rejects malformed input instead of guessing', () => {
    assert.deepEqual(tilesForView({ center: [47, -121], zoom: 13 }), [], 'no viewport');
    assert.deepEqual(tilesForView({ viewport: { width: 800, height: 600 } }), [], 'neither bounds nor centre');
    assert.deepEqual(tilesForView({
        bounds: { minLat: NaN, minLon: -121, maxLat: 48, maxLon: -120 },
        viewport: { width: 800, height: 600 }
    }), [], 'non-finite bounds');
    assert.deepEqual(tilesForView({
        center: [47, -121], zoom: Infinity, viewport: { width: 800, height: 600 }
    }), [], 'non-finite zoom');
    assert.deepEqual(tilesForView({
        center: [47, -121], zoom: 13, viewport: { width: 0, height: 600 }
    }), [], 'zero-width viewport');
});
