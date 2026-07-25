// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { walkFiles } from '../helpers/walk-files.mjs';

const gpxShowcase = await readFile(new URL('../../scripts/showcase/gpx.html', import.meta.url), 'utf8');
const mapShowcase = await readFile(new URL('../../scripts/showcase/map.html', import.meta.url), 'utf8');
const terrainShowcase = await readFile(new URL('../../scripts/showcase/terrain.html', import.meta.url), 'utf8');
const bigMapShowcase = await readFile(new URL('../../scripts/showcase/big-map.html', import.meta.url), 'utf8');
const bigMapNativeShowcase = await readFile(new URL('../../scripts/showcase/big-map-native.html', import.meta.url), 'utf8');
const terrainFrame = await readFile(new URL('../../terrain/terrain.html', import.meta.url), 'utf8');
const terrainGpx = await readFile(new URL('../../scripts/showcase/terrain.gpx', import.meta.url), 'utf8');

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
    // The showcase loads the built bundles (the isolated 3D bridge and the
    // MAIN-world analyzer); MapLibre loads lazily inside the extension frame.
    assert.match(terrainShowcase, /dist\/content\/terrain-map\.js/);
    assert.doesNotMatch(terrainShowcase, /vendor\/maplibre-gl-csp\.js/,
        'MapLibre should load lazily inside the extension-owned frame');
    assert.match(terrainFrame, /vendor\/maplibre-gl-csp\.js/);
    // terrain-cache and settings-schema are bundled into the frame bundle now;
    // bundle composition is asserted in manifest-capture.test.mjs.
    assert.match(terrainFrame, /terrain-frame\.js/);
    assert.match(terrainShowcase, /dist\/content\/gpx-analyzer\.js/);
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

// The showcase pages and terrain/terrain.html hand-mirror the manifest's script
// order, because they stand in for a real extension load. Nothing used to check
// that mirror, so adding a dependency to a src module could leave a page loading
// a consumer without its provider. The consumer then hits its fail-closed guard
// and the whole surface silently renders nothing, which no unit test sees.
//
// Only *hard* dependencies are listed: globals whose absence makes the module
// bail out or throw. Modules also read BPBPeakMarkers and BPBTerrainBasemap
// behind null checks and degrade gracefully, so a page may legitimately omit
// those (scripts/showcase/gpx.html is chart-only and does).
// Every content module now imports its dependencies, so no module reads a
// cross-module global. This provider-order guard therefore has nothing left to
// pin; Step 10 replaces the showcase pages with built bundles and retires this
// machinery. Kept empty (not deleted) until then so the harness stays stable.
const REQUIRES = {};

const providerOf = async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const dir = path.join(root, 'src');
    const providers = new Map();
    for (const file of await walkFiles(dir, candidate => candidate.endsWith('.js'))) {
        const text = await readFile(file, 'utf8');
        for (const [, global] of text.matchAll(/^\s*(?:globalThis|window)\.(BPB[A-Za-z]+)\s*=/gm)) {
            providers.set(global, path.relative(root, file));
        }
    }
    return providers;
};

const loadedScripts = html =>
    [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1].replace(/^[./]*/, ''));

// A global a page satisfies with its own inline stub instead of the real module.
const inlineStubs = html =>
    new Set([...html.matchAll(/(?:globalThis|window)\.(BPB[A-Za-z]+)\s*=/g)].map(match => match[1]));

test('every REQUIRES entry names a real module and a real provider', async () => {
    const providers = await providerOf();
    for (const [module, globals] of Object.entries(REQUIRES)) {
        const text = await readFile(new URL(`../../${module}`, import.meta.url), 'utf8');
        for (const global of globals) {
            assert.ok(providers.has(global), `${module} requires ${global}, which nothing provides`);
            assert.match(text, new RegExp(`\\b${global}\\b`), `${module} no longer reads ${global}`);
        }
    }
});

test('every harness page loads the providers its scripts hard-require, in order', async () => {
    const providers = await providerOf();
    const pages = [
        ['scripts/showcase/gpx.html', gpxShowcase],
        ['scripts/showcase/map.html', mapShowcase],
        ['scripts/showcase/terrain.html', terrainShowcase],
        ['scripts/showcase/big-map.html', bigMapShowcase],
        ['scripts/showcase/big-map-native.html', bigMapNativeShowcase],
        ['terrain/terrain.html', terrainFrame]
    ];

    const problems = [];
    for (const [pageName, html] of pages) {
        const scripts = loadedScripts(html);
        const stubbed = inlineStubs(html);
        scripts.forEach((script, index) => {
            const earlier = new Set(scripts.slice(0, index));
            for (const global of REQUIRES[script] || []) {
                const provider = providers.get(global);
                if (earlier.has(provider) || stubbed.has(global)) continue;
                problems.push(`${pageName}: ${script} requires ${global}, but ${provider} does not load before it`);
            }
        });
    }
    assert.deepEqual(problems, [], `harness pages drifted from the module graph:\n${problems.join('\n')}`);
});

// Every script that serves the showcase to a real browser must do so over HTTPS
// on a Peakbagger hostname. src/peakbagger/peakbagger-request.js refuses any URL
// whose protocol is not https: or whose host is not Peakbagger's — a deliberate
// security property — and the GPX Analyzer fetches its track through that guard.
// Served over http://, the analyzer panel renders "Better Peakbagger refused an
// invalid Peakbagger request.", the route never loads, and the 3D toggle stays
// disabled: terrain:verify and terrain:verify:firefox time out, and
// showcase:render writes that refusal into the store listing screenshots.
const FIXTURE_SERVERS = [
    'scripts/verify-terrain-visual.mjs',
    'scripts/verify-firefox-terrain.mjs',
    'scripts/render-showcase.mjs',
];

test('every showcase server speaks HTTPS on a Peakbagger host, or the analyzer refuses its own GPX', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    for (const relative of FIXTURE_SERVERS) {
        const source = await readFile(path.join(root, relative), 'utf8');
        assert.match(source, /from ['"]node:https['"]/,
            `${relative} must serve the showcase over HTTPS`);
        assert.doesNotMatch(source, /from ['"]node:http['"]/,
            `${relative} must not fall back to a plain HTTP fixture server`);
        assert.match(source, /peakbagger\.com/,
            `${relative} must serve from a Peakbagger hostname`);
        // Every showcase URL the browser is pointed at. Chrome's own CDP
        // endpoint on 127.0.0.1 is a control channel, not a page under test,
        // and stays plain HTTP.
        const plainShowcaseUrls = (source.match(/http:\/\/[^\s'"`)]+/g) || [])
            .filter(value => !value.startsWith('http://127.0.0.1'))
            .filter(value => !value.startsWith('http://www.w3.org'));
        assert.deepEqual(plainShowcaseUrls, [],
            `${relative} points a browser at a plain-HTTP showcase URL: ${plainShowcaseUrls.join(', ')}`);
        // A self-signed fixture certificate is disposable and must be removed.
        assert.match(source, /openssl/, `${relative} must mint its own fixture certificate`);
        assert.match(source, /rm\(\s*certificate/i,
            `${relative} must delete its fixture key and certificate after the run`);
    }
});

test('the request guard that makes the HTTPS fixture necessary is still in force', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const { fetchPeakbaggerResource } = await import(
        new URL('../../src/peakbagger/peakbagger-request.js', import.meta.url).href);
    let called = false;
    const overHttp = await fetchPeakbaggerResource('http://www.peakbagger.com/scripts/showcase/terrain.gpx', {
        kind: 'gpx', fetchFn: async () => { called = true; },
    });
    assert.equal(overHttp.error.code, 'invalid-request',
        'plain HTTP must stay refused — the fixtures serve HTTPS because of this, not the reverse');
    assert.equal(called, false, 'and it must fail before any fetch');
    assert.ok(root);
});
