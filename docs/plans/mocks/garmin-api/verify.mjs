// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyAndCapture({ page, origin, output, capture }) {
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `${origin}/docs/plans/mocks/garmin-api/index.html`;
    let scene = 0;
    const go = async screen => {
        // Hash-only navigation preserves form state. Every capture/test scene
        // needs a new document, including native checkbox defaults and focus.
        await page.goto(`${base}?scene=${++scene}#${screen}`);
        await page.locator(`[data-screen="${screen}"]`).waitFor({ state: 'visible' });
        await page.locator('#theme').selectOption('light');
    };
    const shot = async name => {
        if (capture) await page.locator('.app').screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    };
    const noOverflow = async () => {
        const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
        assert(dimensions.scroll <= dimensions.width + 1, `Horizontal overflow: ${JSON.stringify(dimensions)}`);
    };
    const geometry = async selectors => page.evaluate(selectors => ({
        boxes: selectors.map(selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }), scroll: { x: scrollX, y: scrollY },
    }), selectors);
    const stable = (before, after) => {
        before.boxes.forEach((box, i) => Object.keys(box).forEach(key => {
            assert(Math.abs(box[key] - after.boxes[i][key]) <= 1, `Layout moved: ${i}.${key} ${box[key]} → ${after.boxes[i][key]}`);
        }));
        assert.deepEqual(after.scroll, before.scroll, 'Reading position moved');
    };
    const checkSync = async (theme, width) => {
        await page.setViewportSize({ width, height: width === 390 ? 1000 : 900 });
        await go('inbox');
        await page.locator('#theme').selectOption(theme);
        await page.locator('#response').selectOption('error');
        const button = page.locator('#inbox-check');
        await button.focus();
        const selectors = ['#inbox-check', '[data-screen="inbox"] h1', '.inbox-list', '.inbox-footer'];
        const before = await geometry(selectors);
        await button.press('Enter');
        await page.waitForFunction(() => document.querySelector('#inbox-check').getAttribute('aria-busy') === 'true');
        stable(before, await geometry(selectors));
        assert(await button.evaluate(el => document.activeElement === el), 'Busy action lost keyboard focus');
        await button.press('Enter');
        if (theme === 'light' && width === 1180) await shot('03b-inbox-checking');
        await page.waitForFunction(() => document.querySelector('#inbox-status').textContent.startsWith('Could not reach Garmin.'));
        stable(before, await geometry(selectors));
        assert(await button.evaluate(el => document.activeElement === el), 'Error moved keyboard focus');
        if (theme === 'dark' && width === 390) await shot('06-narrow-dark-error');
        await page.locator('#response').selectOption('success');
        await button.focus();
        const retryBefore = await geometry(selectors);
        await button.press('Space');
        await page.waitForFunction(() => document.querySelector('#inbox-check').getAttribute('aria-busy') === 'true');
        stable(retryBefore, await geometry(selectors));
        await page.waitForFunction(() => document.querySelector('#inbox-status').textContent.startsWith('Checked just now'));
        stable(retryBefore, await geometry(selectors));
        await noOverflow();
    };

    await page.setViewportSize({ width: 1180, height: 900 });
    await go('connect');
    await shot('01-connect');
    await page.locator('#show-key').click();
    assert.equal(await page.locator('#personal-key').getAttribute('type'), 'text');
    await page.locator('#response').selectOption('error');
    await page.locator('#connect').focus();
    const connectSelectors = ['#connect', '.connection', '[data-screen="connect"] .footnote'];
    const connectBefore = await geometry(connectSelectors);
    await page.locator('#connect').press('Enter');
    await page.waitForFunction(() => document.querySelector('#connect').getAttribute('aria-busy') === 'true');
    stable(connectBefore, await geometry(connectSelectors));
    await page.waitForFunction(() => document.querySelector('#connect-status').textContent.startsWith('Could not reach Garmin'));
    stable(connectBefore, await geometry(connectSelectors));
    await page.locator('#response').selectOption('success');
    await page.locator('#connect').click();
    await page.waitForFunction(() => location.hash === '#settings');
    assert.equal(await page.locator('#settings-primary').textContent(), 'Enable Garmin drafts');
    await page.locator('#settings-primary').click();
    await shot('02-schedule');
    await page.locator('#frequency').selectOption('manual');
    assert.match(await page.locator('#settings-status').textContent(), /Automatic checks are off/);
    await page.locator('#settings-check').focus();
    const settingsSelectors = ['#settings-check', '[data-screen="settings"] .card', '.connection-details'];
    const settingsBefore = await geometry(settingsSelectors);
    await page.locator('#settings-check').press('Enter');
    await page.waitForFunction(() => document.querySelector('#settings-check').getAttribute('aria-busy') === 'true');
    stable(settingsBefore, await geometry(settingsSelectors));
    await page.waitForFunction(() => document.querySelector('#settings-status').textContent.startsWith('Checked just now'));
    stable(settingsBefore, await geometry(settingsSelectors));
    await page.locator('#frequency').selectOption('custom');
    assert(await page.locator('#custom-row').isVisible());
    await page.locator('#custom-hours').fill('0');
    assert.match(await page.locator('#settings-status').textContent(), /Enter a whole number/);
    await page.locator('#custom-hours').fill('6');
    assert.match(await page.locator('#settings-status').textContent(), /every 6 hours/);
    await go('inbox');
    await shot('03-inbox');
    await go('review');
    assert.equal(await page.locator('.summit-check:checked').count(), 2);
    await shot('04-review');
    await page.locator('.summit-check').nth(2).check();
    assert.equal(await page.locator('#open-drafts').textContent(), 'Open 3 drafts');
    for (const checkbox of await page.locator('.summit-check').all()) await checkbox.uncheck();
    // Exercise the JS activation guard; normal Playwright clicks correctly
    // refuse an aria-disabled control before dispatching its click handler.
    await page.locator('#open-drafts').click({ force: true });
    assert.equal(await page.locator('#open-drafts').getAttribute('aria-busy'), null);
    await page.locator('.summit-check').first().check();
    await page.locator('#open-drafts').focus();
    const reviewSelectors = ['#open-drafts', '.review-grid', '.review-actions'];
    const reviewBefore = await geometry(reviewSelectors);
    await page.locator('#open-drafts').press('Enter');
    await page.waitForFunction(() => document.querySelector('#open-drafts').getAttribute('aria-busy') === 'true');
    stable(reviewBefore, await geometry(reviewSelectors));
    await page.waitForFunction(() => document.querySelector('#review-status').textContent.startsWith('Drafts are ready'));
    stable(reviewBefore, await geometry(reviewSelectors));
    await go('export');
    const exportBefore = await geometry(['#export-settings', '.export-card', '.import-note']);
    await page.locator('#include-credentials').check();
    stable(exportBefore, await geometry(['#export-settings', '.export-card', '.import-note']));
    await shot('05-export-key');
    await page.locator('#export-settings').click();
    stable(exportBefore, await geometry(['#export-settings', '.export-card', '.import-note']));
    assert.match(await page.locator('#export-status').textContent(), /including saved credentials/);

    for (const theme of ['light', 'dark']) {
        for (const width of [1180, 390]) await checkSync(theme, width);
    }
    await page.setViewportSize({ width: 390, height: 1000 });
    for (const screen of ['connect', 'settings', 'review', 'export']) {
        await go(screen);
        await page.locator('#theme').selectOption('dark');
        await noOverflow();
        if (screen === 'review') await shot('07-narrow-dark-review');
    }
    await page.setViewportSize({ width: 1180, height: 900 });
    await go('settings');
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await noOverflow();
    await page.locator('#frequency').selectOption('manual');
    assert.match(await page.locator('#settings-status').textContent(), /Automatic checks are off/);
    // Full-page stitching with CSS zoom can repeat tiles in Chromium. Inspect
    // the viewport and then explicitly reveal the lower action instead.
    if (capture) await page.screenshot({ path: path.join(output, '08-enlarged-settings.png') });
    await page.locator('#settings-primary').scrollIntoViewIfNeeded();
    assert(await page.locator('#settings-primary').isVisible());
    if (capture) await page.screenshot({ path: path.join(output, '09-enlarged-settings-actions.png') });
    assert.deepEqual(errors, [], 'Prototype page errors');
    console.log('Mock checks passed: five screens; connection/consent, schedule, selection, credential export; four inbox theme/viewport combinations with busy/error/retry geometry and keyboard focus; narrow screens; 200% CSS zoom.');
}
