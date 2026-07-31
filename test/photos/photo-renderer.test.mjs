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

test('the climbing symbols follow guidebook conventions, not a nautical anchor', () => {
    const anchor = Renderer.markerSymbolSvg('anchor');
    // A bolted anchor reads as two bolts slung to a master point. The old
    // glyph was a boat anchor: a ring, a shank, and curved flukes.
    assert.equal((anchor.match(/<circle/g) || []).length, 3);
    assert.match(anchor, /M -0\.56 -0\.26 L 0 0\.36 L 0\.56 -0\.26/);
    assert.doesNotMatch(anchor, /Q/, 'no fluke arc');
    // A belay is the stance bar the leader stops on, not a circled X.
    const belay = Renderer.markerSymbolSvg('belay');
    assert.match(belay, /M -0\.85 0\.5 H 0\.85/);
    assert.doesNotMatch(belay, /M -0\.38 -0\.38 L 0\.38 0\.38/, 'no crossed-out circle');

    for (const type of Project.MARKER_TYPES) {
        const symbol = Renderer.markerSymbolSvg(type);
        assert.match(symbol, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.match(symbol, /viewBox="-1\.05 -1\.05 2\.1 2\.1"/);
        assert.match(symbol, /aria-hidden="true"/);
        assert.doesNotMatch(symbol, /data-bpb-object/);
    }
    // currentColor lets the rail tint the glyph; the canvas passes a real hex
    // so an exported fill can never resolve against a stylesheet.
    assert.match(Renderer.markerSymbolSvg('bolt'), /fill="currentColor"/);
    assert.match(Renderer.markerSymbolSvg('bolt', { color: '#43a047' }), /fill="#43a047"/);
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
