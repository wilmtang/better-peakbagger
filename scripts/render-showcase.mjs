#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from 'node:https';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createFixtureCertificate,
    resolveFixtureFile,
    sendFixtureError,
    sendFixtureFile,
    sendFixtureNotFound,
    sendFixtureText,
} from './browser-verification-fixtures.mjs';
import {
    closeServer,
    createResourceStack,
    listenServer,
    manageChildProcess,
} from './resource-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'store-assets');
// These screenshots ship to the Chrome Web Store listing, and the GPX Analyzer
// fetches its track through src/peakbagger/peakbagger-request.js, which refuses
// any URL whose protocol is not https:. Served over http:// the analyzer panel
// renders "Better Peakbagger refused an invalid Peakbagger request." and that
// is what lands in store-assets/ — so the showcase host is HTTPS on a
// Peakbagger hostname, exactly like the real page.
const SHOWCASE_HOST = 'www.peakbagger.com';
const chrome = process.env.CHROME_BIN || ({
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')
}[process.platform] || 'google-chrome');
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const usgsTopoUrl = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/export?bbox=-122.005,48.70,-121.625,48.79&bboxSR=4326&imageSR=4326&size=800,190&format=png32&transparent=false&f=image';
let usgsTopo;

const popupMock = provider => `
<script>
(() => {
  const provider = ${JSON.stringify(provider)};
  const job = {
    provider,
    activityId: '482614',
    phase: 'ready',
    trackSummary: {
      originalPointCount: 4862,
      retainedPointCount: 1174,
      maxDeviationM: 2.8
    },
    selectedIds: [2296, 21500],
    matches: [
      {
        id: 2296,
        name: 'Mount Baker',
        classification: 'strong',
        confidence: 94,
        evidence: { distanceM: 8, elevationDeltaM: 11, trackQuality: .98, ambiguous: false }
      },
      {
        id: 21500,
        name: 'Sherman Peak',
        classification: 'probable',
        confidence: 73,
        evidence: { distanceM: 46, elevationDeltaM: 27, trackQuality: .98, ambiguous: false }
      }
    ]
  };

  const sendMessage = async message => {
    if (message.type === 'CAPTURE_OPEN_DRAFTS') return { ...job, phase: 'opened' };
    return job;
  };

  window.chrome = {
    tabs: { query: async () => [{ id: 7 }], create: async () => ({}) },
    runtime: { sendMessage }
  };
})();
</script>`;

const interpolate = (a, b, t) => a + (b - a) * t;

const multiDayGpx = () => {
    const anchors = [
        { time: '2026-07-10T13:20:00Z', lat: 48.7061, lon: -121.8098, ele: 1050 },
        { time: '2026-07-10T22:40:00Z', lat: 48.7338, lon: -121.8182, ele: 1950 },
        { time: '2026-07-11T08:30:00Z', lat: 48.7339, lon: -121.8181, ele: 1955 },
        { time: '2026-07-11T14:18:00Z', lat: 48.7770, lon: -121.8130, ele: 3286 },
        { time: '2026-07-11T22:10:00Z', lat: 48.7340, lon: -121.8183, ele: 1946 },
        { time: '2026-07-12T13:00:00Z', lat: 48.7338, lon: -121.8182, ele: 1950 },
        { time: '2026-07-12T18:42:00Z', lat: 48.7061, lon: -121.8098, ele: 1050 }
    ].map(anchor => ({ ...anchor, ms: Date.parse(anchor.time) }));

    const points = [];
    for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex++) {
        const start = anchors[anchorIndex];
        const end = anchors[anchorIndex + 1];
        const steps = 15;
        for (let step = anchorIndex ? 1 : 0; step <= steps; step++) {
            const t = step / steps;
            const wiggle = Math.sin((step + anchorIndex * 3) * .85) * .00045;
            points.push({
                lat: interpolate(start.lat, end.lat, t) + wiggle,
                lon: interpolate(start.lon, end.lon, t) - wiggle * .7,
                ele: interpolate(start.ele, end.ele, t) + Math.sin(step * .7) * 8,
                time: new Date(interpolate(start.ms, end.ms, t)).toISOString()
            });
        }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"><trk><name>Synthetic three-day Mount Baker showcase</name><trkseg>\n${points.map(point =>
        `<trkpt lat="${point.lat.toFixed(6)}" lon="${point.lon.toFixed(6)}"><ele>${point.ele.toFixed(1)}</ele><time>${point.time}</time></trkpt>`
    ).join('\n')}\n</trkseg></trk></gpx>`;
};

const resources = createResourceStack();
let primaryError = null;
const certificate = await resources.guard(() =>
    createFixtureCertificate({ host: SHOWCASE_HOST, label: 'showcase' }));
resources.defer('showcase certificate', () => certificate.remove());

const handleRequest = async (request, response) => {
    try {
        const url = new URL(request.url, `https://${SHOWCASE_HOST}`);

        if (url.pathname === '/scripts/showcase/multiday.gpx') {
            sendFixtureText(response, 200, multiDayGpx(), 'application/gpx+xml; charset=utf-8');
            return;
        }

        if (url.pathname === '/scripts/showcase/MasterMap.aspx') {
            sendFixtureText(response, 200,
                await readFile(path.join(root, 'scripts/showcase/map.html')), 'text/html; charset=utf-8');
            return;
        }

        if (url.pathname === '/scripts/showcase/usgs-topo.png') {
            response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
            response.end(usgsTopo);
            return;
        }

        if (url.pathname === '/popup/popup.html' && url.searchParams.get('showcase') === '1') {
            const provider = url.searchParams.get('provider') === 'garmin' ? 'garmin' : 'strava';
            const html = await readFile(path.join(root, 'popup/popup.html'), 'utf8');
            sendFixtureText(response, 200,
                html.replace('</head>', `${popupMock(provider)}\n</head>`), 'text/html; charset=utf-8');
            return;
        }

        const file = await resolveFixtureFile(url.pathname);
        if (!file) {
            sendFixtureNotFound(response);
            return;
        }
        await sendFixtureFile(response, file);
    } catch (error) {
        sendFixtureError(response, error);
    }
};
const server = await resources.guard(() =>
    createServer({ key: certificate.key, cert: certificate.cert }, handleRequest));
resources.defer('showcase server', () => closeServer(server));

const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    manageChildProcess(resources, child, `showcase child ${path.basename(command)}`);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`${command} did not finish within 60 seconds`)), 60_000);
    const settle = operation => value => {
        clearTimeout(timer);
        operation(value);
    };
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', settle(reject));
    child.on('close', settle(code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    }));
});

const screenshot = async (port, route, output) => {
    await run(chrome, [
        '--headless=new',
        '--hide-scrollbars',
        '--disable-gpu',
        '--force-device-scale-factor=1',
        '--window-size=1280,800',
        '--virtual-time-budget=2600',
        // The showcase certificate is generated per run for this host only, and
        // the resolver rule below keeps the name pointed at the local server.
        '--ignore-certificate-errors',
        `--host-resolver-rules=MAP ${SHOWCASE_HOST} 127.0.0.1`,
        `--screenshot=${output}`,
        `https://${SHOWCASE_HOST}:${port}${route}`
    ]);
};

const gif = async (frames, output, frameDuration) => {
    const concat = frames.flatMap(frame => ['-loop', '1', '-t', String(frameDuration), '-i', frame]);
    const inputs = frames.map((_, index) => `[${index}:v]scale=960:600:flags=lanczos,setsar=1[v${index}]`).join(';');
    const streams = frames.map((_, index) => `[v${index}]`).join('');
    const filter = `${inputs};${streams}concat=n=${frames.length}:v=1:a=0,split[p0][p1];[p0]palettegen=max_colors=96:stats_mode=diff[pal];[p1][pal]paletteuse=dither=bayer:bayer_scale=4`;
    await run(ffmpeg, ['-y', ...concat, '-filter_complex', filter, '-loop', '0', output]);
};

try {
    await mkdir(outputDir, { recursive: true });

    const topoResponse = await fetch(usgsTopoUrl);
    if (!topoResponse.ok) throw new Error(`USGS topo request failed with ${topoResponse.status}`);
    usgsTopo = Buffer.from(await topoResponse.arrayBuffer());

    await listenServer(server, 0, '127.0.0.1');
    const { port } = server.address();

    const frameDir = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-showcase-'));
    resources.defer('showcase frames', () => rm(frameDir, { recursive: true, force: true }));
    const activityStrava = path.join(frameDir, 'activity-strava.png');
    const activityGarmin = path.join(frameDir, 'activity-garmin.png');
    const gpxHoverFractions = [.14, .28, .42, .56, .7, .84];
    const gpxFrames = gpxHoverFractions.map((_, index) => path.join(frameDir, `gpx-${index}.png`));

    await screenshot(port, '/scripts/showcase/capture.html?provider=strava', activityStrava);
    await screenshot(port, '/scripts/showcase/capture.html?provider=garmin', activityGarmin);
    await screenshot(port, '/scripts/showcase/capture.html?provider=strava', path.join(outputDir, 'screenshot-0-strava-capture.png'));
    await screenshot(port, '/scripts/showcase/capture.html?provider=garmin', path.join(outputDir, 'screenshot-0-garmin-capture.png'));

    for (let index = 0; index < gpxFrames.length; index++) {
        await screenshot(port, `/scripts/showcase/gpx.html?hover=${gpxHoverFractions[index]}`, gpxFrames[index]);
    }
    await screenshot(port, '/scripts/showcase/gpx.html?hover=.56', path.join(outputDir, 'screenshot-1-gpx-analyzer.png'));

    await gif([activityStrava, activityGarmin], path.join(outputDir, 'showcase-activity-capture.gif'), 2.4);
    await gif(gpxFrames, path.join(outputDir, 'showcase-gpx-map-sync.gif'), 1);
} catch (error) {
    primaryError = error;
}
await resources.dispose(primaryError);
