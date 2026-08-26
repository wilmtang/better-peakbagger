// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the derived Firefox extension in a disposable headless profile. This
// deliberately starts as a narrow vertical slice: prove Firefox interprets its
// manifest, starts background.js, and runs both execution worlds before the
// broader browser fixtures are shared with the Chrome verifier.
/* global document, location, window */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Builder, By, Key, until } from 'selenium-webdriver';
import { Button } from 'selenium-webdriver/lib/input.js';
import firefox from 'selenium-webdriver/firefox.js';

import {
    createBrowserFixtureServer,
    createSyntheticCaptureJob,
    fixtureHost,
    storeUrls,
    surfaceSelectors,
    verificationViewport,
    waitForCondition,
} from './browser-verification-fixtures.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import {
    isRetryableFirefoxStartup,
    stopOwnedFirefoxProcesses,
} from './firefox-verifier-processes.mjs';
import { readCompressedGpxFixture } from '../test/helpers/gpx-fixtures.mjs';
import { createResourceStack, quitWebDriver } from './resource-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firefoxSunTheme = process.env.BPB_VERIFY_FIREFOX_SUN_THEME === 'light' ? 'light' : 'dark';

async function startFirefoxDriver(options, profileRoot) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const service = new firefox.ServiceBuilder().addArguments(
            '--allow-system-access',
            `--profile-root=${profileRoot}`,
        );
        try {
            return await new Builder()
                .forBrowser('firefox')
                .setFirefoxOptions(options)
                .setFirefoxService(service)
                .build();
        } catch (error) {
            await stopOwnedFirefoxProcesses(profileRoot);
            if (attempt === 1 && isRetryableFirefoxStartup(error)) {
                console.warn('Firefox WebDriver exited cleanly during startup; retrying once after verifier-owned cleanup.');
                continue;
            }
            throw error;
        }
    }
    throw new Error('Firefox WebDriver startup exhausted its retry');
}

async function extensionBaseUrl(driver, addonId) {
    await driver.setContext(firefox.Context.CHROME);
    try {
        return await driver.executeScript(`
      const policy = WebExtensionPolicy.getByID(arguments[0]);
      return policy ? policy.getURL("") : null;
    `, addonId);
    } finally {
        await driver.setContext(firefox.Context.CONTENT);
    }
}

function assertState(condition, message, state) {
    if (!condition) {
        throw new Error(state === undefined ? message : `${message}: ${JSON.stringify(state)}`);
    }
}

async function writeElementScreenshot(driver, selector, outputPath) {
    if (!outputPath) return;
    const screenshot = await driver.findElement(By.css(selector)).takeScreenshot(true);
    await writeFile(outputPath, screenshot, 'base64');
}

async function waitForScript(
    driver,
    script,
    description,
    timeout = 15_000,
    isReady = Boolean,
) {
    try {
        return await driver.wait(async () => {
            const value = await driver.executeScript(script);
            return isReady(value) ? value : false;
        }, timeout);
    } catch (error) {
        let current;
        try {
            current = await driver.executeScript(script);
        } catch (readError) {
            current = `unavailable: ${readError.message}`;
        }
        throw new Error(`Timed out waiting for ${description}; current value: ${JSON.stringify(current)}`, {
            cause: error,
        });
    }
}

async function evaluatePageRealm(driver, expression) {
    const bidi = await driver.getBidi();
    const context = await driver.getWindowHandle();
    const response = await bidi.send({
        method: 'script.evaluate',
        params: {
            expression,
            target: { context },
            awaitPromise: true,
            resultOwnership: 'none',
        },
    });
    if (response.type === 'error') {
        throw new Error(`${response.error}: ${response.message}`);
    }
    if (response.result?.type === 'exception') {
        throw new Error(response.result.exceptionDetails?.text || 'page-realm script failed');
    }
    return response.result;
}

async function main() {
    const resources = createResourceStack();
    let primaryError = null;
    try {
        const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'better-peakbagger-firefox-verify-'));
        const stopOwnedProcesses = async () => {
            await stopOwnedFirefoxProcesses(temporaryRoot);
        };
        const removeTemporaryRoot = async () => {
            await rm(temporaryRoot, { recursive: true, force: true });
        };
        resources.defer('Firefox verification root', removeTemporaryRoot);
        resources.defer('Firefox owned processes', stopOwnedProcesses);
        const profileTemplate = path.join(temporaryRoot, 'profile');
        await mkdir(profileTemplate);

        const suppliedSource = process.env.BPB_VERIFY_EXTENSION_SOURCE
            ? path.resolve(process.env.BPB_VERIFY_EXTENSION_SOURCE)
            : null;
        const prepared = suppliedSource ? null : await prepareFirefoxSource({ temporaryRoot });
        if (prepared) resources.defer('prepared Firefox extension', () => prepared.cleanup());
        const extensionSource = suppliedSource || prepared.sourceDir;
        const capitolRegressionGpx =
            await readCompressedGpxFixture('capitol-2021-segment-order.gpx.gz.b64');
        const fixture = await createBrowserFixtureServer({
            temporaryRoot,
            analyzerGpx: capitolRegressionGpx,
        });
        resources.defer('Firefox browser fixture', () => fixture.close());
        const buddyListFixture = await readFile(
            path.join(root, 'test', 'fixtures', 'pages', 'report-buddy-list.html'),
            'utf8',
        );

        const options = new firefox.Options()
            .addArguments('-headless')
            .enableBidi()
            .setProfile(profileTemplate)
            .setPreference('network.dns.localDomains', [
                fixtureHost,
                'peakbagger.com',
                'tiles.mapterhorn.com',
                'tiles.openfreemap.org',
                'caltopo.s3.amazonaws.com',
                'ctusfs.s3.amazonaws.com',
                'tileserver.trimbleoutdoors.com',
                'a.tile.opentopomap.org',
                'tile.openstreetmap.org',
                'services.arcgisonline.com',
            ].join(','))
            .windowSize(verificationViewport);
        options.setAcceptInsecureCerts(true);
        if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);

        const driver = await startFirefoxDriver(options, temporaryRoot);
        resources.defer('Firefox WebDriver', () => quitWebDriver(driver));
        await driver.manage().setTimeouts({ pageLoad: 20_000, script: 15_000 });

        const addonId = await driver.installAddon(extensionSource, true);
        resources.defer('temporary Firefox add-on', () => driver.uninstallAddon(addonId));
        const baseUrl = await extensionBaseUrl(driver, addonId);
        if (!baseUrl?.startsWith('moz-extension://')) {
            throw new Error(`Firefox reported an invalid extension origin: ${JSON.stringify(baseUrl)}`);
        }

        const optionsUrl = new URL('options/options.html', baseUrl).href;
        const favoritesUrl = new URL('options/favorites.html', baseUrl).href;
        await driver.get(optionsUrl);
        const runtimeProbe = await driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            api.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: -1 })
                .then(value => done({ ok: true, value: value ?? null }))
                .catch(error => done({ ok: false, error: String(error) }));
        });
        if (!runtimeProbe?.ok) {
            throw new Error(`Firefox background did not answer CAPTURE_STATUS: ${runtimeProbe?.error || 'no reply'}`);
        }

        const extensionState = await driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            const keys = {
                sync: 'bpbBrowserVerifySync',
                local: 'bpbBrowserVerifyLocal',
                session: 'bpbBrowserVerifySession',
            };
            const changed = new Promise(resolve => {
                const listener = (changes, area) => {
                    if (area === 'local' && changes[keys.local]?.newValue === 'local') {
                        api.storage.onChanged.removeListener(listener);
                        resolve(true);
                    }
                };
                api.storage.onChanged.addListener(listener);
            });
            Promise.all([
                api.storage.sync.set({ [keys.sync]: 'sync' }),
                api.storage.local.set({ [keys.local]: 'local' }),
                api.storage.session.set({ [keys.session]: 'session' }),
            ]).then(async () => {
                const [sync, local, session, onChanged] = await Promise.all([
                    api.storage.sync.get(keys.sync),
                    api.storage.local.get(keys.local),
                    api.storage.session.get(keys.session),
                    changed,
                ]);
                await Promise.all([
                    api.storage.sync.remove(keys.sync),
                    api.storage.local.remove(keys.local),
                    api.storage.session.remove(keys.session),
                ]);
                done({
                    origin: globalThis.location.origin,
                    version: api.runtime.getManifest().version,
                    optionsOpenInTab: api.runtime.getManifest().options_ui?.open_in_tab,
                    values: [sync[keys.sync], local[keys.local], session[keys.session]],
                    onChanged,
                });
            }).catch(error => done({ error: String(error) }));
        });
        assertState(
            extensionState.origin.startsWith('moz-extension://'),
            'Firefox options did not use a moz-extension origin',
            extensionState,
        );
        assertState(
            extensionState.version && await driver.findElement(By.id('about-version')).getText()
        === `Version ${extensionState.version}` && extensionState.optionsOpenInTab === false,
            'Firefox options did not render the manifest version',
            extensionState,
        );
        assertState(
            extensionState.onChanged && extensionState.values.join(',') === 'sync,local,session',
            'Firefox storage areas or storage.onChanged did not round-trip',
            extensionState,
        );
        const imgbbSaved = await driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            api.runtime.sendMessage({
                type: 'PHOTO_IMGBB_SAVE_KEY',
                key: 'browser-verification-only',
            }).then(response => {
                globalThis.dispatchEvent(new Event('focus'));
                done(response);
            }).catch(error => done({ error: String(error) }));
        });
        assertState(
            imgbbSaved?.ok,
            'Firefox Settings could not save the ImgBB verifier key',
            imgbbSaved,
        );
        const firefoxImgbbOptions = await waitForScript(
            driver,
            `const status = document.getElementById("imgbb-key-status")?.textContent || "";
       if (!status.startsWith("ImgBB is configured")) return null;
       return {
         status,
         removeVisible: !document.getElementById("imgbb-key-remove")?.hidden
       };`,
            'the Firefox ImgBB connection status',
            5_000,
            value => !!value,
        );
        assertState(
            firefoxImgbbOptions.removeVisible && /ImgBB is configured/.test(firefoxImgbbOptions.status || ''),
            'Firefox Settings did not own the saved ImgBB connection',
            firefoxImgbbOptions,
        );

        const photoUrl = new URL('photos/photos.html?mode=library', baseUrl).href;
        await driver.get(photoUrl);
        const firefoxPhotoLibrary = await waitForScript(
            driver,
            `const status = document.getElementById("photo-backup-status")?.textContent || "";
       if (/Checking/.test(status)) return null;
       return {
         heading: document.getElementById("library-heading")?.textContent,
         boundary: document.querySelector(".backup-card")?.textContent,
         status,
         credentialHidden: document.getElementById("credential-card")?.hidden,
         horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
       };`,
            'the Firefox photo-library recovery surface',
            5_000,
            value => !!value,
        );
        assertState(
            firefoxPhotoLibrary.heading === 'Photo library'
        && /photo-library\.json/.test(firefoxPhotoLibrary.boundary || '')
        && /Original images, API keys, and remote deletion links stay on this device/.test(
            firefoxPhotoLibrary.boundary || '',
        )
        && firefoxPhotoLibrary.credentialHidden === true
        && !firefoxPhotoLibrary.horizontalOverflow,
            'Firefox did not render the photo library or metadata-only recovery boundary',
            firefoxPhotoLibrary,
        );
        await driver.findElement(By.id('show-editor')).click();
        await driver.executeAsyncScript(done => {
            const canvas = globalThis.document.createElement('canvas');
            canvas.width = 900;
            canvas.height = 600;
            const drawing = canvas.getContext('2d');
            drawing.fillStyle = '#8fc7e8';
            drawing.fillRect(0, 0, 900, 600);
            drawing.fillStyle = '#566b60';
            drawing.beginPath();
            drawing.moveTo(0, 600);
            drawing.lineTo(300, 220);
            drawing.lineTo(500, 430);
            drawing.lineTo(700, 150);
            drawing.lineTo(900, 600);
            drawing.closePath();
            drawing.fill();
            canvas.toBlob(blob => {
                const transfer = new globalThis.DataTransfer();
                transfer.items.add(new File([blob], 'firefox-verification-topo.png', { type: 'image/png' }));
                const input = globalThis.document.getElementById('photo-file');
                Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
                input.dispatchEvent(new Event('change', { bubbles: true }));
                done(true);
            }, 'image/png');
        });
        await driver.wait(until.elementIsVisible(driver.findElement(By.id('editor-workspace'))), 5_000);
        await driver.findElement(By.id('photo-alt')).sendKeys('Firefox verification mountain route');
        const firefoxPhotoEditor = await waitForScript(
            driver,
            `const saved = document.getElementById("save-status")?.textContent || "";
       if (!/Saved on this device/.test(saved)) return null;
       const viewport = document.getElementById("photo-viewport")?.getBoundingClientRect();
       return {
         saved,
         upload: document.getElementById("upload-insert")?.textContent,
         viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
         horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
       };`,
            'the Firefox photo editor autosave',
            5_000,
            value => !!value,
        );
        assertState(
            firefoxPhotoEditor.upload === 'Upload to ImgBB'
        && firefoxPhotoEditor.viewport?.width > 300
        && firefoxPhotoEditor.viewport?.height > 300
        && !firefoxPhotoEditor.horizontalOverflow,
            'Firefox did not decode and autosave the packaged photo editor',
            firefoxPhotoEditor,
        );

        // The drawing tools, in Gecko's own pointer and SVG implementation. Every
        // assertion here is a behaviour a user reported broken, so a regression
        // must not be able to reach Firefox unnoticed.
        const overlay = await driver.findElement(By.id('photo-overlay'));
        const clickOverlay = async (x, y) => {
            // Firefox's requested window height includes browser chrome on Linux, so
            // the content viewport can be shorter than it is on macOS. Re-center the
            // drawing surface before every pointer action rather than relying on a
            // preceding tool-button click to leave the requested offset in bounds.
            await driver.executeScript(
                "arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' });",
                overlay,
            );
            await driver.actions({ bridge: true })
                .move({ origin: overlay, x, y }).click().perform();
        };
        const clickEditorControl = async element => {
            await driver.executeScript(
                "arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' });",
                element,
            );
            await element.click();
        };

        await driver.findElement(By.css('[data-tool="route"]')).click();
        await clickOverlay(-140, 110);
        const firefoxRouteStart = await waitForScript(
            driver,
            `const dot = document.querySelector("#photo-overlay .route-preview-dot");
       return dot ? { cx: dot.getAttribute("cx"), cy: dot.getAttribute("cy") } : null;`,
            "the Firefox route's first point",
            5_000,
            value => !!value,
        );
        assertState(
            Number(firefoxRouteStart.cx) > 0 && Number(firefoxRouteStart.cy) > 0,
            "Firefox did not show the route's first point before the second click",
            firefoxRouteStart,
        );

        await clickOverlay(0, 0);
        await clickEditorControl(await driver.findElement(By.id('route-smooth')));
        await clickOverlay(140, -90);
        await clickEditorControl(await driver.findElement(By.id('finish-route')));

        // Symbols, placed back to back: the tool must stay armed, and opacity must
        // reach the painted group rather than only the inspector.
        await clickEditorControl(await driver.findElement(By.css('[data-tool="anchor"]')));
        await clickOverlay(-60, -60);
        await clickOverlay(60, 30);
        await driver.executeScript(`
      const slider = document.getElementById("object-opacity");
      slider.value = "40";
      slider.dispatchEvent(new Event("input", { bubbles: true }));`);

        const firefoxTopoState = await waitForScript(
            driver,
            `const armed = document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool;
       const route = document.querySelector('#photo-overlay g[data-bpb-object] path');
       const anchors = document.querySelectorAll("#photo-overlay g[data-bpb-object] circle");
       const dimmed = document.querySelector('#photo-overlay g[data-bpb-object][opacity]');
       if (!route || !dimmed) return null;
       return {
         armed,
         smoothStillChecked: document.getElementById("route-smooth").checked,
         curved: /C/.test(route.getAttribute("d") || ""),
         anchorShapes: anchors.length,
         opacity: dimmed.getAttribute("opacity"),
         symbolsPainted: document.querySelectorAll("[data-symbol] svg").length
       };`,
            'the Firefox topo tools',
            5_000,
            value => !!value,
        );
        assertState(
            firefoxTopoState.armed === 'anchor'
        && firefoxTopoState.smoothStillChecked === true
        && firefoxTopoState.curved === true
        && firefoxTopoState.opacity === '0.4'
        && firefoxTopoState.symbolsPainted === 5,
            'Firefox lost the armed tool, the smooth curve, an opacity, or the rail symbols',
            firefoxTopoState,
        );

        // The export boundary: Gecko rasterizes the marks this extension draws, and
        // the result stays readable rather than tainting the canvas. Only a browser
        // can answer this, and a silent failure here would surface as an upload
        // that never produces bytes.
        const firefoxExport = await driver.executeAsyncScript(done => {
            const source = globalThis.document.getElementById('photo-overlay').cloneNode(true);
            for (const node of source.querySelectorAll('.route-preview, .vertex-handle')) node.remove();
            const width = Number(source.getAttribute('width'));
            const height = Number(source.getAttribute('height'));
            const markup = new globalThis.XMLSerializer().serializeToString(source);
            const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
            const image = new globalThis.Image();
            image.onload = () => {
                URL.revokeObjectURL(url);
                const canvas = globalThis.document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0, width, height);
                let readable = false;
                try {
                    context.getImageData(0, 0, 1, 1);
                    readable = true;
                } catch { readable = false; }
                canvas.toBlob(blob => done({
                    readable,
                    bytes: blob ? blob.size : 0,
                    naturalWidth: image.naturalWidth
                }), 'image/jpeg', 0.92);
            };
            image.onerror = () => {
                URL.revokeObjectURL(url);
                done({ readable: false, bytes: 0, naturalWidth: 0 });
            };
            image.src = url;
        });
        assertState(
            firefoxExport.readable && firefoxExport.bytes > 0 && firefoxExport.naturalWidth > 0,
            'Firefox could not rasterize the topo overlay into an untainted canvas',
            firefoxExport,
        );

        // Project download and import, which is the only path back for an original
        // image after a profile is cleared.
        // Autosave is debounced, so poll the store the editor actually writes
        // rather than sampling it once and calling a slow tick a lost drawing.
        const readPhotoStore = () => driver.executeAsyncScript(done => {
            const open = () => new Promise(resolve => {
                const request = globalThis.indexedDB.open('betterPeakbaggerPhotos');
                request.onsuccess = () => resolve(request.result);
            });
            const all = (database, store) => new Promise(resolve => {
                const request = database.transaction(store).objectStore(store).getAll();
                request.onsuccess = () => resolve(request.result);
            });
            open().then(async database => {
                const [photos, projects, originals] = await Promise.all([
                    all(database, 'photos'), all(database, 'projects'), all(database, 'originals')
                ]);
                database.close();
                done({
                    localId: photos[0] ? photos[0].localId : null,
                    objects: projects[0] ? projects[0].objects.length : 0,
                    opacity: projects[0]
                        ? projects[0].objects.map(object => object.style.opacity).sort()[0]
                        : null,
                    originalBytes: originals[0] && originals[0].blob ? originals[0].blob.size : 0
                });
            });
        });
        let firefoxRoundTrip = null;
        try {
            await driver.wait(async () => {
                firefoxRoundTrip = await readPhotoStore();
                return firefoxRoundTrip.objects === 3 && firefoxRoundTrip.originalBytes > 0;
            }, 10_000);
        } catch (error) {
            assertState(false,
                `Firefox did not autosave the drawn project and its original (${error.message})`,
                firefoxRoundTrip);
        }
        assertState(
            firefoxRoundTrip.opacity === 0.4,
            'Firefox persisted the drawn marks without the opacity the user set',
            firefoxRoundTrip,
        );

        await driver.findElement(By.id('show-library')).click();
        // One script end to end: a Marionette sandbox is not guaranteed to carry a
        // global between calls, and splitting this made it look like a page bug.
        const firefoxImport = await driver.executeAsyncScript(done => {
            const open = () => new Promise(resolve => {
                const request = globalThis.indexedDB.open('betterPeakbaggerPhotos');
                request.onsuccess = () => resolve(request.result);
            });
            const one = (database, store, key) => new Promise(resolve => {
                const request = database.transaction(store).objectStore(store).get(key);
                request.onsuccess = () => resolve(request.result);
            });
            const allKeys = database => new Promise(resolve => {
                const request = database.transaction('photos').objectStore('photos').getAllKeys();
                request.onsuccess = () => resolve(request.result);
            });
            const encoder = new TextEncoder();
            const table = new Uint32Array(256);
            for (let index = 0; index < 256; index++) {
                let value = index;
                for (let bit = 0; bit < 8; bit++) {
                    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
                }
                table[index] = value >>> 0;
            }
            const crc32 = bytes => {
                let value = 0xffffffff;
                for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
                return (value ^ 0xffffffff) >>> 0;
            };
            // The same stored ZIP32 container photo-archive.js writes; the download
            // itself would need a file dialog this profile has no way to answer.
            const storedZip = files => {
                const locals = [];
                const centrals = [];
                let offset = 0;
                for (const [name, bytes] of files) {
                    const nameBytes = encoder.encode(name);
                    const crc = crc32(bytes);
                    const local = new DataView(new ArrayBuffer(30));
                    local.setUint32(0, 0x04034b50, true);
                    local.setUint16(4, 20, true);
                    local.setUint16(6, 0x0800, true);
                    local.setUint32(14, crc, true);
                    local.setUint32(18, bytes.length, true);
                    local.setUint32(22, bytes.length, true);
                    local.setUint16(26, nameBytes.length, true);
                    locals.push(new Uint8Array(local.buffer), nameBytes, bytes);
                    const central = new DataView(new ArrayBuffer(46));
                    central.setUint32(0, 0x02014b50, true);
                    central.setUint16(4, 20, true);
                    central.setUint16(6, 20, true);
                    central.setUint16(8, 0x0800, true);
                    central.setUint32(16, crc, true);
                    central.setUint32(20, bytes.length, true);
                    central.setUint32(24, bytes.length, true);
                    central.setUint16(28, nameBytes.length, true);
                    central.setUint32(42, offset, true);
                    centrals.push(new Uint8Array(central.buffer), nameBytes);
                    offset += 30 + nameBytes.length + bytes.length;
                }
                const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
                const end = new DataView(new ArrayBuffer(22));
                end.setUint32(0, 0x06054b50, true);
                end.setUint16(8, files.length, true);
                end.setUint16(10, files.length, true);
                end.setUint32(12, centralSize, true);
                end.setUint32(16, offset, true);
                return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)],
                    { type: 'application/zip' });
            };

            open().then(async database => {
                const [localId] = await allKeys(database);
                const [photo, project, original] = await Promise.all([
                    one(database, 'photos', localId),
                    one(database, 'projects', localId),
                    one(database, 'originals', localId)
                ]);
                database.close();
                const buffer = await original.blob.arrayBuffer();
                const archive = storedZip([
                    ['project.json', encoder.encode(JSON.stringify(project, null, 2) + '\n')],
                    ['photo.json', encoder.encode(JSON.stringify(photo, null, 2) + '\n')],
                    ['original.png', new Uint8Array(buffer)]
                ]);
                // Wipe the local copies first, so the import has to reconstruct them:
                // that is the new-device case, not the duplicate case.
                const wipe = await open();
                await Promise.all(['photos', 'projects', 'originals', 'thumbnails'].map(store =>
                    new Promise(resolve => {
                        const request = wipe.transaction(store, 'readwrite').objectStore(store).clear();
                        request.onsuccess = () => resolve();
                    })));
                wipe.close();
                const transfer = new globalThis.DataTransfer();
                transfer.items.add(new File([archive], 'topo.bpb-photo', { type: 'application/zip' }));
                const input = globalThis.document.getElementById('import-project');
                Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
                input.dispatchEvent(new Event('change', { bubbles: true }));
                done({ localId, archiveBytes: archive.size });
            });
        });
        assertState(
            firefoxImport.archiveBytes > 0,
            'Firefox could not stage a project bundle',
            firefoxImport,
        );
        const firefoxImported = await waitForScript(
            driver,
            `const toast = document.getElementById("toast-message")?.textContent || "";
       if (!/Imported/.test(toast)) return null;
       return { toast, cards: document.querySelectorAll("#library-list .photo-card").length };`,
            'the Firefox project import',
            10_000,
            value => !!value,
        );
        assertState(
            firefoxImported.cards === 1 && !/new local draft/.test(firefoxImported.toast),
            'Firefox did not reunite an imported bundle with its own record',
            firefoxImported,
        );

        await driver.executeAsyncScript(done => {
            const open = () => new Promise((resolve, reject) => {
                const request = globalThis.indexedDB.open('betterPeakbaggerPhotos');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            open().then(database => {
                const read = database.transaction(['photos', 'thumbnails']);
                const photoRequest = read.objectStore('photos').getAll();
                const thumbnailRequest = read.objectStore('thumbnails').getAll();
                read.oncomplete = () => {
                    const photo = photoRequest.result[0];
                    const thumbnail = thumbnailRequest.result[0];
                    const write = database.transaction(['photos', 'thumbnails'], 'readwrite');
                    for (let index = 1; index <= 48; index += 1) {
                        const localId = `firefox-library-page-${String(index).padStart(2, '0')}`;
                        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
                        write.objectStore('photos').put({
                            ...structuredClone(photo),
                            localId,
                            title: `Firefox library page ${String(index).padStart(2, '0')}`,
                            createdAt: timestamp,
                            updatedAt: timestamp,
                            assets: {
                                originalRetained: false,
                                projectRetained: false,
                                thumbnailRetained: true,
                            },
                        });
                        write.objectStore('thumbnails').put({ localId, blob: thumbnail.blob });
                    }
                    write.oncomplete = () => {
                        database.close();
                        done({ ok: true });
                    };
                    write.onerror = () => done({ ok: false, error: String(write.error) });
                    write.onabort = () => done({ ok: false, error: String(write.error) });
                };
                read.onerror = () => done({ ok: false, error: String(read.error) });
                read.onabort = () => done({ ok: false, error: String(read.error) });
            }, error => done({ ok: false, error: String(error) }));
        });
        await driver.get(photoUrl);
        const firefoxPagedLibrary = await waitForScript(
            driver,
            `const cards = document.querySelectorAll("#library-list .photo-card");
       const pagination = document.getElementById("library-pagination");
       if (cards.length !== 48 || pagination?.hidden) return null;
       const bounds = pagination.getBoundingClientRect();
       return {
         cards: cards.length,
         pageStatus: document.getElementById("library-page-status")?.textContent,
         previousDisabled: document.getElementById("library-previous")?.disabled,
         nextDisabled: document.getElementById("library-next")?.disabled,
         paginationLeft: bounds.left,
         paginationRight: bounds.right,
         viewportWidth: document.documentElement.clientWidth,
         horizontalOverflow:
           document.documentElement.scrollWidth > document.documentElement.clientWidth
       };`,
            'the Firefox paged photo library',
            5_000,
            value => !!value,
        );
        assertState(
            firefoxPagedLibrary.cards === 48
        && firefoxPagedLibrary.pageStatus === 'Page 1 of 2 · 49 photos'
        && firefoxPagedLibrary.previousDisabled === true
        && firefoxPagedLibrary.nextDisabled === false
        && firefoxPagedLibrary.paginationLeft >= 0
        && firefoxPagedLibrary.paginationRight <= firefoxPagedLibrary.viewportWidth
        && !firefoxPagedLibrary.horizontalOverflow,
            'Firefox did not render the first bounded photo-library page',
            firefoxPagedLibrary,
        );
        if (process.env.BPB_VERIFY_FIREFOX_PHOTO_LIBRARY_SCREENSHOT) {
            const screenshot = await driver.findElement(By.id('library-pagination')).takeScreenshot(true);
            await writeFile(process.env.BPB_VERIFY_FIREFOX_PHOTO_LIBRARY_SCREENSHOT, screenshot, 'base64');
        }

        const originalFirefoxRect = await driver.manage().window().getRect();
        await driver.manage().window().setRect({ width: 520, height: 800 });
        const firefoxNarrowLibrary = await driver.executeScript(`
      const pagination = document.getElementById("library-pagination");
      const bounds = pagination.getBoundingClientRect();
      return {
        cards: document.querySelectorAll("#library-list .photo-card").length,
        pageStatus: document.getElementById("library-page-status")?.textContent,
        paginationLeft: bounds.left,
        paginationRight: bounds.right,
        viewportWidth: document.documentElement.clientWidth,
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth
      };`);
        assertState(
            firefoxNarrowLibrary.cards === 48
        && firefoxNarrowLibrary.pageStatus === 'Page 1 of 2 · 49 photos'
        && firefoxNarrowLibrary.paginationLeft >= 0
        && firefoxNarrowLibrary.paginationRight <= firefoxNarrowLibrary.viewportWidth
        && !firefoxNarrowLibrary.horizontalOverflow,
            'Firefox narrow photo-library pagination overflowed',
            firefoxNarrowLibrary,
        );
        if (process.env.BPB_VERIFY_FIREFOX_PHOTO_LIBRARY_NARROW_SCREENSHOT) {
            const screenshot = await driver.findElement(By.id('library-pagination')).takeScreenshot(true);
            await writeFile(
                process.env.BPB_VERIFY_FIREFOX_PHOTO_LIBRARY_NARROW_SCREENSHOT,
                screenshot,
                'base64',
            );
        }
        await driver.findElement(By.id('library-next')).click();
        const firefoxSecondPage = await waitForScript(
            driver,
            `const status = document.getElementById("library-page-status")?.textContent || "";
       if (status !== "Page 2 of 2 · 49 photos") return null;
       return {
         cards: document.querySelectorAll("#library-list .photo-card").length,
         previousDisabled: document.getElementById("library-previous")?.disabled,
         nextDisabled: document.getElementById("library-next")?.disabled
       };`,
            'the Firefox final photo-library page',
            5_000,
            value => !!value,
        );
        assertState(
            firefoxSecondPage.cards === 1
        && firefoxSecondPage.previousDisabled === false
        && firefoxSecondPage.nextDisabled === true,
            'Firefox did not navigate to the final photo-library page',
            firefoxSecondPage,
        );
        await driver.manage().window().setRect(originalFirefoxRect);

        // The guide, which is a packaged page of its own and paints its legend from
        // the renderer rather than from authored artwork.
        await driver.get(new URL('photos/guide.html', baseUrl).href);
        const firefoxGuide = await waitForScript(
            driver,
            `const painted = document.querySelectorAll(".guide-legend [data-symbol] svg").length;
       if (!painted) return null;
       return {
         painted,
         title: document.title,
         horizontalOverflow:
           document.documentElement.scrollWidth > document.documentElement.clientWidth
       };`,
            'the Firefox photo guide',
            5_000,
            value => !!value,
        );
        assertState(
            firefoxGuide.painted === 5 && !firefoxGuide.horizontalOverflow,
            'Firefox did not render the photo guide and its renderer-painted legend',
            firefoxGuide,
        );

        await driver.get(optionsUrl);

        await driver.executeAsyncScript((theme, done) => {
            const api = globalThis.browser || globalThis.chrome;
            const entries = Array.from({ length: 1500 }, (_, index) => ({
                cid: 100000 + index,
                name: index === 1498
                    ? 'Navigation Alpine Climber 1499'
                    : `Navigation Scale Climber ${String(index + 1).padStart(4, '0')}`,
                addedAt: index,
                source: index % 2 ? 'buddy' : 'manual',
            }));
            api.storage.sync.get('bpbSettings').then(({ bpbSettings = {} }) => Promise.all([
                api.storage.sync.set({
                    bpbSettings: {
                        ...bpbSettings,
                        theme,
                        enable3dMap: true,
                        addReportCredit: true,
                        enableGithubBackup: true,
                        favoritesSource: 'custom',
                    },
                }),
                api.storage.local.set({
                    bpbGithubAuth: {
                        token: 'browser-verification-only',
                        repo: { owner: 'fixture', name: 'backup', branch: 'main', fullName: 'fixture/backup' },
                    },
                    bpbFavoriteClimbers: { schemaVersion: 1, entries },
                }),
            ])).then(() => done(true), error => done(String(error)));
        }, firefoxSunTheme);
        await driver.navigate().refresh();
        await waitForScript(
            driver,
            "return document.getElementById('theme')?.value === 'dark' && document.documentElement.dataset.bpbTheme === 'dark';",
            'the persisted Firefox option',
        );
        // The custom-list workspace is its own page; drive it there for the list
        // checks, then return to Settings for the sidebar and backup checks.
        await driver.get(favoritesUrl);
        await waitForScript(
            driver,
            "return document.querySelectorAll('.favorite-item').length === 1500;",
            'the full Firefox favorite-climber scale list',
        );
        const fullFavoriteCount = await driver.findElement(By.id('favorites-count')).getText();
        await driver.findElement(By.id('favorites-search')).sendKeys('alpin clmber 1499');
        const fuzzyFavoriteSearch = await waitForScript(driver, `
      const rows = [...document.querySelectorAll(".favorite-item")];
      const count = document.getElementById("favorites-count")?.textContent || "";
      return rows.length === 1 && count === "1 of 1,500 favorites" ? {
        name: rows[0].querySelector(".favorite-name")?.textContent || "",
        count,
      } : false;
    `, 'the Firefox favorite-climber fuzzy search');
        assertState(
            fullFavoriteCount === '1,500 favorites'
        && fuzzyFavoriteSearch.name === 'Navigation Alpine Climber 1499',
            'Firefox did not report or fuzzy-filter the full favorite-climber list',
            { fullFavoriteCount, fuzzyFavoriteSearch },
        );
        await driver.executeScript(`
      const search = document.getElementById("favorites-search");
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    `);
        await waitForScript(
            driver,
            "return document.querySelectorAll('.favorite-item').length === 1500;",
            'the restored Firefox favorite-climber scale list',
        );

        const signedInBuddyUrl = 'https://www.peakbagger.com/report/report.aspx?r=b';
        await evaluatePageRealm(driver, `(() => {
      const url = ${JSON.stringify(signedInBuddyUrl)};
      const html = ${JSON.stringify(buddyListFixture)};
      const api = globalThis.browser || globalThis.chrome;
      const dialog = document.getElementById("favorites-mirror-confirmation");
      globalThis.__bpbNativeFetch = globalThis.fetch;
      dialog.dataset.verifyBuddyRequests = "0";
      globalThis.fetch = async (input, init) => {
        if (String(input) !== url) return globalThis.__bpbNativeFetch(input, init);
        dialog.dataset.verifyBuddyRequests = String(
          Number(dialog.dataset.verifyBuddyRequests) + 1,
        );
        return { status: 200, headers: {}, text: async () => html };
      };
      globalThis.__bpbNativeRuntimeSendMessage = api.runtime.sendMessage.bind(api.runtime);
      globalThis.__bpbHeldReplacement = null;
      dialog.dataset.verifyHeld = "false";
      dialog.dataset.verifyDismissals = "0";
      let wasHidden = dialog.hidden;
      globalThis.__bpbReplacementObserver = new MutationObserver(() => {
        if (dialog.hidden && !wasHidden) {
          dialog.dataset.verifyDismissals = String(
            Number(dialog.dataset.verifyDismissals) + 1,
          );
        }
        wasHidden = dialog.hidden;
      });
      globalThis.__bpbReplacementObserver.observe(dialog, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
      api.runtime.sendMessage = message => {
        if (message?.type !== "FAVORITES_MUTATE" || message.mutation?.kind !== "replace") {
          return globalThis.__bpbNativeRuntimeSendMessage(message);
        }
        return new Promise(resolve => {
          dialog.dataset.verifyHeld = "true";
          globalThis.__bpbHeldReplacement = resolve;
        });
      };
    })()`);
        await driver.findElement(By.id('favorites-mirror-buddies')).click();
        const mirrorPreview = await waitForScript(driver, `
      const dialog = document.getElementById("favorites-mirror-confirmation");
      const status = document.getElementById("favorites-import-status")?.textContent || "";
      return !dialog.hidden
        ? { visible: true, requests: Number(dialog.dataset.verifyBuddyRequests) }
        : status && !/Loading your Buddy List/.test(status)
          ? { visible: false, status, requests: Number(dialog.dataset.verifyBuddyRequests) }
          : false;
    `, 'the Firefox Buddy replacement preview');
        assertState(
            mirrorPreview.visible && mirrorPreview.requests === 1,
            'Firefox did not load one Buddy report into the replacement confirmation',
            mirrorPreview,
        );
        const reviewedReplacement = await driver.executeScript(
            "return document.getElementById('favorites-mirror-confirmation-detail').textContent;",
        );
        await driver.findElement(By.id('favorites-mirror-confirm')).click();
        const replacementBusy = await waitForScript(driver, `
      const dialog = document.getElementById("favorites-mirror-confirmation");
      const confirm = document.getElementById("favorites-mirror-confirm");
      const cancel = document.getElementById("favorites-mirror-cancel");
      return dialog?.getAttribute("aria-busy") === "true"
        && document.activeElement === dialog
        && confirm?.disabled
        && cancel?.disabled
        && dialog.dataset.verifyHeld === "true"
        ? {
            focused: document.activeElement.id,
            busy: dialog.getAttribute("aria-busy"),
            confirmDisabled: confirm.disabled,
            cancelDisabled: cancel.disabled,
          }
        : false;
    `, 'the Firefox Buddy replacement busy state');
        assertState(
            replacementBusy.focused === 'favorites-mirror-confirmation'
        && replacementBusy.busy === 'true'
        && replacementBusy.confirmDisabled
        && replacementBusy.cancelDisabled,
            'Firefox did not keep deliberate focus inside the busy replacement dialog',
            replacementBusy,
        );
        const busyStayedOpen = await driver.executeScript(`
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.getElementById("favorites-mirror-cancel")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const dialog = document.getElementById("favorites-mirror-confirmation");
      return !dialog.hidden && dialog.getAttribute("aria-busy") === "true";
    `);
        assertState(busyStayedOpen, 'Firefox dismissed an in-progress Buddy replacement');
        await evaluatePageRealm(driver, `
      globalThis.__bpbHeldReplacement({
        ok: false,
        error: { code: "unavailable", message: "browser verification failure" },
      });
      globalThis.__bpbHeldReplacement = null;
      document.getElementById("favorites-mirror-confirmation").dataset.verifyHeld = "false";
    `);
        const retryableReplacement = await waitForScript(driver, `
      const dialog = document.getElementById("favorites-mirror-confirmation");
      const confirm = document.getElementById("favorites-mirror-confirm");
      const cancel = document.getElementById("favorites-mirror-cancel");
      return dialog.dataset.verifyHeld === "false" && !dialog.hasAttribute("aria-busy")
        ? {
            hidden: dialog.hidden,
            focused: document.activeElement?.id || "",
            confirmDisabled: confirm.disabled,
            cancelDisabled: cancel.disabled,
            impactMatches:
              document.getElementById("favorites-mirror-confirmation-detail")?.textContent
                === ${JSON.stringify(reviewedReplacement)},
            dismissals: Number(dialog.dataset.verifyDismissals),
          }
        : false;
    `, 'the retryable Firefox Buddy replacement');
        assertState(
            !retryableReplacement.hidden
        && retryableReplacement.focused === 'favorites-mirror-confirm'
        && !retryableReplacement.confirmDisabled
        && !retryableReplacement.cancelDisabled
        && retryableReplacement.impactMatches
        && retryableReplacement.dismissals === 0,
            'Firefox did not retain the reviewed Buddy replacement after failure',
            retryableReplacement,
        );
        await evaluatePageRealm(driver, `
      const api = globalThis.browser || globalThis.chrome;
      api.runtime.sendMessage = globalThis.__bpbNativeRuntimeSendMessage;
    `);
        const buddyRequestsBeforeRetry = await driver.executeScript(
            "return Number(document.getElementById('favorites-mirror-confirmation').dataset.verifyBuddyRequests);",
        );
        await driver.findElement(By.id('favorites-mirror-confirm')).click();
        const mirrorApplied = await waitForScript(driver, `
      const api = globalThis.browser || globalThis.chrome;
      return api.storage.local.get("bpbFavoriteClimbers").then(({ bpbFavoriteClimbers }) => {
        const status = document.getElementById("favorites-import-status")?.textContent || "";
        return bpbFavoriteClimbers?.entries?.length === 6
          && document.getElementById("favorites-mirror-confirmation")?.hidden
          && /Mirror complete: 6 added, 1500 removed/.test(status)
          ? {
              dismissals: Number(
                document.getElementById("favorites-mirror-confirmation").dataset.verifyDismissals
              ),
              buddyRequests: Number(
                document.getElementById("favorites-mirror-confirmation").dataset.verifyBuddyRequests
              ),
            }
          : false;
      });
    `, 'the retried Firefox Buddy replacement');
        assertState(
            mirrorApplied.dismissals === 1
        && mirrorApplied.buddyRequests === buddyRequestsBeforeRetry,
            'Firefox reloaded or repeatedly dismissed the retried Buddy replacement',
            { buddyRequestsBeforeRetry, mirrorApplied },
        );
        await evaluatePageRealm(driver, `
      globalThis.__bpbReplacementObserver.disconnect();
      globalThis.fetch = globalThis.__bpbNativeFetch;
    `);

        // Back to Settings for the sidebar scroll-spy. The workspace list moved off
        // this page, but the page stays tall enough (map, backup, about) to exercise
        // an instant long-distance jump to the drafts anchor.
        await driver.get(optionsUrl);
        await waitForScript(
            driver,
            "return !!document.querySelector('.side-nav a[href=\"#drafts\"]') && !!document.getElementById('drafts');",
            'the Firefox settings sidebar and drafts anchor',
        );

        const longDistanceBefore = await driver.executeScript(`
      const content = document.querySelector(".content");
      const target = document.getElementById("drafts");
      const previousBehavior = content.style.scrollBehavior;
      content.style.scrollBehavior = "auto";
      content.scrollTop = 0;
      void content.scrollTop;
      if (previousBehavior) content.style.scrollBehavior = previousBehavior;
      else content.style.removeProperty("scroll-behavior");

      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      const distance = () => target.getBoundingClientRect().top
        - content.getBoundingClientRect().top - margin;
      return {
        distance: distance(),
        viewportHeight: content.clientHeight,
      };
    `);
        await driver.findElement(By.css('.side-nav a[href="#drafts"]')).click();
        const longDistanceAfter = await waitForScript(driver, `
      const content = document.querySelector(".content");
      const target = document.getElementById("drafts");
      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      const state = {
        distance: target.getBoundingClientRect().top
          - content.getBoundingClientRect().top - margin,
        scrollTop: content.scrollTop,
        hash: location.hash,
      };
      return {
        ...state,
        ready: Math.abs(state.distance) <= 2
          && state.scrollTop > 0
          && state.hash === "#drafts",
      };
    `, 'the instant Firefox long-distance settings navigation', 15_000,
        state => state?.ready);
        const longDistanceNavigation = {
            before: longDistanceBefore.distance,
            after: longDistanceAfter.distance,
            viewportHeight: longDistanceBefore.viewportHeight,
            scrollTop: longDistanceAfter.scrollTop,
            hash: longDistanceAfter.hash,
        };
        assertState(
            longDistanceNavigation.before > Math.min(longDistanceNavigation.viewportHeight * 2, 1200)
        && Math.abs(longDistanceNavigation.after) <= 2
        && longDistanceNavigation.scrollTop > 0
        && longDistanceNavigation.hash === '#drafts',
            'the Firefox settings sidebar did not make long-distance navigation instant',
            longDistanceNavigation,
        );

        await driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            api.storage.sync.get('bpbSettings').then(({ bpbSettings = {} }) => Promise.all([
                api.storage.sync.set({
                    bpbSettings: {
                        ...bpbSettings,
                        favoritesSource: 'custom',
                        removeFavoriteWhenBuddyRemoved: false,
                    },
                }),
                api.storage.local.set({
                    bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
                }),
            ])).then(() => done(true), error => done(String(error)));
        });
        const buddyMutationBaseline = { ...fixture.requests };
        const otherClimberUrl = `https://${fixtureHost}:${fixture.port}/climber/climber.aspx?cid=900002`;
        await driver.get(otherClimberUrl);
        await driver.wait(until.elementLocated(By.id('BuddyButton')), 10_000);
        await driver.wait(until.elementLocated(By.id('bpb-climber-favorite')), 10_000);
        await driver.findElement(By.id('BuddyButton')).click();
        const buddyAdded = await waitForScript(driver, `
      const nativeButton = document.getElementById("BuddyButton");
      const favorite = document.getElementById("bpb-climber-favorite");
      return /^Remove\\b/.test(nativeButton?.value || "") && favorite?.textContent === "★" ? {
        native: nativeButton.value,
        favorite: favorite.textContent,
      } : false;
    `, 'the confirmed Firefox Buddy addition');
        await driver.findElement(By.id('BuddyButton')).click();
        const removalPreserved = await waitForScript(driver, `
      const nativeButton = document.getElementById("BuddyButton");
      const favorite = document.getElementById("bpb-climber-favorite");
      return /^Add\\b/.test(nativeButton?.value || "") && favorite?.textContent === "★";
    `, 'the default Firefox Buddy removal policy');
        assertState(
            buddyAdded.favorite === '★' && removalPreserved,
            'Firefox did not add a confirmed Buddy or preserve the favorite on default removal',
            { buddyAdded, removalPreserved },
        );

        // The "Keep Buddy removals in sync" toggle lives on the favorites page.
        await driver.get(favoritesUrl);
        const removeWithBuddy = await driver.findElement(By.id('favorites-remove-with-buddy'));
        assertState(!(await removeWithBuddy.isSelected()),
            'Firefox rendered destructive Buddy removal sync on by default');
        await removeWithBuddy.click();
        const removalPreferenceSaved = await driver.wait(() => driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            api.storage.sync.get('bpbSettings')
                .then(({ bpbSettings }) => done(bpbSettings?.removeFavoriteWhenBuddyRemoved === true));
        }), 5_000);
        assertState(removalPreferenceSaved, 'Firefox did not persist the Buddy removal preference');
        await driver.get(otherClimberUrl);
        await driver.wait(until.elementLocated(By.id('BuddyButton')), 10_000);
        await driver.findElement(By.id('BuddyButton')).click();
        await waitForScript(driver, `
      return /^Remove\\b/.test(document.getElementById("BuddyButton")?.value || "")
        && document.getElementById("bpb-climber-favorite")?.textContent === "★";
    `, 'the second confirmed Firefox Buddy addition');
        await driver.findElement(By.id('BuddyButton')).click();
        const removalSynced = await waitForScript(driver, `
      return /^Add\\b/.test(document.getElementById("BuddyButton")?.value || "")
        && document.getElementById("bpb-climber-favorite")?.textContent === "☆";
    `, 'the opted-in Firefox Buddy removal policy');
        assertState(
            removalSynced
        && fixture.requests.buddyMutations - buddyMutationBaseline.buddyMutations === 4
        && fixture.requests.buddyReports - buddyMutationBaseline.buddyReports === 4,
            'Firefox Buddy mutation sync did not issue one confirmed refresh per native action',
            { before: buddyMutationBaseline, after: fixture.requests, removalSynced },
        );

        await driver.get(optionsUrl);
        await driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            api.storage.sync.get('bpbSettings').then(({ bpbSettings = {} }) => Promise.all([
                api.storage.sync.set({
                    bpbSettings: {
                        ...bpbSettings,
                        favoritesSource: 'buddies',
                        removeFavoriteWhenBuddyRemoved: false,
                    },
                }),
                api.storage.local.set({
                    bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
                }),
            ])).then(() => done(true), error => done(String(error)));
        });

        await driver.get(
            `https://${fixtureHost}:${fixture.port}/climber/ascent.aspx?aid=1`,
        );
        const surfaceState = await waitForScript(driver, `
      const state = {
        origin: location.origin,
        theme: document.documentElement.getAttribute("data-bpb-theme"),
        analyzer: Boolean(document.getElementById("bpb-gpx-analysis")),
        stats: document.querySelector("#bpb-gpx-analysis div")?.textContent || "",
        sun: (() => {
          const panel = document.getElementById("bpb-gpx-analysis");
          const coordinates = panel?.querySelector(".bpb-gpx-coordinate-controls");
          const calculator = panel?.querySelector(".bpb-sun-calculator");
          const legend = panel?.querySelector("#bpb-gpx-chart-legend");
          return {
            exists: Boolean(calculator),
            noDateInput: !calculator?.querySelector('input[type="date"]'),
            collapsed: calculator?.querySelector(".bpb-sun-calculator__panel")?.hidden === true,
            summary: calculator?.querySelector(".bpb-sun-calculator__summary")?.textContent || "",
            disabled: calculator?.querySelector(".bpb-sun-calculator__toggle")?.disabled === true,
            placed: coordinates?.nextElementSibling === calculator && calculator?.nextElementSibling === legend,
            borderStyle: calculator ? getComputedStyle(calculator).borderStyle : null,
          };
        })(),
        chart: (() => {
          const canvas = document.querySelector("#bpb-gpx-analysis canvas");
          const chart = canvas ? globalThis.Chart?.getChart?.(canvas) : null;
          if (!chart) return null;
          return {
            labels: chart.data.datasets.map(dataset => dataset.label),
            pointCounts: chart.data.datasets.map(dataset => dataset.data.length),
            breakCounts: chart.data.datasets.map(dataset =>
              dataset.data.filter(point => point?._raw === null).length),
          };
        })(),
      };
      return {
        ...state,
        ready: state.analyzer
          && /Interactive Stats: 17\\.53 miles \\| 5735 ft gain \\| Time: 36h 20m/.test(state.stats)
          && /Adjusted GPX metrics \\(raw GPX \\+15824 ft gain\\)/.test(state.stats)
          && state.chart?.labels?.join("|") === "Elevation by Distance|Elevation by Time"
          && state.chart?.pointCounts?.join("|") === "971|971"
          && state.chart?.breakCounts?.join("|") === "0|0"
          && state.sun.exists && state.sun.noDateInput && state.sun.collapsed
          && !state.sun.disabled && state.sun.summary === "Select a chart point"
          && state.sun.placed && state.sun.borderStyle === "solid",
      };
    `, 'the Firefox MAIN-world analyzer stats', 15_000, state => state?.ready);
        if (surfaceState.theme === null) {
            throw new Error('Firefox isolated-world theme bundle did not initialize');
        }
        const analyzerCanvas = await driver.findElement(By.css('#bpb-gpx-analysis canvas'));
        await analyzerCanvas.sendKeys(Key.ARROW_RIGHT);
        const selectedSunState = await waitForScript(driver, `
      const calculator = document.querySelector(".bpb-sun-calculator");
      const summary = calculator?.querySelector(".bpb-sun-calculator__summary")?.textContent || "";
      const direction = calculator?.querySelector(".bpb-sun-calculator__direction")?.textContent || "";
      return calculator?.querySelector(".bpb-sun-calculator__toggle")?.disabled === false
        && /°/.test(summary) && /Direction\\s*\\d+°/.test(direction)
        ? { summary, direction } : false;
    `, 'the Firefox GPX Sun selection');
        assertState(/°/.test(selectedSunState.summary),
            'Firefox GPX Sun did not follow keyboard route selection', selectedSunState);
        const analyzerSunToggle = await driver.findElement(By.css('.bpb-sun-calculator__toggle'));
        if ((await analyzerSunToggle.getAttribute('aria-expanded')) !== 'true') await analyzerSunToggle.click();
        const analyzerSunSlider = await driver.findElement(By.css('.bpb-sun-calculator__time'));
        const analyzerSunBefore = await driver.executeScript(
            'const slider = arguments[0]; return { value: Number(slider.value), valueText: slider.getAttribute("aria-valuetext") || "" };',
            analyzerSunSlider,
        );
        await driver.executeScript('arguments[0].focus();', analyzerSunToggle);
        await driver.actions().sendKeys(Key.TAB, Key.ARROW_RIGHT).perform();
        const analyzerSunAccessibility = await waitForScript(driver, `
      const slider = document.querySelector('.bpb-sun-calculator__time');
      const style = slider ? getComputedStyle(slider) : null;
      const valueText = slider?.getAttribute('aria-valuetext') || '';
      return slider && Number(slider.value) === ${JSON.stringify(analyzerSunBefore.value + 1)}
        && valueText !== ${JSON.stringify(analyzerSunBefore.valueText)}
        && /\\d.*:\\d.*(?:[A-Z]{2,5}|UTC)/.test(valueText) ? {
        height: slider.getBoundingClientRect().height,
        valueText,
        focusVisible: slider.matches(':focus-visible'),
        outlineWidth: style?.outlineWidth,
        outlineStyle: style?.outlineStyle,
        horizon: slider.closest('.bpb-sun-calculator')?.dataset.horizon || '',
        belowClass: slider.closest('.bpb-sun-calculator')
          ?.querySelector('.bpb-sun-calculator__sun')
          ?.classList.contains('bpb-sun-calculator__sun--below-horizon') === true,
        summary: slider.closest('.bpb-sun-calculator')
          ?.querySelector('.bpb-sun-calculator__summary')?.textContent || '',
        chevronTransform: getComputedStyle(slider.closest('.bpb-sun-calculator')
          ?.querySelector('.bpb-sun-calculator__chevron')).transform,
      } : false;
    `, 'the Firefox GPX Sun slider semantics');
        assertState(
            analyzerSunAccessibility.height >= 44 && analyzerSunAccessibility.focusVisible
            && analyzerSunAccessibility.outlineWidth === '3px'
            && analyzerSunAccessibility.outlineStyle === 'solid'
            && /^(above|below)$/.test(analyzerSunAccessibility.horizon)
            && analyzerSunAccessibility.belowClass
                === /below horizon/.test(analyzerSunAccessibility.summary)
            && analyzerSunAccessibility.chevronTransform !== 'none',
            'Firefox GPX Sun slider lacks clock semantics, keyboard focus, or target geometry',
            analyzerSunAccessibility,
        );
        await writeElementScreenshot(
            driver,
            '#bpb-gpx-analysis',
            process.env.BPB_VERIFY_FIREFOX_ANALYZER_SCREENSHOT,
        );
        if (process.env.BPB_VERIFY_FIREFOX_ANALYZER_NARROW_SCREENSHOT) {
            const previousRect = await driver.manage().window().getRect();
            await driver.manage().window().setRect({ width: 480, height: 900 });
            await driver.wait(() => driver.executeScript('return innerWidth < 680;'), 5_000);
            await writeElementScreenshot(
                driver,
                '#bpb-gpx-analysis',
                process.env.BPB_VERIFY_FIREFOX_ANALYZER_NARROW_SCREENSHOT,
            );
            await driver.manage().window().setRect(previousRect);
        }

        const terrainToggle = await driver.findElement(By.css(surfaceSelectors.terrainToggle));
        await driver.executeScript((extensionRoot, selector) => {
            window.__bpbTerrainForgeryDrained = false;
            const receiveDrain = event => {
                if (event.source !== window || event.data?.__bpbTerrainProbe !== 'drained') return;
                window.removeEventListener('message', receiveDrain);
                window.__bpbTerrainForgeryDrained = true;
            };
            window.addEventListener('message', receiveDrain);
            document.querySelector(selector)?.click();
            for (const type of ['requestConsent', 'init', 'prefetch']) {
                window.postMessage({
                    __bpbTerrain: true,
                    dir: 'toCS',
                    type,
                    routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
                    center: [48.7, -121.8],
                    zoom: 13,
                    viewport: { width: 1000, height: 760 },
                }, location.origin);
            }
            window.postMessage({ __bpbTerrainProbe: 'drained' }, location.origin);
            const direct = document.createElement('iframe');
            direct.id = 'bpb-forged-terrain-frame';
            direct.src = new URL('terrain/terrain.html', extensionRoot).href;
            window.__bpbForgedTerrainReady = false;
            window.addEventListener('message', event => {
                if (event.source === direct.contentWindow && event.data?.__bpbTerrainFrame === true
                    && event.data?.type === 'ready') window.__bpbForgedTerrainReady = true;
            });
            direct.addEventListener('load', () => {
                direct.contentWindow.postMessage({
                    __bpbTerrainFrame: true,
                    dir: 'toFrame',
                    type: 'init',
                    activation: 'guessed',
                    routeSegments: [[[48.7, -121.8], [48.71, -121.81]]],
                    basemaps: [{ name: 'Forged', tiles: ['https://tiles.openfreemap.org/{z}/{x}/{y}.png'] }],
                }, new URL(extensionRoot).origin);
            }, { once: true });
            document.body.append(direct);
        }, baseUrl, surfaceSelectors.terrainToggle);
        const forgedFrame = await driver.findElement(By.id('bpb-forged-terrain-frame'));
        await driver.wait(async () => driver.executeScript(
            'return window.__bpbTerrainForgeryDrained === true && window.__bpbForgedTerrainReady === true;'), 5_000);
        await driver.executeScript(`
          const direct = document.getElementById('bpb-forged-terrain-frame');
          direct.contentWindow.postMessage({
            __bpbTerrainFrame: true,
            dir: 'toFrame',
            type: 'init',
            activation: 'guessed-after-ready',
            routeSegments: [[[48.7, -121.8], [48.71, -121.81]]]
          }, new URL(arguments[0]).origin);
        `, baseUrl);

        // Normalize the page coordinator after the scripted click. Depending
        // on when the rejected bridge reply arrives, it may already be idle or
        // still be in its cancelable loading state. Escape is inert when idle,
        // so one real keypress plus the visible idle postcondition avoids
        // turning an unconditional second click into an accidental close.
        await terrainToggle.sendKeys(Key.ESCAPE);
        await driver.wait(async () => driver.executeScript(selector => {
            const toggle = document.querySelector(selector);
            return toggle?.getAttribute('aria-busy') !== 'true'
                && toggle?.getAttribute('aria-pressed') === 'false'
                && document.querySelectorAll('#bpb-terrain-frame').length === 0;
        }, surfaceSelectors.terrainToggle), 5_000);
        await terrainToggle.click();
        const activeTerrainState = await waitForScript(driver, `
          const frames = document.querySelectorAll('#bpb-terrain-frame');
          const origin = frames[0]?.src || '';
          return {
            ready: frames.length === 1 && origin.startsWith('moz-extension://'),
            frames: frames.length,
            origin
          };`, 'Firefox ascent 3D extension frame', 10_000, state => state?.ready);
        const ascentFrameOrigin = activeTerrainState.origin;

        await driver.switchTo().frame(forgedFrame);
        const forgedFrameState = await driver.executeScript(`return {
          map: Boolean(document.getElementById("bpb-terrain-map")),
          providerRequests: performance.getEntriesByType("resource")
            .map(entry => entry.name)
            .filter(name => /mapterhorn|openfreemap|opentopomap|arcgisonline|trimbleoutdoors|caltopo/i.test(name))
        };`);
        await driver.switchTo().defaultContent();
        const forgedHostState = await driver.executeScript(`return {
          consent: Boolean(document.getElementById("bpb-terrain-consent")),
          bridgeFrames: document.querySelectorAll("#bpb-terrain-frame").length
        };`);
        assertState(
            !forgedFrameState.map
            && forgedFrameState.providerRequests.length === 0
            && !forgedHostState.consent,
            'Firefox host forgeries started terrain work',
            { forgedFrameState, forgedHostState },
        );
        await driver.executeScript("document.getElementById('bpb-forged-terrain-frame')?.remove();");
        assertState(
            ascentFrameOrigin.startsWith('moz-extension://'),
            'Firefox ascent 3D did not create an extension-owned frame',
            ascentFrameOrigin,
        );

        await driver.get(`https://${fixtureHost}:${fixture.port}/Peak.aspx?pid=2829`);
        await driver.wait(until.elementLocated(By.id('bpb-peak-links')), 10_000);
        await driver.wait(until.elementLocated(By.css(surfaceSelectors.terrainToggle)), 10_000);
        const peakState = await waitForScript(driver, `
      const button = document.querySelector(${JSON.stringify(surfaceSelectors.terrainToggle)});
      const mount = document.getElementById("bpb-map-viewport");
      const sun = document.querySelector(".bpb-sun-calculator");
      return button && mount && sun && !button.disabled ? {
        links: document.querySelectorAll("#bpb-peak-links a").length,
        theme: document.documentElement.getAttribute("data-bpb-theme"),
        framePreserved: document.getElementById("Gmap")?.parentElement === mount,
        sunAfterMap: mount.nextElementSibling === sun,
        sunDateInput: Boolean(sun.querySelector('input[type="date"]')),
        sunCollapsed: sun.querySelector(".bpb-sun-calculator__panel")?.hidden === true,
        sunSummary: sun.querySelector(".bpb-sun-calculator__summary")?.textContent || "",
        sunBorderStyle: getComputedStyle(sun).borderStyle,
      } : false;
    `, 'the Firefox Peak surface');
        assertState(
            peakState.links >= 4 && peakState.theme !== null && peakState.framePreserved
        && peakState.sunAfterMap && peakState.sunDateInput && peakState.sunCollapsed
        && /°/.test(peakState.sunSummary) && peakState.sunBorderStyle === 'solid',
            'Firefox Peak links, theme, 3D mount, or Sun calculator did not initialize',
            peakState,
        );
        const peakSunToggle = await driver.findElement(By.css('.bpb-sun-calculator__toggle'));
        if ((await peakSunToggle.getAttribute('aria-expanded')) !== 'true') await peakSunToggle.click();
        const peakSunTarget = await driver.executeScript(`
      const slider = document.querySelector('.bpb-sun-calculator__time');
      return slider ? {
        height: slider.getBoundingClientRect().height,
        valueText: slider.getAttribute('aria-valuetext') || '',
        horizon: slider.closest('.bpb-sun-calculator')?.dataset.horizon || '',
        belowClass: slider.closest('.bpb-sun-calculator')
          ?.querySelector('.bpb-sun-calculator__sun')
          ?.classList.contains('bpb-sun-calculator__sun--below-horizon') === true,
        summary: slider.closest('.bpb-sun-calculator')
          ?.querySelector('.bpb-sun-calculator__summary')?.textContent || '',
        chevronTransform: getComputedStyle(slider.closest('.bpb-sun-calculator')
          ?.querySelector('.bpb-sun-calculator__chevron')).transform,
      } : null;
    `);
        assertState(
            peakSunTarget?.height >= 44 && /\d.*:\d/.test(peakSunTarget?.valueText || '')
            && /^(above|below)$/.test(peakSunTarget?.horizon || '')
            && peakSunTarget?.belowClass === /below horizon/.test(peakSunTarget?.summary || '')
            && peakSunTarget?.chevronTransform !== 'none',
            'Firefox Peak Sun slider lacks clock semantics or target geometry',
            peakSunTarget,
        );
        await writeElementScreenshot(
            driver,
            '.bpb-sun-calculator',
            process.env.BPB_VERIFY_FIREFOX_PEAK_SCREENSHOT,
        );
        if (process.env.BPB_VERIFY_FIREFOX_PEAK_NARROW_SCREENSHOT) {
            const previousRect = await driver.manage().window().getRect();
            await driver.manage().window().setRect({ width: 480, height: 900 });
            await driver.wait(() => driver.executeScript('return innerWidth < 680;'), 5_000);
            await writeElementScreenshot(
                driver,
                '.bpb-sun-calculator',
                process.env.BPB_VERIFY_FIREFOX_PEAK_NARROW_SCREENSHOT,
            );
            await driver.manage().window().setRect(previousRect);
        }

        await driver.get(`https://${fixtureHost}:${fixture.port}/map/BigMap.aspx?t=A&d=2296`);
        const bigMapState = await waitForScript(driver, `
      const button = document.querySelector(${JSON.stringify(surfaceSelectors.terrainToggle)});
      return button && !button.disabled && document.getElementById("bpb-map-viewport") ? {
        theme: document.documentElement.getAttribute("data-bpb-theme"),
        frameReady: Boolean(document.getElementById("if")?.contentWindow?.mapsPlaceholder),
      } : false;
    `, 'the Firefox BigMap surface');
        assertState(
            bigMapState.theme !== null && bigMapState.frameReady,
            'Firefox BigMap bridge or native frame did not initialize',
            bigMapState,
        );

        await driver.get(
            `https://${fixtureHost}:${fixture.port}/map/BigMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300&cyn=0`,
        );
        const peakBigMapState = await waitForScript(driver, `
      const button = document.querySelector(${JSON.stringify(surfaceSelectors.terrainToggle)});
      const iframe = document.getElementById("if");
      return button && !button.disabled && document.getElementById("bpb-map-viewport") ? {
        title: button.title,
        markerReady: Boolean(iframe?.contentWindow?.mapsPlaceholder),
      } : false;
    `, 'the Firefox Full Screen peak map surface');
        assertState(
            peakBigMapState.title === 'View this peak on 3D terrain' && peakBigMapState.markerReady,
            'Firefox Full Screen peak map did not expose the 3D toggle',
            peakBigMapState,
        );

        await driver.get(
            `https://${fixtureHost}:${fixture.port}/climber/PeakAscents.aspx?pid=1039`,
        );
        const filterHandle = await driver.getWindowHandle();
        await driver.wait(until.elementLocated(By.id('pbaf-bar')), 10_000);
        const filterStateBefore = await driver.executeScript(`return {
      visible: [...document.querySelectorAll("table.gray tr")]
        .filter(row => row.cells.length > 1 && row.cells[0].tagName === "TD" && getComputedStyle(row).display !== "none").length,
      total: [...document.querySelectorAll("table.gray tr")]
        .filter(row => row.cells.length > 1 && row.cells[0].tagName === "TD").length,
      first: document.querySelector("table.gray tr td")?.textContent.trim(),
      controls: document.querySelectorAll(".pbaf-table-sort").length,
      resetHidden: document.querySelector(".pbaf-reset")?.hidden,
      labels: [...document.querySelectorAll(".pbaf-chip-label")].map(label => label.textContent),
      settingsControl: document.querySelector(".pbaf-settings-link")?.tagName,
    };`);
        const hasBeta = await driver.findElement(By.xpath(
            '//button[contains(@class,"pbaf-chip")][.//span[normalize-space()="Has beta"]]',
        ));
        await hasBeta.sendKeys(Key.chord(Key.ALT, Key.ARROW_LEFT));
        const filterKeyboardOrder = await driver.executeScript(
            'return [...document.querySelectorAll(".pbaf-chip-label")].map(label => label.textContent);',
        );
        await hasBeta.sendKeys(Key.ENTER);
        const climberSort = await driver.findElements(By.css('.pbaf-table-sort'));
        await climberSort[0].sendKeys(Key.ENTER);
        const filterStateAfter = await driver.executeScript(`return {
      visible: [...document.querySelectorAll("table.gray tr")]
        .filter(row => row.cells.length > 1 && row.cells[0].tagName === "TD" && getComputedStyle(row).display !== "none").length,
      first: document.querySelector("table.gray tr td")?.textContent.trim(),
    };`);
        const initialHandles = await driver.getAllWindowHandles();
        const settingsControl = await driver.findElement(By.css('.pbaf-settings-link'));
        // Firefox 152 can report the button's own count child as intercepting an
        // element click. Keyboard activation is the same trusted user route and
        // also proves this custom control remains operable without a pointer.
        await settingsControl.sendKeys(Key.ENTER);
        const openedHandles = await driver.wait(async () => {
            const handles = await driver.getAllWindowHandles();
            return handles.length === initialHandles.length + 1 ? handles : false;
        }, 10_000);
        const settingsHandle = openedHandles.find(handle => !initialHandles.includes(handle));
        await driver.switchTo().window(settingsHandle);
        await driver.wait(async () => (await driver.getCurrentUrl()).endsWith('/options/options.html#beta'), 10_000);
        const linkedSettingsState = await driver.executeScript(`return {
      href: location.href,
      heading: document.querySelector('#beta-settings-heading')?.textContent,
    };`);
        const readSettingsTopology = () => driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            Promise.all([api.tabs.query({}), api.windows.getAll(), api.tabs.getCurrent()])
                .then(([tabs, windows, current]) => {
                    const source = tabs.find(tab => /\/climber\/PeakAscents\.aspx/i.test(tab.url || ''));
                    done({
                        options: current
                            ? [{ id: current.id, windowId: current.windowId, active: current.active }]
                            : [],
                        source: source ? { id: source.id, windowId: source.windowId, active: source.active } : null,
                        windowCount: windows.length,
                    });
                }, error => done({ error: String(error) }));
        });
        const activateSettings = async activate => {
            await driver.switchTo().window(settingsHandle);
            await driver.executeScript('location.hash = "github";');
            await driver.wait(async () => (await driver.getCurrentUrl()).endsWith('#github'), 5_000);
            await driver.switchTo().window(filterHandle);
            const control = await driver.findElement(By.css('.pbaf-settings-link'));
            await activate(control);
            await driver.switchTo().window(settingsHandle);
            await driver.wait(async () => (await driver.getCurrentUrl()).endsWith('#beta'), 5_000);
            const topology = await readSettingsTopology();
            assertState(topology.options?.length === 1,
                'Firefox Settings activation duplicated the exact options tab', topology);
            return topology;
        };
        const settingsModifier = process.platform === 'darwin' ? Key.COMMAND : Key.CONTROL;
        const shortcutTopology = await activateSettings(control => driver.actions({ async: true })
            .keyDown(settingsModifier).click(control).keyUp(settingsModifier).perform());
        const middleTopology = await activateSettings(control => driver.actions({ async: true })
            .move({ origin: control }).press(Button.MIDDLE).release(Button.MIDDLE).perform());
        const keyboardTopology = await activateSettings(control => control.sendKeys(Key.ENTER));
        await driver.switchTo().window(settingsHandle);
        await driver.executeScript('location.hash = "github";');
        await driver.wait(async () => (await driver.getCurrentUrl()).endsWith('#github'), 5_000);
        const beforeNewWindow = await readSettingsTopology();
        await driver.switchTo().window(filterHandle);
        const shiftControl = await driver.findElement(By.css('.pbaf-settings-link'));
        await driver.executeScript(`
      window.__bpbSettingsShift = null;
      document.querySelector('.pbaf-settings-link').addEventListener('keydown', event => {
        window.__bpbSettingsShift = {
          type: event.type,
          isTrusted: event.isTrusted,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          button: event.button,
        };
      }, { once: true });
    `);
        await shiftControl.sendKeys(Key.chord(Key.SHIFT, Key.ENTER));
        const shiftEvent = await driver.executeScript(`return {
      event: window.__bpbSettingsShift,
      text: document.querySelector('.pbaf-settings-link')?.textContent,
    };`);
        await driver.switchTo().window(settingsHandle);
        await driver.wait(async () => (await driver.getCurrentUrl()).endsWith('#beta'), 5_000);
        let newWindowTopology;
        try {
            newWindowTopology = await driver.wait(async () => {
                const topology = await readSettingsTopology();
                return topology.options?.[0]?.windowId !== topology.source?.windowId
                    && topology.windowCount === beforeNewWindow.windowCount + 1
                    ? topology
                    : false;
            }, 5_000);
        } catch (error) {
            const topology = await readSettingsTopology();
            throw new Error(`Firefox Shift Settings activation did not create a window: ${JSON.stringify({
                shiftEvent,
                topology,
                beforeNewWindow,
                cause: error.message,
            })}`);
        }
        const reusedSettingsTab = [shortcutTopology, middleTopology, keyboardTopology, newWindowTopology]
            .every(state => state.options?.length === 1);
        const modifierStayedInWindow = [shortcutTopology, middleTopology]
            .every(state => state.options[0]?.windowId === state.source?.windowId);
        const shiftCreatedWindow = newWindowTopology.options[0]?.windowId !== newWindowTopology.source?.windowId
            && newWindowTopology.windowCount === beforeNewWindow.windowCount + 1;
        await driver.close();
        const [remainingFilterHandle] = await driver.getAllWindowHandles();
        await driver.switchTo().window(remainingFilterHandle);
        assertState(
            filterStateBefore.controls > 1
        && filterStateBefore.visible === filterStateBefore.total
        && filterStateBefore.resetHidden === true
        && JSON.stringify(filterStateBefore.labels) === JSON.stringify([
            'Climbing buddies', 'GPS track', 'Trip report', 'Link', 'Has beta',
        ])
        && JSON.stringify(filterKeyboardOrder) === JSON.stringify([
            'Climbing buddies', 'GPS track', 'Trip report', 'Has beta', 'Link',
        ])
        && filterStateBefore.settingsControl === 'BUTTON'
        && linkedSettingsState.href.endsWith('/options/options.html#beta')
        && linkedSettingsState.heading === 'Ascent beta filter'
        && reusedSettingsTab && modifierStayedInWindow && shiftCreatedWindow
        && filterStateAfter.visible < filterStateBefore.visible
        && filterStateAfter.first !== filterStateBefore.first,
            'Firefox ascent filter did not preserve first-use rows, filter, and sort by keyboard',
            {
                before: filterStateBefore,
                keyboardOrder: filterKeyboardOrder,
                after: filterStateAfter,
                linkedSettingsState,
                shortcutTopology,
                middleTopology,
                keyboardTopology,
                beforeNewWindow,
                newWindowTopology,
            },
        );

        await driver.get(
            `https://${fixtureHost}:${fixture.port}/report/report.aspx?r=b&cid=900001`,
        );
        await driver.wait(until.elementLocated(By.css('#RGridView .pbaf-table-sort')), 10_000);
        const buddyStateBefore = await driver.executeScript(`return {
      labels: [...document.querySelectorAll("#RGridView .pbaf-table-sort")]
        .map(control => control.firstChild.textContent.trim()),
      betaBar: Boolean(document.getElementById("pbaf-bar")),
      firstPeak: document.querySelector("#RGridView tr:nth-child(2) td:nth-child(4)")?.textContent.trim(),
    };`);
        const buddyControls = await driver.findElements(By.css('#RGridView .pbaf-table-sort'));
        await buddyControls[3].click();
        const buddyStateAfter = await driver.executeScript(`return {
      firstPeak: document.querySelector("#RGridView tr:nth-child(2) td:nth-child(4)")?.textContent.trim(),
      sort: document.querySelector("#RGridView th:nth-child(4)")?.getAttribute("aria-sort"),
    };`);
        assertState(
            buddyStateBefore.labels.length === 6
        && buddyStateBefore.betaBar === false
        && buddyStateAfter.sort === 'ascending'
        && buddyStateAfter.firstPeak !== buddyStateBefore.firstPeak,
            'Firefox Buddy List did not expose six sorter-only controls',
            { before: buddyStateBefore, after: buddyStateAfter },
        );

        const listUrl = `https://${fixtureHost}:${fixture.port}/list.aspx?lid=95005&sort=ascent&cid=900001&u=ft`;
        await driver.get(listUrl);
        await driver.wait(until.elementLocated(By.css('table.gray .pbaf-table-sort')), 10_000);
        const listStateBefore = await driver.executeScript(`const table = document.querySelector("table.gray");
    const rows = [...table.rows]
      .filter(row => row.cells.length === 8 && row.cells[0].tagName === "TD");
    return {
      labels: [...table.querySelectorAll(".pbaf-table-sort")]
        .map(control => control.firstChild.textContent.trim()),
      betaBar: Boolean(document.getElementById("pbaf-bar")),
      firstPeak: rows[0]?.cells[1].textContent.trim(),
      url: location.href,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };`);
        const listControls = await driver.findElements(By.css('table.gray .pbaf-table-sort'));
        await listControls[1].click();
        const listStateAfter = await driver.executeScript(`const table = document.querySelector("table.gray");
    const rows = [...table.rows]
      .filter(row => row.cells.length === 8 && row.cells[0].tagName === "TD");
    return {
      firstPeak: rows[0]?.cells[1].textContent.trim(),
      sort: table.rows[0].cells[1].getAttribute("aria-sort"),
      url: location.href,
    };`);
        assertState(
            listStateBefore.labels.length === 8
        && listStateBefore.betaBar === false
        && listStateBefore.horizontalOverflow === false
        && listStateAfter.sort === 'ascending'
        && listStateAfter.firstPeak !== listStateBefore.firstPeak
        && listStateAfter.url === listStateBefore.url,
            'Firefox Peak List did not expose eight in-place sort controls',
            { before: listStateBefore, after: listStateAfter },
        );

        await driver.get(
            `https://${fixtureHost}:${fixture.port}/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999`,
        );
        const readProfileBackupState = () => driver.executeScript(`
      const panel = document.querySelector(${JSON.stringify(surfaceSelectors.profileBackup)});
      return {
        copy: panel?.textContent || "",
        primary: panel?.querySelector(".bpb-profile-primary")?.textContent || "",
      };
    `);
        const profileBackupState = await driver.wait(async () => {
            const state = await readProfileBackupState();
            return state.primary === 'Back up all ascents' && /fixture\/backup/.test(state.copy)
                ? state
                : false;
        }, 10_000).catch(readProfileBackupState);
        assertState(
            profileBackupState.primary === 'Back up all ascents'
        && /fixture\/backup/.test(profileBackupState.copy),
            'Firefox full-profile backup surface did not mount for its verified owner',
            profileBackupState,
        );

        const editorUrl = `https://${fixtureHost}:${fixture.port}/climber/ascentedit.aspx?cid=900001`;
        await driver.get(editorUrl);
        await driver.wait(until.elementLocated(By.css(surfaceSelectors.editor)), 10_000);
        const editorHandle = await driver.getWindowHandle();
        const handlesBeforeDraftManager = new Set(await driver.getAllWindowHandles());
        const draftsManagerButton = await driver.findElement(By.css('.bpb-re-manage'));
        await driver.executeScript(
            "arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' });",
            draftsManagerButton,
        );
        await draftsManagerButton.click();
        const draftsManagerHandle = await driver.wait(async () => {
            const handles = await driver.getAllWindowHandles();
            return handles.find(handle => !handlesBeforeDraftManager.has(handle)) || false;
        }, 5_000);
        await driver.switchTo().window(draftsManagerHandle);
        const draftsManagerUrl = await driver.getCurrentUrl();
        // The manager is its own page, so this also proves the standalone page
        // boots in Firefox: its own bundle and the shared theme bootstrap.
        // Seeding from the manager's own page proves the standalone page renders a
        // draft and still picks up a write made while it is open. report-drafts only
        // accepts <cid>:new | a<aid> | p<pid>, so the key has to be a real one.
        const draftsManagerState = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.set({
        "bpbReportDraft:900001:a4242": {
          text: "Standalone drafts page verification",
          mode: "rich",
          savedAt: Date.now(),
          label: { peak: "Verification Peak", date: "7/30/2026" }
        }
      }).then(async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !document.querySelector(".drafts-list li")) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        done({
          heading: document.querySelector("h1")?.textContent,
          rows: document.querySelectorAll(".drafts-list li").length,
          title: document.querySelector(".drafts-list .draft-title")?.textContent,
          sidebar: !!document.querySelector(".side-nav")
        });
      });`);
        assertState(
            draftsManagerUrl === `${baseUrl}options/drafts.html`
        && draftsManagerState.heading === 'Trip report drafts'
        && draftsManagerState.rows === 1
        && /Verification Peak/.test(draftsManagerState.title || '')
        && draftsManagerState.sidebar === false,
            'Firefox report editor did not open a working standalone drafts manager',
            { draftsManagerUrl, draftsManagerState },
        );
        await driver.close();
        await driver.switchTo().window(editorHandle);
        await driver.navigate().refresh();
        await driver.wait(until.elementLocated(By.css(surfaceSelectors.editor)), 10_000);

        await driver.findElement(By.id('GPXUpload')).sendKeys(fixture.gpxPath);
        const uploadState = await waitForScript(driver, `
      const process = document.querySelector(".bpb-process-button");
      const date = document.getElementById("DateText")?.value || "";
      const now = new Date();
      const pad = value => String(value).padStart(2, "0");
      const today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
      return process ? {
        date,
        today,
        label: process.textContent,
        ariaLabel: process.getAttribute("aria-label"),
        nativePreviewHidden: document.getElementById("GPXPreview")
          ?.classList.contains("bpb-native-preview-hidden") || false,
      } : false;
    `, 'the Firefox GPX Process affordance');
        assertState(
            uploadState.date === uploadState.today
        && /Process/.test(uploadState.label || '')
        && uploadState.ariaLabel === 'Process the chosen GPX and fill this form'
        && uploadState.nativePreviewHidden,
            'Firefox did not autofill the ascent date and swap trusted GPX selection to Process',
            uploadState,
        );
        const creditState = await waitForScript(driver, `
      const link = document.querySelector("#bpb-report-editor a[href*='better-peakbagger']");
      const textarea = document.getElementById("JournalText");
      return link && textarea?.value.includes(link.href) ? {
        href: link.href,
        serialized: textarea.value,
        nativeForm: textarea.form?.id || null,
      } : false;
    `, 'the Firefox report credit');
        assertState(
            creditState.href === storeUrls.firefox && creditState.nativeForm,
            'Firefox report credit or native form ownership was wrong',
            creditState,
        );
        const editorSurface = await driver.findElement(By.css('.bpb-re-surface'));
        await editorSurface.click();
        const modifier = process.platform === 'darwin' ? Key.COMMAND : Key.CONTROL;
        await editorSurface.sendKeys('Cross-browser ');
        await driver.actions({ async: true })
            .keyDown(modifier).sendKeys('b').keyUp(modifier)
            .sendKeys('bold')
            .keyDown(modifier).sendKeys('b').keyUp(modifier)
            .sendKeys('.')
            .perform();
        const editorTypedState = await waitForScript(
            driver,
            "const value = document.getElementById('JournalText')?.value || ''; return value.includes('Cross-browser') ? { value } : false;",
            'Firefox editor serialization',
        );
        assertState(
            /Cross-browser \[b\]bold\[\/b\]\./.test(editorTypedState.value),
            'Firefox real bold input did not serialize synchronously',
            editorTypedState,
        );
        await waitForScript(
            driver,
            "return /Draft saved on this device/.test(document.querySelector('.bpb-re-status')?.textContent || '');",
            'the Firefox local report draft',
        );
        await driver.navigate().refresh();
        await driver.wait(until.elementLocated(By.css('.bpb-re-draft')), 10_000);

        await driver.get(new URL('popup/popup.html', baseUrl).href);
        const popupState = await waitForScript(driver, `
      const text = document.getElementById("state")?.textContent || "";
      return /Open an activity to begin/.test(text) ? text : false;
    `, 'the Firefox popup worker status');
        assertState(
            /Garmin Connect or Strava/.test(popupState),
            'Firefox popup did not query its real active tab and render the worker response',
            popupState,
        );

        const controlHandle = await driver.getWindowHandle();
        const sourceTabId = await driver.executeAsyncScript(done => {
            const api = globalThis.browser || globalThis.chrome;
            api.tabs.query({ active: true, currentWindow: true })
                .then(([tab]) => done(tab?.id ?? null), error => done({ error: String(error) }));
        });
        assertState(Number.isInteger(sourceTabId), 'Firefox draft source tab identity was unavailable', sourceTabId);
        const seededJob = createSyntheticCaptureJob(sourceTabId);
        const opened = await driver.executeAsyncScript((job, done) => {
            const api = globalThis.browser || globalThis.chrome;
            api.storage.session.set({
                bpbCaptureJobs: { [job.sourceTabId]: job },
                bpbDraftTabs: {},
            }).then(() => api.runtime.sendMessage({
                type: 'CAPTURE_OPEN_DRAFTS',
                tabId: job.sourceTabId,
                selectedIds: [2829],
            })).then(async reply => {
                const tab = reply?.tabIds?.length ? await api.tabs.get(reply.tabIds[0]) : null;
                done({ reply, tab });
            }).catch(error => done({ error: String(error) }));
        }, seededJob);
        const draftTabId = opened.reply?.tabIds?.[0];
        assertState(
            Number.isInteger(draftTabId),
            'Firefox worker did not create a draft tab',
            opened,
        );
        assertState(
            opened.reply?.groupWarning || Number(opened.tab?.groupId) >= 0,
            'Firefox draft tab was neither grouped nor reported honestly',
            opened,
        );

        const draftHandle = await driver.wait(async () => {
            const handles = await driver.getAllWindowHandles();
            return handles.find(handle => handle !== controlHandle) || false;
        }, 10_000);
        await driver.switchTo().window(draftHandle);
        const workerDraftUrl = await driver.wait(async () => {
            const current = await driver.getCurrentUrl();
            return /peakbagger\.com\/climber\/ascentedit\.aspx\?pid=2829&cid=900001/i.test(current)
                ? current
                : false;
        }, 10_000);
        assertState(
            /peakbagger\.com\/climber\/ascentedit\.aspx\?pid=2829&cid=900001/i.test(workerDraftUrl),
            'Firefox worker did not navigate the draft tab to its bound peak and climber',
            workerDraftUrl,
        );
        await driver.switchTo().window(controlHandle);

        const wrongDraftUrl = `https://${fixtureHost}:${fixture.port}/climber/ascentedit.aspx?pid=999&cid=900001`;
        await driver.executeAsyncScript((tabId, url, done) => {
            const api = globalThis.browser || globalThis.chrome;
            api.tabs.update(tabId, { url }).then(() => done(true), error => done({ error: String(error) }));
        }, draftTabId, wrongDraftUrl);
        await driver.switchTo().window(draftHandle);
        await driver.wait(async () => (await driver.getCurrentUrl()) === wrongDraftUrl, 10_000);
        const mismatch = await driver.wait(until.elementLocated(By.id('bpb-draft-banner')), 10_000).then(
            element => element.getText(),
        );
        assertState(
            /does not match its prepared ascent draft/.test(mismatch)
        && fixture.requests.previewPosts === 0,
            'Firefox worker accepted the wrong peak identity',
            { mismatch, requests: fixture.requests },
        );

        const correctDraftUrl = `https://${fixtureHost}:${fixture.port}/climber/ascentedit.aspx?pid=2829&cid=900001`;
        await driver.get(correctDraftUrl);
        try {
            await waitForCondition(() => fixture.requests.previewPosts === 1, {
                description: 'the Firefox draft GPS Preview POST',
                timeoutMs: 15_000,
            });
        } catch (error) {
            const pageState = await driver.executeScript(`return {
        url: location.href,
        banner: document.getElementById("bpb-draft-banner")?.textContent || null,
        date: document.getElementById("DateText")?.value || null,
        files: document.getElementById("GPXUpload")?.files?.length ?? null,
      };`).catch(readError => ({ error: String(readError) }));
            throw new Error(`Firefox draft Preview did not submit: ${JSON.stringify({
                requests: fixture.requests,
                pageState,
            })}`, { cause: error });
        }
        await waitForScript(
            driver,
            "return /Preview is ready/.test(document.getElementById('bpb-draft-banner')?.textContent || '');",
            'the completed Firefox draft banner',
        );
        assertState(
            fixture.requests.previewPosts === 1
        && fixture.requests.savePosts === 0
        && fixture.requests.lastPreview?.attachedGpx
        && fixture.requests.lastPreview?.dateFilled
        && fixture.requests.lastPreview?.suffixBlank,
            'Firefox draft handoff did not attach/fill/Preview exactly once',
            fixture.requests,
        );

        await driver.switchTo().window(controlHandle);
        const privateState = await driver.executeAsyncScript((sourceId, draftId, done) => {
            const api = globalThis.browser || globalThis.chrome;
            api.storage.session.get(['bpbCaptureJobs', 'bpbDraftTabs']).then(values => done({
                job: values.bpbCaptureJobs?.[sourceId] || null,
                draft: values.bpbDraftTabs?.[draftId] || null,
            }), error => done({ error: String(error) }));
        }, sourceTabId, draftTabId);
        assertState(
            privateState.job?.phase === 'previewed'
        && privateState.job?.uploadGpx === null
        && privateState.draft?.complete === true
        && privateState.draft?.previewStarted === true,
            'Firefox worker did not complete the exactly-once handoff',
            privateState,
        );
        await driver.switchTo().window(draftHandle);
        await driver.close();
        await driver.switchTo().window(controlHandle);

        const capabilities = await driver.getCapabilities();
        console.log('Firefox extension startup verification passed:');
        console.log(`  - ${capabilities.getBrowserName()} ${capabilities.getBrowserVersion()}`);
        console.log(`  - hidden/headless at ${verificationViewport.width}x${verificationViewport.height}`);
        console.log('  - real sync/local/session storage and storage.onChanged round-tripped');
        console.log('  - the photo library rendered its metadata-only recovery boundary and decoded/autosaved a PNG');
        console.log('  - a 49-photo library stayed at 48 cards, fit desktop and narrow pagination, and opened page 2');
        console.log('  - the topo tools drew a route from its first click, kept the smooth curve and the');
        console.log('    armed tool, dimmed a mark to 40%, rasterized the overlay into an untainted canvas,');
        console.log('    imported a project bundle back under its own record, and painted the guide legend');
        console.log('  - the real 1,500-row favorite list reported its total, fuzzy-searched, and kept long navigation instant');
        console.log('  - a held Buddy replacement stayed busy and focused, then failed retryably without another fetch');
        console.log('  - four native Buddy actions refreshed/synced custom favorites under both removal policies');
        console.log('  - options, popup, ascent, editor, Peak, BigMap, PeakAscents, Buddy List, Peak List, and profile-backup surfaces initialized');
        console.log('  - the full Capitol GPX rendered 971 points per chart series with the corrected metrics and zero breaks');
        console.log('  - a fresh ascent form autofilled its local date and trusted GPX selection swapped Preview for Process');
        console.log('  - the report editor opened the standalone report-drafts manager page, which rendered a seeded draft');
        console.log('  - forged page/frame messages, synthetic clicks, and direct embedding started no terrain work');
        console.log('  - trusted keyboard/pointer Settings actions preserved modifiers and reused one exact tab');
        console.log('  - AMO report credit, real editor input/draft recovery, filter/sort, and trusted 3D frame creation passed');
        console.log('  - a real draft tab rejected wrong identity, attached GPX, filled fields, Previewed once, and never Saved');
        console.log('  - native toolbar activeTab grant, popup chrome, prompts, and window placement were not tested');
    } catch (error) {
        primaryError = error;
    }
    await resources.dispose(primaryError);
}

main().catch(error => {
    console.error(`Firefox extension startup verification failed: ${error.stack || error.message}`);
    process.exitCode = 1;
});
