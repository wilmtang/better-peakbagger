// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, Image */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';
export async function verifyWildfires({ origin, evaluate, evaluateTerrain, navigate, click, clickPoint, press, resize, setZoom, setSettings, wait, setMode, release, heldCount, evidence, screenshotPage, firefoxMode }) {
    const output = process.env.BPB_VERIFY_FIRE_SCREENSHOT_DIR || '/tmp/bpb-wildfire-visual'; await mkdir(output, { recursive: true });
    const count = () => evidence.filter(request => request.host === 'services3.arcgis.com').length;
    const open = async () => { if (!await evaluate(() => document.querySelector('.bpb-layers-trigger').getAttribute('aria-expanded') === 'true')) await click('.bpb-layers-trigger'); };
    const ready = () => wait(() => document.querySelector('[data-layer="wildfire"]').dataset.status === '', 'complete fire overlay');
    const refreshFire = async () => {
        const point = await evaluate(() => { const b = document.querySelector('[data-overlay="wildfire"] .bpb-layers-retry'), r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, exposed: hit === b || b.contains(hit), hit: hit?.outerHTML.slice(0, 250), viewport: [window.innerWidth, window.innerHeight], scroll: [window.scrollX, window.scrollY] }; });
        assert.equal(point.exposed, true, `wildfire recovery action is exposed: ${JSON.stringify(point)}`); await clickPoint(point.x, point.y);
    };
    const fireBox = '[data-layer="wildfire"] input';
    await setSettings({ theme: 'light', enable3dMap: true, showSunMoon: false, showWeather: false, showSnotel: false });
    await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map-first`);
    await wait(() => !!document.querySelector('[data-layer="wildfire"] input') && !document.querySelector('.bpb-map-layers').hidden, 'wildfire control on real extension map');
    await evaluate(() => document.getElementById('Gmap').scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    await open(); assert.equal(count(), 0, 'opening Overlays does not fetch fire data');
    setMode('fire-loading'); await click(fireBox);
    await wait(() => document.querySelector('[data-layer="wildfire"]').dataset.status === 'loading', 'pending fire reports');
    assert.equal(await evaluate(() => !!document.querySelector('[aria-label="Wildfires opacity"]')), false);
    await waitForCondition(() => heldCount() >= 2, { description: 'both fire transports held', timeoutMs: 10000 });
    setMode('complete'); release(); await ready();
    assert.equal(await evaluate(() => document.querySelector('[data-layer="wildfire"] .bpb-layers-value-number').textContent), '1 in view');
    assert.equal(count(), 2);
    assert.equal(await evaluate(() => {
        const w = document.getElementById('Gmap').contentWindow, map = w.mapsPlaceholder;
        return map.getPane('bpb-wildfires').querySelectorAll('path').length === 2 && w.nativeLayers.every(layer => map.hasLayer(layer))
            && Number(w.getComputedStyle(map.getPane('bpb-wildfires')).zIndex) < Number(w.getComputedStyle(map.getPane('overlayPane')).zIndex);
    }), true, 'fire vectors and polygon hole render beneath unchanged native vectors');
    await evaluate(() => document.querySelector('[data-overlay="wildfire"] .bpb-fire-list summary').focus());
    await press(firefoxMode ? '\uE007' : 'Enter');
    await wait(() => document.querySelector('[data-overlay="wildfire"] details').open, 'keyboard fire details');
    assert.equal(await evaluate(() => {
        const text = document.querySelector('[data-overlay="wildfire"] details').textContent;
        return text.includes('2026-10-24') && text.includes('2026-08-01') && text.includes('2026-09-20');
    }), true, 'incident, observed perimeter and edit dates stay separate');
    await evaluate(() => { document.querySelector('[data-overlay="wildfire"] details').open = false; });
    const geometry = () => evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x + window.scrollX, r.y + window.scrollY, r.width, r.height]; };
        return { trigger: rect('.bpb-layers-trigger'), retry: rect('[data-overlay="wildfire"] .bpb-layers-retry'),
            heading: rect('h1'), following: rect('a[href*="BigMap"]'), scroll: [window.scrollX, window.scrollY] };
    });
    const stable = (a, b) => { for (const key of Object.keys(a)) a[key].forEach((value, index) => assert.ok(Math.abs(value - b[key][index]) <= 1, `fire ${key} shifted: ${JSON.stringify({ a, b })}`)); };
    const cases = [];
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        await setZoom(1); await resize(width, 1100); await setSettings({ theme, enable3dMap: true, showSunMoon: false, showWeather: false }); await setZoom(zoom);
        await evaluate(() => document.getElementById('Gmap').scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })); await open();
        await wait(() => { const button = document.querySelector('[data-overlay="wildfire"] .bpb-layers-retry'); const panel = document.querySelector('.bpb-layers-panel'), before = button.getBoundingClientRect(), p = panel.getBoundingClientRect(); panel.scrollTop += before.top - p.top - Math.min(60, p.height / 3); const r = button.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.top >= 0 && r.bottom <= window.innerHeight && (hit === button || button.contains(hit)); }, 'visible fire recovery action');
        await wait(() => {
            const button = document.querySelector('[data-overlay="wildfire"] .bpb-layers-retry'), r = button.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            if (!(hit === button || button.contains(hit))) { const panel = document.querySelector('.bpb-layers-panel'), p = panel.getBoundingClientRect(); panel.scrollTop += r.top - p.top - Math.min(60, p.height / 3); window.__bpbFireViewport = null; return false; }
            const signature = JSON.stringify([r.x, r.y, r.width, r.height, window.scrollX, window.scrollY, window.innerWidth, document.querySelector('.bpb-layers-panel').scrollTop]);
            const previous = window.__bpbFireViewport;
            window.__bpbFireViewport = { signature, count: previous?.signature === signature ? previous.count + 1 : 0 };
            return window.__bpbFireViewport.count >= 2;
        }, 'settled wildfire controls after resize/zoom');
        await evaluate(() => { delete window.__bpbFireViewport; });
        const before = await geometry();
        setMode('fire-loading'); await refreshFire();
        await wait(() => document.querySelector('[data-layer="wildfire"]').dataset.status === 'loading', 'fire refresh pending'); stable(before, await geometry());
        await waitForCondition(() => heldCount() >= 2, { description: 'slow fire refresh transports', timeoutMs: 10000 });
        const busy = count(); await evaluate(() => document.querySelector('[data-overlay="wildfire"] .bpb-layers-retry').click()); assert.equal(count(), busy);
        setMode('complete'); release(); await ready(); stable(before, await geometry());
        setMode('fire-perimeter-error'); await refreshFire();
        await wait(() => document.querySelector('[data-layer="wildfire"]').dataset.status === 'saved', 'perimeter refresh failure retains complete older geometry'); stable(before, await geometry());
        setMode('complete'); await refreshFire(); await ready(); stable(before, await geometry());
        await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-fires-${width}-${theme}-${zoom}.png`)); cases.push({ width, theme, zoom });
    }
    await setZoom(1); await resize(1440, 1100); await setSettings({ theme: 'light', enable3dMap: true, showWeather: false, showSunMoon: false });
    await evaluate(() => document.getElementById('Gmap').scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    const colored = async label => {
        const file = path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${label}.png`); await screenshotPage(file);
        return evaluate(async encoded => {
            const img = new Image(); img.src = `data:image/png;base64,${encoded}`; await img.decode();
            const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; const c = canvas.getContext('2d'); c.drawImage(img, 0, 0);
            const pixels = c.getImageData(0, 0, img.width, img.height).data; let count = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 160 && pixels[i] < 235 && pixels[i + 1] > 45 && pixels[i + 1] < 100 && pixels[i + 2] < 65) count++;
            return count;
        }, (await readFile(file)).toString('base64'));
    };
    await click('.bpb-layers-trigger'); const nativePixels = await waitForCondition(() => colored('fires-native'), { description: 'native wildfire pixels after viewport replacement', timeoutMs: 15000, isReady: count => count > 20 }); assert.ok(nativePixels > 20, `native fire pixels: ${nativePixels}`);
    await open(); await click(fireBox); await click('.bpb-layers-trigger'); const offPixels = await waitForCondition(() => colored('fires-off'), { description: 'wildfire off removes painted pixels', timeoutMs: 10000, isReady: count => count < nativePixels / 2 }); assert.ok(offPixels < nativePixels / 2, 'negative control removes fire pixels');
    await open(); await click(fireBox); await ready(); await click('.bpb-layers-trigger');
    await wait(() => document.getElementById('bpb-terrain-toggle')?.disabled === false, '3D activation available');
    await click('#bpb-terrain-toggle'); await wait(() => document.getElementById('bpb-terrain-toggle').getAttribute('aria-pressed') === 'true', 'packaged 3D renderer');
    await ready();
    const renderer = await evaluateTerrain(() => { const gl = document.querySelector('canvas.maplibregl-canvas').getContext('webgl2'), info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
    assert.ok(renderer && !/swiftshader|software|llvmpipe/i.test(renderer), `hardware renderer required: ${renderer}`);
    const terrainPixels = await waitForCondition(() => colored('fires-terrain'), { description: '3D wildfire pixels', timeoutMs: 20000, isReady: count => count > 20 }); assert.ok(terrainPixels > 20, `3D fire pixels: ${terrainPixels}`);
    let sourceProbe = null;
    if (process.env.BPB_VERIFY_FIRE_LIVE === '1') {
        setMode('fire-live-probe');
        const probe = async () => Promise.all([['Incident_Locations', 'IncidentTypeCategory'], ['Interagency_Perimeters', 'attr_IncidentTypeCategory']].map(async ([service, field]) => {
            const url = new URL(`https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_${service}_Current/FeatureServer/0/query`);
            Object.entries({ f: 'json', where: `${field}='WF'`, geometry: '-122,46,-121,47', geometryType: 'esriGeometryEnvelope', inSR: 4326, returnCountOnly: true }).forEach(([key, value]) => url.searchParams.set(key, value));
            const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) });
            const body = await response.json(); return { service, status: response.status, count: body.count, ok: response.ok && Number.isInteger(body.count) && body.count >= 0 };
        }));
        sourceProbe = { page: await evaluate(probe), terrain: await evaluateTerrain(probe) };
        assert.ok([...sourceProbe.page, ...sourceProbe.terrain].every(result => result.ok), JSON.stringify(sourceProbe));
        setMode('complete');
    }
    await open(); assert.equal(await evaluate(() => document.querySelector('[data-layer="wildfire"] input').checked), true);
    await click('[data-layer="wildfire"] button');
    await wait(() => document.querySelector('[data-overlay="wildfire"] .bpb-fire-list summary')?.textContent === 'Example Mountain Fire', '3D typed fire details');
    await wait(() => {
        const b = document.querySelector('[data-overlay="wildfire"] .bpb-layers-retry'), panel = document.querySelector('.bpb-layers-panel'), p = panel.getBoundingClientRect(), r = b.getBoundingClientRect();
        panel.scrollTop += r.top - p.top - Math.min(60, p.height / 3);
        const box = b.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return hit === b || b.contains(hit);
    }, 'visible 3D fire recovery');
    const terrainGeometry = await geometry(); setMode('fire-loading'); await refreshFire();
    await wait(() => document.querySelector('[data-layer="wildfire"]').dataset.status === 'loading', '3D pending fire reports');
    await waitForCondition(() => heldCount() >= 2, { description: 'held 3D fire transports', timeoutMs: 10000 }); stable(terrainGeometry, await geometry());
    setMode('complete'); release(); await ready(); stable(terrainGeometry, await geometry());
    setMode('fire-perimeter-error'); await refreshFire();
    await wait(() => document.querySelector('[data-layer="wildfire"]').dataset.status === 'saved', '3D retained perimeter refresh failure'); stable(terrainGeometry, await geometry());
    setMode('complete'); await refreshFire(); await ready(); stable(terrainGeometry, await geometry());
    await click('.bpb-layers-trigger'); await click('#bpb-terrain-toggle'); await ready();
    await open(); await click(fireBox); setMode('fire-empty'); await click(fireBox); await ready();
    assert.equal(await evaluate(() => document.querySelector('[data-layer="wildfire"] .bpb-layers-value-number').textContent), '0 in view');
    assert.match(await evaluate(() => document.querySelector('[data-overlay="wildfire"] .bpb-layers-feedback').textContent), /No reported fires/);
    await click(fireBox); setMode('fire-perimeter-error'); await click(fireBox);
    await wait(() => document.querySelector('[data-layer="wildfire"]').dataset.status === 'error', 'initial partial fire load');
    assert.equal(await evaluate(() => document.querySelector('[data-layer="wildfire"] .bpb-layers-row-status').textContent), 'Partly loaded');
    assert.equal(await evaluate(() => document.querySelector('[data-overlay="wildfire"] .bpb-fire-list summary').textContent), 'Example Mountain Fire');
    const surfaces = ['peak'];
    for (const [surface, url] of [
        ['ascent', `${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`],
        ['Full Screen', `${origin}/map/BigMap.aspx?t=A`],
        ['standalone', `${origin}/map/MasterMap.aspx?t=A`],
    ]) {
        setMode('complete'); await navigate(url);
        await wait(() => !!document.querySelector('[data-layer="wildfire"] input') && !document.querySelector('.bpb-map-layers').hidden, 'wildfire menu on additional native surface');
        const before = count(); await open(); assert.equal(count(), before, 'menu-only does not fetch on another surface');
        assert.equal(await evaluate(() => document.querySelectorAll('.bpb-map-layers').length), 1, 'one menu per map owner');
        assert.equal(await evaluate(() => document.querySelector('[data-layer="wildfire"] input').checked), false, 'unrelated sessions start off');
        await click(fireBox); await ready();
        assert.equal(await evaluate(() => document.querySelector('[data-layer="wildfire"] .bpb-layers-value-number').textContent), '1 in view');
        surfaces.push(surface);
    }
    assert.equal(surfaces.length, 4);
    assert.equal(cases.length, 8);
    return { cases, surfaces, terrainStates: ['ready', 'pending', 'success', 'perimeter-refresh-error', 'retry'], renderer, sourceProbe, pixels: { nativePixels, offPixels, terrainPixels }, requests: count(), screenshots: output };
}
