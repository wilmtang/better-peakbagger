// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gpxShowcase = await readFile(new URL('../scripts/showcase/gpx.html', import.meta.url), 'utf8');
const mapShowcase = await readFile(new URL('../scripts/showcase/map.html', import.meta.url), 'utf8');
const terrainShowcase = await readFile(new URL('../scripts/showcase/terrain.html', import.meta.url), 'utf8');
const bigMapShowcase = await readFile(new URL('../scripts/showcase/big-map.html', import.meta.url), 'utf8');
const bigMapNativeShowcase = await readFile(new URL('../scripts/showcase/big-map-native.html', import.meta.url), 'utf8');
const terrainFrame = await readFile(new URL('../terrain/terrain.html', import.meta.url), 'utf8');
const terrainGpx = await readFile(new URL('../scripts/showcase/terrain.gpx', import.meta.url), 'utf8');

test('GPX showcase preserves the production map-then-chart order', () => {
    const mapIndex = gpxShowcase.indexOf('class="map-card"');
    const gpxLinkIndex = gpxShowcase.indexOf('Download this GPS track');

    assert.notEqual(mapIndex, -1);
    assert.notEqual(gpxLinkIndex, -1);
    assert.ok(mapIndex < gpxLinkIndex, 'route map should render above the GPX link and injected chart');
    assert.doesNotMatch(gpxShowcase, /gpx-columns/, 'showcase must not restore the fabricated side-by-side layout');
});

test('GPX showcase map is privacy-safe and credits its basemap', () => {
    assert.match(gpxShowcase, /Synthetic three-day demo track/);
    assert.match(mapShowcase, /Synthetic demo track/);
    assert.match(mapShowcase, /U\.S\. Geological Survey, National Geospatial Program/);
    assert.doesNotMatch(mapShowcase, />Trailhead<|>Camp<|>Summit</, 'map should not add fabricated place callouts');
});

test('3D terrain showcase uses the production renderer with a synthetic route', () => {
    assert.match(terrainShowcase, /src\/terrain-map\.js/);
    assert.doesNotMatch(terrainShowcase, /vendor\/maplibre-gl-csp\.js/,
        'MapLibre should load lazily inside the extension-owned frame');
    assert.match(terrainFrame, /vendor\/maplibre-gl-csp\.js/);
    assert.match(terrainFrame, /src\/terrain-cache\.js/);
    assert.match(terrainFrame, /src\/terrain-frame\.js/);
    assert.match(terrainShowcase, /src\/gpx-metrics\.js/);
    assert.match(terrainShowcase, /src\/gpx-analyzer\.js/);
    assert.match(terrainShowcase, /enable3dMap:\s*true/);
    assert.doesNotMatch(terrainShowcase, /bpb-terrain-disclosure/);
    assert.match(terrainGpx, /Synthetic Mount Baker terrain check/);
    assert.doesNotMatch(terrainGpx, /<name>.*(?:Garmin|Strava|Alex|Zihao)/i);
});

test('BigMap showcase contains only synthetic multi-route interaction data', () => {
    assert.match(bigMapShowcase, /Synthetic recent GPS tracks/);
    // The Full Screen shell hosts the native Leaflet map in a same-origin
    // MasterMap child iframe (mirroring production); the tracks and their native
    // interactions live in that sub-fixture.
    assert.match(bigMapShowcase, /iframe id="if"[^>]*MasterMap\.aspx/);
    assert.match(bigMapNativeShowcase, /mouseover/);
    assert.match(bigMapNativeShowcase, /trip-report link/);
    assert.doesNotMatch(bigMapShowcase, /(?:Garmin|Strava|Zihao|Wilm Tang)/i);
    assert.doesNotMatch(bigMapNativeShowcase, /(?:Garmin|Strava|Zihao|Wilm Tang)/i);
});
