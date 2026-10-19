// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnotelMapReveal } from '../../src/snow/snotel-map-view.js';

const stations = [
    { latitude: 46.78, longitude: -121.75 },
    { latitude: 46.81, longitude: -121.33 },
    { latitude: 46.9, longitude: -121.6 },
    { latitude: 47.1, longitude: -121.2 },
];
function setup({ terrain = false, reduced = false, visible = false } = {}) {
    const calls = [], events = new Map();
    const project = () => visible ? { x: 100, y: 120 } : { x: -1000, y: 5000 };
    const map = {
        getCenter: () => ({ lat: 46.85, lng: -121.76 }), getZoom: () => 14,
        getSize: () => ({ x: 320, y: 240 }), getContainer: () => ({ clientWidth: 320, clientHeight: 240 }),
        project, latLngToContainerPoint: project, getPitch: () => 55, getBearing: () => 30,
        on: (name, handler) => events.set(name, handler), off: name => events.delete(name),
        flyToBounds: (bounds, options) => calls.push({ bounds, options }),
        fitBounds: (bounds, options) => calls.push({ bounds, options }), stop: () => calls.push('stop'),
    };
    const reveal = createSnotelMapReveal({ getMap: () => map, terrain, window: { matchMedia: () => ({ matches: reduced }) } });
    return { map, reveal, calls, events };
}

for (const terrain of [false, true]) {
    test(`${terrain ? '3D' : '2D'} reveals offscreen stations once, keeps the current area and never zooms in`, () => {
        const env = setup({ terrain });
        assert.equal(env.reveal.show(stations), true);
        const { bounds, options } = env.calls[0];
        const lngLatBounds = terrain ? bounds : bounds.map(([lat, lon]) => [lon, lat]);
        assert.deepEqual(lngLatBounds, [[-121.76, 46.78], [-121.33, 46.9]], 'frame the current center and first three nearby stations');
        assert.equal(options.maxZoom, 14);
        assert.equal(terrain ? options.duration : options.duration * 1000, 450);
        if (terrain) { assert.equal(options.pitch, 55); assert.equal(options.bearing, 30); assert.equal(options.linear, true); }
        env.events.get('moveend')();
        env.reveal.cancel(); assert.equal(env.calls.length, 1, 'a finished reveal must not stop later user gestures');
    });
    test(`${terrain ? '3D' : '2D'} preserves an already visible station and skips empty coverage`, () => {
        const env = setup({ terrain, visible: true });
        assert.equal(env.reveal.show(stations), false);
        assert.equal(env.reveal.show([]), false); assert.deepEqual(env.calls, []);
    });
    test(`${terrain ? '3D' : '2D'} respects reduced motion and cancels only its own animation`, () => {
        const env = setup({ terrain, reduced: true });
        env.reveal.show(stations);
        assert.equal(env.calls[0].options.duration, 0);
        if (!terrain) assert.equal(env.calls[0].options.animate, false);
        env.reveal.cancel(); assert.equal(env.calls.length, 1, 'an instant reveal must not stop a later gesture');
        const animated = setup({ terrain });
        animated.reveal.show(stations); animated.reveal.cancel();
        assert.equal(animated.calls[1], 'stop');
        animated.reveal.cancel(); assert.equal(animated.calls.length, 2);
    });
}

test('Alaska stations across the date line use the nearby world copy', () => {
    const env = setup({ terrain: true });
    env.map.getCenter = () => ({ lat: 65, lng: 179.9 });
    env.reveal.show([{ latitude: 65.1, longitude: -179.9 }]);
    const { bounds } = env.calls[0];
    assert.ok(bounds[1][0] - bounds[0][0] < 1, 'do not zoom out across the entire world');
});
