// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { terrainTiles } from '../../src/terrain/terrain-tiles.js';

const { lonToTileX, latToTileY, fitZoom, tilesForView, CAP_POLICY } = terrainTiles;

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

// The tilt-warming options. The frame asks for the coarse rungs of a live
// pitched camera, which is a different question from the first-paint set: the
// levels are below the target, the rectangle is bigger, and it grows again for
// each coarser rung because each is used further from the camera.
const levelsOf = tiles => [...new Set(tiles.map(tile => tile.z))].sort((a, b) => b - a);

test('levelOffsets choose which levels below the target to enumerate', () => {
    const view = { center: [43.5, -118.5], zoom: 14, viewport: { width: 1100, height: 700 }, maxZoom: 18 };
    // A terrain frame's finest elevation level is two below the camera zoom, so
    // the frame asks for -3 and coarser; nothing at or above the zoom appears.
    const warm = tilesForView({ ...view, levelOffsets: [-3, -4, -5], cap: 64 });
    assert.deepEqual(levelsOf(warm), [11, 10, 9]);
    assert.ok(warm.every(inRange));

    // Order is immaterial: the enumeration sorts finest first itself.
    assert.deepEqual(
        tilesForView({ ...view, levelOffsets: [-5, -3, -4], cap: 64 }),
        warm, 'offsets are normalised, so a caller cannot get a different set by reordering');

    // Offsets that would resolve past the DEM protocol's own bounds are dropped
    // rather than producing a URL the protocol refuses.
    const shallow = tilesForView({ center: [43.5, -118.5], zoom: 2, viewport: { width: 1100, height: 700 }, levelOffsets: [0, -1, -2, -3, -8] });
    assert.ok(shallow.every(tile => tile.z >= 0), 'no negative levels');
    assert.ok(levelsOf(shallow).length >= 2);
    assert.deepEqual(tilesForView({ center: [43.5, -118.5], zoom: 17, viewport: { width: 800, height: 600 }, maxZoom: 18, levelOffsets: [4], cap: 64 }),
        [], 'an offset past zoom 18 leaves nothing to enumerate');
});

test('a level offset never silently duplicates a tile after clamping', () => {
    // At a shallow target, several distinct offsets clamp toward the same level.
    const tiles = tilesForView({
        center: [43.5, -118.5], zoom: 1, viewport: { width: 1100, height: 700 },
        levelOffsets: [0, -1, -2, -3], cap: 64
    });
    const keys = tiles.map(tile => `${tile.z}/${tile.x}/${tile.y}`);
    assert.equal(keys.length, new Set(keys).size, 'the set is deduplicated');
});

const rowSpanAt = (tiles, z) => {
    const rows = tiles.filter(tile => tile.z === z).map(tile => tile.y);
    return rows.length ? Math.max(...rows) - Math.min(...rows) + 1 : 0;
};

test('expand grows the rectangle about its centre', () => {
    const view = {
        center: [43.5, -118.5], zoom: 14, viewport: { width: 1100, height: 700 },
        maxZoom: 18, levelOffsets: [-1, -2], cap: 512
    };
    const tight = tilesForView(view);
    const wide = tilesForView({ ...view, expand: 4 });
    assert.ok(wide.length > tight.length, `a bigger rectangle covers more tiles (${tight.length} -> ${wide.length})`);
    // Every tile the unexpanded footprint needed is still there: expansion grows
    // the rectangle about its centre, it does not move it.
    const wideKeys = new Set(wide.map(tile => `${tile.z}/${tile.x}/${tile.y}`));
    assert.ok(tight.every(tile => wideKeys.has(`${tile.z}/${tile.x}/${tile.y}`)));
    assert.ok(wide.every(inRange));
});

test('expandStep buys reach at the coarse end without paying for it at the fine end', () => {
    const view = {
        center: [43.5, -118.5], zoom: 14, viewport: { width: 1100, height: 700 },
        maxZoom: 18, levelOffsets: [-3, -4, -5], expand: 2, cap: 512
    };
    const uniform = tilesForView(view);
    const stepped = tilesForView({ ...view, expandStep: 4 });
    // A coarse level covers so much ground that a uniform expansion adds nothing
    // at all here — every rung still fits in one tile. Stepping is what reaches
    // the neighbouring tile, which is where a tilted camera's horizon band lands.
    const coarsest = Math.min(...levelsOf(stepped));
    assert.equal(rowSpanAt(uniform, coarsest), 1, 'a uniform expansion never leaves the centre tile');
    assert.ok(rowSpanAt(stepped, coarsest) > 1, 'the coarsest rung reaches its neighbours');
    // The finest requested rung is unchanged, so the extra reach costs nothing at
    // the expensive end of the ladder.
    const finest = Math.max(...levelsOf(stepped));
    assert.equal(rowSpanAt(stepped, finest), rowSpanAt(uniform, finest));
});

test('the cap is a hard bound under either policy, and they differ in what gives way', () => {
    const view = {
        center: [43.5, -118.5], zoom: 15, viewport: { width: 1100, height: 700 },
        maxZoom: 18, levelOffsets: [-1, -2, -3, -4], expand: 3, expandStep: 2, cap: 16
    };
    assert.equal(tilesForView({ ...view, cap: 9999 }).length, 51, 'uncapped, this view wants 51 tiles');
    const coarsened = tilesForView({ ...view, capPolicy: CAP_POLICY.COARSEN });
    const shed = tilesForView({ ...view, capPolicy: CAP_POLICY.SHED_FINEST });
    assert.ok(coarsened.length > 0 && coarsened.length <= 16, `coarsened to ${coarsened.length}`);
    assert.ok(shed.length > 0 && shed.length <= 16, `shed to ${shed.length}`);
    // Coarsening walks the whole ladder away from the camera's level; shedding
    // keeps it anchored there and gives up the finest rung instead. Warming needs
    // the second, because the renderer only ever asks near the camera's level.
    assert.ok(Math.max(...levelsOf(shed)) > Math.max(...levelsOf(coarsened)),
        'shedding keeps a level the camera actually renders at');
    assert.ok(Math.min(...levelsOf(coarsened)) < Math.min(...levelsOf(shed)),
        'coarsening reaches levels the camera never asks for');
    // Default is the first-paint behaviour, so the background prefetch is unmoved.
    assert.deepEqual(tilesForView({ center: [47, -121], zoom: 13, viewport: { width: 800, height: 600 } }),
        tilesForView({ center: [47, -121], zoom: 13, viewport: { width: 800, height: 600 }, capPolicy: CAP_POLICY.COARSEN }));
});

test('bounds plus an explicit zoom takes the rectangle from one and the level from the other', () => {
    const bounds = { minLat: 43.48, maxLat: 43.56, minLon: -118.56, maxLon: -118.44 };
    const viewport = { width: 1100, height: 700 };
    // Without a zoom the level is the fit zoom, which for this small rectangle is
    // capped at maxZoom; with one, the level is the camera's. A live pitched
    // camera needs the second: its visible rectangle is far wider than its zoom.
    const fitted = tilesForView({ bounds, viewport, maxZoom: 18, cap: 512 });
    const explicit = tilesForView({ bounds, viewport, zoom: 14, maxZoom: 18, cap: 512 });
    assert.deepEqual(levelsOf(fitted), [11, 10], 'this rectangle fills a 1100x700 viewport at level 11');
    assert.deepEqual(levelsOf(explicit), [14, 13], 'the explicit zoom names the level instead');
    // The rectangle is the same either way, so the corners stay covered.
    for (const tiles of [fitted, explicit]) {
        const level = Math.max(...levelsOf(tiles));
        assert.ok(tiles.some(tile => tile.z === level
            && tile.x === lonToTileX(bounds.minLon, level) && tile.y === latToTileY(bounds.maxLat, level)));
    }
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

    // The widening options fail closed too: a bad knob must not silently fall
    // back to a different tile set than the caller asked for.
    const view = { center: [47, -121], zoom: 13, viewport: { width: 800, height: 600 } };
    assert.deepEqual(tilesForView({ ...view, levelOffsets: [] }), [], 'no levels requested');
    assert.deepEqual(tilesForView({ ...view, levelOffsets: [0, -1.5] }), [], 'fractional level offset');
    assert.deepEqual(tilesForView({ ...view, levelOffsets: 'all' }), [], 'level offsets must be a list');
    assert.deepEqual(tilesForView({ ...view, expand: 0.5 }), [], 'an expansion may not shrink the view');
    assert.deepEqual(tilesForView({ ...view, expand: NaN }), [], 'non-finite expansion');
    assert.deepEqual(tilesForView({ ...view, expandStep: 0 }), [], 'a step may not shrink each rung');
    assert.deepEqual(tilesForView({ ...view, capPolicy: 'whatever' }), [], 'unknown cap policy');
});
