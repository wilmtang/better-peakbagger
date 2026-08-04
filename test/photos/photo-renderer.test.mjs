// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { photoProject as Project } from '../../src/photos/photo-project.js';
import { photoRenderer as Renderer } from '../../src/photos/photo-renderer.js';

const HASH = 'a'.repeat(64);
const TIME = '2026-07-27T18:00:00.000Z';

const projectWithObjects = () => Project.cleanProject({
    schemaVersion: 1,
    localId: 'photo-1',
    image: { width: 1600, height: 1200, sourceSha256: HASH },
    objects: [
        {
            id: 'route-1',
            type: 'route',
            z: 0,
            geometry: {
                points: [[100, 1000], [500, 600], [900, 200]],
                controls: [null, { in: [400, 700], out: [600, 500] }, null],
            },
            style: { color: '#e53935', width: 8, stroke: 'dashed', end: 'arrow' },
        },
        {
            id: 'anchor-1',
            type: 'anchor',
            z: 1,
            geometry: { x: 900, y: 200, rotation: 20 },
            style: { color: '#ffffff', scale: 1.2 },
        },
        {
            id: 'pitch-1',
            type: 'pitch',
            z: 2,
            pitch: 3,
            geometry: { x: 500, y: 600, rotation: 0 },
            style: { color: '#fdd835', scale: 1, background: true },
        },
        {
            id: 'text-1',
            type: 'text',
            z: 3,
            text: 'Crux <roof> & "traverse"',
            geometry: { x: 300, y: 300, rotation: -5 },
            style: {
                color: '#ffffff', scale: 0.8, align: 'left', background: false,
            },
        },
    ],
    export: { mime: 'image/jpeg', quality: 0.92 },
    updatedAt: TIME,
});

test('renders cleaned route geometry, symbols, pitch labels, and escaped text as SVG', () => {
    const svg = Renderer.renderOverlaySvg(projectWithObjects());
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox="0 0 1600 1200"/);
    assert.match(svg, /M 100 1000 C 100 1000 400 700 500 600 C 600 500 900 200 900 200/);
    assert.match(svg, /stroke-dasharray="24 16"/);
    assert.match(svg, /marker-end="url\(#bpb-arrow-e53935\)"/);
    assert.match(svg, /data-bpb-object="anchor-1"/);
    assert.match(svg, />P3<\/text>/);
    assert.match(svg, /Crux &lt;roof&gt; &amp; &quot;traverse&quot;/);
    assert.doesNotMatch(svg, /<script/i);
});

test('every arrowed route keeps its own arrowhead color', () => {
    const arrowRoute = (id, color, end) => ({
        id,
        type: 'route',
        z: 0,
        geometry: { points: [[100, 100], [400, 400]], controls: [] },
        style: { color, width: 8, stroke: 'solid', end },
    });
    const svg = Renderer.renderOverlaySvg(Project.cleanProject({
        schemaVersion: 1,
        localId: 'photo-1',
        image: { width: 1600, height: 1200, sourceSha256: HASH },
        objects: [
            arrowRoute('route-red', '#e53935', 'arrow'),
            arrowRoute('route-blue', '#1e88e5', 'arrow'),
            arrowRoute('route-blue-again', '#1e88e5', 'arrow'),
            arrowRoute('route-plain', '#43a047', 'none'),
        ],
        export: { mime: 'image/jpeg', quality: 0.92 },
        updatedAt: TIME,
    }));

    assert.deepEqual(svg.match(/<marker id="[^"]+"/g), [
        '<marker id="bpb-arrow-e53935"',
        '<marker id="bpb-arrow-1e88e5"',
    ], 'one marker per distinct arrow color, deduplicated');
    assert.deepEqual(svg.match(/L 10 5 L 0 10 z" fill="[^"]+"/g), [
        'L 10 5 L 0 10 z" fill="#e53935"',
        'L 10 5 L 0 10 z" fill="#1e88e5"',
    ]);
    assert.deepEqual(svg.match(/marker-end="[^"]+"/g), [
        'marker-end="url(#bpb-arrow-e53935)"',
        'marker-end="url(#bpb-arrow-1e88e5)"',
        'marker-end="url(#bpb-arrow-1e88e5)"',
    ], 'the route without an arrow end references no marker');
});

test('omits the arrow defs entirely when no route ends in an arrow', () => {
    const svg = Renderer.renderOverlaySvg(Project.cleanProject({
        schemaVersion: 1,
        localId: 'photo-1',
        image: { width: 1600, height: 1200, sourceSha256: HASH },
        objects: [{
            id: 'anchor-1',
            type: 'anchor',
            z: 0,
            geometry: { x: 900, y: 200, rotation: 0 },
            style: { color: '#ffffff', scale: 1 },
        }],
        export: { mime: 'image/jpeg', quality: 0.92 },
        updatedAt: TIME,
    }));
    assert.doesNotMatch(svg, /<defs>/);
    assert.doesNotMatch(svg, /<marker/);
});

test('rejects unclean projects before generating markup', () => {
    assert.throws(() => Renderer.renderOverlaySvg({
        ...projectWithObjects(),
        schemaVersion: 99,
    }), /clean project/);
});

test('hashes exported bytes with SHA-256', async () => {
    const blob = new Blob(['topo'], { type: 'image/jpeg' });
    assert.equal(await Renderer.sha256(blob, webcrypto),
        '4d79c63e02c6a66d127fee87c91aa70d86bde9aada8cd271c412b079b22e538b');
});

test('estimates from the same full-resolution encoding used for export', async () => {
    const encodes = [];
    const draws = [];
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
            drawImage: (...args) => draws.push(args),
        }),
        toBlob(callback, mime, quality) {
            encodes.push({ mime, quality, width: this.width, height: this.height });
            callback(new Blob([`${mime}:${quality}`], { type: mime }));
        },
    };
    class ImageCtor {
        set src(value) {
            this.value = value;
            queueMicrotask(() => this.onload());
        }
    }
    const dependencies = {
        ImageCtor,
        URLImpl: {
            createObjectURL: () => 'blob:overlay',
            revokeObjectURL: () => {},
        },
        BlobCtor: Blob,
    };
    const project = Project.cleanProject({
        ...projectWithObjects(),
        export: { mime: 'image/jpeg', quality: 0.67 },
    });
    const options = {
        project,
        source: { fixture: 'source-bitmap', width: 1600, height: 1200 },
        document: { createElement: () => canvas },
        imageDependencies: dependencies,
    };

    const estimated = await Renderer.estimateProject(options);
    assert.deepEqual({
        mime: estimated.mime,
        bytes: estimated.bytes,
        width: estimated.width,
        height: estimated.height,
    }, {
        mime: 'image/jpeg',
        bytes: new Blob(['image/jpeg:0.67']).size,
        width: 1600,
        height: 1200,
    });
    assert.equal('sha256' in estimated, false, 'estimating does not hash until upload');
    assert.deepEqual(encodes[0], {
        mime: 'image/jpeg',
        quality: 0.67,
        width: 1600,
        height: 1200,
    });
    assert.equal(draws.length, 2, 'source pixels and the rendered overlay are both flattened');

    const exported = await Renderer.exportProject({ ...options, crypto: webcrypto });
    assert.equal(exported.bytes, estimated.bytes);
    assert.equal(exported.sha256.length, 64);
    assert.deepEqual(encodes[1], encodes[0], 'export uses the exact same encoding path');
});

test('opacity dims the whole mark, including its arrowhead and contrast plate', () => {
    const svg = Renderer.renderOverlaySvg(Project.cleanProject({
        schemaVersion: 1,
        localId: 'photo-1',
        image: { width: 1600, height: 1200, sourceSha256: HASH },
        objects: [
            {
                id: 'route-1',
                type: 'route',
                z: 0,
                geometry: { points: [[100, 100], [400, 400]], controls: [] },
                style: {
                    color: '#e53935', width: 8, stroke: 'solid', end: 'arrow', opacity: 0.35,
                },
            },
            {
                id: 'anchor-1',
                type: 'anchor',
                z: 1,
                geometry: { x: 900, y: 200, rotation: 0 },
                style: { color: '#ffffff', scale: 1, opacity: 0.6 },
            },
            {
                id: 'text-1',
                type: 'text',
                z: 2,
                text: 'Traverse',
                geometry: { x: 300, y: 300, rotation: 0 },
                style: {
                    color: '#ffffff', scale: 1, align: 'left', background: true, opacity: 0.5,
                },
            },
            {
                id: 'bolt-1',
                type: 'bolt',
                z: 3,
                geometry: { x: 200, y: 900, rotation: 0 },
                style: { color: '#1e88e5', scale: 1 },
            },
        ],
        export: { mime: 'image/jpeg', quality: 0.92 },
        updatedAt: TIME,
    }));
    // The value sits on each object's own group: stroke-opacity would leave a
    // referenced arrow marker and a filled label plate at full strength.
    assert.match(svg, /<g data-bpb-object="route-1" opacity="0.35"><path /);
    assert.match(svg, /<g data-bpb-object="anchor-1" opacity="0.6" transform=/);
    assert.match(svg, /<g data-bpb-object="text-1" opacity="0.5" transform=/);
    // A fully opaque mark stays attribute-free, so existing exports are
    // byte-identical to what they were before opacity existed.
    assert.match(svg, /<g data-bpb-object="bolt-1" transform=/);
});

test('the climbing symbols reuse Mountain Project shapes and retain the additional anchor', () => {
    assert.deepEqual(Project.MARKER_TYPES,
        ['bolt', 'anchor', 'piton', 'rappel', 'belay'],
        'the Better Peakbagger-only anchor stays beside the reused Mountain Project shapes');

    const bolt = Renderer.markerSymbolSvg('bolt');
    assert.match(bolt,
        /M -0\.72 -0\.72 L 0\.72 0\.72 M 0\.72 -0\.72 L -0\.72 0\.72/,
        'bolt uses Mountain Project X geometry');
    assert.doesNotMatch(bolt, /<circle/);

    const piton = Renderer.markerSymbolSvg('piton');
    assert.match(piton,
        /M -0\.15 0\.72 V -0\.72 H 0\.29 A 0\.43 0\.43 0 0 1 0\.29 0\.14 H -0\.15/,
        'Mountain Project draws a piton as a P-shaped peg');

    const rappel = Renderer.markerSymbolSvg('rappel');
    assert.match(rappel, /<circle cx="0" cy="0" r="0\.72"/);
    assert.match(rappel, /M 0 -0\.36 V 0\.36 M -0\.36 0 L 0 0\.36 L 0\.36 0/,
        'Mountain Project draws rappel as a circled down-arrow');

    const belay = Renderer.markerSymbolSvg('belay');
    assert.match(belay, /<circle cx="0" cy="0" r="0\.72"/,
        'Mountain Project draws belay as a plain circle');
    assert.doesNotMatch(belay, /<path/);

    const anchor = Renderer.markerSymbolSvg('anchor');
    assert.equal((anchor.match(/<circle/g) || []).length, 2);
    assert.match(anchor, /r="0\.17" fill="currentColor"/,
        'the additional anchor is a bullseye distinct from Mountain Project belay');
    assert.doesNotMatch(anchor, /<path/);

    for (const type of Project.MARKER_TYPES) {
        const symbol = Renderer.markerSymbolSvg(type);
        assert.match(symbol, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.match(symbol, /viewBox="-1\.05 -1\.05 2\.1 2\.1"/);
        assert.match(symbol, /aria-hidden="true"/);
        assert.doesNotMatch(symbol, /data-bpb-object/);
    }
    // currentColor lets the rail tint the glyph; the canvas passes a real hex
    // so an exported fill can never resolve against a stylesheet.
    assert.match(anchor, /fill="currentColor"/);
    assert.match(Renderer.markerSymbolSvg('anchor', { color: '#43a047' }), /fill="#43a047"/);
});

test('editor pixel sizes come from the same dimensions the renderer paints', () => {
    const image = { width: 1600, height: 1200 };
    const rendered = value => Math.round(value * 1000) / 1000;
    assert.equal(rendered(Renderer.objectSizePixels('bolt', image, 1)), 32.4);
    assert.equal(rendered(Renderer.objectSizePixels('anchor', image, 2)), 64.8);
    assert.equal(rendered(Renderer.objectSizePixels('pitch', image, 1)), 42);
    assert.equal(rendered(Renderer.objectSizePixels('text', image, 0.5)), 21);

    const svg = Renderer.renderOverlaySvg(projectWithObjects());
    assert.match(svg, /data-bpb-object="anchor-1"[^>]*scale\(38\.88\)/);
    assert.match(svg, /data-bpb-object="pitch-1"[\s\S]*font-size="42"/);
});

test('checks source dimensions before allocating the export canvas', async () => {
    let allocated = false;
    await assert.rejects(Renderer.exportProject({
        project: projectWithObjects(),
        source: { width: 1200, height: 1600 },
        document: {
            createElement() {
                allocated = true;
                throw new Error('canvas must not be allocated');
            },
        },
    }), /dimensions do not match/);
    assert.equal(allocated, false);
});

test('exports a legitimate panorama at the exact pixel budget', async () => {
    const project = Project.createProject({
        localId: 'panorama',
        width: 16_000,
        height: 4_000,
        sourceSha256: HASH,
        updatedAt: TIME,
    });
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toBlob: callback => callback(new Blob(['panorama'], { type: 'image/jpeg' })),
    };
    class TestImage {
        set src(_value) { queueMicrotask(() => this.onload?.()); }
    }
    const exported = await Renderer.exportProject({
        project,
        source: { width: project.image.width, height: project.image.height },
        document: { createElement: () => canvas },
        crypto: webcrypto,
        imageDependencies: {
            ImageCtor: TestImage,
            URLImpl: {
                createObjectURL: () => 'blob:overlay',
                revokeObjectURL() {},
            },
            BlobCtor: Blob,
        },
    });
    assert.equal(canvas.width * canvas.height, Project.MAX_PIXELS);
    assert.deepEqual(
        { width: exported.width, height: exported.height },
        { width: 16_000, height: 4_000 },
    );
});
