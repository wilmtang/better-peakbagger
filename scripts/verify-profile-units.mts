// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Chrome loads real dist; Firefox renders its bundle with settings APIs stubbed.
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { firefox, type BrowserContext, type Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { units } from '../src/ui/units.js';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { createVerificationRoot, launchVerificationChrome, PEAKBAGGER_HOST_RULE } from './verification-launch.mts';

const [browserName, mode, ...extra] = process.argv.slice(2);
assert.ok(['chrome', 'firefox'].includes(browserName) && (!mode || mode === '--baseline') && !extra.length,
    'Usage: node scripts/verify-profile-units.mts chrome|firefox [--baseline]');
const output = process.env.BPB_PROFILE_UNITS_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const resources = createResourceStack();
let failure: unknown = null;
try {
    const profile = await createVerificationRoot(resources, 'bpb-profile-units-', 'profile units test profile');
    // Preserve the required helper option despite its incomplete JS-inferred signature.
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile } as never);
    resources.defer('profile units HTTPS fixture', () => fixture.close());
    let context: BrowserContext, settingsPage: Page | undefined;
    if (browserName === 'chrome') {
        context = await launchVerificationChrome(resources, 'profile units Chrome', profile, {
            viewport: { width: 1280, height: 900 }, trustArgs: fixture.chromeTrustArgs,
            extension: path.resolve('dist'), hosts: [PEAKBAGGER_HOST_RULE],
        });
        settingsPage = await context.newPage();
        await settingsPage.goto('chrome://extensions-internals/');
        const record = await settingsPage.waitForFunction(() => {
            try { return JSON.parse(document.body.innerText).find((item: { name: string; id: string }) => item.name === 'Better Peakbagger'); }
            catch { return false; }
        }).then(handle => handle.jsonValue());
        await settingsPage.goto(`chrome-extension://${record.id}/options/options.html`);
    } else {
        const browser = await firefox.launch({ headless: true,
            firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        resources.defer('profile units Firefox', () => browser.close());
        context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
        await context.addInitScript(() => {
            type Listener = (changes: object, area: string) => void;
            const listeners: Listener[] = [];
            let settings = {};
            (window as unknown as { chrome: unknown }).chrome = {
                storage: { sync: { get: async () => ({ bpbSettings: settings }), set: async (value: { bpbSettings: object }) => {
                    settings = value.bpbSettings;
                    for (const listener of listeners) listener({ bpbSettings: { newValue: settings } }, 'sync');
                } }, local: { get: async () => ({}) },
                onChanged: { addListener: (listener: Listener) => listeners.push(listener), removeListener() {} } },
            };
        });
    }
    const html = await readFile('test/fixtures/pages/climber-home.html', 'utf8');
    const metric = new JSDOM(html);
    for (const heading of metric.window.document.querySelectorAll('#StatsLabel th')) {
        if (!/^(Elev|Prom)-ft$/.test(heading.textContent || '')) continue;
        const cellIndex = (heading as HTMLTableCellElement).cellIndex;
        for (const row of [...heading.closest('table')!.rows].slice((heading.parentElement as HTMLTableRowElement).rowIndex + 1)) {
            const cell = row.cells[cellIndex];
            cell.textContent = (Number(cell.textContent!.replaceAll(',', '')) / units.FEET_PER_METER).toFixed(1);
        }
        heading.textContent = heading.textContent!.replace('-ft', '-m');
    }
    const metricHtml = metric.serialize();
    metric.window.close();
    await context.route('**/climber/climber.aspx**', route => {
        assert.equal(route.request().method(), 'GET');
        return route.fulfill({ contentType: 'text/html',
            body: new URL(route.request().url()).searchParams.get('native') === 'metric' ? metricHtml : html });
    });
    const page = await context.newPage();
    await page.goto(`https://www.peakbagger.com:${fixture.port}/climber/climber.aspx?cid=900002`);
    if (browserName === 'firefox') {
        await page.addScriptTag({ path: 'dist/content/theme.js' });
        await page.addScriptTag({ path: 'dist/content/profile-units.js' });
    }
    const apply = (patch: object) => (settingsPage || page).evaluate(async next => {
        await chrome.storage.sync.set({ bpbSettings: { units: 'auto', elevationUnits: 'default', theme: 'light', ...next } });
    }, patch);
    const heading = page.locator('#StatsLabel th').filter({ hasText: /^Elev-/ });
    const prominent = page.locator('#StatsLabel th').filter({ hasText: /^Prom-/ });
    const expectUnits = async (unit: string) => {
        await page.waitForFunction(expected => [...document.querySelectorAll('#StatsLabel th')]
            .some(node => node.textContent === `Elev-${expected}`), unit, { timeout: 3000 }).catch(() => {});
        assert.equal(await heading.textContent(), `Elev-${unit}`, 'profile elevation header must follow BPB elevation preference');
        assert.equal(await prominent.textContent(), `Prom-${unit}`, 'profile prominence header must follow BPB elevation preference');
    };
    await apply({ units: 'metric' });
    await page.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'light');
    if (mode === '--baseline') {
        await assert.rejects(() => expectUnits('m'), /profile elevation header must follow BPB elevation preference/);
        console.log(JSON.stringify({ browser: browserName, hidden: true, result: 'expected native ft versus requested m regression reproduced' }));
    } else {
        await expectUnits('m');
        assert.equal(await heading.locator('xpath=../following-sibling::tr[1]/td[2]').textContent(), '4420');
        const geometry = () => page.evaluate(() => {
            const box = (node: Element) => {
                const { x, y, width, height } = node.getBoundingClientRect();
                return { x: x + scrollX, y: y + scrollY, width, height };
            };
            const stats = document.getElementById('StatsLabel')!;
            return { heading: box(stats.querySelector('h2')!), panel: box(stats),
                following: box(stats.querySelector('table:last-of-type')!), scrollX, scrollY };
        });
        let cases = 0;
        for (const nativeUnits of ['imperial', 'metric']) {
            await page.goto(`https://www.peakbagger.com:${fixture.port}/climber/climber.aspx?cid=900002&native=${nativeUnits}`);
            if (browserName === 'firefox') {
                await page.addScriptTag({ path: 'dist/content/theme.js' });
                await page.addScriptTag({ path: 'dist/content/profile-units.js' });
            }
            const displayUnits = nativeUnits === 'metric' ? 'imperial' : 'metric';
            for (const width of [1280, 720]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
                await page.setViewportSize({ width: width / zoom, height: 900 / zoom });
                await apply({ units: displayUnits, theme });
                await expectUnits(displayUnits === 'metric' ? 'm' : 'ft');
                assert.equal(await heading.locator('xpath=../following-sibling::tr[1]/td[2]').textContent(), displayUnits === 'metric' ? '4420' : '14501');
                assert.equal(await prominent.locator('xpath=../following-sibling::tr[1]/td[2]').textContent(), displayUnits === 'metric' ? '4036' : '13241');
                await page.waitForFunction(expected => document.documentElement.dataset.bpbTheme === expected, theme);
                await heading.scrollIntoViewIfNeeded();
                const before = await geometry();
                for (const [patch, expected] of [[{ units: 'imperial' }, 'ft'], [{ units: 'metric', elevationUnits: 'imperial' }, 'ft'],
                    [{ units: 'imperial', elevationUnits: 'metric' }, 'm'], [{ units: 'auto' }, nativeUnits === 'metric' ? 'm' : 'ft']] as const) {
                    await apply({ ...patch, theme });
                    await expectUnits(expected);
                    assert.deepEqual(await geometry(), before, 'changing profile units must keep the panel and reading position stable');
                }
                await apply({ units: displayUnits, theme });
                await expectUnits(displayUnits === 'metric' ? 'm' : 'ft');
                assert.deepEqual(await geometry(), before, 'unit round trips must restore the table and reading position');
                if (output) await page.screenshot({ path: path.join(output, `${browserName}-${displayUnits}-${theme}-${width}-${zoom}.png`) });
                cases++;
            }
        }
        assert.equal(cases, 16);
        console.log(JSON.stringify({ browser: browserName, version: context.browser()?.version(), hidden: true,
            cases, viewports: [1280, 720], height: 900, zoomReflow: [1, 2], themes: ['light', 'dark'],
            extension: browserName === 'chrome' ? 'real unpacked dist' : 'shipped bundles; settings APIs stubbed' }));
    }
} catch (error) { failure = error; }
await resources.dispose(failure as null);
