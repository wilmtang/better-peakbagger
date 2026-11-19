/// <reference lib="dom" />
/// <reference types="chrome" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite, type DomContext } from '../../../scripts/dom-tier.mts';

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
        finish: ((outcome: Outcome) => void) | null;
    };
}

function installAccessFixture(buttonId: string) {
    const fixture: AccessFixtureWindow['providerAccess'] = {
        requests: [], clickRequestCounts: [], closes: 0, finish: null,
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
    document.addEventListener('click', event => {
        if (event.isTrusted && event.target instanceof HTMLElement && event.target.id === buttonId) {
            fixture.clickRequestCounts.push(fixture.requests.length);
        }
    });
    window.close = () => { fixture.closes++; };
    (window as unknown as AccessFixtureWindow).providerAccess = fixture;
}

export default defineDomSuite({
    name: 'map provider access',
    cases: [
        ['gaia', 'Gaia', 'https://www.gaiagps.com/*'],
        ['onx', 'onX', 'https://backcountry.onxmaps.com/*'],
        ['alltrails', 'AllTrails', 'https://www.alltrails.com/*'],
        ['caltopo', 'CalTopo', 'https://caltopo.com/*'],
    ].map(([id, name, origin]) => ({
        name: `${name} requests the selected permission on trusted input and recovers from refusals`,
        viewport: { width: 390, height: 760 },
        async run({ page, open, route, built }: DomContext) {
            const pagePath = `/dist/${id}/access.html`;
            const fixturePath = '/test/provider-access-fixture.js';
            const html = (await built(`${id}/access.html`)).toString('utf8');
            const headScript = '<script src="access-head.js"></script>';
            assert.equal(html.split(headScript).length, 2, 'the packaged head script must be present');
            // The harness installs the extension API at document start. Install
            // the probes before either shipped script can request permission.
            await route(fixturePath, `(${installAccessFixture.toString()})(${JSON.stringify(`allow-${id}`)});`, 'text/javascript');
            await route(pagePath, html.replace(headScript, `<script src="${fixturePath}"></script>\n${headScript}`));
            await open(pagePath);
            const button = page.locator(`#allow-${id}`);
            const close = page.locator(`#close-${id}`);
            const status = page.getByRole('status');
            await button.waitFor();
            const state = () => page.evaluate(() => {
                const { requests, clickRequestCounts, closes } = (window as unknown as AccessFixtureWindow).providerAccess;
                return { requests, clickRequestCounts, closes };
            });
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
                await page.evaluate(resolution => {
                    const fixture = (window as unknown as AccessFixtureWindow).providerAccess;
                    if (!fixture.finish) throw new Error('No permission request is pending');
                    fixture.finish(resolution);
                }, outcome);
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
    })),
});
