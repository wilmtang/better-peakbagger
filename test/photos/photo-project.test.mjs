// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { photoProject as Project } from '../../src/photos/photo-project.js';

const HASH = 'a'.repeat(64);
const TIME = '2026-07-27T18:00:00.000Z';
const NEXT_TIME = '2026-07-27T18:01:00.000Z';

const emptyProject = () => Project.createProject({
    localId: 'photo-1',
    width: 4000,
    height: 3000,
    sourceSha256: HASH,
    updatedAt: TIME,
});

const route = (overrides = {}) => ({
    id: 'route-1',
    type: 'route',
    z: 0,
    geometry: {
        points: [[200, 2500], [900, 1800], [1800, 900]],
        controls: [null, { in: [700, 2000], out: [1100, 1500] }, null],
    },
    style: { color: '#E53935', width: 12, stroke: 'solid', end: 'arrow' },
    ...overrides,
});

test('creates an empty, versioned project with deterministic export defaults', () => {
    assert.deepEqual(emptyProject(), {
        schemaVersion: 1,
        localId: 'photo-1',
        image: { width: 4000, height: 3000, sourceSha256: HASH },
        objects: [],
        export: { mime: 'image/jpeg', quality: 0.92 },
        updatedAt: TIME,
    });
});

test('resolves upload choices without pretending unsupported sources keep their format', () => {
    assert.equal(Project.sourceExportMime('IMAGE/JPEG'), 'image/jpeg');
    assert.equal(Project.sourceExportMime('image/png'), 'image/png');
    assert.equal(Project.sourceExportMime('image/webp'), null);

    assert.deepEqual(Project.resolveExportSettings({
        format: 'original',
        sourceMime: 'image/png',
        jpegQuality: 0.7,
    }), { mime: 'image/png', quality: 1 });
    assert.deepEqual(Project.resolveExportSettings({
        format: 'original',
        sourceMime: 'image/jpeg',
        jpegQuality: 0.7,
    }), { mime: 'image/jpeg', quality: 0.7 });
    assert.deepEqual(Project.resolveExportSettings({
        format: 'png',
        sourceMime: 'image/jpeg',
    }), { mime: 'image/png', quality: 1 });
    assert.deepEqual(Project.resolveExportSettings({
        format: 'jpeg',
        sourceMime: 'image/png',
        jpegQuality: 0.64,
    }), { mime: 'image/jpeg', quality: 0.64 });
    assert.equal(Project.resolveExportSettings({
        format: 'original',
        sourceMime: 'image/webp',
    }), null);
    assert.equal(Project.resolveExportSettings({ format: 'webp' }), null);
});

test('infers a saved project upload choice from its source and effective export', () => {
    assert.equal(Project.inferExportFormat(
        { mime: 'image/jpeg', quality: 0.8 },
        'image/jpeg',
    ), 'original');
    assert.equal(Project.inferExportFormat(
        { mime: 'image/png', quality: 1 },
        'image/jpeg',
    ), 'png');
    assert.equal(Project.inferExportFormat(
        { mime: 'image/jpeg', quality: 0.8 },
        'image/png',
    ), 'jpeg');
    assert.equal(Project.inferExportFormat(
        { mime: 'image/jpeg', quality: 0.8 },
        'image/webp',
    ), 'jpeg');
    assert.equal(Project.inferExportFormat({ mime: 'image/webp', quality: 1 }, 'image/webp'), null);
});

test('cleans every supported topo object and normalizes z-order and colors', () => {
    const project = Project.cleanProject({
        ...emptyProject(),
        objects: [
            {
                id: 'text-1', type: 'text', z: 20,
                geometry: { x: 500, y: 400, rotation: 0 },
                style: {
                    color: '#FFFFFF', scale: 1, align: 'center', background: true,
                },
                text: '  Northeast Ridge  ',
            },
            {
                id: 'pitch-1', type: 'pitch', z: 10, pitch: 4,
                geometry: { x: 800, y: 900, rotation: -10 },
                style: { color: '#FDD835', scale: 1.5, background: false },
            },
            {
                id: 'anchor-1', type: 'anchor', z: 5,
                geometry: { x: 300, y: 2500, rotation: 30 },
                style: { color: '#000000', scale: 0.75 },
            },
            route({ z: 2 }),
        ],
    });

    assert.deepEqual(project.objects.map(object => [object.id, object.z]), [
        ['route-1', 0],
        ['anchor-1', 1],
        ['pitch-1', 2],
        ['text-1', 3],
    ]);
    assert.equal(project.objects[0].style.color, '#e53935');
    assert.equal(project.objects[3].text, 'Northeast Ridge');
    assert.deepEqual(Project.cleanProject(project), project, 'cleaning must be idempotent');
});

test('rejects unsupported schemas, duplicate ids, unsafe styles, and invalid geometry', () => {
    const base = emptyProject();
    const cases = [
        { ...base, schemaVersion: 2 },
        { ...base, localId: '../photo' },
        { ...base, image: { ...base.image, sourceSha256: 'not-a-hash' } },
        { ...base, objects: [route(), route()] },
        { ...base, objects: [route({ style: { ...route().style, color: 'url(script)' } })] },
        { ...base, objects: [route({ geometry: { points: [[0, 0]], controls: [] } })] },
        {
            ...base,
            objects: [{
                id: 'text-1', type: 'text', z: 0, text: '<script>',
                geometry: { x: 99_999, y: 10, rotation: 0 },
                style: { color: '#ffffff', scale: 1, align: 'left', background: false },
            }],
        },
    ];
    for (const candidate of cases) assert.equal(Project.cleanProject(candidate), null);
});

test('bounds project and route complexity', () => {
    const base = emptyProject();
    const tooManyObjects = Array.from({ length: Project.MAX_OBJECTS + 1 }, (_, index) => ({
        id: `anchor-${index}`,
        type: 'anchor',
        z: index,
        geometry: { x: index, y: index, rotation: 0 },
        style: { color: '#e53935', scale: 1 },
    }));
    assert.equal(Project.cleanProject({ ...base, objects: tooManyObjects }), null);

    const tooManyPoints = Array.from(
        { length: Project.MAX_ROUTE_POINTS + 1 },
        (_, index) => [index, index],
    );
    assert.equal(Project.cleanProject({
        ...base,
        objects: [route({ geometry: { points: tooManyPoints, controls: [] } })],
    }), null);
});

test('add, update, remove, and reorder preserve a clean immutable project', () => {
    const original = emptyProject();
    const withRoute = Project.addObject(original, route(), NEXT_TIME);
    assert.equal(original.objects.length, 0);
    assert.equal(withRoute.objects.length, 1);
    assert.equal(withRoute.updatedAt, NEXT_TIME);

    const withAnchor = Project.addObject(withRoute, {
        id: 'anchor-1',
        type: 'anchor',
        geometry: { x: 200, y: 2400, rotation: 0 },
        style: { color: '#1e88e5', scale: 1 },
    }, NEXT_TIME);
    assert.deepEqual(withAnchor.objects.map(object => object.id), ['route-1', 'anchor-1']);

    const wider = Project.updateObject(withAnchor, 'route-1', {
        style: { ...withAnchor.objects[0].style, width: 18 },
    }, NEXT_TIME);
    assert.equal(wider.objects[0].style.width, 18);
    assert.equal(withAnchor.objects[0].style.width, 12);

    const behind = Project.reorderObject(wider, 'anchor-1', 'back', NEXT_TIME);
    assert.deepEqual(behind.objects.map(object => object.id), ['anchor-1', 'route-1']);
    assert.deepEqual(behind.objects.map(object => object.z), [0, 1]);

    const removed = Project.removeObjects(behind, ['anchor-1'], NEXT_TIME);
    assert.deepEqual(removed.objects.map(object => object.id), ['route-1']);
    assert.deepEqual(Project.cleanProject(removed), removed);
});

test('every object carries a bounded opacity so a mark can stop hiding the beta', () => {
    const project = Project.cleanProject({
        ...emptyProject(),
        objects: [
            route({ style: { ...route().style, opacity: 0.4 } }),
            {
                id: 'bolt-1',
                type: 'bolt',
                z: 1,
                geometry: { x: 400, y: 400, rotation: 0 },
                style: { color: '#1e88e5', scale: 1, opacity: 0.55 },
            },
        ],
    });
    assert.equal(project.objects[0].style.opacity, 0.4);
    assert.equal(project.objects[1].style.opacity, 0.55);
    // A project written before the field existed stays fully opaque.
    assert.equal(Project.cleanProject(emptyProject()) && Project.addObject(emptyProject(), {
        id: 'anchor-1',
        type: 'anchor',
        geometry: { x: 10, y: 10, rotation: 0 },
        style: { color: '#43a047', scale: 1 },
    }).objects[0].style.opacity, 1);
    // Invisible is not translucent: an out-of-range opacity rejects the whole
    // document rather than leaving a mark the user cannot find again.
    for (const opacity of [0, 0.02, 1.4, '0.5', Number.NaN]) {
        assert.equal(Project.cleanProject({
            ...emptyProject(),
            objects: [route({ style: { ...route().style, opacity } })],
        }), null, String(opacity));
    }
});

test('a smooth route re-derives its curve from its own points', () => {
    const straight = {
        ...route(),
        geometry: { points: [[200, 2500], [900, 1800], [1800, 900]], controls: [] },
        style: { ...route().style, smooth: true },
    };
    const smoothed = Project.cleanProject({ ...emptyProject(), objects: [straight] });
    assert.equal(smoothed.objects[0].style.smooth, true);
    assert.deepEqual(smoothed.objects[0].geometry.controls,
        Project.smoothControls(straight.geometry.points));

    // Adding a point is exactly what used to silently straighten the route:
    // the editor hands back empty controls and the curve has to survive.
    const extended = Project.updateObject(smoothed, 'route-1', {
        geometry: { points: [...straight.geometry.points, [2400, 400]], controls: [] },
    });
    assert.equal(extended.objects[0].style.smooth, true);
    assert.equal(extended.objects[0].geometry.controls.length, 4);

    // Turning it off drops the curve, and a project predating the flag infers
    // its intent from the handles it already stored.
    const flattened = Project.updateObject(extended, 'route-1', {
        style: { ...extended.objects[0].style, smooth: false },
    });
    assert.deepEqual(flattened.objects[0].geometry.controls, []);
    const legacy = Project.cleanProject({ ...emptyProject(), objects: [route()] });
    assert.equal(legacy.objects[0].style.smooth, true);
    assert.deepEqual(legacy.objects[0].geometry.controls, route().geometry.controls);
});
