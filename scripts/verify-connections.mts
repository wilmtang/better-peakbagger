/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang; SPDX-License-Identifier: AGPL-3.0-or-later
/* global window, document, getComputedStyle, location */
// Packaged Settings, synthetic service replies, no real credentials or writes.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { chromium, firefox, type Browser, type Dialog } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';
import { createFixtureCertificate, resolveFixtureFile, sendFixtureFile } from './browser-verification-fixtures.mts';
import { settingsSchema as Schema } from '../src/settings/settings-schema.ts';

interface ConnectionsFixture {
    calls: number;
    finish: ((ok: boolean) => void) | null;
    requests: number;
    authReads: number;
    garminStatusReads: number;
    garminStatusError: boolean;
    githubPermissionGranted: boolean;
    githubBegins: number;
    holdPermission?: boolean;
    releasePermission?: (() => void) | null;
    focused?: Element | null;
    setGarminConnected: (value: boolean) => void;
    setGithubConnected: (value: boolean) => void;
    notifyGithub: () => void;
    setGarminEnabled: (value: boolean) => void;
}

interface ConnectionsWindow {
    fixture: ConnectionsFixture;
    chrome: unknown;
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ConnectionGeometry {
    scroll: number;
    action: Box | null;
    boxes: Box[];
}

interface ConnectionService {
    name: string;
    section: string;
    action: string;
    status: string;
    following: string;
}

assert.equal(process.argv.length, 2, 'Connection verification accepts no arguments');
assertChromeLaunchAllowed();
const root = path.resolve(process.env.BPB_VERIFY_CONNECTION_SOURCE || 'dist');
const output = '/tmp/bpb-connection-ui';
await mkdir(output, { recursive: true });
const certificate = await createFixtureCertificate({ label: 'connections-ui' });
const server = createServer({ key: certificate.key, cert: certificate.cert }, async (request, response) => {
    try {
        const file = await resolveFixtureFile(new URL(request.url ?? '/', 'https://www.peakbagger.com').pathname, root);
        if (!file) { response.writeHead(404); response.end(); return; }
        await sendFixtureFile(response, file);
    } catch { response.writeHead(500); response.end(); }
});
const services: ConnectionService[] = [
    { name: 'garmin', section: '#capture-garmin', action: '#garmin-disconnect', status: '#garmin-key-status', following: '#capture-gpx' },
    { name: 'imgbb', section: '#capture-photos', action: '#imgbb-key-remove', status: '#imgbb-key-status', following: '#capture-report' },
    { name: 'github', section: '#github-connection', action: '#github-disconnect', status: '#github-disconnect-status', following: '#github-backup' },
];
const browsers: Browser[] = [];
let cases = 0;
try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://www.peakbagger.com:${(server.address() as AddressInfo).port}`;
    for (const name of ['chromium', 'firefox'] as const) {
        assertChromeLaunchAllowed();
        const browser = name === 'chromium'
            ? await chromium.launch({
                channel: 'chromium',
                headless: true,
                args: ['--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1', ...certificate.chromeTrustArgs],
                ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
            })
            : await firefox.launch({ headless: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        browsers.push(browser);
        const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
        await context.addInitScript(defaults => {
            const params = new URLSearchParams(location.search);
            const enabled = params.get('enabled') === 'true';
            const prefs = { ...defaults, theme: params.get('theme'), enableGarminInbox: enabled, enableReportEditor: enabled, enableGithubBackup: enabled };
            const connected = { garmin: true, imgbb: true, github: true };
            const repo = {
                owner: 'fixture-account-with-long-login-name',
                name: 'a-long-backup-repository-name-for-mountain-trip-reports',
                fullName: 'fixture-account-with-long-login-name/a-long-backup-repository-name-for-mountain-trip-reports',
            };
            const listeners: ((changes: Record<string, { newValue: unknown }>, areaName: string) => void)[] = [];
            const area = {
                get: async () => ({ bpbSettings: prefs, bpbDeviceSettings: { schemaVersion: 1, settings: prefs } }),
                set: async () => {},
                remove: async () => {},
            };
            const targetWindow = window as unknown as ConnectionsWindow;
            const fixture: ConnectionsFixture = {
                calls: 0,
                finish: null,
                requests: 0,
                authReads: 0,
                garminStatusReads: 0,
                garminStatusError: false,
                githubPermissionGranted: enabled,
                githubBegins: 0,
                setGarminConnected: value => { connected.garmin = value; },
                setGithubConnected: value => { connected.github = value; },
                notifyGithub: () => listeners.forEach(listener =>
                    listener({ bpbGithubAuth: { newValue: connected.github ? { account: { login: repo.owner } } : null } }, 'local')),
                setGarminEnabled: value => {
                    prefs.enableGarminInbox = value;
                    listeners.forEach(listener => listener({ bpbSettings: { newValue: prefs } }, 'sync'));
                },
            };
            targetWindow.fixture = fixture;
            targetWindow.chrome = {
                storage: {
                    sync: area,
                    local: area,
                    session: area,
                    onChanged: {
                        addListener: (listener: (changes: Record<string, { newValue: unknown }>, areaName: string) => void) => listeners.push(listener),
                        removeListener() {},
                    },
                },
                permissions: {
                    contains: async (details: { origins: string[] }) =>
                        details.origins.some(permOrigin => permOrigin.includes('github.com')) ? fixture.githubPermissionGranted : enabled,
                    request: async () => {
                        fixture.requests++;
                        if (fixture.holdPermission) {
                            return new Promise(resolve => {
                                fixture.releasePermission = () => {
                                    fixture.releasePermission = null;
                                    fixture.githubPermissionGranted = true;
                                    resolve(true);
                                };
                            });
                        }
                        return false;
                    },
                    onAdded: { addListener() {} },
                    onRemoved: { addListener() {} },
                },
                runtime: {
                    id: 'fixture',
                    getManifest: () => ({ version: '4.0.2' }),
                    getURL: (file: string) => new URL(`/${file}`, location.origin).href,
                    sendMessage: async (message: { type: string; patch?: Record<string, unknown> }) => {
                        const serviceMap: Record<string, 'garmin' | 'imgbb' | 'github' | undefined> = {
                            GARMIN_DISCONNECT: 'garmin',
                            PHOTO_IMGBB_REMOVE_KEY: 'imgbb',
                            GITHUB_AUTH_DISCONNECT: 'github',
                        };
                        const service = serviceMap[message.type];
                        if (service) {
                            fixture.calls++;
                            return new Promise(resolve => {
                                fixture.finish = ok => {
                                    fixture.finish = null;
                                    if (ok) connected[service] = false;
                                    if (ok && service === 'github') fixture.notifyGithub();
                                    resolve(ok
                                        ? { ok: true, configured: false, connected: false, hasToken: false, accessRemoved: true }
                                        : { ok: false, phase: 'error', error: { message: 'The saved connection could not be removed. Try Disconnect again.' } });
                                };
                            });
                        }
                        if (message.type === 'SETTINGS_PATCH') { Object.assign(prefs, message.patch); return { ok: true, settings: prefs }; }
                        if (message.type === 'GARMIN_CONNECTION_STATUS') return { ok: true, configured: connected.garmin };
                        if (message.type === 'GARMIN_STATUS') {
                            fixture.garminStatusReads++;
                            if (fixture.garminStatusError) return { ok: false, error: { message: 'Local draft status could not be read.' } };
                            return { ok: true, configured: connected.garmin, enabled: connected.garmin, connectedDate: '2026-10-31', pending: 25, items: [] };
                        }
                        if (message.type === 'PHOTO_IMGBB_STATUS') return { ok: true, configured: connected.imgbb, permissionGranted: enabled };
                        if (message.type === 'GITHUB_AUTH_STATUS') {
                            fixture.authReads++;
                            return { connected: connected.github, hasToken: connected.github, repo, account: { login: repo.owner } };
                        }
                        if (message.type === 'GITHUB_AUTH_BEGIN') { fixture.githubBegins++; return { phase: 'polling', userCode: 'ABCD-EFGH', expiresIn: 900 }; }
                        if (message.type === 'GITHUB_AUTH_STATE') return { phase: 'polling' };
                        if (message.type === 'GITHUB_IGNORED_LIST') return { ok: true, count: 0, state: { enabled: false, phase: 'idle' } };
                        return { ok: true, count: 0 };
                    },
                },
            };
        }, Schema.DEFAULTS);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const geometry = (service: Pick<ConnectionService, 'section' | 'action' | 'following'>): Promise<ConnectionGeometry> =>
            page.evaluate((target): ConnectionGeometry => {
                const action = document.querySelector<HTMLElement>(target.action)!;
                const selectors = [target.section, `${target.section} h3`, target.following];
                const rect = (element: Element): Box => {
                    const { x, y, width, height } = element.getBoundingClientRect();
                    return { x, y, width, height };
                };
                return {
                    scroll: document.querySelector('.content')!.scrollTop,
                    action: action.hidden ? null : rect(action),
                    boxes: [rect(action.parentElement!), ...selectors.map(selector => rect(document.querySelector(selector)!))],
                };
            }, service);
        const stable = (before: ConnectionGeometry, after: ConnectionGeometry, label: string, { backupStateChanged = false } = {}) => {
            assert.equal(after.scroll, before.scroll, `${label}: reading position moved`);
            if (before.action && after.action) {
                for (const key of Object.keys(before.action) as (keyof Box)[]) {
                    assert(Math.abs(before.action[key] - after.action[key]) <= 1, `${label}: action ${key} shifted`);
                }
            }
            before.boxes.forEach((box, index) => (Object.keys(box) as (keyof Box)[]).forEach(key => {
                // Ending the shared GitHub connection deliberately replaces
                // connected backup options with setup guidance. Its heading
                // stays anchored; that following panel may shrink once.
                if (backupStateChanged && index === 3 && key === 'height') return;
                assert(Math.abs(box[key] - after.boxes[index][key]) <= 1, `${label}: box ${index}.${key} shifted: ${JSON.stringify({ before, after })}`);
            }));
        };
        for (const theme of ['light', 'dark']) {
            for (const [width, zoom] of [[1180, 1], [390, 1], [1180, 2]] as const) {
                await page.setViewportSize({ width, height: 1000 });
                for (const enabled of [true, false]) {
                    for (const service of services) {
                        const label = `${name}/${theme}/${width}/zoom${zoom}/${enabled}/${service.name}`;
                        await page.goto(`${origin}/options/options.html?theme=${theme}&enabled=${enabled}&service=${service.name}${service.section}`);
                        const action = page.locator(service.action);
                        await action.waitFor({ state: 'visible' });
                        await page.evaluate(nextZoom => {
                            document.documentElement.style.zoom = String(nextZoom);
                            document.querySelector<HTMLElement>('.content')!.style.scrollBehavior = 'auto';
                        }, zoom);
                        await action.scrollIntoViewIfNeeded();
                        await action.focus();
                        const captureStates = enabled && name === 'chromium' && ((width === 390 && theme === 'dark') || (zoom === 2 && theme === 'light'));
                        const capture = (stage: string) => page.screenshot({ path: path.join(output, `${name}-${service.name}-${theme}-${width}-zoom${zoom}-${stage}.png`) });
                        if (captureStates) await capture('idle');
                        const before = await geometry(service);
                        await action.press('Enter');
                        await page.waitForFunction(() => !!(window as unknown as ConnectionsWindow).fixture.finish);
                        assert.equal(await action.getAttribute('aria-busy'), 'true', label);
                        await action.press('Space');
                        await action.evaluate(button => (button as HTMLElement).click());
                        assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.calls), 1, label);
                        assert(await action.evaluate(button => document.activeElement === button), label);
                        stable(before, await geometry(service), `${label}/pending`);
                        if (captureStates) await capture('pending');
                        await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.finish!(false));
                        await page.locator(service.status).filter({ hasText: /could not be removed/ }).waitFor();
                        await page.waitForFunction(selector => document.querySelector(selector)!.getAttribute('aria-busy') !== 'true', service.action);
                        stable(before, await geometry(service), `${label}/error`);
                        assert(await action.evaluate(button => document.activeElement === button), label);
                        if (enabled && zoom === 1) await page.screenshot({ path: path.join(output, `${name}-${service.name}-${theme}-${width}-error.png`) });
                        await action.press('Enter');
                        await page.waitForFunction(() => !!(window as unknown as ConnectionsWindow).fixture.finish);
                        assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.calls), 2, label);
                        stable(before, await geometry(service), `${label}/retry`);
                        await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.finish!(true));
                        await action.waitFor({ state: 'hidden' });
                        assert.equal(await action.evaluate(button => getComputedStyle(button).display), 'none', label);
                        stable(before, await geometry(service), `${label}/success`, { backupStateChanged: service.name === 'github' });
                        if (captureStates) await capture('success');
                        assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.requests), 0, label);
                        assert(await page.evaluate(() => document.querySelector('.content')!.scrollWidth <= document.querySelector('.content')!.clientWidth + 1), `${label}: horizontal overflow`);
                        assert(await page.evaluate(() => {
                            const active = document.activeElement;
                            return active instanceof HTMLElement && active !== document.body && !active.hidden;
                        }), `${label}: lost focus`);
                        if (service.name === 'garmin') {
                            const removed = await geometry(service);
                            await page.evaluate(nextEnabled => {
                                const fixture = (window as unknown as ConnectionsWindow).fixture;
                                fixture.focused = document.activeElement;
                                fixture.setGarminConnected(true);
                                fixture.setGarminEnabled(nextEnabled);
                            }, enabled);
                            await action.waitFor({ state: 'visible' });
                            await page.locator(service.status).filter({ hasText: /^Connected on this device$/ }).waitFor();
                            stable(removed, await geometry(service), `${label}/external-reconnect`);
                            assert(await page.evaluate(() => document.activeElement === (window as unknown as ConnectionsWindow).fixture.focused), `${label}: reconnect stole focus`);
                        }
                        if (service.name === 'github') {
                            const reads = await page.evaluate(() => {
                                const fixture = (window as unknown as ConnectionsWindow).fixture;
                                fixture.focused = document.activeElement;
                                const authCount = fixture.authReads;
                                fixture.notifyGithub();
                                return authCount;
                            });
                            await page.waitForFunction(previousReads => (window as unknown as ConnectionsWindow).fixture.authReads > previousReads, reads);
                            assert(await page.evaluate(() => document.activeElement === (window as unknown as ConnectionsWindow).fixture.focused), `${label}: credential notification lost focus`);
                            const removed = await geometry(service);
                            await page.evaluate(() => {
                                const fixture = (window as unknown as ConnectionsWindow).fixture;
                                fixture.setGithubConnected(true);
                                fixture.notifyGithub();
                            });
                            await action.waitFor({ state: 'visible' });
                            assert.doesNotMatch((await page.locator(service.status).textContent()) ?? '', /^Disconnected/);
                            stable(removed, await geometry(service), `${label}/external-reconnect`, { backupStateChanged: true });
                            assert(await action.evaluate(button => document.activeElement === button), `${label}: external reconnect lost focus`);
                            if (name === 'chromium' && theme === 'dark' && width === 390 && !enabled) {
                                await page.screenshot({ path: path.join(output, 'github-reconnected-no-access.png') });
                            }
                        }
                        assert.deepEqual(errors, [], label);
                        cases++;
                    }
                }
                // A credential-only status must never authorize a destructive
                // confirmation. Exercise the actual feature transition, failure,
                // recovery and keyboard activation rather than a fixed mock state.
                await page.goto(`${origin}/options/options.html?theme=${theme}&enabled=false&service=garmin-drafts#capture-garmin`);
                await page.locator('#garmin-disconnect').waitFor({ state: 'visible' });
                await page.evaluate(nextZoom => {
                    document.documentElement.style.zoom = String(nextZoom);
                    document.querySelector<HTMLElement>('.content')!.style.scrollBehavior = 'auto';
                    const fixture = (window as unknown as ConnectionsWindow).fixture;
                    fixture.garminStatusError = true;
                    fixture.setGarminEnabled(true);
                }, zoom);
                await page.locator('#garmin-settings-status').filter({ hasText: /Deleting local data is unavailable/ }).waitFor();
                await page.locator('#garmin-preferences summary').click();
                const removeData = page.locator('#garmin-delete');
                const confirmations: string[] = [];
                const dismiss = async (dialog: Dialog) => { confirmations.push(dialog.message()); await dialog.dismiss(); };
                page.on('dialog', dismiss);
                try {
                    await removeData.scrollIntoViewIfNeeded();
                    await removeData.focus();
                    assert.equal(await removeData.getAttribute('aria-disabled'), 'true');
                    const surface = { ...services[0], action: '#garmin-delete' };
                    const before = await geometry(surface);
                    if (name === 'chromium' && theme === 'dark' && width === 390) await page.screenshot({ path: path.join(output, 'garmin-unknown-drafts.png') });
                    await removeData.press('Enter');
                    await removeData.press('Space');
                    assert.deepEqual(confirmations, []);
                    assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.calls), 0);
                    await page.evaluate(() => {
                        const fixture = (window as unknown as ConnectionsWindow).fixture;
                        fixture.garminStatusError = false;
                        fixture.setGarminEnabled(true);
                    });
                    await page.waitForFunction(() => document.getElementById('garmin-delete')!.getAttribute('aria-disabled') === 'false');
                    stable(before, await geometry(surface), `${name}/${theme}/${width}/${zoom}/draft-status-recovered`);
                    assert(await removeData.evaluate(button => document.activeElement === button));
                    await removeData.press('Enter');
                    assert.deepEqual(confirmations, ['Delete 25 local Garmin drafts and their import history?']);
                    assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.calls), 0, 'Cancel must preserve local data');
                    await page.evaluate(() => {
                        const fixture = (window as unknown as ConnectionsWindow).fixture;
                        fixture.garminStatusError = true;
                        fixture.setGarminEnabled(true);
                    });
                    await page.waitForFunction(() => document.getElementById('garmin-delete')!.getAttribute('aria-disabled') === 'true');
                    stable(before, await geometry(surface), `${name}/${theme}/${width}/${zoom}/draft-status-failed`);
                    await removeData.press('Enter');
                    assert.equal(confirmations.length, 1);
                    assert.deepEqual(errors, []);
                    cases++;
                } finally { page.off('dialog', dismiss); }
                await page.goto(`${origin}/options/options.html?theme=${theme}&enabled=false&service=github-setup#github-connection`);
                await page.locator('#github-disconnect').waitFor({ state: 'visible' });
                await page.evaluate(nextZoom => {
                    document.documentElement.style.zoom = String(nextZoom);
                    document.querySelector<HTMLElement>('.content')!.style.scrollBehavior = 'auto';
                    (window as unknown as ConnectionsWindow).fixture.holdPermission = true;
                }, zoom);
                await page.locator('#github-panel button').filter({ hasText: 'Try again' }).click();
                await page.waitForFunction(() => !!(window as unknown as ConnectionsWindow).fixture.releasePermission);
                await page.locator('#github-disconnect').click();
                await page.waitForFunction(() => !!(window as unknown as ConnectionsWindow).fixture.finish);
                await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.finish!(true));
                await page.locator('#github-disconnect').waitFor({ state: 'hidden' });
                const disconnected = await geometry(services[2]);
                const reads = await page.evaluate(() => {
                    const fixture = (window as unknown as ConnectionsWindow).fixture;
                    const authCount = fixture.authReads;
                    fixture.releasePermission!();
                    return authCount;
                });
                await page.waitForFunction(previousReads => (window as unknown as ConnectionsWindow).fixture.authReads > previousReads, reads);
                assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.githubBegins), 0, 'Old permission request must not restart sign-in');
                assert.equal(await page.locator('.github-code').count(), 0);
                stable(disconnected, await geometry(services[2]), `${name}/${theme}/${width}/${zoom}/superseded-setup`);
                await page.locator('#github-panel button').filter({ hasText: 'Connect GitHub' }).click();
                await page.locator('.github-code').waitFor({ state: 'visible' });
                assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.githubBegins), 1, 'A new explicit Connect still works');
                assert.deepEqual(errors, []);
                cases++;
                await page.goto(`${origin}/options/options.html?theme=${theme}&enabled=false&service=github-external-removal#github-connection`);
                await page.locator('#github-disconnect').waitFor({ state: 'visible' });
                await page.evaluate(() => { (window as unknown as ConnectionsWindow).fixture.holdPermission = true; });
                await page.locator('#github-panel button').filter({ hasText: 'Try again' }).click();
                await page.waitForFunction(() => !!(window as unknown as ConnectionsWindow).fixture.releasePermission);
                await page.evaluate(() => {
                    const fixture = (window as unknown as ConnectionsWindow).fixture;
                    fixture.setGithubConnected(false);
                    fixture.notifyGithub();
                    fixture.releasePermission!();
                });
                await page.locator('#github-panel button').filter({ hasText: 'Connect GitHub' }).waitFor({ state: 'visible' });
                assert.equal(await page.evaluate(() => (window as unknown as ConnectionsWindow).fixture.githubBegins), 0, 'External removal supersedes old permission setup');
                assert.equal(await page.locator('.github-code').count(), 0);
                assert.deepEqual(errors, []);
                cases++;
            }
        }
        console.log(`${name} ${browser.version()}: hidden Settings connection states passed; 1180×1000, 390×1000, 200% CSS zoom; light/dark; features on/off.`);
        await context.close();
    }
    assert.equal(cases, 108);
    console.log(`${cases} cases passed. Screenshots: ${output}. Service/storage/permission replies stubbed; native prompts and visible focus not exercised.`);
} finally {
    const closed = await Promise.allSettled(browsers.reverse().map(browser => browser.close()));
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await certificate.remove();
    assert(closed.every(result => result.status === 'fulfilled'), 'Browser teardown failed');
}
