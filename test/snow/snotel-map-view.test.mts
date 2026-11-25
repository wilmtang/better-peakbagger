// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnotelMapReveal, type SnotelRevealMapLike } from '../../src/snow/snotel-map-view.ts';
import type { SnotelMapStation } from '../../src/snow/snotel-map-data.ts';
import { required } from '../helpers/required.mts';

const station = (id: string, latitude: number, longitude: number): SnotelMapStation =>
    ({ id, name: `Station ${id}`, elevation: 1500, latitude, longitude });
const stations = [
    station('1', 46.78, -121.75),
    station('2', 46.81, -121.33),
    station('3', 46.9, -121.6),
    station('4', 47.1, -121.2),
];

type Fit = Parameters<NonNullable<SnotelRevealMapLike['fitBounds']>>;
type Fly = Parameters<NonNullable<SnotelRevealMapLike['flyToBounds']>>;
type Move = { kind: 'fit'; bounds: Fit[0]; options: Fit[1] } | { kind: 'fly'; bounds: Fly[0]; options: Fly[1] };
function setup({ terrain = false, reduced = false, visible = false } = {}) {
    const calls: ('stop' | Move)[] = [], events = new Map<'moveend', () => void>();
    const project = () => visible ? { x: 100, y: 120 } : { x: -1000, y: 5000 };
    const map: SnotelRevealMapLike = {
        getCenter: () => ({ lat: 46.85, lng: -121.76 }), getZoom: () => 14,
        getSize: () => ({ x: 320, y: 240 }), getContainer: () => ({ clientWidth: 320, clientHeight: 240 }) as HTMLElement,
        project, latLngToContainerPoint: project, getPitch: () => 55, getBearing: () => 30,
        on: (name, handler) => events.set(name, handler), off: name => events.delete(name),
        flyToBounds: (bounds, options) => calls.push({ kind: 'fly', bounds, options }),
        fitBounds: (bounds, options) => calls.push({ kind: 'fit', bounds, options }), stop: () => calls.push('stop'),
    };
    const reveal = createSnotelMapReveal({ getMap: () => map, terrain, window: { matchMedia: () => ({ matches: reduced }) } });
    const firstMove = () => {
        const move = calls[0];
        assert.ok(move && move !== 'stop');
        return move;
    };
    return { map, reveal, calls, events, firstMove };
}

for (const terrain of [false, true]) {
    test(`${terrain ? '3D' : '2D'} reveals offscreen stations once, keeps the current area and never zooms in`, () => {
        const env = setup({ terrain });
        assert.equal(env.reveal.show(stations), true);
        const move = env.firstMove();
        assert.equal(move.kind, terrain ? 'fit' : 'fly');
        const { bounds, options } = move;
        const lngLatBounds = terrain ? bounds : bounds.map(([lat, lon]) => [lon, lat]);
        assert.deepEqual(lngLatBounds, [[-121.76, 46.78], [-121.75, 46.85]], 'frame the current center and nearest station');
        assert.equal(options.maxZoom, 14);
        assert.equal(terrain ? options.duration : options.duration * 1000, 450);
        if (terrain) {
            assert.ok(move.kind === 'fit');
            assert.equal(move.options.pitch, 55); assert.equal(move.options.bearing, 30); assert.equal(move.options.linear, true);
        }
        required(env.events.get('moveend'))();
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
        const move = env.firstMove();
        assert.equal(move.kind, terrain ? 'fit' : 'fly');
        assert.equal(move.options.duration, 0);
        if (!terrain) {
            assert.ok(move.kind === 'fly');
            assert.equal(move.options.animate, false);
        }
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
    env.reveal.show([station('alaska', 65.1, -179.9)]);
    const { bounds } = env.firstMove();
    assert.ok(bounds[1][0] - bounds[0][0] < 1, 'do not zoom out across the entire world');
});

test('a farther station must not force a wider discovery view than the nearest station needs', () => {
    const env = setup(); env.reveal.show(stations);
    const bounds = env.firstMove().bounds.map(([lat, lon]) => [lon, lat]);
    assert.deepEqual(bounds, [[-121.76, 46.78], [-121.75, 46.85]], 'reveal the nearest station and current location, without fitting distant alternatives');
});


for (const terrain of [false, true]) {
    test(`${terrain ? '3D' : '2D'} treats a station behind the open menu as hidden and fits into free space`, () => {
        const env = setup({ terrain, visible: true });
        assert.equal(env.reveal.show(stations, [[0, 0, .75, 1]]), true);
        const move = env.firstMove();
        assert.equal(move.kind, terrain ? 'fit' : 'fly');
        assert.equal(move.kind === 'fit' ? move.options.padding.left : move.options.paddingTopLeft[0], 252);
        assert.equal(move.options.maxZoom, 14);
        const clear = setup({ terrain, visible: true });
        assert.equal(clear.reveal.show(stations, [[.6, 0, 1, .5]]), false, 'an unobscured existing station needs no camera change');
    });
    test(`${terrain ? '3D' : '2D'} skips a fully covered map, distant coverage and a moving camera`, () => {
        const env = setup({ terrain });
        assert.equal(env.reveal.show(stations, [[0, 0, 1, 1]]), false, 'never fit into an unusable sliver');
        assert.equal(env.reveal.show([station('far', 40, -111)]), false, 'discovery stays inside 50 km');
        env.map.isMoving = () => true;
        assert.equal(env.reveal.show(stations), false); assert.deepEqual(env.calls, []);
    });
    test(`${terrain ? '3D' : '2D'} sorts discovery by current camera distance rather than incoming station order`, () => {
        const env = setup({ terrain }); env.reveal.show([...stations].reverse());
        const bounds = terrain ? env.firstMove().bounds : env.firstMove().bounds.map(([lat, lon]) => [lon, lat]);
        assert.deepEqual(bounds, [[-121.76, 46.78], [-121.75, 46.85]]);
    });
}

test('native map chrome also makes a geographically visible station unusable', () => {
    const env = setup({ visible: true });
    const control = { getBoundingClientRect: () => ({ left: 80, top: 90, right: 140, bottom: 150, width: 60, height: 60 }) };
    // The fixture supplies only the container geometry and controls queried by the reveal.
    env.map.getContainer = () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        ownerDocument: { querySelectorAll: () => [control, control] },
    }) as unknown as HTMLElement;
    assert.equal(env.reveal.show(stations), true, 'basemap and zoom controls count as obstructions too');
    const move = env.firstMove();
    assert.ok(move.kind === 'fly');
    const { paddingTopLeft: [left, top], paddingBottomRight: [right, bottom] } = move.options;
    assert.ok(left >= 152 || top >= 162 || 320 - right <= 68 || 240 - bottom <= 78, 'both geographic anchors fit clear of the control');
});

for (const terrain of [false, true]) test(`${terrain ? '3D' : '2D'} accepts a station exactly on the fitted safe boundary without repeating the reveal`, () => {
    const env = setup({terrain});
    env.map.project = env.map.latLngToContainerPoint = () => ({x:252,y:120});
    assert.equal(env.reveal.show(stations, [[0,0,.75,1]]), false);
    assert.deepEqual(env.calls, []);
});

test('small supported maps retain the same full-marker safety inset used by visibility checks', () => {
    const env = setup(); env.map.getSize = () => ({x:80,y:80});
    assert.equal(env.reveal.show(stations), true);
    const move = env.firstMove();
    assert.ok(move.kind === 'fly');
    assert.deepEqual(move.options.paddingTopLeft, [24,24]);
    assert.deepEqual(move.options.paddingBottomRight, [24,24]);
});
