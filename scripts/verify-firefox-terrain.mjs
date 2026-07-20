#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { firefox } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewport = { width: 1000, height: 760 };
const fixtureHost = "www.peakbagger.com";
const syntheticTerrariumWebp = Buffer.from(
  "UklGRoIAAABXRUJQVlA4THYAAAAv/8F/AD8gFkzyR94dhICgyHPTY/6zQwZFtW1TKqigggoqqKCC/rM/wx3R/wkI/M//A+P38h+YpefnP1DLz8t/4Fauz38gV4/Pf2DXtuc/0OvT+Y//+I/41uc/wDsv/wHdffkP4N6T/4DtvfkP0P6T/4CM/8Ef",
  "base64",
);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gpx", "application/gpx+xml; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

async function safeFile(pathname) {
  const resolved = path.resolve(projectRoot, `.${pathname}`);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) return null;
  try {
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function createFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${fixtureHost}`);
      if (url.pathname.toLowerCase() === "/async/pllbb.aspx") {
        const bounds = ["miny", "maxy", "minx", "maxx"].map(name =>
          Number(url.searchParams.get(name)));
        if (bounds.some(value => !Number.isFinite(value))) {
          response.writeHead(400);
          response.end("bad bounds");
          return;
        }
        const [miny, maxy, minx, maxx] = bounds;
        const latitude = (miny + maxy) / 2;
        const longitude = (minx + maxx) / 2;
        response.writeHead(200, {
          "content-type": "text/xml; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(`<ts><t i="58603" n="Iron Mountain" a="${latitude}" o="${longitude}" c="1" r="246"/></ts>`);
        return;
      }

      const showcaseRoutes = {
        "/climber/ascent.aspx": "/scripts/showcase/terrain.html",
        "/map/mastermap.aspx": "/scripts/showcase/terrain-native-map.html",
      };
      let pathname = showcaseRoutes[url.pathname.toLowerCase()] || decodeURIComponent(url.pathname);
      if (pathname.startsWith("/scripts/showcase/terrain-tiles/")) {
        pathname = "/scripts/showcase/terrain-basemap-tile.png";
      }
      const file = await safeFile(pathname);
      if (!file) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      let contents = await readFile(file);
      if (url.pathname === "/dist/terrain/terrain.html") {
        contents = Buffer.from(contents.toString("utf8")
          .replace("</head>", `  <script>
    globalThis.chrome = { runtime: { getURL: resource => new URL('/dist/' + resource, location.origin).href } };
  </script>
</head>`)
          .replace("  <script src=\"terrain-frame.js\"></script>", `  <script>
    maplibregl.Map = new Proxy(maplibregl.Map, {
      construct(Target, args, newTarget) {
        const instance = Reflect.construct(Target, args, newTarget);
        globalThis.__bpbTerrainTestMap = instance;
        return instance;
      }
    });
  </script>
  <script src="terrain-frame.js"></script>`));
      }
      response.writeHead(200, {
        "content-type": contentTypes.get(path.extname(file)) || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(contents);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.stack || error.message);
    }
  });
  return server;
}

async function main() {
  const server = createFixtureServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  let browser;
  try {
    browser = await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        "network.dns.localDomains": fixtureHost,
        "webgl.disabled": false,
      },
    });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    const requests = { terrain: 0, basemap: 0, peaks: 0 };
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", request => {
      const url = request.url();
      if (url.startsWith("https://tiles.mapterhorn.com/")) requests.terrain += 1;
      if (url.includes("/terrain-tiles/")) requests.basemap += 1;
      if (/\/Async\/PLLBB\.aspx/i.test(url)) requests.peaks += 1;
    });
    await page.route("https://tiles.mapterhorn.com/**", route => route.fulfill({
      status: 200,
      contentType: "image/webp",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "X-BPB-Terrain-Fixture": "synthetic-terrarium-v1",
      },
      body: syntheticTerrariumWebp,
    }));
    await page.route("https://**", route => route.abort());

    await page.goto(
      `http://${fixtureHost}:${port}/climber/ascent.aspx?mode=terrain&map=wide`,
      { waitUntil: "load" },
    );
    await page.waitForFunction(() => {
      const frame = document.getElementById("bpb-terrain-frame");
      const win = frame?.contentWindow;
      const map = win?.__bpbTerrainTestMap;
      return frame?.style.opacity === "1" && map?.loaded()
        && map.getLayer("bpb-route") && map.getLayer("bpb-peaks-ring")
        && map.getSource("basemap");
    }, null, { timeout: 20_000 });

    const frame = page.frameLocator("#bpb-terrain-frame");
    const rendererState = await frame.locator("canvas.maplibregl-canvas").evaluate(canvas => {
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
      const map = globalThis.__bpbTerrainTestMap;
      return {
        renderer,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        canvas: { width: canvas.width, height: canvas.height },
        terrain: Boolean(map.getTerrain()),
        route: Boolean(map.getLayer("bpb-route")),
        basemap: Boolean(map.getSource("basemap")),
        peaks: Boolean(map.getLayer("bpb-peaks-ring")),
      };
    });
    if (!rendererState.renderer) throw new Error("Firefox exposed no WebGL renderer");
    if (/swiftshader|software|llvmpipe/i.test(rendererState.renderer)) {
      throw new Error(`Refusing Firefox terrain verification on software WebGL (${rendererState.renderer})`);
    }
    if (!rendererState.terrain || !rendererState.route || !rendererState.basemap
      || !rendererState.peaks || rendererState.canvas.width === 0 || rendererState.canvas.height === 0) {
      throw new Error(`Firefox terrain surface was incomplete: ${JSON.stringify(rendererState)}`);
    }
    await page.waitForFunction(() => {
      const map = document.getElementById("bpb-terrain-frame")?.contentWindow?.__bpbTerrainTestMap;
      return map?.querySourceFeatures("bpb-peaks")?.length > 0;
    }, null, { timeout: 10_000 });

    const canvas = frame.locator("canvas.maplibregl-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Firefox terrain canvas had no pointer target");
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -360);
    await page.waitForFunction(previous => {
      const map = document.getElementById("bpb-terrain-frame")?.contentWindow?.__bpbTerrainTestMap;
      return map?.getZoom() > previous;
    }, rendererState.zoom, { timeout: 8_000 });

    const pitchBefore = await canvas.evaluate(() => globalThis.__bpbTerrainTestMap.getPitch());
    await page.mouse.move(center.x, center.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(center.x, center.y - 180, { steps: 8 });
    await page.mouse.up({ button: "right" });
    await page.waitForFunction(previous => {
      const map = document.getElementById("bpb-terrain-frame")?.contentWindow?.__bpbTerrainTestMap;
      return Math.abs((map?.getPitch() ?? previous) - previous) > 2;
    }, pitchBefore, { timeout: 8_000 });

    // Firefox on macOS rewrites Ctrl+primary into a secondary-button gesture.
    // Exercise that production alternative separately from the normal right drag.
    const ctrlPitchBefore = await canvas.evaluate(() => globalThis.__bpbTerrainTestMap.getPitch());
    await page.keyboard.down("Control");
    await page.mouse.move(center.x, center.y);
    await page.mouse.down({ button: "left" });
    await page.mouse.move(center.x, center.y + 100, { steps: 6 });
    await page.mouse.up({ button: "left" });
    await page.keyboard.up("Control");
    await page.waitForFunction(previous => {
      const map = document.getElementById("bpb-terrain-frame")?.contentWindow?.__bpbTerrainTestMap;
      return Math.abs((map?.getPitch() ?? previous) - previous) > 1;
    }, ctrlPitchBefore, { timeout: 8_000 });

    await page.evaluate(() => {
      const mount = document.querySelector(".terrain-check .map-shell");
      mount.style.width = "620px";
    });
    const resized = await page.waitForFunction(() => {
      const frameElement = document.getElementById("bpb-terrain-frame");
      const win = frameElement?.contentWindow;
      const canvasElement = frameElement?.contentDocument?.querySelector("canvas.maplibregl-canvas");
      const map = win?.__bpbTerrainTestMap;
      return canvasElement?.width > 0 && canvasElement.width < 800
        && map?.loaded() && map.getLayer("bpb-route") ? {
          width: canvasElement.width,
          height: canvasElement.height,
          route: Boolean(map.getLayer("bpb-route")),
        } : false;
    }, null, { timeout: 10_000 }).then(handle => handle.jsonValue());
    if (!resized.route || requests.terrain === 0 || requests.basemap === 0 || requests.peaks === 0) {
      throw new Error(`Firefox terrain fixtures were incomplete: ${JSON.stringify({ resized, requests })}`);
    }
    if (errors.length) throw new Error(`Firefox terrain runtime errors:\n${errors.join("\n")}`);

    console.log("Firefox terrain verification passed:");
    console.log(`  - Firefox ${browser.version()}, hidden/headless ${viewport.width}x${viewport.height}`);
    console.log(`  - renderer: ${rendererState.renderer}`);
    console.log(`  - terrain/basemap/route/peaks rendered; scroll zoom, right drag, Ctrl-drag, and resize passed`);
    console.log(`  - resized canvas ${resized.width}x${resized.height}; native focus/window placement was not tested`);
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
