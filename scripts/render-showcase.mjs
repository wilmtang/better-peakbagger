#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'store-assets');
const chrome = process.env.CHROME_BIN || ({
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')
}[process.platform] || 'google-chrome');
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';

const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.gif', 'image/gif'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.mjs', 'text/javascript; charset=utf-8']
]);

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
        { time: '2026-07-10T13:20:00Z', lat: 48.724, lon: -121.873, ele: 1100 },
        { time: '2026-07-10T22:40:00Z', lat: 48.754, lon: -121.846, ele: 1950 },
        { time: '2026-07-11T08:30:00Z', lat: 48.7541, lon: -121.8459, ele: 1955 },
        { time: '2026-07-11T14:18:00Z', lat: 48.792, lon: -121.814, ele: 3286 },
        { time: '2026-07-11T22:10:00Z', lat: 48.7542, lon: -121.8461, ele: 1946 },
        { time: '2026-07-12T13:00:00Z', lat: 48.754, lon: -121.846, ele: 1950 },
        { time: '2026-07-12T18:42:00Z', lat: 48.724, lon: -121.873, ele: 1100 }
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

const safeFile = async pathname => {
    const resolved = path.resolve(root, `.${pathname}`);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    try {
        if (!(await stat(resolved)).isFile()) return null;
        return resolved;
    } catch {
        return null;
    }
};

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');

        if (url.pathname === '/scripts/showcase/multiday.gpx') {
            response.writeHead(200, { 'content-type': 'application/gpx+xml; charset=utf-8' });
            response.end(multiDayGpx());
            return;
        }

        if (url.pathname === '/scripts/showcase/MasterMap.aspx') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(await readFile(path.join(root, 'scripts/showcase/map.html')));
            return;
        }

        if (url.pathname === '/popup/popup.html' && url.searchParams.get('showcase') === '1') {
            const provider = url.searchParams.get('provider') === 'garmin' ? 'garmin' : 'strava';
            const html = await readFile(path.join(root, 'popup/popup.html'), 'utf8');
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(html.replace('</head>', `${popupMock(provider)}\n</head>`));
            return;
        }

        const file = await safeFile(url.pathname);
        if (!file) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        response.writeHead(200, { 'content-type': contentTypes.get(path.extname(file)) || 'application/octet-stream' });
        response.end(await readFile(file));
    } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error.stack || error.message);
    }
});

const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
});

const screenshot = async (port, route, output) => {
    await run(chrome, [
        '--headless=new',
        '--hide-scrollbars',
        '--disable-gpu',
        '--force-device-scale-factor=1',
        '--window-size=1280,800',
        '--virtual-time-budget=2600',
        `--screenshot=${output}`,
        `http://127.0.0.1:${port}${route}`
    ]);
};

const gif = async (frames, output, frameDuration) => {
    const concat = frames.flatMap(frame => ['-loop', '1', '-t', String(frameDuration), '-i', frame]);
    const inputs = frames.map((_, index) => `[${index}:v]scale=960:600:flags=lanczos,setsar=1[v${index}]`).join(';');
    const streams = frames.map((_, index) => `[v${index}]`).join('');
    const filter = `${inputs};${streams}concat=n=${frames.length}:v=1:a=0,split[p0][p1];[p0]palettegen=max_colors=96:stats_mode=diff[pal];[p1][pal]paletteuse=dither=bayer:bayer_scale=4`;
    await run(ffmpeg, ['-y', ...concat, '-filter_complex', filter, '-loop', '0', output]);
};

await mkdir(outputDir, { recursive: true });

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
    const frameDir = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-showcase-'));
    const activityStrava = path.join(frameDir, 'activity-strava.png');
    const activityGarmin = path.join(frameDir, 'activity-garmin.png');
    const gpxFrames = [.22, .4, .58, .78].map((_, index) => path.join(frameDir, `gpx-${index}.png`));

    try {
        await screenshot(port, '/scripts/showcase/capture.html?provider=strava', activityStrava);
        await screenshot(port, '/scripts/showcase/capture.html?provider=garmin', activityGarmin);
        await screenshot(port, '/scripts/showcase/capture.html?provider=strava', path.join(outputDir, 'screenshot-0-strava-capture.png'));
        await screenshot(port, '/scripts/showcase/capture.html?provider=garmin', path.join(outputDir, 'screenshot-0-garmin-capture.png'));

        for (let index = 0; index < gpxFrames.length; index++) {
            await screenshot(port, `/scripts/showcase/gpx.html?hover=${[.22, .4, .58, .78][index]}`, gpxFrames[index]);
        }
        await screenshot(port, '/scripts/showcase/gpx.html?hover=.58', path.join(outputDir, 'screenshot-1-gpx-analyzer.png'));

        await gif([activityStrava, activityGarmin], path.join(outputDir, 'showcase-activity-capture.gif'), 2.4);
        await gif(gpxFrames, path.join(outputDir, 'showcase-gpx-map-sync.gif'), .9);
    } finally {
        await rm(frameDir, { recursive: true, force: true });
    }
} finally {
    server.close();
}
