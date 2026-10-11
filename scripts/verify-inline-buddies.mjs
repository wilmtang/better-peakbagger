// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, chrome, innerWidth, innerHeight, getComputedStyle */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrowserFixtureServer, projectRoot, waitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

// HTTPS contract fixture, actual unpacked extension and worker, native input.
assertChromeLaunchAllowed();
const resources = createResourceStack();
const profile = await mkdtemp(path.join(os.tmpdir(), 'better-peakbagger-inline-buddies-'));
resources.defer('inline Buddy profile', () => rm(profile, { recursive: true, force: true }));
let failure;
try {
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile, inlineBuddies: true });
    resources.defer('inline Buddy fixture', () => fixture.close());
    const extension = path.join(projectRoot, 'dist');
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [...fixture.chromeTrustArgs, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
    });
    resources.defer('inline Buddy browser', () => context.close());
    const url = `https://www.peakbagger.com:${fixture.port}/climber/climber.aspx?cid=900002&hover=1`;
    const page = await context.newPage();
    await page.goto(url);
    const open = async target => {
        await target.locator('#hover-climber').scrollIntoViewIfNeeded();
        await target.locator('#hover-climber + button').click();
        await target.waitForFunction(() => !document.getElementById('bpb-climber-card').hidden
            && !document.getElementById('bpb-climber-card-buddy').disabled);
    };
    await page.waitForSelector('#hover-climber + button');
    await open(page);
    assert.equal(fixture.requests.buddyMutations, 0);
    await page.locator('#bpb-climber-card-buddy').click();
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-buddy').textContent === 'Remove climbing buddy'
        && document.getElementById('bpb-climber-card-buddy').disabled === false);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async () => {
        await chrome.storage.sync.set({ bpbSettings: { favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved: true } });
    });
    await page.waitForFunction(() => !document.getElementById('bpb-climber-card-favorite').hidden);
    await page.locator('#bpb-climber-card-buddy').click();
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-buddy').textContent === 'Add climbing buddy'
        && document.getElementById('bpb-climber-card-buddy').disabled === false);
    assert.equal(fixture.requests.buddyMutations, 2);

    // Hold a POST to verify another tab cannot overwrite or Ignore its target.
    const other = await context.newPage(); await other.goto(url); await other.waitForSelector('#hover-climber + button');
    await open(other);
    let release, dispatched = false;
    const gate = new Promise(resolve => { release = resolve; });
    resources.defer('held Buddy POST', () => release());
    const intercept = async route => {
        if (route.request().method() === 'POST') { dispatched = true; await gate; }
        await route.continue();
    };
    await context.route('**/climber/climber.aspx?cid=900002', intercept);
    await page.locator('#bpb-climber-card-buddy').click();
    await other.waitForFunction(() => document.getElementById('bpb-climber-card-buddy').textContent === 'Check buddy status'
        && document.getElementById('bpb-climber-card-ignore').disabled);
    await waitForCondition(() => dispatched, { description: 'held Buddy POST dispatch' });
    await other.locator('#bpb-climber-card-buddy').click();
    await other.waitForFunction(() => document.querySelector('.bpb-climber-card-feedback').textContent.includes('another tab'));
    release();
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-buddy').textContent === 'Remove climbing buddy'
        && document.getElementById('bpb-climber-card-favorite').textContent === 'Remove favorite climber'
        && document.getElementById('bpb-climber-card-buddy').disabled === false);
    await context.unroute('**/climber/climber.aspx?cid=900002', intercept);
    assert.equal(fixture.requests.buddyMutations, 3);

    const output = process.env.BPB_BUDDY_SCREENSHOTS;
    if (output) {
        await mkdir(output, { recursive: true });
        for (const [width, theme] of [[1000, 'light'], [320, 'dark']]) {
            await page.setViewportSize({ width, height: 760 });
            await page.locator('#hover-climber').scrollIntoViewIfNeeded();
            if (await page.locator('#bpb-climber-card').isHidden()) await open(page);
            await page.evaluate(theme => { document.documentElement.dataset.bpbTheme = theme; }, theme);
            await page.waitForFunction(() => {
                const card = document.getElementById('bpb-climber-card'), rect = card.getBoundingClientRect();
                return !card.hidden && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
                    && card.scrollWidth <= card.clientWidth + 1 && getComputedStyle(card).opacity === '1'
                    && card.getAnimations().every(animation => animation.playState === 'finished');
            });
            await page.screenshot({ path: path.join(output, `buddy-added-${width}-${theme}.png`) });
        }
    }
    await page.locator('#bpb-climber-card-buddy').click();
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-buddy').textContent === 'Add climbing buddy'
        && document.getElementById('bpb-climber-card-favorite').textContent === 'Add favorite climber'
        && document.getElementById('bpb-climber-card-buddy').disabled === false);
    assert.equal(fixture.requests.buddyMutations, 4);
    const state = await worker.evaluate(async () => chrome.storage.local.get(['bpbBuddyIntents', 'bpbBuddyCache']));
    assert.deepEqual(state.bpbBuddyIntents, []);
    assert.deepEqual(state.bpbBuddyCache.entries, []);
    await page.locator('#AddBuddy').click();
    await page.waitForFunction(() => document.getElementById('RemoveBuddy')?.disabled === false);
    await page.locator('#RemoveBuddy').click();
    await page.waitForFunction(() => document.getElementById('AddBuddy')?.disabled === false);
    assert.equal(fixture.requests.buddyMutations, 6);
    console.log(JSON.stringify({ browser: context.browser().version(), hidden: true,
        surface: 'native HTML/CSS; no WebGL', viewports: ['1000x760 light', '320x760 dark'],
        buddyPosts: fixture.requests.buddyMutations, checks: 'inline/native add/remove, shared worker, cross-tab race, favorites reconciliation' }));
} catch (error) { failure = error; }
finally { await resources.dispose(failure); }
assert.equal(existsSync(profile), false);
console.log(JSON.stringify({ cleanup: 'browser/server closed and profile/certificate removed', profile }));
