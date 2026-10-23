// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyAuth({ page, origin, output, capture }) {
    const keyUrl = 'https://connect.garmin.com/app/settings/personalApiToken';
    const errors = [];
    const onError = error => errors.push(error.message);
    page.on('pageerror', onError);
    let cases = 0;
    const go = async (screen, query = '') => {
        await page.goto(`${origin}/docs/plans/mocks/garmin-api/index.html?auth-test=${++cases}${query}#${screen}`);
        await page.locator(`[data-screen="${screen}"]`).waitFor({ state: 'visible' });
    };
    // Fixture controls represent a background response without scrolling the product.
    const set = (selector, value) => page.evaluate(({ selector, value }) => {
        const el = document.querySelector(selector); el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
    const geometry = selectors => page.evaluate(selectors => ({
        boxes: selectors.map(s => {
            const r = document.querySelector(s).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        }), scroll: [scrollX, scrollY],
    }), selectors);
    const stable = (a, b) => {
        a.boxes.forEach((r, i) => Object.keys(r).forEach(k => assert(Math.abs(r[k] - b.boxes[i][k]) <= 1, `Auth layout moved: ${i}.${k}`)));
        assert.deepEqual(a.scroll, b.scroll, 'Auth reading position moved');
    };
    const shot = async name => {
        if (capture) await page.locator('.app').screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    };
    const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Auth horizontal overflow');
    const waitStatus = prefix => page.waitForFunction(prefix => document.querySelector('#connect-status').textContent.startsWith(prefix), prefix);
    try {
        await page.setViewportSize({ width: 1180, height: 900 });
        await go('connect');
        const link = page.locator('#get-garmin-key');
        assert.equal(await link.getAttribute('href'), keyUrl);
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.match(await link.getAttribute('rel'), /noopener/);
        assert.match(await page.locator('#key-note').textContent(), /up to one year/);
        // Verify user-initiated navigation without making a request to Garmin.
        await page.context().route(keyUrl, route => route.fulfill({ contentType: 'text/html', body: '<title>Intercepted key page</title>' }));
        try {
            const [tab] = await Promise.all([page.waitForEvent('popup'), link.click()]);
            try { await tab.waitForURL(keyUrl); } finally { await tab.close(); }
        } finally { await page.context().unroute(keyUrl); }

        for (const theme of ['light', 'dark']) for (const width of [1180, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 1000 : 900 });
            await go('settings');
            await set('#theme', theme);
            if (width === 390) await set('#frequency', 'manual');
            const frequency = await page.locator('#frequency').inputValue();
            const history = await page.locator('#history').inputValue();
            await page.locator('[data-nav="inbox"]').click();
            await page.locator('[data-screen="inbox"]').waitFor({ state: 'visible' });
            await set('#response', 'expired');
            const check = page.locator('#inbox-check');
            await check.focus();
            const selectors = ['#inbox-check', '[data-screen="inbox"] h1', '.inbox-list', '.inbox-footer'];
            const before = await geometry(selectors);
            await check.press('Enter');
            await page.waitForFunction(() => document.querySelector('#inbox-check').getAttribute('aria-busy') === 'true');
            stable(before, await geometry(selectors));
            await page.waitForFunction(() => document.querySelector('#inbox-status').textContent.startsWith('Garmin API key expired.'));
            stable(before, await geometry(selectors));
            assert(await check.evaluate(el => document.activeElement === el), 'Expiry moved keyboard focus');
            await check.press('Space'); await check.click({ force: true });
            assert.equal(await check.getAttribute('data-runs'), '1', 'Expired key was retried');
            assert.equal(await page.locator('.activity:visible').count(), 3);
            assert(await page.locator('.activity a').first().isEnabled());
            if (theme === 'light' && width === 1180) await shot('17-expired-inbox');
            if (theme === 'dark' && width === 390) await shot('20-expired-inbox-narrow');

            await page.locator('#inbox-update-key').click();
            await page.locator('[data-screen="connect"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#connect-title').textContent(), 'Update your Garmin key');
            assert(await page.locator('#get-garmin-key').isVisible());
            if (theme === 'light' && width === 1180) await shot('18-reconnect');
            await set('#response', 'rejected');
            const connect = page.locator('#connect'); await connect.focus();
            const formSelectors = ['#connect', '.connection', '#connect-title', '[data-screen="connect"] .footnote'];
            const form = await geometry(formSelectors);
            await connect.press('Enter');
            await page.waitForFunction(() => document.querySelector('#connect').getAttribute('aria-busy') === 'true');
            stable(form, await geometry(formSelectors));
            await connect.press('Enter'); await connect.click({ force: true });
            assert.equal(await connect.getAttribute('data-runs'), '1', 'Replacement was submitted twice');
            await waitStatus('Garmin didn’t accept');
            stable(form, await geometry(formSelectors));
            assert.equal(await page.locator('#personal-key').getAttribute('aria-invalid'), 'true');
            assert.equal(await page.locator('#connection-state').inputValue(), 'expired');
            assert(await connect.evaluate(el => document.activeElement === el), 'Rejected replacement moved focus');
            if (theme === 'light' && width === 1180) await shot('19-reconnect-error');
            await set('#response', 'error'); await connect.press('Enter');
            await waitStatus('Could not reach Garmin');
            stable(form, await geometry(formSelectors));
            assert.equal(await page.locator('#personal-key').getAttribute('aria-invalid'), null, 'Network error blamed the key');
            await set('#response', 'success'); await connect.press('Space');
            await page.waitForFunction(() => location.hash === '#inbox');
            assert.equal(await page.locator('#connection-state').inputValue(), 'active');
            assert.equal(await page.locator('#frequency').inputValue(), frequency);
            assert.equal(await page.locator('#history').inputValue(), history);
            assert.equal(await page.locator('.activity:visible').count(), 3);
            assert.equal(await page.locator('#inbox-update-key').isVisible(), false);
            assert.equal(await check.getAttribute('aria-disabled'), null);
            if (frequency === 'manual') assert.doesNotMatch(await page.locator('#inbox-lede').textContent(), /automatically/);
            await noOverflow();
        }

        await go('inbox');
        await set('#response', 'rejected'); await page.locator('#inbox-check').click();
        await page.waitForFunction(() => document.querySelector('#inbox-status').textContent.startsWith('Garmin needs a new API key.'));
        assert.doesNotMatch(await page.locator('#inbox-status').textContent(), /expired/);
        await go('settings');
        await page.locator('.connection-details summary').click();
        await page.locator('#replace-key').click();
        await page.locator('[data-screen="connect"]').waitFor({ state: 'visible' });
        await set('#response', 'rejected'); await page.locator('#connect').click();
        await waitStatus('Garmin didn’t accept');
        assert.equal(await page.locator('#connection-state').inputValue(), 'active', 'Invalid new key replaced the working connection');

        await page.setViewportSize({ width: 390, height: 1000 });
        await go('connect', '&connection=expired');
        await set('#theme', 'dark');
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        await noOverflow();
        if (capture) await page.locator('[data-screen="connect"]').screenshot({ path: path.join(output, '21-reconnect-enlarged.png') });
        assert.equal(cases, 8, 'Unexpected or zero auth cases');
        assert.deepEqual(errors, [], 'Auth prototype errors');
        console.log('Key recovery mock checks passed: 8 cases; real key-link target with intercepted navigation; expiry/rejection, paused retries, retained drafts/settings, replacement failure/offline/success, stable geometry/focus in both themes at 1180/390px, and 200% CSS zoom.');
    } finally { page.off('pageerror', onError); }
}
