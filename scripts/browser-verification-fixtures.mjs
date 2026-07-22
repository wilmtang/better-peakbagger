// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
  profileBackup: "#bpb-profile-backup",
  terrainToggle: "#bpb-terrain-toggle",
});
export const storeUrls = Object.freeze({
  chrome: "https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn",
  firefox: "https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/",
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

export function createSyntheticCaptureJob(sourceTabId) {
  const timestamp = Date.now();
  return {
    id: `browser-verify-${timestamp}`,
    sourceTabId,
    provider: "strava",
    activityId: "browser-verify",
    phase: "ready",
    cid: 900001,
    matches: [{
      id: 2829,
      name: "Mount Shuksan",
      classification: "strong",
      confidence: 96,
      selected: true,
      draftFields: {
        date: "2026-07-01",
        time: "08:30",
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
    tripName: "Synthetic",
    nightsOut: null,
    dayStats: [],
    // The draft payload is newly serialized from the narrow allowlist. Unlike
    // the analyzer download fixture above, it deliberately carries no track
    // name or other provider metadata.
    uploadGpx: gpx.replace("<name>Synthetic</name>", ""),
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp + 20 * 60 * 1000,
  };
}

const ascentHtml = `<!doctype html><html><head><title>Ascent</title></head><body>
<table><tr><td>Elevation:</td><td>10,781 ft</td></tr></table>
<iframe src="/map/MasterMap.aspx?t=P&d=2296&c=900001&hj=300" width="450" height="450"></iframe>
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
  const [key, cert, ascentEditHtml, peakAscentsHtml, profileAscentsHtml, buddyListHtml, climberHtml] = await Promise.all([
    readFile(keyPath),
    readFile(certificatePath),
    readFile(
      path.join(projectRoot, "test", "fixtures", "pages", "climber-ascentedit.html"),
      "utf8",
    ),
    readFile(
      path.join(projectRoot, "test", "fixtures", "peakascents", "1039-default-full-columns.html"),
      "utf8",
    ),
    readFile(
      path.join(projectRoot, "test", "fixtures", "pages", "climber-ascents.html"),
      "utf8",
    ),
    readFile(
      path.join(projectRoot, "test", "fixtures", "pages", "report-buddy-list.html"),
      "utf8",
    ),
    readFile(
      path.join(projectRoot, "test", "fixtures", "pages", "climber-home.html"),
      "utf8",
    ),
  ]);
  const gpxPath = path.join(temporaryRoot, "browser-verification.gpx");
  await writeFile(gpxPath, gpx, "utf8");
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
    "$1Your file was successfully uploaded. Preview is ready.$2",
  );
  const otherClimberBaseHtml = climberHtml
    .replace("Peakbagging Page for Alex Doe", "Peakbagging Page for Morgan Longlastname")
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
    request.on("data", chunk => {
      length += chunk.length;
      if (length > 2_000_000) {
        reject(new Error("Browser fixture POST exceeded 2 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    request.on("error", reject);
  });
  const server = createServer({ key, cert }, async (request, response) => {
    const url = new URL(request.url, `https://${fixtureHost}`);
    const send = (contentType, body) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    };
    if (/ascentedit\.aspx/i.test(url.pathname)) {
      if (request.method === "POST") {
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
            "text/html; charset=utf-8",
            preview ? previewSuccessHtml : relativeAscentEditHtml,
          );
        } catch (error) {
          response.writeHead(400);
          response.end(error.message);
          return;
        }
      }
      return send("text/html; charset=utf-8", relativeAscentEditHtml);
    }
    if (/ascent\.aspx/i.test(url.pathname)) return send("text/html; charset=utf-8", ascentHtml);
    if (/peakascents\.aspx/i.test(url.pathname)) {
      return send("text/html; charset=utf-8", peakAscentsHtml);
    }
    if (/climblistc\.aspx/i.test(url.pathname)) {
      return send("text/html; charset=utf-8", profileAscentsHtml);
    }
    if (/\/climber\/climber\.aspx/i.test(url.pathname)) {
      if (request.method === "POST") {
        const body = new URLSearchParams(await readRequestBody(request));
        const action = body.get("BuddyButton") || "";
        if (/^Add\b/i.test(action)) otherClimberIsBuddy = true;
        else if (/^Remove\b/i.test(action)) otherClimberIsBuddy = false;
        requests.buddyMutations += 1;
      }
      return send("text/html; charset=utf-8", renderOtherClimber());
    }
    if (/\/report\/report\.aspx/i.test(url.pathname)
        && (url.searchParams.get("r") || "").toLowerCase() === "b") {
      requests.buddyReports += 1;
      requests.buddyReportStates.push(otherClimberIsBuddy);
      return send("text/html; charset=utf-8", renderBuddyList());
    }
    if (/peak\.aspx/i.test(url.pathname)) return send("text/html; charset=utf-8", peakHtml);
    if (/bigmap\.aspx/i.test(url.pathname)) {
      return send("text/html; charset=utf-8",
        (url.searchParams.get("t") || "").toUpperCase() === "P" ? peakBigMapHtml : bigMapHtml);
    }
    if (/mastermap\.aspx/i.test(url.pathname)) {
      return send("text/html; charset=utf-8",
        (url.searchParams.get("t") || "").toUpperCase() === "P" ? peakMasterMapHtml : masterMapHtml);
    }
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
    gpxPath,
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  };
}
