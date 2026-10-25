// Hidden research harness. It does not install or change the extension.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium, firefox } from 'playwright';
import { assertChromeLaunchAllowed } from '../../../../scripts/chrome-launch-guard.mjs';
import { createFixtureCertificate, waitForCondition } from '../../../../scripts/browser-verification-fixtures.mjs';

assert.equal(process.argv.length, 3, 'Usage: node browser.mjs /absolute/disposable-directory');
assertChromeLaunchAllowed();
const root = path.resolve(process.argv[2]), here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '../../../..');
const manifest = JSON.parse(await readFile(path.join(root, 'source-manifest.json')));
const oracle = JSON.parse(await readFile(path.join(root, 'oracle.json')));
const bytes = await readFile(path.join(root, 'sample.zip'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.zipSha256);
assert.equal(oracle.length, manifest.rows);
const fixtures = new Map();
for (const name of ['page', 'worker']) {
    const bundle = await build({ entryPoints: [path.join(here, `${name}.js`)], bundle: true, minify: true,
        write: false, platform: 'browser', format: 'esm', target: ['chrome128', 'firefox128'],
        nodePaths: [path.join(root, 'node_modules'), path.join(project, 'node_modules')] });
    fixtures.set(`/${name}.js`, { type: 'text/javascript', body: bundle.outputFiles[0].contents });
}
for (const [url, file, type] of [
    ['/leaflet.js', path.join(root, 'node_modules/leaflet/dist/leaflet.js'), 'text/javascript'],
    ['/leaflet.css', path.join(root, 'node_modules/leaflet/dist/leaflet.css'), 'text/css'],
    ['/maplibre-gl-worker.mjs', path.join(project, 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'), 'text/javascript'],
    ['/maplibre-gl-shared.mjs', path.join(project, 'node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs'), 'text/javascript'],
    ['/maplibre.css', path.join(project, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'text/css'],
    ['/sqlite3.wasm', path.join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'), 'application/wasm'],
]) fixtures.set(url, { type, body: await readFile(file) });
fixtures.set('/sample.zip', { type: 'application/zip', body: bytes });
fixtures.set('/invalid.zip', { type: 'application/zip', body: Buffer.from('not a zip') });
fixtures.set('/fixture.css', { type: 'text/css', body: Buffer.from(`
    *{box-sizing:border-box}body{margin:0;background:#f7f7f4;color:#23392d;font:15px system-ui}
    header{padding:20px}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 8px}
    #stage{height:540px;margin:0 20px;border:1px solid #bec8bf;position:relative}
    #leaflet,#maplibre{position:absolute;inset:0;background:#e5e7e3}
    [hidden]{display:none!important}#status{display:block;min-height:24px;font-variant-numeric:tabular-nums}
    footer{padding:12px 20px;font-size:12px}
`) });
const html = `<!doctype html><html><head><meta charset="utf-8"><title>FCC browser experiment</title>
    <link rel="stylesheet" href="/leaflet.css"><link rel="stylesheet" href="/maplibre.css">
    <link rel="stylesheet" href="/fixture.css"></head><body><header>
    <h1>Reported LTE coverage — browser processing experiment</h1>
    <p>Bounded AZGeo FCC-derived sample · carrier and reporting date unavailable</p>
    <output id="status" aria-live="polite">Loading local test archive…</output></header>
    <div id="stage"><div id="leaflet"></div><div id="maplibre" hidden></div></div>
    <footer>Green: reported LTE sample · Red: synthetic route · Blank: outside sample or no record.
    This fixture does not establish usable reception.</footer>
    <script src="/leaflet.js"></script><script type="module" src="/page.js"></script></body></html>`;
let browser, server, certificate, profile;
let archiveRequests = 0;
const report = { sample: manifest, package: { originalFccArchive: false, bytes: bytes.length },
    libraries: {}, browsers: [], limits: ['FCC original archive access blocked; local repackaging only',
        'No full-state archive, IndexedDB persistence, raw-polygon dataset or installed extension was tested'] };
for (const [name, base] of [['@sqlite.org/sqlite-wasm', root], ['sql.js', root], ['leaflet', root], ['maplibre-gl', project], ['jszip', project]]) {
    const pkg = JSON.parse(await readFile(path.join(base, 'node_modules', name, 'package.json')));
    report.libraries[name] = { version: pkg.version, license: pkg.license };
}
const execFileAsync = promisify(execFile);
async function rss() {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command=']);
    const rows = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
        .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), kib: Number(match[3]), command: match[4] }));
    const owned = new Set(rows.filter(row => row.command.includes(profile)).map(row => row.pid));
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    return rows.filter(row => owned.has(row.pid)).reduce((sum, row) => sum + row.kib * 1024, 0);
}
try {
    certificate = await createFixtureCertificate({ label: 'fcc-browser-experiment' });
    server = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
        const asset = request.url === '/' ? { type: 'text/html', body: Buffer.from(html) } : fixtures.get(request.url);
        if (!asset) { response.writeHead(404); response.end(); return; }
        if (request.url === '/sample.zip') archiveRequests++;
        response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://services6.arcgis.com" });
        response.end(asset.body);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `https://www.peakbagger.com:${server.address().port}`;
    report.fixtureOrigin = 'HTTPS www.peakbagger.com with disposable certificate';
    for (const engine of ['chromium', 'firefox']) {
        profile = await mkdtemp(path.join(tmpdir(), `bpb-fcc-${engine}-`));
        const context = engine === 'chromium'
            ? await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
                ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], viewport: { width: 1000, height: 760 },
                args: ['--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1', ...certificate.chromeTrustArgs] })
            : await firefox.launchPersistentContext(profile, { headless: true, viewport: { width: 1000, height: 760 },
                ignoreHTTPSErrors: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        browser = context;
        const result = { browser: engine, version: context.browser().version(), hidden: true, viewport: [1000, 760],
            cases: [], profileRemoved: false, errors: [] };
        report.browsers.push(result);
        const page = await context.newPage();
        page.on('pageerror', error => result.errors.push(error.message));
        let frameMaximum = 0;
        await page.goto(origin);
        await page.waitForFunction(() => Boolean(window.experiment));
        await page.evaluate(() => window.experiment.mapReady);
        result.memoryBaselineRssBytes = await rss();
        result.sampledMaximumRssBytes = result.memoryBaselineRssBytes;
        // Process RSS includes renderer/GPU/library overhead. It is not retained
        // data size or an exact peak; worker transient allocations can be missed.
        let sampling = true, samplingBusy = false;
        const timer = setInterval(async () => {
            if (!sampling || samplingBusy) return;
            samplingBusy = true;
            try { result.sampledMaximumRssBytes = Math.max(result.sampledMaximumRssBytes, await rss()); }
            finally { samplingBusy = false; }
        }, 100);
        try {
            await page.evaluate(() => {
                window.frameGaps = []; let previous = performance.now();
                const frame = now => { window.frameGaps.push(now - previous); previous = now; window.frameTimer = requestAnimationFrame(frame); };
                window.frameTimer = requestAnimationFrame(frame);
            });
            result.load = await page.evaluate(() => window.experiment.load());
            assert.equal(result.load.rows, manifest.rows);
            assert.equal(result.load.archiveBytes, bytes.length);
            const initialRequests = archiveRequests;
            const positions = [[-111.80, 34.84, 14], [-111.72, 34.91, 14], [-111.77, 34.87, 13], [-111.3, 34.87, 14]];
            for (const renderer of ['leaflet', 'maplibre']) {
                await page.evaluate(renderer => window.experiment.engine(renderer), renderer);
                for (const position of positions) {
                    const previous = await page.evaluate(() => window.experiment.results.length);
                    await page.evaluate(position => window.experiment.move(...position), position);
                    const state = await waitForCondition(() => page.evaluate(() => ({ count: window.experiment.results.length,
                        result: window.experiment.results.at(-1), errors: window.experiment.errors })), {
                        description: `${engine}/${renderer} settled viewport`, timeoutMs: 10000,
                        isReady: value => value.count > previous });
                    assert.deepEqual(state.errors, []);
                    const { bounds, ids, nativeRoutePresent } = state.result;
                    const expected = oracle.filter(({ bounds: b }) => b[0] <= bounds[2] && b[2] >= bounds[0]
                        && b[1] <= bounds[3] && b[3] >= bounds[1]).map(row => row.id).sort((a, b) => a - b);
                    assert.deepEqual(ids, expected, `${engine}/${renderer}: viewport IDs differ from independent source oracle`);
                    assert.equal(nativeRoutePresent, true);
                    assert.equal(archiveRequests, initialRequests, 'A pan or renderer switch downloaded the archive again');
                    const row = { ...state.result, count: ids.length, expectedCount: expected.length }; delete row.ids;
                    result.cases.push(row);
                }
                await page.evaluate(() => window.experiment.move(-111.77, 34.87, 13));
                await waitForCondition(() => page.evaluate(() => window.experiment.results.at(-1)?.ids.length), {
                    description: 'nonempty screenshot coverage', isReady: count => count > 0 });
                const screenshot = await page.screenshot({ path: path.join(root, `${engine}-${renderer}.png`) });
                const routePixels = await page.evaluate(async ({ renderer, png }) => {
                    const ex = window.experiment;
                    const point = renderer === 'leaflet' ? ex.leaflet.latLngToContainerPoint([34.865, -111.77])
                        : ex.map.project([-111.77, 34.865]);
                    const box = document.getElementById(renderer).getBoundingClientRect();
                    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
                    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
                    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
                    const pixels = context.getImageData(Math.round(box.left + point.x) - 5, Math.round(box.top + point.y) - 5, 11, 11).data;
                    let red = 0;
                    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 180 && pixels[i + 1] < 100 && pixels[i + 2] < 100) red++;
                    return red;
                }, { renderer, png: screenshot.toString('base64') });
                assert.ok(routePixels >= 10, `${engine}/${renderer}: coverage obscures the route (${routePixels} red pixels)`);
                result.routePixels ??= {}; result.routePixels[renderer] = routePixels;
            }
            const gl = await page.evaluate(() => {
                const gl = window.experiment.map.getCanvas().getContext('webgl2');
                const info = gl.getExtension('WEBGL_debug_renderer_info');
                return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
            });
            assert.ok(gl && !/swiftshader|llvmpipe|software|softpipe/i.test(gl), `Software renderer: ${gl}`);
            result.renderer = gl;
            result.invalidZipRejected = await page.evaluate(async () => {
                try { await window.experiment.rpc('load', { url: '/invalid.zip' }); return false; } catch { return true; }
            });
            assert.equal(result.invalidZipRejected, true);
            const retained = await page.evaluate(() => window.experiment.rpc('view', { bounds: [-111.85, 34.83, -111.69, 34.91] }));
            assert.ok(retained.collection.features.length > 0, 'Invalid replacement erased the loaded dataset');
            result.invalidReplacementRetainedData = true;
            result.invalidBoundsRejected = await page.evaluate(async () => {
                try { await window.experiment.rpc('view', { bounds: [1, 2, 0, 3] }); return false; } catch { return true; }
            });
            assert.equal(result.invalidBoundsRejected, true);
            const negative = await page.evaluate(() => window.experiment.results.at(-1));
            assert.ok(negative.ids.length, 'Zero nonempty cases executed');
            const b = negative.bounds;
            const independentIds = oracle.filter(({ bounds: v }) => v[0] <= b[2] && v[2] >= b[0]
                && v[1] <= b[3] && v[3] >= b[1]).map(row => row.id).sort((a, b) => a - b);
            assert.deepEqual(negative.ids, independentIds);
            assert.throws(() => assert.deepEqual(negative.ids.slice(1), independentIds),
                { code: 'ERR_ASSERTION' }, 'Dropped-feature negative control failed');
            result.droppedFeatureControlDetected = true;
            result.liveCorsCount = await page.evaluate(async () => {
                const url = 'https://services6.arcgis.com/clPWQMwZfdWn4MQZ/ArcGIS/rest/services/FCC_Mobile_Broadband/FeatureServer/195/query?f=json&where=1%3D1&returnCountOnly=true&geometry=-111.86%2C34.78%2C-111.66%2C34.96&geometryType=esriGeometryEnvelope&inSR=4326';
                const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
                const data = await response.json();
                return { status: response.status, count: data.count, error: data.error ?? null };
            });
            assert.equal(result.liveCorsCount.status, 200); assert.equal(result.liveCorsCount.count, manifest.rows);
            const gaps = await page.evaluate(() => { cancelAnimationFrame(window.frameTimer); return window.frameGaps; });
            frameMaximum = Math.max(...gaps);
            result.sampledMainThreadFrameGapMaxMs = frameMaximum;
            result.frameGapMeaning = 'Includes map updates, screenshot and source request; not an isolated parser long-task measurement';
            result.sampledMaximumRssBytes = Math.max(result.sampledMaximumRssBytes, await rss());
            assert.equal(result.cases.length, 8); assert.deepEqual(result.errors, []);
            await page.evaluate(() => window.experiment.dispose());
        } finally {
            sampling = false; clearInterval(timer);
            while (samplingBusy) await new Promise(resolve => setTimeout(resolve, 10));
            await context.close(); browser = null;
            await rm(profile, { recursive: true, force: true });
            result.profileRemoved = true;
        }
        console.log(JSON.stringify(result));
    }
    assert.equal(report.browsers.length, 2);
    report.archiveRequests = archiveRequests;
    report.success = true;
} catch (error) { report.success = false; report.error = error.stack; throw error; }
finally {
    await browser?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await certificate?.remove();
    await writeFile(path.join(root, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
}
