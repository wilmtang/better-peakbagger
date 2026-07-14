// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gpxShowcase = await readFile(new URL('../scripts/showcase/gpx.html', import.meta.url), 'utf8');
const mapShowcase = await readFile(new URL('../scripts/showcase/map.html', import.meta.url), 'utf8');

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
