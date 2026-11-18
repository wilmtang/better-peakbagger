// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { terrainCamera } from '../../src/terrain/terrain-camera.ts';

test('terrain camera converts Leaflet zoom and coordinate order without losing fractional zoom', () => {
    const leaflet = {
        getCenter: () => ({ lat: 48.72, lng: -121.79 }),
        getZoom: () => 14.5,
    };

    const camera = terrainCamera.fromLeaflet(leaflet);
    assert.deepEqual(camera, { center: [48.72, -121.79], zoom: 13.5 });
    assert.deepEqual(terrainCamera.toMapLibre(camera), {
        center: [-121.79, 48.72],
        zoom: 13.5,
    });
});

test('terrain camera applies only validated MapLibre state to Leaflet', () => {
    const calls: { center: unknown; zoom: unknown; options: unknown }[] = [];
    const leaflet = {
        setView: (center: unknown, zoom: unknown, options: unknown) => calls.push({ center, zoom, options }),
    };

    assert.equal(terrainCamera.applyToLeaflet(leaflet, {
        center: [47.64, -122.29],
        zoom: 12.25,
    }), true);
    assert.deepEqual(calls, [{
        center: [47.64, -122.29],
        zoom: 13.25,
        options: { animate: false },
    }]);

    assert.equal(terrainCamera.applyToLeaflet(leaflet, {
        center: [47.64, -122.29],
        zoom: 99,
    }), false);
    assert.equal(calls.length, 1, 'invalid cross-world camera data must not move the native map');
});
