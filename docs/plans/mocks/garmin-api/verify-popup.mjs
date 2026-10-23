// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyPopup({ page, origin, output, capture }) {
    const errors = [];
    const onError = error => errors.push(error.message);
    page.on('pageerror', onError);
    let executed = 0;
    const base = `${origin}/docs/plans/mocks/garmin-api/popup.html`;
    const go = async (theme = 'light', context = 'activity', state = 'ready') => {
        await page.goto(`${base}?theme=${theme}&context=${context}&state=${state}`);
        await page.locator('#popup-inbox').waitFor({ state: 'visible' });
        assert.equal(await page.locator('html').getAttribute('data-bpb-theme'), theme);
    };
    const selectFixture = (selector, value) => page.evaluate(({ selector, value }) => {
        const control = document.querySelector(selector);
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
    const box = () => page.evaluate(() => ({
        boxes: ['#popup-inbox', '.brand', '#capture-scene', '#popup-surface', '.demo-controls'].map(selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        }), x: scrollX, y: scrollY,
    }));
    const stable = (a, b) => {
        a.boxes.forEach((rect, i) => Object.keys(rect).forEach(key =>
            assert(Math.abs(rect[key] - b.boxes[i][key]) <= 1, `Popup layout moved: ${i}.${key}`)));
        assert.equal(a.x, b.x); assert.equal(a.y, b.y);
    };
    const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Popup horizontal overflow');
    const shot = async name => {
        if (capture) await page.locator('#popup-surface').screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    };
    try {
        for (const theme of ['light', 'dark']) for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 600 });
            await go(theme);
            const button = page.locator('#popup-inbox');
            assert.equal(await page.locator('#popup-inbox-status').textContent(), 'Your Garmin activities, imported automatically.');
            assert.equal(await page.locator('#popup-capture-title').textContent(), 'Prepare this activity');
            assert.equal(await button.getAttribute('data-opens'), null, 'Opening popup started navigation');
            if (width === 390) await shot(theme === 'light' ? '10-popup-activity' : '11-popup-dark');
            await button.focus();
            const before = await box();
            assert(before.boxes[0].height >= 44, 'Inbox target too small');
            for (const state of ['empty', 'disconnected', 'checking', 'attention', 'expired', 'manual', 'unknown', 'many', 'ready']) {
                await selectFixture('#popup-state', state);
                stable(before, await box());
                assert(await button.evaluate(el => document.activeElement === el), 'Count update moved focus');
                assert.equal(await button.getAttribute('aria-disabled'), null, 'Sync/connection state disabled inbox');
                if (state === 'empty' || state === 'disconnected') assert.equal(await page.locator('#popup-count').isVisible(), false);
                if (state === 'unknown') assert.match(await button.getAttribute('aria-label'), /count unavailable/);
                if (state === 'expired') assert.match(await page.locator('#popup-inbox-status').textContent(), /key expired.*reconnect/);
                if (state === 'manual') assert.doesNotMatch(await page.locator('#popup-inbox-status').textContent(), /automatically/);
                if (state === 'many') {
                    assert.equal(await page.locator('#popup-count').textContent(), '99+');
                    assert.match(await button.getAttribute('aria-label'), /125 pending activities/);
                }
            }
            await selectFixture('#popup-response', 'error');
            await button.press('Enter');
            await page.waitForFunction(() => document.querySelector('#popup-inbox').getAttribute('aria-busy') === 'true');
            stable(before, await box());
            assert(await page.locator('.inbox-spinner').isVisible());
            assert.equal(await page.locator('.inbox-indicator svg').isVisible(), false);
            await button.press('Enter');
            await button.click({ force: true });
            assert.equal(await button.getAttribute('data-opens'), '1', 'Repeated activation started duplicate open');
            await page.waitForFunction(() => document.querySelector('#popup-inbox-status').textContent.startsWith('Couldn’t open inbox'));
            stable(before, await box());
            assert(await button.evaluate(el => document.activeElement === el), 'Open error lost focus');
            assert.equal(await page.locator('.inbox-spinner').isVisible(), false);
            if (theme === 'dark' && width === 390) await shot('12-popup-open-error');
            await selectFixture('#popup-response', 'success');
            await button.press('Space');
            await page.waitForFunction(() => document.querySelector('#popup-inbox')?.getAttribute('aria-busy') === 'true');
            stable(before, await box());
            await page.waitForURL(/index\.html\?inbox=ready#inbox$/);
            await page.locator('[data-screen="inbox"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('.activity').count(), 3, 'Opening cleared pending activity count');
            await noOverflow();
            executed++;
        }
        await page.setViewportSize({ width: 390, height: 600 });
        for (const context of ['unsupported', 'working', 'capture-error']) {
            await go('light', context);
            assert(await page.locator('#popup-inbox').isEnabled());
            if (context === 'unsupported') {
                assert.equal(await page.locator('#popup-capture').isVisible(), false);
                await shot('13-popup-any-site');
            }
            await page.locator('#open-settings').focus();
            await page.keyboard.press('Tab');
            assert(await page.locator('#popup-inbox').evaluate(el => document.activeElement === el), 'Inbox missing from keyboard order');
            await page.locator('#popup-inbox').press('Enter');
            await page.waitForURL(/index\.html\?inbox=ready#inbox$/);
            executed++;
        }
        for (const state of ['empty', 'disconnected']) {
            await go('light', 'unsupported', state);
            if (state === 'disconnected') await shot('14-popup-before-connect');
            await page.locator('#popup-inbox').click();
            await page.waitForURL(new RegExp(`index\\.html\\?inbox=${state}#inbox$`));
            await page.locator('#inbox-empty').waitFor({ state: 'visible' });
            assert.equal(await page.locator('.inbox-list').isVisible(), false);
            if (state === 'disconnected') {
                await page.locator('#inbox-connect').click();
                await page.locator('[data-screen="connect"]').waitFor({ state: 'visible' });
            }
            executed++;
        }
        for (const state of ['expired', 'attention']) {
            await go('dark', 'unsupported', state);
            assert.equal(await page.locator('#popup-count').textContent(), '3');
            if (state === 'expired') await shot('16-popup-expired');
            await page.locator('#popup-inbox').press('Enter');
            await page.waitForURL(new RegExp(`index\\.html\\?inbox=${state}#inbox$`));
            assert.equal(await page.locator('.activity').count(), 3);
            assert.match(await page.locator('#inbox-status').textContent(), /Imports paused; your drafts are safe/);
            await page.locator('#inbox-update-key').click();
            await page.locator('[data-screen="connect"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#connect').textContent(), 'Reconnect Garmin');
            executed++;
        }
        await page.setViewportSize({ width: 390, height: 1000 });
        await go('dark');
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        await noOverflow();
        const enlarged = await box();
        await selectFixture('#popup-state', 'many');
        stable(enlarged, await box());
        assert(await page.locator('#popup-inbox-label').evaluate(el => {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            context.font = getComputedStyle(el).font;
            return context.measureText('Activity').width <= el.clientWidth;
        }), 'Enlarged inbox label splits a word into fragments');
        await shot('15-popup-enlarged');
        await page.locator('#popup-inbox').focus();
        const enlargedFocused = await box();
        await selectFixture('#popup-response', 'error');
        await page.locator('#popup-inbox').press('Enter');
        await page.waitForFunction(() => document.querySelector('#popup-inbox').getAttribute('aria-busy') === 'true');
        stable(enlargedFocused, await box());
        await page.waitForFunction(() => document.querySelector('#popup-inbox-status').textContent.startsWith('Couldn’t open inbox'));
        stable(enlargedFocused, await box());
        assert.equal(executed, 11, 'Unexpected or zero popup cases');
        assert.deepEqual(errors, [], 'Popup prototype errors');
        console.log('Popup mock checks passed: 11 cases; 390/320px light/dark, nine badge/copy states, pending/error/retry navigation, duplicate activation, keyboard focus, empty/setup/reconnect destinations and 200% CSS zoom.');
    } finally { page.off('pageerror', onError); }
}
