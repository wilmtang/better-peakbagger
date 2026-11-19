/// <reference lib="dom" />
/// <reference types="chrome" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite, type DomCase, type DomContext } from '../../../scripts/dom-tier.mts';

type Outcome = 'denied' | 'error' | 'granted';

interface Request {
    permission: chrome.permissions.Permissions;
    active: boolean;
}

interface AccessFixtureWindow extends Window {
    providerAccess: {
        requests: Request[];
        clickRequestCounts: number[];
        closes: number;
        notifications: [tabId: number, message: unknown][];
        finish: ((outcome: Outcome) => void) | null;
    };
}

function installAccessFixture(buttonId: string) {
    const fixture: AccessFixtureWindow['providerAccess'] = {
        requests: [], clickRequestCounts: [], closes: 0, notifications: [], finish: null,
    };
    const ext = globalThis.browser || globalThis.chrome;
    Object.assign(ext.permissions, {
        request: (permission: chrome.permissions.Permissions) => {
            fixture.requests.push({ permission: structuredClone(permission), active: navigator.userActivation.isActive });
            return new Promise<boolean>((resolve, reject) => {
                fixture.finish = outcome => {
                    fixture.finish = null;
                    if (outcome === 'error') reject(new Error('fixture browser error'));
                    else resolve(outcome === 'granted');
                };
            });
        },
    });
    Object.assign(ext.tabs, {
        async sendMessage(tabId: number, message: unknown) {
            fixture.notifications.push([tabId, structuredClone(message)]);
        },
    });
    document.addEventListener('click', event => {
        if (event.isTrusted && event.target instanceof HTMLElement && event.target.id === buttonId) {
            fixture.clickRequestCounts.push(fixture.requests.length);
        }
    });
    window.close = () => { fixture.closes++; };
    (window as unknown as AccessFixtureWindow).providerAccess = fixture;
}

async function openPackagedAccess({ page, open, route, built }: DomContext, provider: string, search = '') {
    const pagePath = `/dist/${provider}/access.html`;
    const fixturePath = '/test/provider-access-fixture.js';
    const buttonId = `allow-${provider}`;
    const html = (await built(`${provider}/access.html`)).toString('utf8');
    const headScript = '<script src="access-head.js"></script>';
    assert.equal(html.split(headScript).length, 2, 'the packaged head script must be present');
    // Install the probes before either shipped script can request permission.
    await route(fixturePath, `(${installAccessFixture.toString()})(${JSON.stringify(buttonId)});`, 'text/javascript');
    await route(pagePath, html.replace(headScript, `<script src="${fixturePath}"></script>\n${headScript}`));
    await open(`${pagePath}${search}`);
    const button = page.locator(`#${buttonId}`);
    const status = page.getByRole('status');
    await button.waitFor();
    const state = () => page.evaluate(() => {
        const { requests, clickRequestCounts, closes, notifications } = (window as unknown as AccessFixtureWindow).providerAccess;
        return { requests, clickRequestCounts, closes, notifications };
    });
    const finish = (outcome: Outcome) => page.evaluate(resolution => {
        const fixture = (window as unknown as AccessFixtureWindow).providerAccess;
        if (!fixture.finish) throw new Error('No permission request is pending');
        fixture.finish(resolution);
    }, outcome);
    return { button, status, state, finish };
}

const bcLandAccess: DomCase = {
    name: 'BC parcel maps guards duplicate activation and notifies only the source tab',
    viewport: { width: 390, height: 760 },
    async run(context) {
        const { page } = context;
        const { button, status, state, finish } = await openPackagedAccess(context, 'bc-land', '?tab=7');
        assert.equal((await state()).requests.length, 0, 'opening BC access must leave permissions untouched');
        assert.deepEqual((await state()).notifications, []);
        await button.focus();
        await button.evaluate((element: HTMLButtonElement) => element.click());
        assert.equal((await state()).requests.length, 0, 'synthetic BC access must leave permissions untouched');

        await page.keyboard.press('Enter');
        await status.filter({ hasText: 'Waiting for the browser' }).waitFor();
        assert.equal(await button.getAttribute('aria-disabled'), 'true');
        assert.equal(await button.evaluate((element: HTMLButtonElement) => element.disabled), false);
        assert.ok(await button.evaluate(element => document.activeElement === element));
        await page.keyboard.press('Enter');
        const pending = await state();
        assert.deepEqual(pending.requests, [{ permission: { origins: ['https://maps.gov.bc.ca/*'] }, active: true }]);
        assert.deepEqual(pending.clickRequestCounts, [1, 1], 'both trusted clicks reach the busy guard');
        assert.deepEqual(pending.notifications, []);

        await finish('denied');
        await status.filter({ hasText: 'Access not granted. Try again.' }).waitFor();
        await page.locator('#allow-bc-land[aria-disabled="false"]').waitFor();
        assert.equal(await button.textContent(), 'Allow access');
        assert.deepEqual((await state()).notifications, []);

        await page.keyboard.press('Enter');
        await status.filter({ hasText: 'Waiting for the browser' }).waitFor();
        await finish('granted');
        await status.filter({ hasText: 'Access enabled.' }).waitFor();
        await page.locator('#allow-bc-land[aria-disabled="false"]').waitFor();
        assert.equal(await button.textContent(), 'Return to map');
        assert.ok(await button.evaluate(element => document.activeElement === element));
        const granted = await state();
        assert.deepEqual(granted.requests, [pending.requests[0], pending.requests[0]]);
        assert.deepEqual(granted.notifications, [[7, { type: 'BC_LAND_PERMISSION_GRANTED' }]]);
        assert.equal(granted.closes, 0);

        await button.evaluate((element: HTMLButtonElement) => element.click());
        assert.equal((await state()).closes, 0);
        await page.keyboard.press('Enter');
        const returned = await state();
        assert.equal(returned.closes, 1);
        assert.deepEqual(returned.requests, granted.requests);
        assert.deepEqual(returned.notifications, granted.notifications);
    },
};

const providers = [
    ['gaia', 'Gaia', 'https://www.gaiagps.com/*'],
    ['onx', 'onX', 'https://backcountry.onxmaps.com/*'],
    ['alltrails', 'AllTrails', 'https://www.alltrails.com/*'],
    ['caltopo', 'CalTopo', 'https://caltopo.com/*'],
];

export default defineDomSuite({
    name: 'map provider access',
    cases: [...providers.map(([id, name, origin]) => ({
        name: `${name} requests the selected permission on trusted input and recovers from refusals`,
        viewport: { width: 390, height: 760 },
        async run(context: DomContext) {
            const { page } = context;
            const { button, status, state, finish } = await openPackagedAccess(context, id);
            const close = page.locator(`#close-${id}`);
            assert.equal((await state()).requests.length, 0, 'opening the page must leave permissions untouched');
            assert.equal((await state()).closes, 0, 'opening the page must leave it open');
            await button.evaluate((element: HTMLButtonElement) => element.click());
            await close.evaluate((element: HTMLButtonElement) => element.click());
            assert.equal((await state()).requests.length, 0, 'synthetic input must leave permissions untouched');
            assert.equal((await state()).closes, 0, 'synthetic input must leave the page open');
            assert.ok(await close.isHidden());

            const outcomes = [
                ['denied', 'not granted'], ['error', 'could not change'], ['granted', 'Return to'],
            ] as const;
            for (const [index, [outcome, label]] of outcomes.entries()) {
                await button.press('Enter');
                await page.locator(`#allow-${id}[aria-busy="true"]`).waitFor();
                assert.equal(await button.evaluate(element => (element as HTMLButtonElement).disabled), false,
                    'pending permission keeps the action focusable');
                assert.ok(await button.evaluate(element => document.activeElement === element));
                const bounds = await button.boundingBox();
                assert.ok(bounds);
                await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
                const pending = await state();
                assert.equal(pending.requests.length, index + 1, 'pending permission accepts one request per attempt');
                assert.deepEqual(pending.clickRequestCounts.slice(-2), [index + 1, index + 1],
                    'the trusted activation must start the request in the click dispatch');
                assert.deepEqual(pending.requests.at(-1), { permission: { origins: [origin] }, active: true });
                await finish(outcome);
                await status.filter({ hasText: label }).waitFor();
                await page.locator(`#allow-${id}[aria-busy="false"]`).waitFor();
                assert.equal(await button.evaluate((element: HTMLButtonElement) => element.disabled), outcome === 'granted');
                assert.equal(await button.isDisabled(), outcome === 'granted');
                assert.equal(await close.evaluate((element: HTMLButtonElement) => element.hidden), outcome !== 'granted');
                assert.equal(await close.isHidden(), outcome !== 'granted');
            }
            assert.equal(await button.textContent(), `${name} access enabled`);
            assert.ok(await close.evaluate(element => document.activeElement === element));
            await close.evaluate((element: HTMLButtonElement) => element.click());
            assert.equal((await state()).closes, 0);
            await close.click();
            assert.equal((await state()).closes, 1);
        },
    })), bcLandAccess],
});
