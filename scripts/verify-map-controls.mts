// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />

import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
    createFixtureCertificate, resolveFixtureFile, sendFixtureFile, sendFixtureText,
    sendFixtureError, instrumentTerrainFrameHtml, instrumentTerrainFrameModule, waitForCondition as untypedWaitForCondition,
} from './browser-verification-fixtures.mts';
import { createResourceStack, closeServer, listenServer } from './resource-stack.mts';
import { snowMapDem } from './verify-snow-map-fixture.mts';
import { createVerificationRoot, launchVerificationChrome, launchVerificationFirefox } from './verification-launch.mts';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => T | Promise<T>, options: { description: string; isReady?: (value: T) => unknown }) => Promise<T>;
type Box = { x: number; y: number; width: number; height: number };
interface ControlState { button: Box; map: Box | null; heading: Box | null; following: Box | null; scrollX: number; scrollY: number }
// Page-world sampling probe; callbacks cast in place so the shared program keeps Window unchanged.
interface SampleProbe { __controlSamples: Box[]; __sampleControls: boolean }

const args = process.argv.slice(2);
const surfaces = ['peak', 'ascent', 'big-map', 'big-peak', 'different-routes', 'recent-routes'];
assert.ok(args.every(arg => arg === '--firefox' || arg.startsWith('--surface=') && surfaces.includes(arg.slice(10))),
    `Unknown map-controls arguments: ${args.join(' ')}`);
const selection = args.find(arg => arg.startsWith('--surface='))?.slice(10);
const firefoxMode = args.includes('--firefox');
const artifacts = process.env.BPB_VERIFY_MAP_CONTROLS_ARTIFACTS;
const host = 'www.peakbagger.com';
const resources = createResourceStack();
const themeBundle = await readFile(new URL('../dist/content/theme.js', import.meta.url), 'utf8');
let primaryError: unknown = null;
try {
    const profile = await createVerificationRoot(resources, 'bpb-map-controls-', 'map controls profile');
    const certificate = await createFixtureCertificate({ host, directory: profile } as never);
    assert.ok(certificate);
    resources.defer('map controls certificate', () => certificate.remove());
    const server = createServer(certificate, async (request, response) => {
        try {
            const url = new URL(request.url!, `https://${host}`);
            if (url.pathname.toLowerCase() === '/async/pllbb.aspx') return sendFixtureText(response, 200, '<ts/>', 'text/xml');
            const routes: Record<string, string> = {
                '/peak.aspx': '/scripts/showcase/peak-map.html',
                '/climber/ascent.aspx': '/scripts/showcase/terrain.html',
                '/map/bigmap.aspx': '/scripts/showcase/big-map.html',
                '/map/mastermap.aspx': url.searchParams.has('big')
                    ? '/scripts/showcase/big-map-native.html' : '/scripts/showcase/terrain-native-map.html',
            };
            const pathname = url.pathname.startsWith('/scripts/showcase/terrain-tiles/')
                ? '/scripts/showcase/terrain-basemap-tile.png' : routes[url.pathname.toLowerCase()] || url.pathname;
            const file = await resolveFixtureFile(pathname);
            if (!file) return sendFixtureText(response, 404, 'Not found');
            await sendFixtureFile(response, file, {
                // The legacy helper infers transform as null-only; any HTML/module transform is accepted at run time.
                transform: pathname === '/dist/terrain/terrain.html' ? instrumentTerrainFrameHtml
                    : pathname === '/dist/terrain/terrain-frame.js' ? instrumentTerrainFrameModule : null,
            } as never);
        } catch (error) { sendFixtureError(response, error); }
    });
    resources.defer('map controls fixture server', () => closeServer(server));
    await listenServer(server, 0, '127.0.0.1');
    const origin = `https://${host}:${(server.address() as AddressInfo).port}`;
    const context = firefoxMode
        ? await launchVerificationFirefox(resources, 'map controls context', profile, {
            firefoxUserPrefs: { 'webgl.sanitize-unmasked-renderer': false,
                ...(process.platform === 'darwin' ? { 'webgl.disable-angle': false } : {}) },
        })
        : await launchVerificationChrome(resources, 'map controls context', profile, { ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            trustArgs: certificate.chromeTrustArgs, hosts: [`${host} 127.0.0.1`] });
    const browser = context.browser()!;
    console.log(`Hidden ${firefoxMode ? 'Firefox' : 'Chrome'} ${browser.version()}; disposable profile ${profile}`);
    let hold = false;
    const held = new Set<() => void>();
    const release = () => { hold = false; for (const resolve of held) resolve(); held.clear(); };
    resources.defer('held terrain tiles', release);
    await context.route(/^https:\/\/tiles\.mapterhorn\.com\//, async route => {
        if (hold) await new Promise<void>(resolve => held.add(resolve));
        await route.fulfill({ status: 200, contentType: 'image/webp', body: snowMapDem, headers: { 'access-control-allow-origin': '*' } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    // Fixtures own storage and activation stubs; all three page coordinators,
    // the frame bridge protocol and MapLibre renderer are shipped bundles.
    const read = () => page.evaluate((): ControlState => {
        const rect = (element: Element | null) => {
            if (!element) return null;
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return { button: rect(document.getElementById('bpb-terrain-toggle'))!,
            map: rect(document.querySelector('#bpb-map-viewport, .bpb-terrain-mount-fullscreen')),
            heading: rect(document.getElementById('native-map-heading')),
            following: rect(document.querySelector('.bpb-sun-calculator, #bpb-gpx-panel')),
            scrollX: window.scrollX, scrollY: window.scrollY };
    });
    const stable = (before: ControlState, after: ControlState, label: string) => {
        for (const region of ['button', 'map', 'heading', 'following'] as const) for (const dimension of ['x', 'y', 'width', 'height'] as const) {
            assert.ok(Math.abs((before[region]?.[dimension] || 0) - (after[region]?.[dimension] || 0)) <= 1,
                `${label}: ${region}.${dimension} moved: ${JSON.stringify({ before, after })}`);
        }
        assert.equal(after.scrollY, before.scrollY, `${label}: reading position moved`);
        assert.equal(after.scrollX, before.scrollX, `${label}: horizontal scroll moved`);
    };
    const sample = () => page.evaluate(() => {
        const probe = window as unknown as SampleProbe;
        probe.__controlSamples = [];
        probe.__sampleControls = true;
        const tick = () => {
            const r = document.getElementById('bpb-terrain-toggle')!.getBoundingClientRect();
            probe.__controlSamples.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            if (probe.__sampleControls) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const checkSamples = async (before: ControlState, label: string) => {
        const samples = await page.evaluate(() => { const probe = window as unknown as SampleProbe; probe.__sampleControls = false; return probe.__controlSamples; });
        assert.ok(samples.length > 0, `${label}: no painted states sampled`);
        for (const button of samples) stable(before, { ...before, button }, label);
    };
    const waitIdle = () => page.waitForFunction(() => {
        const button = document.getElementById('bpb-terrain-toggle')!;
        return button.textContent === '3D' && !button.hasAttribute('aria-busy');
    });
    const waitActive = () => page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')?.textContent === '2D'
        && document.getElementById('bpb-terrain-frame')?.style.opacity === '1');
    const screenshot = async (name: string) => {
        if (!artifacts) return;
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, `${firefoxMode ? 'firefox' : 'chrome'}-${name}.png`) });
    };
    const failures: string[] = [];
    let cases = 0;
    for (const [surface, url] of [
        ['peak', '/Peak.aspx?pid=2829'],
        ['ascent', '/climber/ascent.aspx?aid=1&mode=terrain&map=wide'],
        ['big-map', '/map/BigMap.aspx?t=G&mode3d=1'],
        ['big-peak', '/map/BigMap.aspx?t=P&d=2829&cy=48.83115&cx=-121.60214&z=14&mode3d=1'],
        ['different-routes', '/Map/BigMap.aspx?t=G&d=2096&c=40786&gt=rc'],
        ['recent-routes', '/Map/BigMap.aspx?t=G&d=2096&c=40786&gt=rt'],
    ].filter(([name]) => !selection || name === selection)) for (const [width, theme] of surface === 'peak'
        ? [[1280, 'light'], [1280, 'dark'], [375, 'light'], [375, 'dark']] as const
        : [[1280, 'light'], [375, 'dark']] as const) {
        const label = `${surface}/${width}/${theme}`;
        console.log(`Checking ${label}`);
        let stage = 'native fixture';
        try {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto(`${origin}${url}&theme=${theme}`);
            await page.addScriptTag({ content: themeBundle });
            await page.waitForFunction(() => {
                const button = document.getElementById('bpb-terrain-toggle') as HTMLButtonElement | null;
                const native = document.querySelector('iframe[src*="MasterMap.aspx" i]') as HTMLIFrameElement | null;
                return button && !button.disabled && (native?.contentWindow as unknown as { mapsPlaceholder?: unknown } | null)?.mapsPlaceholder;
            });
            // Fit the showcase's fixed presentation shell to the same narrow
            // map dimensions users can choose in the real page's resize rail.
            await page.addStyleTag({ content: '.terrain-check {box-sizing:border-box;width:100%;padding:8px;margin:0}.terrain-check .map-shell {width:100%;min-height:0}' });
            // The synthetic resize above invalidates Leaflet on the next
            // animation frame. Wait for the visible control gap before driving
            // the UI, as a person would after choosing a map size.
            await page.waitForFunction(() => {
                const native = document.querySelector('iframe[src*="MasterMap.aspx" i]') as HTMLIFrameElement | null;
                const zoom = native?.contentDocument?.querySelector('.leaflet-control-zoom')?.getBoundingClientRect();
                const button = document.getElementById('bpb-terrain-toggle')?.getBoundingClientRect();
                return zoom && button && button.bottom <= native!.getBoundingClientRect().top + native!.clientTop + zoom.top - 7;
            });
            await page.locator('#bpb-terrain-toggle').evaluate(button => button.scrollIntoView({ block: 'center', behavior: 'instant' }));
            // Every pending-state case must take the network path, including
            // a summit already visited in an earlier viewport in this profile.
            await page.evaluate(() => window.caches.delete('bpb-mapterhorn-dem-v1'));
            await page.locator('#bpb-terrain-toggle').focus();
            const before = await read();
            const nativeFrame = page.frameLocator('iframe[src*="MasterMap.aspx" i]');
            if (theme === 'dark') {
                await nativeFrame.locator('html[data-bpb-theme="dark"]').waitFor({ state: 'attached' });
                const appearance = await nativeFrame.locator('.leaflet-control-zoom a').first().evaluate(element => ({
                    background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color,
                    credits: getComputedStyle(document.querySelector('.leaflet-control-attribution')!).backgroundColor,
                    creditLink: getComputedStyle(document.querySelector('.leaflet-control-attribution a')!).color,
                }));
                assert.equal(appearance.background, 'rgb(39, 44, 41)', `${label}: native zoom follows dark mode`);
                assert.equal(appearance.color, 'rgb(226, 222, 213)');
                assert.equal(appearance.credits, 'rgba(31, 35, 33, 0.82)');
                assert.equal(appearance.creditLink, 'rgb(170, 208, 255)');
            }
            await screenshot(`${surface}-${width}-2d`);
            const point = { x: before.button.x + before.button.width / 2, y: before.button.y + before.button.height / 2 };
            hold = true;
            stage = 'loading';
            await sample();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.getElementById('bpb-terrain-toggle')!.getAttribute('aria-busy') === 'true');
            // Cancel an actual pending renderer, after its first held DEM read.
            // The coordinator label can precede the asynchronous frame creation.
            await waitForCondition(() => held.size > 0, { description: `${label}: renderer waiting for terrain` });
            stable(before, await read(), `${label}/loading`);
            await screenshot(`${surface}-${width}-pending`);
            await page.keyboard.press('Space');
            stage = 'cancel';
            await waitIdle();
            stable(before, await read(), `${label}/cancel`);
            release();
            await page.mouse.click(point.x, point.y);
            stage = 'active';
            await waitActive();
            const frame = page.frameLocator('#bpb-terrain-frame');
            const zoomGeometry = async () => {
                const native = await page.locator('iframe[src*="MasterMap.aspx" i]').evaluate(node => {
                    const element = node as HTMLIFrameElement;
                    const box = element.getBoundingClientRect(), zoom = element.contentDocument!.querySelector('.leaflet-control-zoom')!.getBoundingClientRect();
                    return { x: box.x + element.clientLeft + zoom.x, y: box.y + element.clientTop + zoom.y, width: zoom.width, height: zoom.height };
                });
                const terrain = await frame.locator('.maplibregl-ctrl-group').boundingBox();
                return { native, terrain };
            };
            const aligned = (value: { native: Box; terrain: Box | null }) => value.terrain && (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(value.native[key] - value.terrain![key]) <= 2);
            const zoom = await zoomGeometry();
            assert.ok(aligned(zoom), `${label}: 3D zoom must match native 2D geometry: ${JSON.stringify(zoom)}`);
            const credits = (await frame.locator('.maplibregl-ctrl-attrib').boundingBox())!;
            const terrainMapBox = (await frame.locator('#bpb-terrain-map').boundingBox())!;
            assert.ok(Math.abs(credits.x + credits.width - terrainMapBox.x - terrainMapBox.width) <= 1
                && Math.abs(credits.y + credits.height - terrainMapBox.y - terrainMapBox.height) <= 1,
            `${label}: credits must hug the bottom-right border: ${JSON.stringify({ credits, terrainMapBox })}`);
            const creditCollisions = () => frame.locator('.maplibregl-ctrl-attrib-inner').evaluate(element => {
                const zoomBox = document.querySelector('.maplibregl-ctrl-group')!.getBoundingClientRect();
                const nodes = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT), collisions: (string | null)[] = [];
                while (nodes.nextNode()) {
                    const range = document.createRange(); range.selectNodeContents(nodes.currentNode);
                    for (const rect of range.getClientRects()) if (rect.left < zoomBox.right && rect.right > zoomBox.left
                        && rect.top < zoomBox.bottom && rect.bottom > zoomBox.top) collisions.push(nodes.currentNode.textContent);
                }
                return collisions;
            });
            assert.deepEqual(await creditCollisions(), [], `${label}: readable credit text must not overlap zoom`);
            if (await page.locator('#native-map-heading').count()) {
                const native = (await page.locator('#if').boundingBox())!;
                const terrain = (await page.locator('#bpb-terrain-frame').boundingBox())!;
                for (const dimension of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(native[dimension] - terrain[dimension]) <= 1,
                    `${label}: 3D must fill the native map, preserving the header: ${JSON.stringify({ native, terrain })}`);
                assert.equal(await page.locator('#subject-peak').evaluate(link => {
                    const r = link.getBoundingClientRect();
                    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('a') === link;
                }), true, `${label}: the native peak link remains clickable in 3D`);
            }
            const renderer = await frame.locator('canvas.maplibregl-canvas').evaluate(canvas => {
                const gl = (canvas as HTMLCanvasElement).getContext('webgl2')!, info = gl.getExtension('WEBGL_debug_renderer_info');
                return (info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) as string;
            });
            assert.ok(renderer && !/software|swiftshader|llvmpipe/i.test(renderer), `Hardware WebGL required: ${renderer}`);
            if (process.platform === 'darwin') assert.match(renderer, /ANGLE Metal Renderer/, 'macOS verification requires Metal');
            console.log(`${label}: ${renderer}`);
            stable(before, await read(), `${label}/active`);
            const checkCorners = async () => {
                const map = (await frame.locator('#bpb-terrain-map').boundingBox())!;
                const overlay = (await page.locator('.bpb-layers-trigger').boundingBox())!;
                const base = (await frame.locator('[aria-label="Base map"]').boundingBox())!;
                assert.ok(Math.abs(overlay.x - map.x - 10) <= 1, `${label}: overlays align to the visible map's left edge`);
                assert.ok(Math.abs(overlay.y - map.y - 10) <= 1, `${label}: overlays align to the map's top edge`);
                assert.ok(base.x + base.width > map.x + map.width / 2, `${label}: basemap stays in the right corner`);
                assert.ok(map.x + map.width - base.x - base.width <= 26, `${label}: basemap stays against the right inset`);
                assert.ok(overlay.x + overlay.width + 4 <= base.x,
                    `${label}: corner controls overlap: ${JSON.stringify({ overlay, base })}`);
                assert.equal(await page.locator('.bpb-layers-panel [aria-label="Base map"]').count(), 0);
            };
            await checkCorners();
            if (surface === 'peak') {
                const creditControl = frame.locator('.maplibregl-ctrl-attrib');
                await creditControl.evaluate(element => { (element as HTMLElement).style.fontSize = '22px'; });
                await waitForCondition(creditCollisions, { description: `${label}: enlarged credits avoid zoom`, isReady: values => !values.length });
                assert.ok(aligned(await zoomGeometry()), `${label}: enlarged credits must not move zoom`);
                stable(before, await read(), `${label}/enlarged-credits`);
                await screenshot(`${surface}-${width}-${theme}-enlarged-credits`);
                await creditControl.evaluate(element => { (element as HTMLElement).style.fontSize = ''; });
                stage = 'layer picker focus';
                const picker = frame.locator('[aria-label="Base map"]');
                const pickerState = () => picker.evaluate(element => {
                    const style = getComputedStyle(element), r = element.getBoundingClientRect();
                    // Firefox retains the frame's last activeElement when
                    // Tab leaves its document; that element no longer has focus.
                    return { focused: document.activeElement === element && document.hasFocus(), visible: element.matches(':focus-visible'),
                        scheme: style.colorScheme, outline: style.outlineStyle, width: style.outlineWidth,
                        offset: style.outlineOffset, color: style.outlineColor,
                        rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
                });
                for (const scale of [1, 2]) {
                    // Enlarged text also exercises the picker's constrained
                    // width without changing the renderer's camera or canvas.
                    await frame.locator('#bpb-terrain-map').evaluate((control, factor) => { (control as HTMLElement).style.fontSize = `${12 * factor}px`; }, scale);
                    await page.locator('.bpb-map-layers').evaluate((control, factor) => { (control as HTMLElement).style.fontSize = `${12 * factor}px`; }, scale);
                    await checkCorners();
                    const idle = await pickerState();
                    await page.keyboard.press('Tab');
                    await picker.focus();
                    const focused = await pickerState();
                    await screenshot(`${surface}-${width}-${theme}-picker-focus-${scale}x`);
                    assert.equal(focused.focused && focused.visible, true, `${label}: keyboard focus is visible: ${JSON.stringify(focused)}`);
                    assert.equal(focused.outline, 'solid', `${label}: native focus halo must be replaced`);
                    assert.equal(focused.scheme, theme, `${label}: native menu must follow the map theme`);
                    assert.equal(focused.width, '2px', `${label}: use the compact map-control focus ring`);
                    assert.equal(focused.offset, '-2px', `${label}: focus ring stays inside the scrollable corner control`);
                    assert.equal(focused.color, theme === 'dark' ? 'rgb(121, 184, 255)' : 'rgb(47, 111, 208)');
                    assert.deepEqual(focused.rect, idle.rect, `${label}: focus moved or resized the layer picker`);
                    await picker.press('Escape');
                    assert.equal((await pickerState()).focused, true, `${label}: native picker Escape preserves focus`);
                    assert.equal(await frame.locator('#bpb-terrain-map').count(), 1, `${label}: native picker Escape must not exit 3D`);
                    await picker.press('Tab');
                    await waitForCondition(pickerState, { description: `${label}: keyboard can leave the picker`, isReady: state => !state.focused });
                    assert.deepEqual((await pickerState()).rect, idle.rect, `${label}: blur moved or resized the layer picker`);
                    stable(before, await read(), `${label}/picker-${scale}x`);
                }
                await frame.locator('#bpb-terrain-map').evaluate(control => { (control as HTMLElement).style.fontSize = ''; });
                await page.locator('.bpb-map-layers').evaluate(control => { (control as HTMLElement).style.fontSize = ''; });
                await page.locator('.bpb-layers-trigger').click();
                await frame.locator('[aria-label="Base map"]').click();
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('.bpb-layers-panel').isVisible(), true, `${label}: basemap interaction preserves the overlay menu`);
                await page.locator('.bpb-layers-trigger').click();
                assert.equal(await page.locator('.bpb-layers-panel').isVisible(), false, `${label}: only the Layers button collapses the menu`);
            }
            const group = (await frame.locator('.maplibregl-ctrl-group').boundingBox())!;
            const button = (await read()).button;
            assert.ok(group.y - button.y - button.height >= 7, `${label}: toggle overlaps zoom: ${JSON.stringify({ group, button })}`);
            const attributionDisclosure = frame.locator('.maplibregl-ctrl-attrib-button');
            if (await attributionDisclosure.isVisible()) await attributionDisclosure.click();
            else assert.ok((await frame.locator('.maplibregl-ctrl-attrib-inner').textContent() || '').includes('Mapterhorn'),
                `${label}: noncompact credits remain readable without a disclosure`);
            stable(before, await read(), `${label}/attribution`);
            const expandedGroup = (await frame.locator('.maplibregl-ctrl-group').boundingBox())!;
            assert.ok(expandedGroup.y - button.y - button.height >= 7,
                `${label}: expanded attribution pushes zoom into toggle: ${JSON.stringify({ expandedGroup, button })}`);
            await screenshot(`${surface}-${width}-3d`);
            stage = 'return';
            await page.mouse.click(point.x, point.y);
            await waitIdle();
            stable(before, await read(), `${label}/return`);
            await page.mouse.click(point.x, point.y);
            stage = 'renderer error';
            await waitActive();
            await frame.locator('canvas.maplibregl-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext());
            await waitIdle();
            const failed = await read();
            // The analyzer deliberately reveals a new error detail in its
            // panel. That disclosure may expand once; the map, action and
            // document scroll must still stay anchored, and retry restores it.
            stable(before, surface === 'ascent' ? { ...failed, following: before.following } : failed, `${label}/renderer-error`);
            await page.mouse.click(point.x, point.y);
            stage = 'retry';
            await waitActive();
            stable(before, await read(), `${label}/retry`);
            await checkSamples(before, label);
            await page.setViewportSize({ width: width - 30, height: 900 });
            await waitForCondition(zoomGeometry, { description: `${label}: zoom follows native map resize`, isReady: aligned });
            cases++;
        } catch (error) {
            release();
            await screenshot(`${surface}-${width}-${theme}-failed`);
            const live = await page.evaluate(() => ({ toggle: document.getElementById('bpb-terrain-toggle')?.outerHTML,
                frame: document.getElementById('bpb-terrain-frame')?.outerHTML,
                native: (document.querySelector('iframe[src*="MasterMap.aspx" i]') as HTMLIFrameElement | null)?.src,
                focus: document.activeElement?.outerHTML.slice(0, 150) })).catch(() => null);
            console.error(`${label}/${stage}: ${(error as Error).message}; live=${JSON.stringify(live)}`);
            failures.push(`${label}/${stage}: ${(error as Error).message}`);
        }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(pageErrors, [], 'fixture page errors');
    assert.ok(cases > 0, 'No map controls cases passed');
    console.log(`Hidden ${firefoxMode ? 'Firefox' : 'Chrome'} ${browser.version()}: ${cases} stable map-control cases passed (1280/375 × 1000).`);
} catch (error) { primaryError = error; }
await resources.dispose(primaryError as null);
