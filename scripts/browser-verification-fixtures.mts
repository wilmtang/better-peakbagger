/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BrowserContext, Page } from 'playwright';

/* global document */

import type { ExtensionGlobal } from './page-probes.mts';
import { waitForCondition, type WaitForConditionOptions } from './wait-for-condition.mts';
export { instrumentTerrainFrameHtml, instrumentTerrainFrameModule } from './terrain-frame-instrumentation.mts';
export { waitForCondition, type WaitForConditionOptions };
// The page-side probes live in page-probes.mts, free of Node dependencies so
// browser tests can load them; this module keeps exporting them.
export {
    surfaceSelectors,
    assertMapToggleAnchor,
    readPeakSunPlacement,
    webdriverScript,
    readDraftsManagerReadiness,
    installAnalyzerBfcacheProbe,
    readAnalyzerBfcacheState,
    readAnalyzerChartState,
    readScaleChartState,
    readSunCalculatorGeometry,
} from './page-probes.mts';
export type {
    ToggleAnchorRect,
    DraftsManagerReadinessState,
    AnalyzerBfcacheState,
    AnalyzerChartState,
    ScaleChartState,
    SunCalculatorGeometryState,
} from './page-probes.mts';
import {
    closeServer,
    createResourceStack,
    listenServer,
} from './resource-stack.mts';

const execFileAsync = promisify(execFile);

export const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);
export const fixtureHost = 'www.peakbagger.com';
export const verificationViewport = Object.freeze({ width: 1000, height: 760 });
export const storeUrls = Object.freeze({
    chrome: 'https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn',
    firefox: 'https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/',
});

export interface FailureCollector {
    failures: string[];
    check(condition: unknown, message: string): void;
    throwIfAny(label: string): void;
}

export interface AnalyzerDarkFocusState {
    theme: string | undefined;
    focused: boolean;
    focusVisible: boolean;
    outlineStyle: string;
    outlineWidth: string;
    outlineColor: string;
}

export interface ToolbarTargetState {
    visibility: DocumentVisibilityState;
    readyState: DocumentReadyState;
}

export interface BuddyHelperPage {
    url(): string;
}

export interface BuddyHelperCleanupState {
    urls: string[];
    closed: boolean;
}

export interface BuddyReportCacheState {
    ownerCid: number;
    fetchedAt: number;
    count: number;
}

export interface WindowUrlEntry {
    handle: string;
    url?: string;
    closed?: boolean;
}

export interface WindowUrlPollState {
    windows: WindowUrlEntry[];
    matches: WindowUrlEntry[];
}

export interface WindowUrlDriver {
    getAllWindowHandles(): Promise<string[]>;
    switchTo(): { window(handle: string): Promise<unknown> };
    getCurrentUrl(): Promise<string>;
}

export type SyntheticCaptureJob = {
    id: string;
    sourceTabId: number;
    provider: string;
    activityId: string;
    phase: string;
    cid: number;
    matches: {
        id: number;
        name: string;
        classification: string;
        confidence: number;
        selected: boolean;
        draftFields: {
            date: string;
            time: string;
            startElevationM: number;
            endElevationM: number;
            upDistanceM: number;
            downDistanceM: number;
            upDuration: { days: number; hours: number; minutes: number };
            downDuration: { days: number; hours: number; minutes: number };
            upGainM: number;
            downGainM: number;
        };
    }[];
    selectedIds: number[];
    capturePreferences: {
        retainWaypoints: boolean;
        fillAscentDetails: boolean;
        fillTripInfo: boolean;
        fillWildernessNights: boolean;
    };
    tripName: string;
    nightsOut: number | null;
    dayStats: unknown[];
    payloadKey: string;
    error: unknown;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
};

export type SyntheticCapturePayload = {
    key: string;
    value: {
        jobId: string;
        gpx: string;
    };
};

export type FixtureCertificateOptions = {
    host?: string;
    directory?: string | null;
    label?: string;
    opensslPath?: string;
    readCertificate?: (filePath: string) => Promise<Buffer>;
};

export type FixtureCertificate = {
    key: Buffer;
    cert: Buffer;
    root: string;
    chromeTrustArgs: readonly string[];
    remove(): Promise<void>;
};

export interface BrowserFixtureServerOptions {
    temporaryRoot?: string;
    analyzerGpx?: string;
    analyzerGpxByCase?: Record<string, string>;
    analyzerDelayMs?: number;
    inlineBuddies?: boolean;
    peakMapDocument?: string;
    masterMapDocument?: string;
    bigMapDocument?: string;
}

export interface FixturePreviewRequest {
    attachedGpx: boolean;
    dateFilled: boolean;
    suffixBlank: boolean;
}

export interface BrowserFixtureRequests {
    previewPosts: number;
    savePosts: number;
    lastPreview: FixturePreviewRequest | null;
    buddyMutations: number;
    buddyReports: number;
    buddyReportStates: boolean[];
    analyzerTracks: Record<string, number>;
    profileListReads: number;
    cancelledProfileReads: number;
}

export interface BrowserFixtureServer {
    port: number;
    chromeTrustArgs: readonly string[];
    gpxPath: string;
    requests: BrowserFixtureRequests;
    holdProfileLists: () => void;
    releaseProfileLists: () => void;
    close: () => Promise<void>;
}

export interface SendFixtureFileOptions {
    transform?: ((source: string) => string) | null;
    cacheControl?: string;
}

export function createFailureCollector(): FailureCollector {
    const failures: string[] = [];
    return {
        failures,
        check(condition: unknown, message: string): void {
            if (!condition) failures.push(message);
        },
        throwIfAny(label: string): void {
            if (!failures.length) return;
            throw new Error(`${label}:\n${failures.map(message => `  - ${message}`).join('\n')}`);
        },
    };
}

// Live verifier changes share the worker queue with page-owned writes. A raw
// sync read/replace can restore an old theme after a pending map/units patch.
export async function patchVerificationSettings(
    page: { evaluate<T, A>(fn: (arg: A) => Promise<T>, arg: A): Promise<T> },
    patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    return page.evaluate(async update => {
        const response = await (globalThis as ExtensionGlobal).chrome!.runtime.sendMessage({
            type: 'SETTINGS_PATCH', patch: update,
        }) as { ok?: boolean; settings?: Record<string, unknown>; error?: { message?: string } } | undefined;
        if (response?.ok !== true || !response.settings) {
            throw new Error(response?.error?.message || 'Verification settings patch failed.');
        }
        return response.settings;
    }, patch);
}

export async function waitForAnalyzerDarkFocus(
    canvas: {
        evaluate<R>(fn: (element: HTMLElement) => R): Promise<R>;
    },
    options: WaitForConditionOptions<AnalyzerDarkFocusState> = {},
): Promise<AnalyzerDarkFocusState> {
    return waitForCondition(() => canvas.evaluate(element => {
        const style = globalThis.getComputedStyle(element);
        return {
            theme: element.closest<HTMLElement>('#bpb-gpx-analysis')?.dataset.theme,
            focused: document.activeElement === element,
            focusVisible: element.matches(':focus-visible'),
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            outlineColor: style.outlineColor,
        };
    }), {
        ...options,
        description: 'the rendered analyzer dark-theme focus ring',
        isReady: state => state.theme === 'dark' && state.focused && state.focusVisible
            && state.outlineStyle === 'solid' && state.outlineWidth === '3px'
            && state.outlineColor === 'rgb(121, 184, 255)',
    });
}

// Extensions.triggerAction selects an action in the target's window, then
// executes it for that window's selected tab. Target discovery alone cannot
// prove that a newly created tab has finished becoming the selected tab.
export async function activateToolbarTarget(
    cdp: { send(method: 'Target.activateTarget', params: { targetId: string }): Promise<unknown> },
    page: { evaluate<R>(fn: () => R): Promise<R> },
    targetId: string,
    options: WaitForConditionOptions<ToolbarTargetState> = {},
): Promise<ToolbarTargetState> {
    // Provider URLs are intentionally unavailable to chrome.tabs until the
    // toolbar grants activeTab. Select via CDP without widening permissions.
    await cdp.send('Target.activateTarget', { targetId });
    return waitForCondition(() => page.evaluate(() => ({
        visibility: document.visibilityState,
        readyState: document.readyState,
    })), {
        description: 'loaded toolbar target selection',
        ...options,
        isReady: state => state.visibility === 'visible' && state.readyState === 'complete',
    });
}

export async function waitForBuddyHelperCleanup<P extends BuddyHelperPage>(
    context: { pages(): P[] },
    buddyUrl: string,
    workingPage: P,
    options: WaitForConditionOptions<BuddyHelperCleanupState> = {},
): Promise<BuddyHelperCleanupState> {
    return waitForCondition(() => {
        const pages = context.pages();
        const urls = pages.map(page => page.url());
        return { urls, closed: pages.includes(workingPage) && workingPage.url() === buddyUrl
            && urls.filter(url => url === buddyUrl).length === 1
            && !urls.some(url => /\/options\/buddy-refresh\.html(?:#|$)/.test(url)) };
    }, {
        description: 'Buddy helper teardown with the original page preserved',
        timeoutMs: 5000,
        ...options,
        isReady: state => state.closed,
    });
}

export async function waitForBuddyReportCache(
    optionsPage: {
        evaluate<R, A>(fn: (arg: A) => Promise<R> | R, arg: A): Promise<R>;
    },
    reportPage: {
        evaluate<R>(fn: () => R): Promise<R>;
    },
    expected: { ownerCid: number; count: number },
    options: WaitForConditionOptions<BuddyReportCacheState | false> = {},
): Promise<BuddyReportCacheState> {
    const fetchedAt = await reportPage.evaluate(() => Math.floor(performance.timeOrigin));
    if (!Number.isFinite(fetchedAt) || fetchedAt < 0) throw new Error('Buddy report navigation time is unavailable');
    return waitForCondition(() => optionsPage.evaluate(async target => {
        const api = (globalThis as ExtensionGlobal).browser || (globalThis as ExtensionGlobal).chrome;
        const stored = await api!.storage.local.get('bpbBuddyCache');
        const cache = stored.bpbBuddyCache as {
            fetchedAt?: number;
            ownerCid?: number;
            entries?: unknown[];
        } | undefined;
        return cache?.fetchedAt === target.fetchedAt && cache.ownerCid === target.ownerCid
            && Array.isArray(cache.entries) && cache.entries.length === target.count
            ? { ownerCid: cache.ownerCid, fetchedAt: cache.fetchedAt, count: cache.entries.length } : false;
    }, { fetchedAt, ...expected }), {
        description: 'the working Buddy report cache publication',
        timeoutMs: 5000,
        ...options,
    });
}

// Playwright's waitForFunction polls the immediate return value. An async
// predicate returns a truthy Promise even when it later resolves to false.
// Await each page read in the driver before deciding whether polling is done.
export function waitForPageCondition<T, A = null>(
    page: { evaluate<R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R> },
    predicate: (arg: A) => T | Promise<T>,
    arg: A = null as A,
    { timeout = 10_000 }: { timeout?: number } = {},
): Promise<Exclude<T, false | null | undefined | 0 | ''>> {
    return waitForCondition(() => page.evaluate(predicate, arg), {
        description: `page condition: ${predicate.toString()}`,
        timeoutMs: timeout,
    });
}

// Moving a Firefox tab can replace its WebDriver handle while preserving the
// extension tab ID. Reacquire the exact destination; ambiguous matches fail.
export async function waitForWindowUrl(
    driver: WindowUrlDriver,
    expectedUrl: string,
    options: WaitForConditionOptions<WindowUrlPollState> = {},
): Promise<string> {
    const state = await waitForCondition(async () => {
        const windows: WindowUrlEntry[] = [];
        for (const handle of await driver.getAllWindowHandles()) {
            try {
                await driver.switchTo().window(handle);
                windows.push({ handle, url: await driver.getCurrentUrl() });
            } catch (error) {
                const name = error && typeof error === 'object' && 'name' in error
                    ? (error as { name?: unknown }).name
                    : undefined;
                if (name !== 'NoSuchWindowError') throw error;
                windows.push({ handle, closed: true });
            }
        }
        return { windows, matches: windows.filter(entry => entry.url === expectedUrl) };
    }, {
        ...options,
        description: `window at ${expectedUrl}`,
        isReady: candidate => candidate.matches.length === 1,
    });
    const handle = state.matches[0].handle;
    await driver.switchTo().window(handle);
    return handle;
}

const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Synthetic</name><trkseg>${
    Array.from({ length: 60 }, (_, index) =>
        `<trkpt lat="${(46.85 + index * 0.0006).toFixed(6)}" lon="${(-121.76 + index * 0.0004).toFixed(6)}">`
      + `<ele>${1500 + index * 25}</ele><time>2026-07-01T13:${String(index % 60).padStart(2, '0')}:00Z</time></trkpt>`)
        .join('')}</trkseg></trk></gpx>`;

export const createScaleAnalyzerGpx = (pointCount = 20_000): string =>
    `<?xml version="1.0"?><gpx version="1.1"><trk><name>Scale</name><trkseg>${
        Array.from({ length: pointCount }, (_, index) => {
            const elevation = index >= 4_316 && index <= 4_326 ? 200
                : index >= 17_649 && index <= 17_659 ? 3_000
                    : Math.round(1_500 + Math.sin(index / 40) * 180);
            return `<trkpt lat="${(40 + index / 1_000_000).toFixed(6)}" lon="${(-105 - index / 1_000_000).toFixed(6)}">`
                + `<ele>${elevation}</ele><time>${new Date(Date.UTC(2026, 6, 10) + index * 1_000).toISOString()}</time></trkpt>`;
        }).join('')}</trkseg></trk></gpx>`;

export function createSyntheticCaptureJob(sourceTabId: unknown): SyntheticCaptureJob {
    const timestamp = Date.now();
    const id = `browser-verify-${timestamp}`;
    return {
        id,
        sourceTabId: sourceTabId as number,
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
        payloadKey: `bpbCapturePayload:${id}`,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: timestamp + 20 * 60 * 1000,
    };
}

export const createSyntheticCapturePayload = (job: SyntheticCaptureJob): SyntheticCapturePayload => ({
    key: job.payloadKey,
    value: {
        jobId: job.id,
        // Newly serialized from the narrow allowlist. Unlike the analyzer
        // fixture above, it carries no track name or provider metadata.
        gpx: gpx.replace('<name>Synthetic</name>', ''),
    },
});

const ascentHtml = `<!doctype html><html><head><title>Ascent</title><style>
body { margin: 18px; font: 13px/1.4 Verdana, Arial, sans-serif; }
table.gray { border-collapse: collapse; background: #e6e6e3; color: #20201e; }
table.gray th, table.gray td { border: 1px solid #b5b7b2; padding: 6px 8px; text-align: left; }
</style></head><body>
<table class="gray" id="ascent-report" width="49%" align="left">
  <tr><td>Elevation:</td><td>10,781 ft</td></tr>
  <tr><th colspan="2">Ascent Trip Report</th></tr>
  <tr><td colspan="2">A long climb report with enough prose to make the adjustable column width visible.</td></tr>
</table>
<table class="gray" id="ascent-summary" width="50%" align="right">
  <tr><th colspan="2">Summary Total Data</th></tr>
  <tr><td>Total Elevation Gain:</td><td>5,735 ft</td></tr>
  <tr><td>Round-Trip Distance:</td><td>17.53 miles</td></tr>
</table>
<br clear="left"><br clear="right">
<iframe src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300" width="450" height="450"></iframe><br>
GPS Waypoints - Hover or click to see name and lat/long<br>
Peaks: climbed and unclimbed by Zihao D<br>
<a href="/track.gpx">Download this GPS track</a>
<a href="/map/BigMap.aspx?t=A">Click Here for a Full Screen Map</a>
</body></html>`;

// Keep oversized media out of the analyzer fixture's normal geometry, while
// exercising the real saved-ascent layout on an explicit fixture variant.
const ascentImageSvg = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750">'
    + '<rect width="1200" height="750" fill="#477e86"/>'
    + '<path d="M0 750L400 100L700 550L950 250L1200 750Z" fill="#b3d5cc"/>'
    + '</svg>'
);
const ascentImageSource = '/fixture-ascent-image.svg';
const ascentImageHtml = [
    ['width-only', 'width="640"'],
    ['both-dimensions', 'width="640" height="400"'],
    ['authored-ratio', 'width="640" height="200"'],
    ['original', ''],
    ['height-only', 'height="200"'],
].map(([id, dimensions]) => `<p>${id}<br><img id="split-image-${id}" ${dimensions}
    src="${ascentImageSource}" alt="Synthetic mountain ${id}"></p>`).join('');

const bigMapHtml = `<!doctype html><html><head><title>Full Screen Map</title></head><body>
<iframe id="if" src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300"></iframe>
</body></html>`;

const peakBigMapHtml = `<!doctype html><html><head><title>Full Screen Peak Map</title></head><body>
<a href="/peak.aspx?pid=2829">Mount Shuksan</a>
<iframe id="if" src="/map/MasterMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300&cyn=0"></iframe>
</body></html>`;

const peakHtml = `<!doctype html><html><head><title>Mount Shuksan</title></head><body>
<h1>Mount Shuksan, Washington</h1>
<table class="gray" align="left">
  <tr><td>Latitude/Longitude (WGS84)</td><td>48.83115, -121.60214 (Dec Deg)</td></tr>
  <tr><td>Nation</td><td>United States</td></tr>
  <tr><td colspan="2"><b>Links</b><br><br>Native links</td></tr>
</table>
<table class="gray" align="right" style="width:760px">
<tr><td>Web Map Links</td><td>
<a href="https://www.peakfinder.org/?lat=48.83115&lng=-121.60214">Peakfinder Panorama</a><br>
<a href="https://caltopo.com/map.html#ll=48.83115,-121.60214&z=14">CalTopo</a>
</td></tr>
<tr><td colspan="2" style="text-align:center">
<b>Dynamic Map</b><br>
<iframe id="Gmap" src="/map/MasterMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300"
  width="100%" height="425px"></iframe><br>
<img src="/image/MainPeakPinkCircle.gif">&nbsp;Mount Shuksan&nbsp;&nbsp;&nbsp;(<img src="/image/ThinMagentaSquare.gif">&nbsp;<span style="font-size:smaller">Key Col</span>)<br>
<a href="/map/BigMap.aspx?cy=48.83115&cx=-121.60214&z=14&l=L_CT|L_OT&t=P&d=2829&c=0&hj=300">
  Click Here for a Full Screen Map
</a>
</td></tr></table>
</body></html>`;

// Enough of Peakbagger's frame for the analyzer overlay and native-layer sync.
const masterMapHtml = `<!doctype html><html><body>
<div id="map" style="position:absolute;inset:0;background:#dce6d7"></div>
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
    off(type, handler) { this.events[type] = (this.events[type] || []).filter(fn => fn !== handler); return this; }
    getContainer() { return document.getElementById('map'); }
    getBounds() { return { getWest: () => -121.78, getEast: () => -121.72, getSouth: () => 46.83, getNorth: () => 46.89 }; }
    getCenter() { return { lat: 46.86, lng: -121.75 }; }
    getZoom() { return 14; }
    removeLayer(layer) { this.layers = this.layers.filter(candidate => candidate !== layer); layer._map = null; }
  }
  window.L = {
    Polyline, Polygon, Map: MapStub,
    GridLayer: { extend: () => class {} }, marker: () => ({}),
    polyline: (latLngs, options) => new Polyline(latLngs, options),
    circleMarker: (latLng, options) => new Polyline([latLng], options)
  };
  window.mapsPlaceholder = new MapStub([
    new Polyline([{ lat: 46.85, lng: -121.76 }, { lat: 46.87, lng: -121.74 }], { color: "#d9483b", weight: 3 })
  ]);
</script></body></html>`;

const peakMasterMapHtml = `<!doctype html><html><body>
<div id="map" style="position:absolute;inset:0;background:#dce6d7"></div>
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
    mouseEventToLatLng(event) { return { lat: 46.8 + event.clientY / 100000, lng: -121.7 + event.clientX / 100000 }; }
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
// that reason, and test/project/showcase.test.mts pins it for every
// fixture-serving script.
//
// This lived as four near-identical copies (here plus the three terrain
// verifiers), which is a poor place for the one mechanism whose absence once
// rendered "Better Peakbagger refused an invalid Peakbagger request." into the
// store-listing screenshots. `remove` deletes the key and certificate; callers
// that minted their own directory get it cleaned up too.
export async function createFixtureCertificate({
    host = fixtureHost,
    directory = null,
    label = 'fixture',
    opensslPath = 'openssl',
    readCertificate = readFile,
}: FixtureCertificateOptions = {}): Promise<FixtureCertificate> {
    const resources = createResourceStack();
    try {
        const owned = directory === null;
        const root = owned
            ? await mkdtemp(path.join(os.tmpdir(), `better-peakbagger-${label}-cert-`))
            : directory;
        const keyPath = path.join(root, 'fixture-key.pem');
        const certificatePath = path.join(root, 'fixture-cert.pem');
        if (owned) {
            resources.defer('fixture certificate directory', () =>
                rm(root, { recursive: true, force: true }));
        } else {
            resources.defer('fixture certificate', () => rm(certificatePath, { force: true }));
            resources.defer('fixture key', () => rm(keyPath, { force: true }));
        }
        await execFileAsync(opensslPath, [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-subj', `/CN=${host}`, '-days', '1',
            '-keyout', keyPath, '-out', certificatePath,
        ]);
        const [key, cert] = await Promise.all([
            readCertificate(keyPath),
            readCertificate(certificatePath),
        ]);
        // Apply trust at browser launch: extension-created tabs can navigate
        // before a per-page TLS policy attaches. Scope it to this disposable key.
        const spki = createHash('sha256').update(new X509Certificate(cert)
            .publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
        return {
            key,
            cert,
            root,
            chromeTrustArgs: Object.freeze([`--ignore-certificate-errors-spki-list=${spki}`]),
            async remove(): Promise<void> {
                await resources.dispose();
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await resources.dispose(new Error(
            `Could not create the isolated HTTPS fixture certificate: ${message}`,
            { cause: error },
        ));
        throw error;
    }
}

export async function createBrowserFixtureServer({
    temporaryRoot,
    analyzerGpx = gpx,
    analyzerGpxByCase = {},
    analyzerDelayMs = 0,
    inlineBuddies = false,
    peakMapDocument = peakMasterMapHtml,
    masterMapDocument = masterMapHtml,
    bigMapDocument = bigMapHtml,
}: BrowserFixtureServerOptions = {}): Promise<BrowserFixtureServer> {
    const resources = createResourceStack();
    const certificate = await resources.guard(() =>
        createFixtureCertificate({ directory: temporaryRoot }));
    resources.defer('browser fixture certificate', () => certificate.remove());
    const { key, cert } = certificate;
    const [
        ascentEditHtml,
        peakAscentsHtml,
        profileAscentsHtml,
        buddyListHtml,
        peakListHtml,
        climberHtml,
    ] = await resources.guard(Promise.all([
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
    ]));
    const gpxPath = path.join(certificate.root, 'browser-verification.gpx');
    const inlineBuddyHtml = inlineBuddies ? await resources.guard(readFile(
        path.join(projectRoot, 'test', 'fixtures', 'pages', 'climber-buddy-form.html'), 'utf8')) : '';
    const ignoredPeakHtml = await resources.guard(readFile(
        path.join(projectRoot, 'test', 'fixtures', 'pages', 'peak-rainier.html'), 'utf8'));
    const ignoredDetailHtml = await resources.guard(readFile(path.join(projectRoot, 'test', 'fixtures', 'pages', 'ascent-ignored-report.html'), 'utf8'));
    const weatherAscentHtml = await resources.guard(readFile(path.join(projectRoot, 'test', 'fixtures', 'pages', 'climber-ascent.html'), 'utf8'));
    const cloudflareChallengeHtml = await resources.guard(readFile(path.join(projectRoot, 'test', 'fixtures', 'pages', 'cloudflare-challenge.html'), 'utf8'));
    const compactIgnoredHtml = await resources.guard(readFile(path.join(projectRoot, 'test', 'fixtures', 'pages', 'ascent-ignored-compact.html'), 'utf8'));
    await resources.guard(writeFile(gpxPath, gpx, 'utf8'));
    const requests: BrowserFixtureRequests = {
        previewPosts: 0,
        savePosts: 0,
        lastPreview: null,
        buddyMutations: 0,
        buddyReports: 0,
        buddyReportStates: [],
        analyzerTracks: {},
        profileListReads: 0,
        cancelledProfileReads: 0,
    };
    let holdProfileLists = false;
    const heldProfileLists = new Set<() => void>();
    const releaseProfileLists = () => {
        holdProfileLists = false;
        for (const release of heldProfileLists) release();
        heldProfileLists.clear();
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
    const renderOtherClimber = () => inlineBuddies ? (otherClimberIsBuddy ? inlineBuddyHtml
        .replace('Add this Climber as a Buddy', 'This Climber is one of your buddies.')
        .replaceAll('AddBuddy', 'RemoveBuddy').replace('Add to your Buddy List', 'Remove from your Buddy List') : inlineBuddyHtml) : otherClimberBaseHtml
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
    const readRequestBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let length = 0;
        request.on('data', (chunk: Buffer) => {
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
    const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? '/', `https://${fixtureHost}`);
        const send = (
            contentType: string,
            body: string | Buffer,
            { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
        ) => {
            response.writeHead(status, { 'content-type': contentType, ...headers });
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
                    response.end(error instanceof Error ? error.message : String(error));
                    return;
                }
            }
            return send('text/html; charset=utf-8', relativeAscentEditHtml);
        }
        if (/ascent\.aspx/i.test(url.pathname)) {
            if (url.searchParams.get('weather') === 'challenge') {
                return send('text/html; charset=utf-8', cloudflareChallengeHtml, { status: 403, headers: { 'cf-mitigated': 'challenge' } });
            }
            if (url.searchParams.has('weather')) {
                let weatherHtml = weatherAscentHtml.replace('Sunday, July 12, 2026', url.searchParams.get('weather') === 'invalid' ? '2024' : 'Friday, July 12, 2024')
                    .replace('</head>', '<style>body{margin:18px;font:13px/1.4 Verdana,Arial,sans-serif}#page{max-width:1120px;margin:auto}table.gray{background:#e6e6e3;border-collapse:collapse}td,th{padding:6px 8px;text-align:left}</style></head>');
                if (url.searchParams.get('weather') !== 'no-map') weatherHtml = weatherHtml.replace('<div id="gpxlinks">', '<iframe src="/map/MasterMap.aspx?t=A&d=2296&c=900001&hj=300" width="450" height="450"></iframe><br><a href="/map/BigMap.aspx?t=A">Click Here for a Full Screen Map</a><div id="gpxlinks">');
                if (url.searchParams.get('weather') === 'long-report') weatherHtml = weatherHtml.replace('<b>Great climb</b>', '<b>Great climb</b>' + '<p>Synthetic long trip report. The report continues on the left while summary and weather stay together on the right.</p>'.repeat(45));
                if (['no-gpx', 'no-map', 'invalid', 'long-report'].includes(url.searchParams.get('weather') || '')) weatherHtml = weatherHtml.replace(/<div id="gpxlinks">[\s\S]*?<\/div>/, '');
                else weatherHtml = weatherHtml.replace(/<div id="gpxlinks">([\s\S]*?)<\/div>/,
                    '<p id="gps-track-note"><small>Note: GPS Tracks may not be accurate, and may not show the best route. Do not follow this route blindly. Conditions change frequently. Use of a GPS unit in the outdoors, even with a pre-loaded track, is no substitute for experience and good judgment. Peakbagger.com accepts NO responsibility or liability from use of this data.</small></p><p id="gpxlinks">$1</p>');
                return send('text/html; charset=utf-8', weatherHtml);
            }
            if (url.searchParams.has('ignored')) return send('text/html; charset=utf-8', ignoredDetailHtml);
            const analyzerCase = (url.searchParams.get('aid') || '').replace(/^analyzer-/, '');
            let layoutHtml = url.searchParams.get('layout') === 'images'
                ? ascentHtml.replace(/<br clear="left">[\s\S]*$/, '</body></html>').replace(
                    '<td colspan="2">A long climb report with enough prose to make the adjustable column width visible.</td>',
                    `<td>Trip Report</td><td>${ascentImageHtml}</td>`,
                )
                : ascentHtml;
            if (url.searchParams.get('layout') === 'details') {
                layoutHtml = ascentHtml.replace(/<br clear="left">[\s\S]*$/, '</body></html>').replace(
                    /<tr><th colspan="2">Ascent Trip Report<\/th><\/tr>\s*<tr><td colspan="2">[^<]*<\/td><\/tr>/,
                    `<tr><td><b>Date:</b></td><td>Saturday, August 26, 2023</td></tr>
                    <tr><td><b>Ascent Type:</b></td><td>Successful Summit Attained</td></tr>
                    <tr><td><b>Peak:</b></td><td><a href="/peak.aspx?pid=1">Fixture Peak</a></td></tr>`,
                );
            }
            const body = analyzerCase && analyzerCase !== url.searchParams.get('aid')
                ? layoutHtml.replace('/track.gpx', `/track.gpx?case=${encodeURIComponent(analyzerCase)}`)
                : layoutHtml;
            return send('text/html; charset=utf-8', body);
        }
        if (/peakascents\.aspx/i.test(url.pathname)) {
            return send('text/html; charset=utf-8', url.searchParams.has('compact') ? compactIgnoredHtml : peakAscentsHtml);
        }
        if (/climblistc\.aspx/i.test(url.pathname)) {
            if (holdProfileLists && url.searchParams.get('j') === '-1' && url.searchParams.get('y') === '9999') {
                requests.profileListReads++;
                response.once('close', () => { if (!response.writableEnded) requests.cancelledProfileReads++; });
                await new Promise<void>(resolve => heldProfileLists.add(resolve));
            }
            return send('text/html; charset=utf-8', profileAscentsHtml);
        }
        if (/\/climber\/climber\.aspx/i.test(url.pathname)) {
            if (request.method === 'POST') {
                const body = new URLSearchParams(await readRequestBody(request));
                if (inlineBuddies && (body.has('ContactTextBox') || body.has('ContactButton')
                    || body.get('__VIEWSTATE') !== 'synthetic-viewstate' || body.get('__EVENTVALIDATION') !== 'synthetic-validation'
                    || body.has('AddBuddy') === body.has('RemoveBuddy'))) {
                    return send('text/plain', 'Invalid Buddy postback', { status: 400 });
                }
                const action = body.get('BuddyButton') || '';
                if (inlineBuddies ? body.has('AddBuddy') : /^Add\b/i.test(action)) otherClimberIsBuddy = true;
                else if (inlineBuddies ? body.has('RemoveBuddy') : /^Remove\b/i.test(action)) otherClimberIsBuddy = false;
                requests.buddyMutations += 1;
            }
            const html = renderOtherClimber();
            return send('text/html; charset=utf-8', url.searchParams.has('hover') ? html.replace('</body>',
                '<section id="hover-card-fixture" style="margin:24px;max-width:440px;text-align:left">'
                + '<div><a id="hover-home" href="/climber/climber.aspx?cid=900002">Home Page</a> · '
                + '<a href="/climber/ClimbListC.aspx?cid=900002">Peak List</a></div>'
                + '<h2>Recent ascents</h2><p><a id="hover-climber" href="/climber/climber.aspx?cid=900002">Morgan Longlastname</a></p>'
                + '<p><a id="hover-other" href="/climber/climber.aspx?cid=900003">Casey Summit</a></p>'
                + '<p><a id="hover-self" href="/climber/climber.aspx?cid=900001">Alex Doe</a></p></section></body>') : html);
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
        if (/peak\.aspx/i.test(url.pathname)) {
            if (url.searchParams.has('signed-out')) {
                return send('text/html; charset=utf-8', ignoredPeakHtml.replace(/<div style="color:navy">[\s\S]*?<\/div>/i, ''));
            }
            if (url.searchParams.has('week-weather')) {
                let html = ignoredPeakHtml.replaceAll('/map/BigMap.aspx?t=P&amp;d=2296&amp;c=900001', '/map/BigMap.aspx?cy=46.851731&amp;cx=-121.760395&amp;z=10&amp;t=P&amp;d=2296&amp;c=900001');
                if (url.searchParams.get('week-weather') === 'no-map') html = html.replace(/<iframe id="Gmap"[\s\S]*?<\/iframe>/, '');
                if (url.searchParams.get('week-weather') === 'map-first') {
                    const mapRow = html.match(/<tr><td colspan="2" align="center"><b>Dynamic Map<\/b>[\s\S]*?<\/tr>/)?.[0];
                    if (!mapRow) throw new Error('The peak fixture has no native Dynamic Map row');
                    html = html.replace(mapRow, '').replace('<table class="gray" align="right" width="50%"><tbody>',
                        `<table class="gray" align="right" width="50%"><tbody>${mapRow}`);
                }
                return send('text/html; charset=utf-8', html);
            }
            return send('text/html; charset=utf-8', url.searchParams.has('ignored') || url.searchParams.get('pid') === '2296' ? ignoredPeakHtml : peakHtml);
        }
        if (/bigmap\.aspx/i.test(url.pathname)) {
            return send('text/html; charset=utf-8',
                (url.searchParams.get('t') || '').toUpperCase() === 'P' ? peakBigMapHtml : bigMapDocument);
        }
        if (url.pathname === '/fixture-ascent-image.svg') return send('image/svg+xml', ascentImageSvg);
        if (/mastermap\.aspx/i.test(url.pathname)) {
            return send('text/html; charset=utf-8',
                (url.searchParams.get('t') || '').toUpperCase() === 'P' ? peakMapDocument : masterMapDocument);
        }
        if (/track\.gpx/i.test(url.pathname)
            || (/^\/climber\/GPXFile\.aspx$/i.test(url.pathname) && url.searchParams.get('aid') === '7654321')) {
            const analyzerCase = url.searchParams.get('case') || 'success';
            requests.analyzerTracks[analyzerCase] = (requests.analyzerTracks[analyzerCase] || 0) + 1;
            if (analyzerCase === 'signed-out') {
                return send('text/html; charset=utf-8', '<html><body>Log In</body></html>', { status: 401 });
            }
            if (analyzerCase === 'missing') {
                return send('text/plain; charset=utf-8', 'not found', { status: 404 });
            }
            if (analyzerCase === 'challenge') {
                return send('text/html; charset=utf-8', '<html><title>Just a moment</title></html>', {
                    status: 403,
                    headers: { 'cf-mitigated': 'challenge' },
                });
            }
            if (analyzerCase === 'invalid-xml') {
                return send('application/gpx+xml', '<gpx><trk>');
            }
            if (analyzerCase === 'invalid-root') {
                return send('application/gpx+xml', '<html><gpx/></html>');
            }
            if (analyzerCase === 'timeout') {
                await new Promise(resolve => setTimeout(resolve, 16_000));
            }
            if (analyzerCase === 'no-points') {
                return send('application/gpx+xml', '<gpx><trk><trkseg/></trk></gpx>');
            }
            if (analyzerCase === 'no-valid-points') {
                return send(
                    'application/gpx+xml',
                    '<gpx><trk><trkseg><trkpt lat="north" lon="-121"><ele>100</ele></trkpt></trkseg></trk></gpx>',
                );
            }
            if (analyzerCase === 'retry'
                && requests.analyzerTracks[analyzerCase] === 1) {
                return send('text/plain; charset=utf-8', 'temporarily unavailable', { status: 503 });
            }
            if (analyzerDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, analyzerDelayMs));
            }
            const track = /^\/climber\/GPXFile\.aspx$/i.test(url.pathname) && url.searchParams.get('aid') === '7654321'
                ? gpx.replaceAll('2026-07-01', '2024-07-12') : analyzerGpxByCase[analyzerCase] || analyzerGpx;
            return send('application/gpx+xml', track);
        }
        if (url.pathname === '/caption-photo.svg') {
            return send('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">'
                + '<path fill="#aacddd" d="M0 0h640v400H0z"/><path fill="#647c81" d="M0 400 230 90 390 280 510 150 640 400z"/></svg>');
        }
        response.writeHead(404);
        response.end('not found');
    };
    const server = await resources.guard(() => createServer({ key, cert }, handleRequest));
    resources.defer('browser fixture server', () => closeServer(server));
    resources.defer('held profile list reads', releaseProfileLists);
    await resources.guard(listenServer(server, 0, '127.0.0.1'));
    return {
        port: (server.address() as AddressInfo).port,
        chromeTrustArgs: certificate.chromeTrustArgs,
        gpxPath,
        requests,
        holdProfileLists: () => { holdProfileLists = true; },
        releaseProfileLists,
        close: () => resources.dispose(),
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
// disabled verify -- terrain, verify -- terrain firefox, and showcase:render, and
// rendered "Better Peakbagger refused an invalid Peakbagger request." into the
// store-listing screenshots. Callers keep their own special routes — the peak
// feed, the synthetic DEM tiles, the popup mock — and compose them with these.

// Every extension asset any fixture serves. A type missing here would reach the
// browser as application/octet-stream, which for a stylesheet or a module is a
// silent, confusing failure rather than a loud one.
export const fixtureContentTypes = new Map<string, string>([
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

export const fixtureContentType = (file: string): string =>
    fixtureContentTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream';

// Resolve a request path to a real file inside `root`, or null. Rejects
// traversal out of the root and anything that is not a regular file.
export async function resolveFixtureFile(pathname: string, root: string = projectRoot): Promise<string | null> {
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

export function sendFixtureText(
    response: ServerResponse,
    status: number,
    body: string | Buffer,
    contentType = 'text/plain; charset=utf-8',
): void {
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
    response.end(body);
}

export const sendFixtureNotFound = (response: ServerResponse, body = 'Not found'): void =>
    sendFixtureText(response, 404, body);

// Parse fixture markup in a blank page with requests blocked for its entire
// lifetime. The page under test keeps its own routes and execution order.
export async function withOfflineFixturePage<T>(context: BrowserContext, prepare: (page: Page) => Promise<T>): Promise<T> {
    const resources = createResourceStack();
    const page = await context.newPage();
    resources.defer('offline fixture page', () => page.close());
    const result = await resources.guard(async () => {
        await page.route('**/*', route => route.abort());
        return prepare(page);
    });
    await resources.dispose();
    return result;
}

// A fixture server must never swallow its own faults: the stack is the only
// signal a check has that its harness broke rather than the product.
export const sendFixtureError = (response: ServerResponse, error: unknown): void => {
    const message = error && typeof error === 'object' && 'message' in error
        ? (error as { message?: unknown }).message
        : undefined;
    sendFixtureText(response, 500, (error instanceof Error ? error.stack : undefined) || String(message ?? error));
};

// Serve one resolved file. `transform` receives the UTF-8 text and returns the
// text to send, for the callers that instrument a page before the browser sees
// it; leaving it out sends the bytes untouched, which is what binary assets
// need. `cacheControl` defaults to no-store so a check never reads a stale
// build; the showcase renderer overrides it for tiles it wants cached.
export async function sendFixtureFile(
    response: ServerResponse,
    file: string | null,
    { transform = null, cacheControl = 'no-store' }: SendFixtureFileOptions = {},
): Promise<void> {
    if (!file) throw new TypeError('Fixture file path is required');
    const contents = transform
        ? Buffer.from(transform(await readFile(file, 'utf8')))
        : await readFile(file);
    response.writeHead(200, {
        'content-type': fixtureContentType(file),
        'cache-control': cacheControl,
    });
    response.end(contents);
}

// Both ascent backup verifiers use this saved edit form. Keep the production
// fixture markup intact outside the fields the two scenarios populate.
export function prepareAscentBackupEditFixture(html: string, { elevationFeet }: { elevationFeet?: number } = {}): string {
    const peak = '<select size="4" name="PeakListBox" id="PeakListBox" style="height:116px;width:292px;">';
    const peakFields = html.match(new RegExp(`${peak}\\s*</select>`, 'g'));
    if (peakFields?.length !== 1) throw new Error('Expected one empty PeakListBox in the ascent backup fixture');
    const date = '<input name="DateText" type="text" id="DateText" style="width:80px;">';
    const elevation = '<input name="PointFt" type="text" id="PointFt" style="WIDTH: 48px" size="1" value="0">';
    const fields = [
        ['PeakListBox', peakFields[0], `${peak}<option value="2296" selected>Mount Rainier</option></select>`],
        ['DateText', date, `${date.slice(0, -1)} value="2026-07-12">`],
    ];
    if (elevationFeet !== undefined) fields.push(['PointFt', elevation, elevation.replace('value="0"', `value="${elevationFeet}"`)]);
    for (const [field, before, after] of fields) {
        if (html.split(before).length !== 2) throw new Error(`Expected one ${field} field in the ascent backup fixture`);
        html = html.replace(before, after);
    }
    return html;
}

