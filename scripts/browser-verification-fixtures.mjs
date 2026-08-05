// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);
export const fixtureHost = 'www.peakbagger.com';
export const verificationViewport = Object.freeze({ width: 1000, height: 760 });
export const surfaceSelectors = Object.freeze({
    analyzer: '#bpb-gpx-analysis',
    editor: '#bpb-report-editor',
    profileBackup: '#bpb-profile-backup',
    terrainToggle: '#bpb-terrain-toggle',
});
export const storeUrls = Object.freeze({
    chrome: 'https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn',
    firefox: 'https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/',
});

export function createFailureCollector() {
    const failures = [];
    return {
        failures,
        check(condition, message) {
            if (!condition) failures.push(message);
        },
        throwIfAny(label) {
            if (!failures.length) return;
            throw new Error(`${label}:\n${failures.map(message => `  - ${message}`).join('\n')}`);
        },
    };
}

export async function waitForCondition(read, {
    description = 'condition',
    intervalMs = 100,
    timeoutMs = 10_000,
} = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    let lastError;
    while (Date.now() <= deadline) {
        try {
            lastValue = await read();
            lastError = undefined;
            if (lastValue) return lastValue;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    const detail = lastError
        ? `last error: ${lastError.message}`
        : `last value: ${JSON.stringify(lastValue)}`;
    throw new Error(`Timed out waiting for ${description} (${detail})`);
}

const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Synthetic</name><trkseg>${
    Array.from({ length: 60 }, (_, index) =>
        `<trkpt lat="${(46.85 + index * 0.0006).toFixed(6)}" lon="${(-121.76 + index * 0.0004).toFixed(6)}">`
      + `<ele>${1500 + index * 25}</ele><time>2026-07-01T13:${String(index % 60).padStart(2, '0')}:00Z</time></trkpt>`)
        .join('')}</trkseg></trk></gpx>`;

export function createSyntheticCaptureJob(sourceTabId) {
    const timestamp = Date.now();
    return {
        id: `browser-verify-${timestamp}`,
        sourceTabId,
        provider: 'strava',
        activityId: 'browser-verify',
        phase: 'ready',
        cid: 900001,
        matches: [{
            id: 2829,
            name: 'Mount Shuksan',
            classification: 'strong',
            confidence: 96,
            selected: true,
            draftFields: {
                date: '2026-07-01',
                time: '08:30',
                startElevationM: 1500,
                endElevationM: 1510,
                upDistanceM: 1200,
                downDistanceM: 1100,
                upDuration: { days: 0, hours: 1, minutes: 30 },
                downDuration: { days: 0, hours: 1, minutes: 5 },
                upGainM: 420,
                downGainM: 35,
            },
        }],
        selectedIds: [2829],
        capturePreferences: {
            retainWaypoints: false,
            fillAscentDetails: true,
            fillTripInfo: false,
            fillWildernessNights: false,
        },
        tripName: 'Synthetic',
        nightsOut: null,
        dayStats: [],
        // The draft payload is newly serialized from the narrow allowlist. Unlike
        // the analyzer download fixture above, it deliberately carries no track
        // name or other provider metadata.
        uploadGpx: gpx.replace('<name>Synthetic</name>', ''),
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: timestamp + 20 * 60 * 1000,
    };
}

const ascentHtml = `<!doctype html><html><head><title>Ascent</title></head><body>
<table><tr><td>Elevation:</td><td>10,781 ft</td></tr></table>
<iframe src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300" width="450" height="450"></iframe>
<a href="/track.gpx">Download this GPS track</a>
<a href="/map/BigMap.aspx?t=A">Full Screen Map</a>
</body></html>`;

const bigMapHtml = `<!doctype html><html><head><title>Full Screen Map</title></head><body>
<iframe id="if" src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300"></iframe>
</body></html>`;

const peakBigMapHtml = `<!doctype html><html><head><title>Full Screen Peak Map</title></head><body>
<a href="/peak.aspx?pid=2829">Mount Shuksan</a>
<iframe id="if" src="/map/MasterMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300&cyn=0"></iframe>
</body></html>`;

const peakHtml = `<!doctype html><html><head><title>Mount Shuksan</title></head><body>
<h1>Mount Shuksan, Washington</h1>
<table>
  <tr><td>Latitude/Longitude (WGS84)</td><td>48.83115, -121.60214 (Dec Deg)</td></tr>
  <tr><td>Nation</td><td>United States</td></tr>
  <tr><td colspan="2"><b>Links</b><br><br>Native links</td></tr>
</table>
<table style="width:760px"><tr><td style="text-align:center">
<b>Dynamic Map</b><br>
<iframe id="Gmap" src="/map/MasterMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300"
  width="100%" height="425px"></iframe><br>
<img src="/image/MainPeakPinkCircle.gif">&nbsp;Mount Shuksan&nbsp;(Unclimbed!)<br>
<a href="/map/BigMap.aspx?cy=48.83115&cx=-121.60214&z=14&l=L_CT|L_OT&t=P&d=2829&c=0&hj=300">
  Click Here for a Full Screen Map
</a>
</td></tr></table>
</body></html>`;

// Enough of Peakbagger's frame for the analyzer overlay and native-layer sync.
const masterMapHtml = `<!doctype html><html><body>
<select id="selmap"><option value="L_CT">Topo</option></select>
<div class="leaflet-control-zoom" style="position:absolute;bottom:10px;right:10px;width:30px;height:60px"></div>
<script>
  class Polyline {
    constructor(latLngs = [], options = {}) { this.latLngs = latLngs; this.options = options; this.events = {}; }
    addTo(map) { map.addLayer(this); return this; }
    bringToBack() { return this; }
    getLatLngs() { return this.latLngs; }
    setLatLng(latLng) { this.latLngs = [latLng]; return this; }
    setStyle(style) { Object.assign(this.options, style); return this; }
    on(type, handler) { (this.events[type] ||= []).push(handler); return this; }
  }
  class Polygon extends Polyline {}
  class MapStub {
    constructor(layers = []) { this.layers = []; this.events = {}; layers.forEach(layer => this.addLayer(layer)); }
    addLayer(layer) { layer._map = this; this.layers.push(layer); for (const fn of this.events.layeradd || []) fn({ layer }); return this; }
    eachLayer(callback) { this.layers.slice().forEach(callback); }
    invalidateSize() {}
    on(type, handler) { (this.events[type] ||= []).push(handler); return this; }
    removeLayer(layer) { this.layers = this.layers.filter(candidate => candidate !== layer); layer._map = null; }
  }
  window.L = {
    Polyline, Polygon, Map: MapStub,
    polyline: (latLngs, options) => new Polyline(latLngs, options),
    circleMarker: (latLng, options) => new Polyline([latLng], options)
  };
  window.mapsPlaceholder = new MapStub([
    new Polyline([{ lat: 46.85, lng: -121.76 }, { lat: 46.87, lng: -121.74 }], { color: "#d9483b", weight: 3 })
  ]);
</script></body></html>`;

const peakMasterMapHtml = `<!doctype html><html><body>
<select id="selmap"><option value="L_CT">Topo</option></select>
<div class="leaflet-control-zoom" style="position:absolute;bottom:10px;right:10px;width:30px;height:60px"></div>
<script>
  class Marker {
    constructor(latLng, iconUrl) {
      this.latLng = latLng;
      this.options = { icon: { options: { iconUrl } } };
    }
    getLatLng() { return this.latLng; }
  }
  class MapStub {
    constructor(layers = []) {
      this.layers = layers;
      this.events = {};
      this.center = { lat: 48.83115, lng: -121.60214 };
      this.zoom = 14;
      for (const layer of layers) layer._map = this;
    }
    eachLayer(callback) { this.layers.slice().forEach(callback); }
    on(type, handler) { (this.events[type] ||= []).push(handler); return this; }
    getCenter() { return this.center; }
    getZoom() { return this.zoom; }
    setView(center, zoom) { this.center = { lat: center[0], lng: center[1] }; this.zoom = zoom; return this; }
  }
  window.L = { Marker, Map: MapStub };
  window.mapsPlaceholder = new MapStub([
    new Marker({ lat: 48.83115, lng: -121.60214 }, "/image/MainPeakPinkCircle.gif")
  ]);
</script></body></html>`;

// The disposable HTTPS identity every browser fixture needs.
//
// src/peakbagger/peakbagger-request.js refuses any URL whose protocol is not
// https: or whose host is not Peakbagger's, and product code fetches through
// that guard — so a plain-HTTP fixture makes the extension refuse its own
// fixture and the check fails for a reason unrelated to the behavior under
// test. AGENTS.md requires HTTPS on a real Peakbagger hostname for exactly
// that reason, and test/project/showcase.test.mjs pins it for every
// fixture-serving script.
//
// This lived as four near-identical copies (here plus the three terrain
// verifiers), which is a poor place for the one mechanism whose absence once
// rendered "Better Peakbagger refused an invalid Peakbagger request." into the
// store-listing screenshots. `remove` deletes the key and certificate; callers
// that minted their own directory get it cleaned up too.
export async function createFixtureCertificate({ host = fixtureHost, directory = null, label = 'fixture' } = {}) {
    const owned = directory === null;
    const root = owned
        ? await mkdtemp(path.join(os.tmpdir(), `better-peakbagger-${label}-cert-`))
        : directory;
    const keyPath = path.join(root, 'fixture-key.pem');
    const certificatePath = path.join(root, 'fixture-cert.pem');
    try {
        await execFileAsync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-subj', `/CN=${host}`, '-days', '1',
            '-keyout', keyPath, '-out', certificatePath,
        ]);
    } catch (error) {
        throw new Error(`Could not create the isolated HTTPS fixture certificate: ${error.message}`);
    }
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
    return {
        key,
        cert,
        root,
        async remove() {
            await rm(owned ? root : keyPath, { recursive: true, force: true });
            if (!owned) await rm(certificatePath, { force: true });
        },
    };
}

export async function createBrowserFixtureServer({ temporaryRoot, analyzerGpx = gpx }) {
    const certificate = await createFixtureCertificate({ directory: temporaryRoot });
    const { key, cert } = certificate;
    const [
        ascentEditHtml,
        peakAscentsHtml,
        profileAscentsHtml,
        buddyListHtml,
        peakListHtml,
        climberHtml,
    ] = await Promise.all([
        readFile(
            path.join(projectRoot, 'test', 'fixtures', 'pages', 'climber-ascentedit.html'),
            'utf8',
        ),
        readFile(
            path.join(projectRoot, 'test', 'fixtures', 'peakascents', '1039-default-full-columns.html'),
            'utf8',
        ),
        readFile(
            path.join(projectRoot, 'test', 'fixtures', 'pages', 'climber-ascents.html'),
            'utf8',
        ),
        readFile(
            path.join(projectRoot, 'test', 'fixtures', 'pages', 'report-buddy-list.html'),
            'utf8',
        ),
        readFile(
            path.join(projectRoot, 'test', 'fixtures', 'pages', 'list-peak-list.html'),
            'utf8',
        ),
        readFile(
            path.join(projectRoot, 'test', 'fixtures', 'pages', 'climber-home.html'),
            'utf8',
        ),
    ]);
    const gpxPath = path.join(temporaryRoot, 'browser-verification.gpx');
    await writeFile(gpxPath, gpx, 'utf8');
    const requests = {
        previewPosts: 0,
        savePosts: 0,
        lastPreview: null,
        buddyMutations: 0,
        buddyReports: 0,
        buddyReportStates: [],
    };
    const relativeAscentEditHtml = ascentEditHtml.replace(
        /action="https:\/\/www\.peakbagger\.com\/climber\/ascentedit\.aspx\?cid=900001"/i,
        'action=""',
    );
    const previewSuccessHtml = relativeAscentEditHtml.replace(
        /(<span id="GPXStatusLabel"[^>]*>)[\s\S]*?(<\/span>)/i,
        '$1Your file was successfully uploaded. Preview is ready.$2',
    );
    const otherClimberBaseHtml = climberHtml
        .replace('Peakbagging Page for Alex Doe', 'Peakbagging Page for Morgan Longlastname')
        .replace(
            'action="https://www.peakbagger.com/climber/climber.aspx?cid=900001"',
            'action=""',
        );
    let otherClimberIsBuddy = false;
    const buddyUpdatePanelScript = `<script>
    sessionStorage.setItem('bpbFixtureClimberLoads', String(
      Number(sessionStorage.getItem('bpbFixtureClimberLoads') || 0) + 1
    ));
    document.addEventListener('submit', async event => {
      if (event.submitter?.id !== 'BuddyButton') return;
      event.preventDefault();
      const body = new URLSearchParams(new FormData(event.target));
      body.set(event.submitter.name, event.submitter.value);
      const response = await fetch(location.href, { method: 'POST', body });
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      document.getElementById('UpdatePanel2').replaceWith(next.getElementById('UpdatePanel2'));
    });
  </script>`;
    const renderOtherClimber = () => otherClimberBaseHtml
        .replace(
            /<div id="UpdatePanel2">[\s\S]*?<\/div>/,
            `<div id="UpdatePanel2">
         <input id="BuddyButton" name="BuddyButton" type="submit"
           value="${otherClimberIsBuddy ? 'Remove from My Buddy List' : 'Add to My Buddy List'}">
       </div>`,
        )
        .replace('</body>', `${buddyUpdatePanelScript}</body>`);
    const renderBuddyList = () => otherClimberIsBuddy
        ? buddyListHtml.replaceAll('710483', '900002').replaceAll('Alpine, Casey', 'Morgan Longlastname')
        : buddyListHtml;
    const readRequestBody = request => new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        request.on('data', chunk => {
            length += chunk.length;
            if (length > 2_000_000) {
                reject(new Error('Browser fixture POST exceeded 2 MB'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
        request.on('error', reject);
    });
    const server = createServer({ key, cert }, async (request, response) => {
        const url = new URL(request.url, `https://${fixtureHost}`);
        const send = (contentType, body) => {
            response.writeHead(200, { 'content-type': contentType });
            response.end(body);
        };
        if (/ascentedit\.aspx/i.test(url.pathname)) {
            if (request.method === 'POST') {
                try {
                    const body = await readRequestBody(request);
                    const preview = /name="GPXPreview"/i.test(body);
                    const save = /name="SaveButton2?"/i.test(body);
                    if (preview) {
                        requests.previewPosts += 1;
                        requests.lastPreview = {
                            attachedGpx: /filename="track\.gpx"[\s\S]*?<gpx\b/i.test(body),
                            dateFilled: /name="DateText"[\s\S]*?\r\n\r\n2026-07-01\r\n/i.test(body),
                            suffixBlank: /name="SuffixText"[\s\S]*?\r\n\r\n\r\n/i.test(body),
                        };
                    }
                    if (save) requests.savePosts += 1;
                    return send(
                        'text/html; charset=utf-8',
                        preview ? previewSuccessHtml : relativeAscentEditHtml,
                    );
                } catch (error) {
                    response.writeHead(400);
                    response.end(error.message);
                    return;
                }
            }
            return send('text/html; charset=utf-8', relativeAscentEditHtml);
        }
        if (/ascent\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', ascentHtml);
        if (/peakascents\.aspx/i.test(url.pathname)) {
            return send('text/html; charset=utf-8', peakAscentsHtml);
        }
        if (/climblistc\.aspx/i.test(url.pathname)) {
            return send('text/html; charset=utf-8', profileAscentsHtml);
        }
        if (/\/climber\/climber\.aspx/i.test(url.pathname)) {
            if (request.method === 'POST') {
                const body = new URLSearchParams(await readRequestBody(request));
                const action = body.get('BuddyButton') || '';
                if (/^Add\b/i.test(action)) otherClimberIsBuddy = true;
                else if (/^Remove\b/i.test(action)) otherClimberIsBuddy = false;
                requests.buddyMutations += 1;
            }
            return send('text/html; charset=utf-8', renderOtherClimber());
        }
        if (/\/report\/report\.aspx/i.test(url.pathname)
        && (url.searchParams.get('r') || '').toLowerCase() === 'b') {
            requests.buddyReports += 1;
            requests.buddyReportStates.push(otherClimberIsBuddy);
            return send('text/html; charset=utf-8', renderBuddyList());
        }
        if (/\/list\.aspx$/i.test(url.pathname)) {
            return send('text/html; charset=utf-8', peakListHtml);
        }
        if (/peak\.aspx/i.test(url.pathname)) return send('text/html; charset=utf-8', peakHtml);
        if (/bigmap\.aspx/i.test(url.pathname)) {
            return send('text/html; charset=utf-8',
                (url.searchParams.get('t') || '').toUpperCase() === 'P' ? peakBigMapHtml : bigMapHtml);
        }
        if (/mastermap\.aspx/i.test(url.pathname)) {
            return send('text/html; charset=utf-8',
                (url.searchParams.get('t') || '').toUpperCase() === 'P' ? peakMasterMapHtml : masterMapHtml);
        }
        if (/track\.gpx/i.test(url.pathname)) return send('application/gpx+xml', analyzerGpx);
        response.writeHead(404);
        response.end('not found');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        port: server.address().port,
        gpxPath,
        requests,
        close: () => new Promise((resolve, reject) =>
            server.close(error => error ? reject(error) : resolve())),
    };
}

// ---------------------------------------------------------------------------
// Static fixture serving
// ---------------------------------------------------------------------------
//
// Four scripts — both terrain verifiers, the LOD check, and the showcase
// renderer — each served files out of this repository over HTTPS, and each had
// written its own copy of the content-type table, the traversal-safe file
// resolver, and the 404/500 replies. Three copies of the table were identical
// apart from a trailing comma; render-showcase.mjs had already drifted, losing
// `.gpx` (so it needed a hard-coded route to answer a GPX request at all) and
// the charset on `.svg`, while gaining `.gif` and `.mjs`.
//
// That is the same failure src/gpx/map-route-limits.js and
// src/capture/upload-limits.js exist to prevent, and this file family is the one
// where it has already cost something: the plain-HTTP fixture that silently
// disabled terrain:verify, terrain:verify:firefox, and showcase:render, and
// rendered "Better Peakbagger refused an invalid Peakbagger request." into the
// store-listing screenshots. Callers keep their own special routes — the peak
// feed, the synthetic DEM tiles, the popup mock — and compose them with these.

// Every extension asset any fixture serves. A type missing here would reach the
// browser as application/octet-stream, which for a stylesheet or a module is a
// silent, confusing failure rather than a loud one.
export const fixtureContentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.gif', 'image/gif'],
    ['.gpx', 'application/gpx+xml; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml; charset=utf-8'],
    ['.webp', 'image/webp'],
]);

export const fixtureContentType = file =>
    fixtureContentTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream';

// Resolve a request path to a real file inside `root`, or null. Rejects
// traversal out of the root and anything that is not a regular file.
export async function resolveFixtureFile(pathname, root = projectRoot) {
    let decoded = pathname;
    try { decoded = decodeURIComponent(pathname); } catch { /* keep the raw spelling */ }
    if (decoded.includes('\0')) return null;
    const resolved = path.resolve(root, `.${decoded}`);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    try {
        return (await stat(resolved)).isFile() ? resolved : null;
    } catch {
        return null;
    }
}

export function sendFixtureText(response, status, body, contentType = 'text/plain; charset=utf-8') {
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
    response.end(body);
}

export const sendFixtureNotFound = (response, body = 'Not found') =>
    sendFixtureText(response, 404, body);

// A fixture server must never swallow its own faults: the stack is the only
// signal a check has that its harness broke rather than the product.
export const sendFixtureError = (response, error) =>
    sendFixtureText(response, 500, error?.stack || String(error?.message ?? error));

// Serve one resolved file. `transform` receives the UTF-8 text and returns the
// text to send, for the callers that instrument a page before the browser sees
// it; leaving it out sends the bytes untouched, which is what binary assets
// need. `cacheControl` defaults to no-store so a check never reads a stale
// build; the showcase renderer overrides it for tiles it wants cached.
export async function sendFixtureFile(response, file, { transform = null, cacheControl = 'no-store' } = {}) {
    const contents = transform
        ? Buffer.from(transform(await readFile(file, 'utf8')))
        : await readFile(file);
    response.writeHead(200, {
        'content-type': fixtureContentType(file),
        'cache-control': cacheControl,
    });
    response.end(contents);
}

// Both terrain verifiers load terrain/terrain.html directly rather than through
// the extension, so both have to supply the two things the real frame gets from
// its extension origin. This was copied byte-for-byte between them; if the two
// copies ever drifted, the Chrome and Firefox terrain checks would be rendering
// materially different frames while still reporting the same pass.
//
// `chrome.runtime.getURL` is what the frame's MapLibre worker and bundle resolve
// against, and dist/ is where the fixture serves them. The Map proxy exposes
// only this fixture's instance, so a check can prove the mocked DEM decoded into
// non-flat terrain; production publishes no MapLibre internals.
export const instrumentTerrainFrameHtml = html => html
    .replace('</head>', `  <script>
    globalThis.chrome = { runtime: { getURL: resource => new URL('/dist/' + resource, location.origin).href } };
  </script>
</head>`)
    .replace('  <script src="terrain-frame.js"></script>', `  <script>
    maplibregl.Map = new Proxy(maplibregl.Map, {
      construct(Target, args, newTarget) {
        const instance = Reflect.construct(Target, args, newTarget);
        globalThis.__bpbTerrainTestMap = instance;
        return instance;
      }
    });
  </script>
  <script src="terrain-frame.js"></script>`);
