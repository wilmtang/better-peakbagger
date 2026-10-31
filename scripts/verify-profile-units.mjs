// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Chrome loads real dist; Firefox renders its bundle with settings APIs stubbed.
/* global document, window, chrome, scrollX, scrollY */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { JSDOM } from 'jsdom';
import { units } from '../src/ui/units.js';
import { createBrowserFixtureServer } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

const [browserName, mode, ...extra] = process.argv.slice(2);
assert.ok(['chrome', 'firefox'].includes(browserName) && (!mode || mode === '--baseline') && !extra.length,
    'Usage: node scripts/verify-profile-units.mjs chrome|firefox [--baseline]');
const output = process.env.BPB_PROFILE_UNITS_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const resources = createResourceStack();
let failure;
try {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-profile-units-'));
    resources.defer('profile units test profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('profile units HTTPS fixture', () => fixture.close());
    let context, settingsPage;
    if (browserName === 'chrome') {
        assertChromeLaunchAllowed();
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
            args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${path.resolve('dist')}`,
                `--load-extension=${path.resolve('dist')}`,
                '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
        });
        resources.defer('profile units Chrome', () => context.close());
        settingsPage = await context.newPage();
        await settingsPage.goto('chrome://extensions-internals/');
        const record = await settingsPage.waitForFunction(() => {
            try { return JSON.parse(document.body.innerText).find(item => item.name === 'Better Peakbagger'); }
            catch { return false; }
        }).then(handle => handle.jsonValue());
        await settingsPage.goto(`chrome-extension://${record.id}/options/options.html`);
    } else {
        const browser = await firefox.launch({ headless: true,
            firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        resources.defer('profile units Firefox', () => browser.close());
        context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
        await context.addInitScript(() => {
            const listeners = [];
            let settings = {};
            window.chrome = {
                storage: { sync: { get: async () => ({ bpbSettings: settings }), set: async value => {
                    settings = value.bpbSettings;
                    for (const listener of listeners) listener({ bpbSettings: { newValue: settings } }, 'sync');
                } }, local: { get: async () => ({}) },
                onChanged: { addListener: listener => listeners.push(listener), removeListener() {} } },
            };
        });
    }
    const html = await readFile('test/fixtures/pages/climber-home.html', 'utf8');
    const metric = new JSDOM(html);
    for (const heading of metric.window.document.querySelectorAll('#StatsLabel th')) {
        if (!/^(Elev|Prom)-ft$/.test(heading.textContent)) continue;
        for (const row of [...heading.closest('table').rows].slice(heading.parentElement.rowIndex + 1)) {
            const cell = row.cells[heading.cellIndex];
            cell.textContent = (Number(cell.textContent.replaceAll(',', '')) / units.FEET_PER_METER).toFixed(1);
        }
        heading.textContent = heading.textContent.replace('-ft', '-m');
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
    const apply = patch => (settingsPage || page).evaluate(async patch => {
        await chrome.storage.sync.set({ bpbSettings: { units: 'auto', elevationUnits: 'default', theme: 'light', ...patch } });
    }, patch);
    const heading = page.locator('#StatsLabel th').filter({ hasText: /^Elev-/ });
    const prominent = page.locator('#StatsLabel th').filter({ hasText: /^Prom-/ });
    const expectUnits = async unit => {
        await page.waitForFunction(unit => [...document.querySelectorAll('#StatsLabel th')]
            .some(node => node.textContent === `Elev-${unit}`), unit, { timeout: 3000 }).catch(() => {});
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
            const box = node => {
                const { x, y, width, height } = node.getBoundingClientRect();
                return { x: x + scrollX, y: y + scrollY, width, height };
            };
            const stats = document.getElementById('StatsLabel');
            return { heading: box(stats.querySelector('h2')), panel: box(stats),
                following: box(stats.querySelector('table:last-of-type')), scrollX, scrollY };
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
                await page.waitForFunction(theme => document.documentElement.dataset.bpbTheme === theme, theme);
                await heading.scrollIntoViewIfNeeded();
                const before = await geometry();
                for (const [patch, expected] of [[{ units: 'imperial' }, 'ft'], [{ units: 'metric', elevationUnits: 'imperial' }, 'ft'],
                    [{ units: 'imperial', elevationUnits: 'metric' }, 'm'], [{ units: 'auto' }, nativeUnits === 'metric' ? 'm' : 'ft']]) {
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
await resources.dispose(failure);
