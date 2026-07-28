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
    assert.match(svg, /marker-end="url\(#bpb-arrow\)"/);
    assert.match(svg, /data-bpb-object="anchor-1"/);
    assert.match(svg, />P3<\/text>/);
    assert.match(svg, /Crux &lt;roof&gt; &amp; &quot;traverse&quot;/);
    assert.doesNotMatch(svg, /<script/i);
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
