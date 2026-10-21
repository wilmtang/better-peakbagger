// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Download this pinned public-domain source separately, then supply its path.
const source = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_admin_1_states_provinces.geojson';
const sha256 = '69a0e06e640b2d505858ae1cb63034e4677f3000b35a98e16312932b98c426b9';
assert.equal(process.argv.length, 3, 'Usage: node scripts/generate-map-overlay-regions.mjs SOURCE.geojson');
const bytes = await readFile(process.argv[2]);
assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, 'pinned Natural Earth input');
const regions = {};
for (const { properties, geometry } of JSON.parse(bytes).features) {
    const key = properties.adm0_a3 === 'USA' ? `us_${properties.postal.toLowerCase()}`
        : properties.adm0_a3 === 'CAN' && ['BC', 'AB'].includes(properties.postal) ? properties.postal.toLowerCase() : null;
    if (!key) continue;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    regions[key] = polygons.map(rings => rings[0].map(point => point.map(value => Number(value.toFixed(5)))));
}
assert.equal(Object.keys(regions).length, 53, '50 states, DC, BC and Alberta');
await writeFile(new URL('../src/maps/canadian-land-regions.json', import.meta.url), JSON.stringify({ source, sha256,
    license: 'Public domain: https://www.naturalearthdata.com/about/terms-of-use/',
    purpose: 'Coarse offline provider routing and overlay availability only; never ownership or access permission.', regions }) + '\n');
