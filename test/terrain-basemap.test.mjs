// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { terrainBasemap } from '../src/terrain-basemap.js';

const load = () => terrainBasemap;

// The module builds objects in the JSDOM realm, so strict deepEqual would trip
// on the foreign prototype; compare structure by value instead.
const plain = value => JSON.parse(JSON.stringify(value));

// A minimal #selmap-like select without a real DOM: enumerate/active only read
// .options, .value, .selectedIndex, and each option's .value/.textContent.
const makeSelect = (options, selectedIndex = 0) => ({
    options,
    selectedIndex,
    get value() { return options[selectedIndex] ? options[selectedIndex].value : ''; }
});
const option = (value, textContent) => ({ value, textContent });

test('drapeFromCode maps known #selmap codes to fixed xyz raster specs and rejects the rest', () => {
    const B = load();
    const calTopo = B.drapeFromCode('L_CT', 'CalTopo');
    assert.deepEqual(plain(calTopo), {
        name: 'CalTopo',
        tiles: ['https://caltopo.s3.amazonaws.com/topo/{z}/{x}/{y}.png?v=1'],
        tileSize: 256,
        minzoom: 6,
        maxzoom: 16,
        scheme: 'xyz',
        stockLod: false,
        attribution: '&copy; <a href="https://caltopo.com" target="_blank" rel="noopener noreferrer">CalTopo</a>'
    });
    // A code with no drape spec (WMS/Google/Bing/etc.) stays 2D-only.
    assert.equal(B.drapeFromCode('L_GG', 'Google'), null);
    assert.equal(B.drapeFromCode('', 'Nameless'), null);
    // Missing/blank names fall back to the code itself.
    assert.equal(B.drapeFromCode('L_OS').name, 'L_OS');
    assert.equal(B.drapeFromCode('L_OS', '   ').name, 'L_OS');
});

test('enumerate mirrors the drape-able #selmap options in order, deduped', () => {
    const B = load();
    const select = makeSelect([
        option('L_CT', 'CalTopo'),
        option('L_GG', 'Google Terrain'), // no spec — dropped
        option('L_MT', 'MyTopo USA/Canada'),
        option('L_CT', 'CalTopo (dup)'),  // duplicate code — dropped
        option('L_OS', 'Open Street Map')
    ]);
    assert.deepEqual(plain(B.enumerate(select).map(basemap => basemap.name)),
        ['CalTopo', 'MyTopo USA/Canada', 'Open Street Map']);
    assert.deepEqual(plain(B.enumerate(null)), []);
    assert.deepEqual(plain(B.enumerate({})), []);
});

test('active prefers the known-code spec for the selected layer', () => {
    const B = load();
    const select = makeSelect([option('L_CT', 'CalTopo'), option('L_MT', 'MyTopo USA/Canada')], 1);
    const map = { _layers: {}, hasLayer: () => true };
    const drape = B.active({}, map, select);
    assert.equal(drape.name, 'MyTopo USA/Canada');
    assert.equal(drape.tiles[0], B.TERRAIN_DRAPE_LAYERS.L_MT.tiles);
});

test('active falls back to the live Leaflet layer for a code it carries no spec for', () => {
    const B = load();
    // National basemap code with no built-in spec, but its live Leaflet layer is
    // a plain {z}/{x}/{y} raster MapLibre can sample.
    const liveLayer = {
        _url: 'https://{s}.national.example/{z}/{x}/{y}{r}.png',
        options: { subdomains: 'abc', minZoom: 3, maxZoom: 17, attribution: 'Nat', tileSize: 256 }
    };
    const select = makeSelect([option('L_NAT', 'National Basemap')]);
    const mapWin = { L_NAT: liveLayer, L: { Browser: { retina: false } }, location: { href: 'https://www.peakbagger.com/map/MasterMap.aspx' } };
    const map = { _layers: { active: liveLayer }, hasLayer: layer => layer === liveLayer };
    const drape = B.active(mapWin, map, select);
    assert.equal(drape.name, 'National Basemap');
    assert.equal(drape.tiles[0], 'https://a.national.example/{z}/{x}/{y}.png');
    assert.equal(drape.minzoom, 3);
    assert.equal(drape.maxzoom, 17);
});

test('active fails closed when there is no map or no selected option', () => {
    const B = load();
    const select = makeSelect([option('L_CT', 'CalTopo')]);
    assert.equal(B.active({}, null, select), null);
    assert.equal(B.active({}, { _layers: {} }, makeSelect([], -1)), null);
    assert.equal(B.active({}, { _layers: {} }, null), null);
});

test('fromLayer rejects WMS and reprojected layers, expands subdomains and retina, and absolutizes', () => {
    const B = load();
    const mapWin = { L: { Browser: { retina: true } }, location: { href: 'https://www.peakbagger.com/map/MasterMap.aspx' } };

    // Retina + subdomain expansion + absolute passthrough.
    const retina = B.fromLayer({
        _url: 'https://{s}.tiles.example/{z}/{x}/{y}{r}.png',
        options: { subdomains: 'abc', minZoom: 2, maxZoom: 16 }
    }, 'Example', mapWin);
    assert.equal(retina.tiles[0], 'https://a.tiles.example/{z}/{x}/{y}@2x.png');

    // A relative Leaflet URL is resolved against the map window's location.
    const relative = B.fromLayer({ _url: '/tiles/{z}/{x}/{y}.png', options: {} }, 'Rel', mapWin);
    assert.equal(relative.tiles[0], 'https://www.peakbagger.com/tiles/{z}/{x}/{y}.png');

    // WMS and reprojected layers cannot drape.
    assert.equal(B.fromLayer({ _url: 'https://wms.example/', wmsParams: {}, options: {} }, 'WMS', mapWin), null);
    assert.equal(B.fromLayer({ _url: 'https://z.example/{z}/{x}/{y}.png', options: { zoomOffset: -1 } }, 'Off', mapWin), null);
});

// The tightened drape LOD trades roughly 2-3x more tile requests for a drape
// that does not step down a level on a small tilt. That trade is only ours to
// make against hosts that tolerate the volume, so the opt-out is a boundary
// worth pinning: OpenTopoMap is volunteer-run under a tile usage policy, and a
// live Leaflet layer is an unknown host on unknown terms.
test('drape specs keep the stock LOD for OpenTopoMap and for unknown live layers', () => {
    const B = load();

    assert.equal(B.drapeFromCode('L_OT', 'OpenTopoMap').stockLod, true,
        'OpenTopoMap must stay on the stock LOD to respect its tile usage policy');

    for (const code of ['L_CT', 'L_FS', 'L_MT', 'L_OS', 'L_AG', 'L_AI', 'L_XX', 'L_AU']) {
        assert.equal(B.drapeFromCode(code, code).stockLod, false,
            `${code} is hosted on infrastructure that tolerates the volume, so it takes the tuned LOD`);
    }

    // A basemap read off the live Leaflet map is whatever the page had active.
    const live = B.fromLayer({ _url: 'https://tiles.example/{z}/{x}/{y}.png', options: {} }, 'National', {
        L: { Browser: { retina: false } },
        location: { href: 'https://www.peakbagger.com/map/MasterMap.aspx' }
    });
    assert.equal(live.stockLod, true, 'an unknown live host must not be handed tripled tile requests');
});
