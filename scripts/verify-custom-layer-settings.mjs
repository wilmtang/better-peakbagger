// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, chrome, innerWidth, Event, getComputedStyle, scrollY */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { waitForCondition } from './browser-verification-fixtures.mjs';
const [kind, ...args] = process.argv.slice(2);
assert(['chrome', 'firefox'].includes(kind) && args.every(arg => arg.startsWith('--screenshots=')), 'Usage: node scripts/verify-custom-layer-settings.mjs chrome|firefox [--screenshots=PATH]');
const shots = args[0]?.slice(14), resources = createResourceStack();
try {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bpb-layer-settings-'));resources.defer('Settings files', () => rm(root, { recursive: true, force: true }));
    let evaluate, inside, editorSave, editorKey, click, press, viewport, shot, version;
    if (kind === 'chrome') {
        const { chromium } = await import('playwright');assertChromeLaunchAllowed();
        const source = path.resolve('dist');
        const context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true,
            viewport: { width: 1100, height: 900 }, args: [`--load-extension=${source}`, `--disable-extensions-except=${source}`] });
        resources.defer('Settings Chrome', () => context.close());
        const page = await context.newPage();await page.goto('chrome://extensions-internals/');
        const extension = await page.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
        await page.goto(`chrome-extension://${extension.id}/options/options.html#custom-map-layers`);
        evaluate = (fn, arg) => page.evaluate(fn, arg);click = selector => page.locator(selector).click();press = selector => page.locator(selector).press('Space');
        inside = (fn, arg) => page.frames().find(frame => frame.url().includes('/custom-overlay/editor.html'))?.evaluate(fn, arg);
        editorSave = () => page.frameLocator('#custom-layer-dialog iframe').locator('#save').press('Space');
        editorKey = (selector, key) => page.frameLocator('#custom-layer-dialog iframe').locator(selector).press(key);
        viewport = width => page.setViewportSize({ width, height: 900 });shot = file => page.screenshot({ path: file });version = context.browser().version();
    } else {
        const { Builder, By, Key } = await import('selenium-webdriver'), firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot: root, distDir: path.resolve('dist') });resources.defer('Settings source', () => prepared.cleanup());resources.defer('Settings processes', () => stopOwnedFirefoxProcesses(root));
        const profile = path.join(root, 'profile');await mkdir(profile);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(new firefox.Options().addArguments('-headless').setProfile(profile))
            .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${root}`)).build();resources.defer('Settings Firefox', () => quitFirefoxDriver(driver, root));
        const addon = await driver.installAddon(prepared.sourceDir, true);await driver.setContext(firefox.Context.CHROME);
        const url = await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);await driver.setContext(firefox.Context.CONTENT);await driver.get(url + '#custom-map-layers');
        evaluate = (fn, arg) => driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null);click = selector => driver.findElement(By.css(selector)).click();press = selector => driver.findElement(By.css(selector)).sendKeys(Key.SPACE);
        inside = async (fn, arg) => { try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));return await driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null); } finally { await driver.switchTo().defaultContent(); } };
        editorSave = async () => { try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));await driver.findElement(By.id('save')).sendKeys(Key.SPACE); } finally { await driver.switchTo().defaultContent(); } };
        editorKey = async (selector, key) => { try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));await driver.findElement(By.css(selector)).sendKeys(key === 'Space' ? Key.SPACE : Key.ENTER); } finally { await driver.switchTo().defaultContent(); } };
        viewport = width => driver.manage().window().setRect({ width: Math.max(500, width), height: 985 });shot = async file => writeFile(file, await driver.takeScreenshot(), 'base64');version = (await driver.getCapabilities()).getBrowserVersion();
    }
    const wait = (fn, description) => waitForCondition(fn, { description });
    await evaluate(async () => {
        const api = window.browser || chrome;
        for (const [index, name] of ['Topo', 'A long custom terrain layer name that must wrap without pushing actions away'].entries()) {
            const reply = await api.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_SAVE', id: `custom:${index}537a032-271c-4d11-9b8c-0edc566b47c1`, expectedRevision: 0,
                source: { revision: 1, name, kind: 'raster', source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'], scheme: 'xyz', tileSize: 256, minNativeZoom: 0, maxNativeZoom: 18 },
                    approvedOrigins: ['https://tiles.example.com'], appearance: { opacity: 60, rules: [] }, attribution: { text: '' } }, requestParameters: [] });
            if (!reply.ok) throw new Error(reply.error);
        }
    });
    await wait(() => evaluate(() => document.querySelectorAll('.custom-layer-row').length === 2), 'saved layer rows');
    let cases = 0;
    for (const width of [1100, kind === 'firefox' ? 500 : 375]) for (const theme of ['light', 'dark']) for (const scale of [1, 1.5]) {
        await viewport(width);await evaluate(({ theme, scale }) => {
            document.documentElement.dataset.bpbTheme = theme;
            document.getElementById('custom-layer-list').style.fontSize = `${13 * scale}px`;
            for (const button of document.querySelectorAll('.custom-layer-actions button')) button.style.fontSize = `${13 * scale}px`;
            document.getElementById('custom-map-layers').scrollIntoView({ block: 'start' });
        }, { theme, scale });
        const state = await evaluate(() => ({ opacity: !!document.querySelector('#custom-layer-list input[type=range]'), rows: [...document.querySelectorAll('.custom-layer-row')].map(row => ({
            overflow: row.scrollWidth > row.clientWidth, buttons: [...row.querySelectorAll('.custom-layer-actions button')].map(button => {
                const r = button.getBoundingClientRect();return [r.y, r.height, r.left, r.right];
            }),
        })), width: innerWidth }));
        assert(!state.opacity);assert(state.rows.every(row => !row.overflow));
        for (const row of state.rows) for (const rect of row.buttons) {
            assert(Math.abs(rect[0] - row.buttons[0][0]) <= 1 && Math.abs(rect[1] - row.buttons[0][1]) <= 1, 'all four actions share a baseline and height');
            assert(rect[2] >= 0 && rect[3] <= state.width, 'actions fit the viewport');
        }
        if (shots && scale === 1) { await mkdir(shots, { recursive: true });await shot(path.join(shots, `settings-${kind}-${width}-${theme}.png`)); }
        cases++;
    }
    const up = '.custom-layer-row:nth-child(2) .custom-layer-order button:first-child';
    await evaluate(() => {
        const api = window.browser || chrome, original = api.runtime.sendMessage.bind(api.runtime);
        window.pendingReorders = 0;api.runtime.sendMessage = message => {
            if (message.type !== 'CUSTOM_OVERLAYS_REORDER') return original(message);
            window.pendingReorders++;return new Promise(resolve => { window.releaseReorder = success => { api.runtime.sendMessage = original;success ? original(message).then(resolve) : resolve({ ok: false, error: 'Order not saved. Try again.' }); }; });
        };
        document.querySelector('.custom-layer-row:nth-child(2) .custom-layer-order button').focus({ preventScroll: true });
    });
    const geometry = () => evaluate(() => ({ scroll: document.querySelector('.content').scrollTop, rows: [...document.querySelectorAll('.custom-layer-row')].map(row => {
        const r = row.getBoundingClientRect();return [r.x, r.y, r.width, r.height];
    }) }));
    const before = await geometry();await press(up);await wait(() => evaluate(() => window.pendingReorders === 1), 'reorder pending');await press(up);assert.equal(await evaluate(() => window.pendingReorders), 1);
    assert.deepEqual(await geometry(), before);await evaluate(() => window.releaseReorder(false));await wait(() => evaluate(() => !document.getElementById('custom-layer-list').hasAttribute('aria-busy')), 'reorder failure');assert.deepEqual(await geometry(), before);
    await press(up);await wait(() => evaluate(() => document.querySelector('.custom-layer-row strong').textContent.startsWith('A long')), 'keyboard reorder retry');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Move A long custom terrain layer name that must wrap without pushing actions away up');
    await click('.custom-layer-row:first-child .custom-layer-actions > button:last-child');await wait(() => evaluate(() => !document.querySelector('.custom-layer-remove').hidden), 'delete confirmation');
    await click('.custom-layer-row:first-child .custom-layer-remove button:last-child');assert.equal(await evaluate(() => document.activeElement.textContent), 'Delete');
    await click('.custom-layer-row:first-child .custom-layer-actions > button:first-of-type');
    await wait(() => inside(() => document.getElementById('advanced').open), 'Edit opens manual settings');
    let disclosureCases = 0;
    const disclosureGeometry = () => inside(() => {
        const summary = document.querySelector('#advanced>summary'), rect = summary.getBoundingClientRect();
        return [rect.x,rect.y,rect.width,rect.height,scrollY];
    });
    for (const width of [1100, kind === 'firefox' ? 500 : 375]) for (const theme of ['light','dark']) for (const scale of [1,1.5]) {
        await viewport(width);await inside(({ theme,scale }) => {
            document.documentElement.dataset.theme = theme;document.body.style.fontSize = `${14*scale}px`;
            document.getElementById('private-parameters').open = false;document.getElementById('advanced').open = false;
        }, { theme,scale });
        const headers = await inside(() => ['private-parameters','advanced'].map(id => {
            const summary = document.querySelector(`#${id}>summary`), css = getComputedStyle(summary), rect = summary.getBoundingClientRect();
            const label = summary.querySelector('span') || summary, text = [...label.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
            const range = document.createRange();range.selectNode(text);
            return { background:css.backgroundColor,border:css.borderTopWidth,font:css.font,height:rect.height,lineHeight:parseFloat(css.lineHeight),textX:range.getBoundingClientRect().x };
        }));
        assert.equal(headers[0].background,headers[1].background,'peer disclosures must share the same background');
        assert.equal(headers[0].font,headers[1].font,'peer disclosures must share typography');
        assert.equal(headers[1].border,'0px','Advanced must not appear as a separate input card');
        assert(headers[1].height <= Math.max(44,headers[1].lineHeight+20)+1,'Advanced stays a compact single-line disclosure');
        assert(Math.abs(headers[0].textX-headers[1].textX)<=1,'disclosure labels share their leading alignment');
        assert(headers.every(header=>header.height>=44),'disclosures retain usable hit targets');
        assert(await inside(() => document.documentElement.scrollWidth<=innerWidth),'enlarged text fits the editor');
        await inside(() => document.querySelector('#advanced>summary').scrollIntoView({block:'center',behavior:'instant'}));
        if(shots&&scale===1)await shot(path.join(shots,`disclosures-${kind}-${width}-${theme}-closed.png`));
        for(const key of ['Space','Enter']) {
            await inside(() => document.querySelector('#advanced>summary').focus({preventScroll:true}));const before=await disclosureGeometry();
            await editorKey('#advanced>summary',key);assert(await inside(()=>document.getElementById('advanced').open));
            const after=await disclosureGeometry();assert(after.every((value,index)=>Math.abs(value-before[index])<=1),'opening Advanced keeps its header and reading position anchored');
            assert(await inside(()=>document.activeElement===document.querySelector('#advanced>summary')),'disclosure retains keyboard focus');
            if(shots&&scale===1&&key==='Space')await shot(path.join(shots,`disclosures-${kind}-${width}-${theme}-open.png`));
            await editorKey('#advanced>summary',key);assert(!await inside(()=>document.getElementById('advanced').open));
            assert((await disclosureGeometry()).every((value,index)=>Math.abs(value-before[index])<=1),'closing Advanced restores the same reading position');
        }
        disclosureCases++;
    }
    assert.equal(disclosureCases,8);
    await inside(()=>{document.body.style.fontSize='';document.getElementById('advanced').open=true;});
    for (const width of [1100, kind === 'firefox' ? 500 : 375]) {
        await viewport(width);
        const controls = await inside(() => ['kind','format','minimum','maximum','scheme','tile-size','bounds'].map(id => {
            const input = document.getElementById(id);return { id, available: !!input.getClientRects().length, label: !!document.querySelector(`label[for="${id}"]`) };
        }));assert(controls.every(control => control.available && control.label), 'every relevant saved raster override is available');
        await inside(() => document.getElementById('scheme').scrollIntoView({ block: 'center' }));
        if (shots) await shot(path.join(shots, `editor-${kind}-${width}-manual.png`));
    }
    await inside(() => {
        for (const [id, value] of [['minimum','3'],['maximum','15'],['scheme','tms'],['tile-size','512'],['bounds','-124,44,-120,49']]) {
            const field = document.getElementById(id);field.value = value;field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        document.getElementById('save').focus();
    });await editorSave();
    await wait(() => inside(() => document.getElementById('feedback').textContent === 'Saved on this device.'), 'manual overrides saved');
    const saved = await evaluate(async () => (await (window.browser || chrome).runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET' })).registry.sources[0].source);
    assert.equal(saved.minNativeZoom, 3);assert.equal(saved.maxNativeZoom, 15);assert.equal(saved.scheme,'tms');assert.equal(saved.tileSize,512);assert.deepEqual(saved.bounds,[-124,44,-120,49]);assert.deepEqual(saved.manualFields.sort(),['bounds','scheme','tile-size']);
    await inside(() => document.getElementById('cancel').click());
    await click('.custom-layer-row:first-child .custom-layer-actions > button:first-of-type');
    await wait(() => inside(() => document.getElementById('advanced').open && document.getElementById('scheme').value === 'tms'), 'manual settings are visible after reopening');
    assert.equal(await inside(() => document.getElementById('maximum').value),'15');
    console.log(JSON.stringify({ verification: 'custom-layer-settings', kind, version, hidden: true, height: 900, widths: [1100, kind === 'firefox' ? 500 : 375], cases, disclosureCases, themes: ['light','dark'], scales: [1,1.5], matchingCompactDisclosures:true, keyboardDisclosureAnchored:true, actionsAligned: true, reorderPendingErrorRetry: true, opacityAbsent: true, manualOverridesVisibleSavedReopened: true }));
    await resources.dispose();
} catch (error) { await resources.dispose(error); }
