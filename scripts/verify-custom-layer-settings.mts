// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createResourceStack } from './resource-stack.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { waitForCondition as untypedWaitForCondition } from './browser-verification-fixtures.mjs';
import { createVerificationRoot } from './verification-launch.mts';
import type { Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => Promise<T>, options: { description: string }) => Promise<T>;
// Browser-neutral page access: Playwright evaluates the function, WebDriver its source.
type PageFn = <T>(fn: (arg: never) => T, arg?: unknown) => Promise<Awaited<T>>;
// Page-world names the callbacks read; each casts in place so Window stays unchanged.
interface ReorderProbe { pendingReorders: number; releaseReorder(success: boolean): void; browser?: typeof chrome }
type Field = HTMLInputElement & HTMLDetailsElement;
const [kind, ...args] = process.argv.slice(2);
assert(['chrome', 'firefox'].includes(kind) && args.every(arg => arg.startsWith('--screenshots=')), 'Usage: node scripts/verify-custom-layer-settings.mts chrome|firefox [--screenshots=PATH]');
const shots = args[0]?.slice(14), resources = createResourceStack();
try {
    const root = await createVerificationRoot(resources, 'bpb-layer-settings-', 'Settings files');
    let evaluate: PageFn, inside: PageFn, editorSave: () => Promise<unknown>, editorKey: (selector: string, key: string) => Promise<unknown>,
        click: (selector: string) => Promise<unknown>, press: (selector: string) => Promise<unknown>,
        viewport: (width: number, height?: number) => Promise<unknown>, shot: (file: string) => Promise<unknown>, version: string;
    if (kind === 'chrome') {
        // Loaded here so the Firefox path does not need Playwright installed.
        const { launchVerificationChrome } = await import('./verification-launch.mts');
        const source = path.resolve('dist');
        const context = await launchVerificationChrome(resources, 'Settings Chrome', path.join(root, 'profile'), {
            viewport: { width: 1100, height: 900 }, extension: source });
        const page = await context.newPage();await page.goto('chrome://extensions-internals/');
        const extension = await page.waitForFunction(() => { try { return JSON.parse(document.body.innerText).find((item: { name: string; id: string }) => item.name === 'Better Peakbagger'); } catch { return false; } }).then(handle => handle.jsonValue());
        await page.goto(`chrome-extension://${extension.id}/options/options.html#custom-map-layers`);
        evaluate = (fn, arg) => page.evaluate(fn as (value: unknown) => never, arg);click = selector => page.locator(selector).click();press = selector => page.locator(selector).press('Space');
        inside = (fn, arg) => page.frames().find(frame => frame.url().includes('/custom-overlay/editor.html'))?.evaluate(fn as (value: unknown) => never, arg) as Promise<never>;
        editorSave = () => page.frameLocator('#custom-layer-dialog iframe').locator('#save').press('Space');
        editorKey = (selector, key) => page.frameLocator('#custom-layer-dialog iframe').locator(selector).press(key);
        viewport = (width,height=900) => page.setViewportSize({ width, height });shot = file => page.screenshot({ path: file });version = context.browser()!.version();
    } else {
        const { Builder, By, Key } = await import('selenium-webdriver'), firefox = (await import('selenium-webdriver/firefox.js')).default;
        const prepared = await prepareFirefoxSource({ temporaryRoot: root, distDir: path.resolve('dist') });resources.defer('Settings source', () => prepared.cleanup());resources.defer('Settings processes', () => stopOwnedFirefoxProcesses(root));
        const profile = path.join(root, 'profile');await mkdir(profile);
        const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(new firefox.Options().addArguments('-headless').setProfile(profile))
            .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${root}`)).build() as FirefoxDriver;resources.defer('Settings Firefox', () => quitFirefoxDriver(driver, root));
        const addon = await driver.installAddon(prepared.sourceDir, true);await driver.setContext(firefox.Context.CHROME);
        const url = await driver.executeScript<string>('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");', addon);await driver.setContext(firefox.Context.CONTENT);await driver.get(url + '#custom-map-layers');
        evaluate = (fn, arg) => driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null) as Promise<never>;click = selector => driver.findElement(By.css(selector)).click();press = selector => driver.findElement(By.css(selector)).sendKeys(Key.SPACE);
        inside = async (fn, arg) => { try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));return await (driver.executeScript(`return (${fn})(arguments[0]);`, arg ?? null) as Promise<never>); } finally { await driver.switchTo().defaultContent(); } };
        editorSave = async () => { try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));await driver.findElement(By.id('save')).sendKeys(Key.SPACE); } finally { await driver.switchTo().defaultContent(); } };
        editorKey = async (selector, key) => { try { await driver.switchTo().frame(await driver.findElement(By.css('#custom-layer-dialog iframe')));await driver.findElement(By.css(selector)).sendKeys(key === 'Space' ? Key.SPACE : Key.ENTER); } finally { await driver.switchTo().defaultContent(); } };
        viewport = (width,height=900) => driver.manage().window().setRect({ width: Math.max(500, width), height: height+85 });shot = async file => writeFile(file, await driver.takeScreenshot(), 'base64');version = (await driver.getCapabilities()).getBrowserVersion() as string;
    }
    const wait = <T,>(fn: () => Promise<T>, description: string) => waitForCondition(fn, { description });
    await evaluate(async () => {
        const api = (window as unknown as ReorderProbe).browser || chrome;
        for (const [index, name] of ['Topo', 'A long custom terrain layer name that must wrap without pushing actions away'].entries()) {
            const reply = await api.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_SAVE', id: `custom:${index}537a032-271c-4d11-9b8c-0edc566b47c1`, expectedRevision: 0,
                source: { revision: 1, name, kind: 'raster', source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'], scheme: 'xyz', tileSize: 256, minNativeZoom: 0, maxNativeZoom: 18 },
                    approvedOrigins: ['https://tiles.example.com'], appearance: { opacity: 60, rules: [] }, attribution: { text: '' } }, requestParameters: [] });
            if (!reply.ok) throw new Error(reply.error as string);
        }
    });
    await wait(() => evaluate(() => document.querySelectorAll('.custom-layer-row').length === 2), 'saved layer rows');
    let cases = 0;
    for (const width of [1100, kind === 'firefox' ? 500 : 375]) for (const theme of ['light', 'dark']) for (const scale of [1, 1.5]) {
        await viewport(width);await evaluate(({ theme: pageTheme, scale: pageScale }: { theme: string; scale: number }) => {
            document.documentElement.dataset.bpbTheme = pageTheme;
            document.getElementById('custom-layer-list')!.style.fontSize = `${13 * pageScale}px`;
            for (const button of document.querySelectorAll<HTMLElement>('.custom-layer-actions button')) button.style.fontSize = `${13 * pageScale}px`;
            document.getElementById('custom-map-layers')!.scrollIntoView({ block: 'start' });
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
        const probe = window as unknown as ReorderProbe;
        const api = probe.browser || chrome, original = api.runtime.sendMessage.bind(api.runtime);
        probe.pendingReorders = 0;api.runtime.sendMessage = ((message: { type: string }) => {
            if (message.type !== 'CUSTOM_OVERLAYS_REORDER') return original(message);
            probe.pendingReorders++;return new Promise<unknown>(resolve => { probe.releaseReorder = success => { api.runtime.sendMessage = original;if (success) original(message).then(resolve); else resolve({ ok: false, error: 'Order not saved. Try again.' }); }; });
        }) as typeof api.runtime.sendMessage;
        document.querySelector<HTMLElement>('.custom-layer-row:nth-child(2) .custom-layer-order button')!.focus({ preventScroll: true });
    });
    const geometry = () => evaluate(() => ({ scroll: document.querySelector<Field>('.content')!.scrollTop, rows: [...document.querySelectorAll('.custom-layer-row')].map(row => {
        const r = row.getBoundingClientRect();return [r.x, r.y, r.width, r.height];
    }) }));
    const before = await geometry();await press(up);await wait(() => evaluate(() => (window as unknown as ReorderProbe).pendingReorders === 1), 'reorder pending');await press(up);assert.equal(await evaluate(() => (window as unknown as ReorderProbe).pendingReorders), 1);
    assert.deepEqual(await geometry(), before);await evaluate(() => (window as unknown as ReorderProbe).releaseReorder(false));await wait(() => evaluate(() => !(document.getElementById('custom-layer-list') as Field).hasAttribute('aria-busy')), 'reorder failure');assert.deepEqual(await geometry(), before);
    await press(up);await wait(() => evaluate(() => document.querySelector<Field>('.custom-layer-row strong')!.textContent.startsWith('A long')), 'keyboard reorder retry');
    assert.equal(await evaluate(() => document.activeElement!.getAttribute('aria-label')), 'Move A long custom terrain layer name that must wrap without pushing actions away up');
    await click('.custom-layer-row:first-child .custom-layer-actions > button:last-child');await wait(() => evaluate(() => !document.querySelector<Field>('.custom-layer-remove')!.hidden), 'delete confirmation');
    await click('.custom-layer-row:first-child .custom-layer-remove button:last-child');assert.equal(await evaluate(() => document.activeElement!.textContent), 'Delete');
    await click('.custom-layer-row:first-child .custom-layer-actions > button:first-of-type');
    await wait(() => inside(() => (document.getElementById('advanced') as Field).open), 'Edit opens manual settings');
    let disclosureCases = 0;
    const disclosureGeometry = () => inside(() => {
        const summary = document.querySelector('#advanced>summary')!, rect = summary.getBoundingClientRect();
        return [rect.x,rect.y,rect.width,rect.height,(document.getElementById('editor-fields')||document.scrollingElement)!.scrollTop];
    });
    const actionGeometry = () => inside(() => {
        const rect = (element: Element) => { const box=element.getBoundingClientRect();return [box.x,box.y,box.width,box.height]; };
        return [rect(document.querySelector('.actions')!),...[...document.querySelectorAll('.actions>button')].filter(element=>element.getClientRects().length).map(rect)];
    });
    for (const [width,height] of [[1100,900],[kind === 'firefox' ? 500 : 375,900],[kind === 'firefox' ? 500 : 375,540]]) for (const theme of ['light','dark']) for (const scale of [1,1.5]) {
        await viewport(width,height);await inside(({ theme: pageTheme,scale: pageScale }: { theme: string; scale: number }) => {
            document.documentElement.dataset.theme = pageTheme;document.body.style.fontSize = `${14*pageScale}px`;
            (document.getElementById('private-parameters') as Field).open = false;(document.getElementById('advanced') as Field).open = false;
        }, { theme,scale });
        const headers = await inside(() => ['private-parameters','advanced'].map(id => {
            const summary = document.querySelector(`#${id}>summary`)!, css = getComputedStyle(summary), rect = summary.getBoundingClientRect();
            const label = summary.querySelector('span') || summary, text = [...label.childNodes].find(node => node.nodeType === 3 && node.textContent!.trim())!;
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
        const fieldWidth=await inside(()=>{const area=document.getElementById('editor-fields')!;return {available:area.clientWidth,content:area.scrollWidth};});
        assert(fieldWidth.content<=fieldWidth.available,`fields do not scroll sideways: ${JSON.stringify(fieldWidth)}`);
        assert(await inside(() => Math.abs(innerHeight-document.querySelector<Field>('.actions')!.getBoundingClientRect().bottom-parseFloat(getComputedStyle(document.getElementById('editor')!).paddingBottom))<=1), 'action bar stays at the sheet bottom even with all sections collapsed');
        const anchoredActions=await actionGeometry();
        const assertActions=async()=>assert((await actionGeometry()).every((rect,index)=>rect.every((value,axis)=>Math.abs(value-anchoredActions[index][axis])<=1)),'disclosure and scrolling must not move or resize footer actions');
        await inside(() => document.querySelector<Field>('#advanced>summary')!.scrollIntoView({block:'center',behavior:'instant'}));
        if(shots&&scale===1)await shot(path.join(shots,`disclosures-${kind}-${width}-${height}-${theme}-closed.png`));
        for(const key of ['Space','Enter']) {
            await inside(() => document.querySelector<HTMLElement>('#advanced>summary')!.focus({preventScroll:true}));const anchored=await disclosureGeometry();
            await editorKey('#advanced>summary',key);assert(await inside(()=>(document.getElementById('advanced') as Field).open));
            await assertActions();
            const after=await disclosureGeometry();assert(after.every((value,index)=>Math.abs(value-anchored[index])<=1),'opening Advanced keeps its header and reading position anchored');
            assert(await inside(()=>document.activeElement===document.querySelector('#advanced>summary')),'disclosure retains keyboard focus');
            if(shots&&scale===1&&key==='Space')await shot(path.join(shots,`disclosures-${kind}-${width}-${height}-${theme}-open.png`));
            await editorKey('#advanced>summary',key);assert(!await inside(()=>(document.getElementById('advanced') as Field).open));
            await assertActions();
            assert((await disclosureGeometry()).every((value,index)=>Math.abs(value-anchored[index])<=1),'closing Advanced restores the same reading position');
        }
        for(const selector of ['#private-parameters>summary','#form details.help:not(#private-access-help)>summary']) {
            await editorKey(selector,'Space');await assertActions();await editorKey(selector,'Space');await assertActions();
        }
        await inside(()=>{
            (document.getElementById('advanced') as Field).open=true;
            const help=document.querySelector<HTMLDetailsElement>('#form details.help:not(#private-access-help)')!;help.open=true;
            help.querySelector('a')!.focus();
        });
        await wait(()=>inside(()=>{
            const link=document.querySelector<Field>('#form details.help:not(#private-access-help) a')!.getBoundingClientRect();
            return link.bottom<=document.querySelector<Field>('.actions')!.getBoundingClientRect().top&&link.top>=(document.getElementById('editor-fields') as Field).getBoundingClientRect().top;
        }),'last form content reachable above action bar');await assertActions();
        await inside(()=>document.querySelector<HTMLElement>('#bounds-label .info')!.focus());
        await wait(()=>inside(()=>{
            const tip=document.getElementById('bounds-help')!, box=tip.getBoundingClientRect(), area=(document.getElementById('editor-fields') as Field).getBoundingClientRect();
            return !tip.hidden&&box.top>=area.top&&box.bottom<=area.bottom;
        }),'keyboard tooltip fits above fixed actions');await assertActions();
        await inside(()=>{ document.getElementById('editor-fields')!.scrollTop=0; });
        await wait(()=>inside(()=>(document.getElementById('bounds-help') as Field).hidden),'scrolling fields closes an out-of-view tooltip');await assertActions();
        await inside(()=>{
            document.querySelector<Field>('#form details.help:not(#private-access-help)')!.open=false;(document.getElementById('advanced') as Field).open=false;
        });
        await assertActions();
        disclosureCases++;
    }
    assert.equal(disclosureCases,12);
    await inside(()=>{document.body.style.fontSize='';(document.getElementById('advanced') as Field).open=true;});
    for (const width of [1100, kind === 'firefox' ? 500 : 375]) {
        await viewport(width);
        const controls = await inside(() => ['kind','format','minimum','maximum','scheme','tile-size','bounds'].map(id => {
            const input = document.getElementById(id)!;return { id, available: !!input.getClientRects().length, label: !!document.querySelector(`label[for="${id}"]`) };
        }));assert(controls.every(control => control.available && control.label), 'every relevant saved raster override is available');
        await inside(() => (document.getElementById('scheme') as Field).scrollIntoView({ block: 'center' }));
        if (shots) await shot(path.join(shots, `editor-${kind}-${width}-manual.png`));
    }
    await inside(() => {
        for (const [id, value] of [['minimum','3'],['maximum','15'],['scheme','tms'],['tile-size','512'],['bounds','-124,44,-120,49']]) {
            const field = document.getElementById(id) as Field;field.value = value;field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        (document.getElementById('save') as Field).focus();
    });await editorSave();
    await wait(() => inside(() => (document.getElementById('feedback') as Field).textContent === 'Saved on this device.'), 'manual overrides saved');
    const saved = await evaluate(async () => (await ((window as unknown as ReorderProbe).browser || chrome).runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET' })).registry.sources[0].source as { minNativeZoom: number; maxNativeZoom: number; scheme: string; tileSize: number; bounds: number[]; manualFields: string[] });
    assert.equal(saved.minNativeZoom, 3);assert.equal(saved.maxNativeZoom, 15);assert.equal(saved.scheme,'tms');assert.equal(saved.tileSize,512);assert.deepEqual(saved.bounds,[-124,44,-120,49]);assert.deepEqual(saved.manualFields.sort(),['bounds','scheme','tile-size']);
    await inside(() => (document.getElementById('cancel') as Field).click());
    await click('.custom-layer-row:first-child .custom-layer-actions > button:first-of-type');
    await wait(() => inside(() => (document.getElementById('advanced') as Field).open && (document.getElementById('scheme') as Field).value === 'tms'), 'manual settings are visible after reopening');
    assert.equal(await inside(() => (document.getElementById('maximum') as Field).value),'15');
    console.log(JSON.stringify({ verification: 'custom-layer-settings', kind, version, hidden: true, heights: [900,540], widths: [1100, kind === 'firefox' ? 500 : 375], cases, disclosureCases, themes: ['light','dark'], scales: [1,1.5], matchingCompactDisclosures:true, keyboardDisclosureAnchored:true, footerPinnedAcrossExpansionAndScroll:true, lastContentReachable:true, keyboardTooltipScrollAware:true, actionsAligned: true, reorderPendingErrorRetry: true, opacityAbsent: true, manualOverridesVisibleSavedReopened: true }));
    await resources.dispose();
} catch (error) { await resources.dispose(error as null); }
