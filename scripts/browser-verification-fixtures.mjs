// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const fixtureHost = "www.peakbagger.com";
export const verificationViewport = Object.freeze({ width: 1000, height: 760 });
export const surfaceSelectors = Object.freeze({
  analyzer: "#bpb-gpx-analysis",
  editor: "#bpb-report-editor",
  terrainToggle: "#bpb-terrain-toggle",
});
export const storeUrls = Object.freeze({
  chrome: "https://chromewebstore.google.com/detail/better-peakbagger/",
  firefox: "https://addons.mozilla.org/firefox/addon/better-peakbagger/",
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
      throw new Error(`${label}:\n${failures.map(message => `  - ${message}`).join("\n")}`);
    },
  };
}

export async function waitForCondition(read, {
  description = "condition",
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
      + `<ele>${1500 + index * 25}</ele><time>2026-07-01T13:${String(index % 60).padStart(2, "0")}:00Z</time></trkpt>`)
    .join("")}</trkseg></trk></gpx>`;

const ascentHtml = `<!doctype html><html><head><title>Ascent</title></head><body>
<table><tr><td>Elevation:</td><td>10,781 ft</td></tr></table>
<iframe src="/map/MasterMap.aspx?t=P&d=2296&c=900001&hj=300" width="450" height="450"></iframe>
<a href="/track.gpx">Download this GPS track</a>
<a href="/map/BigMap.aspx?t=A">Full Screen Map</a>
</body></html>`;

const bigMapHtml = `<!doctype html><html><head><title>Full Screen Map</title></head><body>
<iframe id="if" src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300"></iframe>
</body></html>`;

const peakHtml = `<!doctype html><html><head><title>Mount Shuksan</title></head><body>
<h1>Mount Shuksan, Washington</h1>
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

export async function createBrowserFixtureServer({ temporaryRoot }) {
  const keyPath = path.join(temporaryRoot, "fixture-key.pem");
  const certificatePath = path.join(temporaryRoot, "fixture-cert.pem");
  try {
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-subj", `/CN=${fixtureHost}`, "-days", "1",
      "-keyout", keyPath, "-out", certificatePath,
    ]);
  } catch (error) {
    throw new Error(`Could not create the isolated HTTPS fixture certificate: ${error.message}`);
  }
  const [key, cert, ascentEditHtml] = await Promise.all([
    readFile(keyPath),
    readFile(certificatePath),
    readFile(
      path.join(projectRoot, "test", "fixtures", "pages", "climber-ascentedit.html"),
      "utf8",
    ),
  ]);
  const server = createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url, `https://${fixtureHost}`);
    const send = (contentType, body) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    };
    if (/ascentedit\.aspx/i.test(url.pathname)) return send("text/html; charset=utf-8", ascentEditHtml);
    if (/ascent\.aspx/i.test(url.pathname)) return send("text/html; charset=utf-8", ascentHtml);
    if (/peak\.aspx/i.test(url.pathname)) return send("text/html; charset=utf-8", peakHtml);
    if (/bigmap\.aspx/i.test(url.pathname)) return send("text/html; charset=utf-8", bigMapHtml);
    if (/mastermap\.aspx/i.test(url.pathname)) return send("text/html; charset=utf-8", masterMapHtml);
    if (/track\.gpx/i.test(url.pathname)) return send("application/gpx+xml", gpx);
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  };
}
