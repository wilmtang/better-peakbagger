// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Transition geometry checks against shipped UI assets with controlled APIs.
// Fixtures are isolated HTTPS Peakbagger pages; no live data or accounts are used.
/* global document, window, location, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, firefox } from 'playwright';
// @ts-expect-error jsdom ships no declarations, and this Node-side use is a parse and serialize.
import { JSDOM } from 'jsdom';
import { layoutVerificationPlan } from './layout-verification-plan.mjs';
import { retainBrowserFailure, verificationScreenshots } from './browser-verification-evidence.mjs';
import { createBrowserFixtureServer, fixtureContentType, projectRoot } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { gpxPanelCss } from '../src/gpx/gpx-panel-css.js';
import { darkCss } from '../src/theme/site-dark-css.js';
import { verifySettingsActions } from './verify-settings-actions.mts';
import { verifyClimberFiles } from './verify-climber-files.mjs';
import { verifyPhotoReportEdit } from './verify-photo-report-edit.mjs';
import { verifyPeakWeatherRefresh } from './verify-peak-weather-refresh.mjs';
import { verifyReportCaptionStability } from './verify-report-caption-stability.mts';
import { verifyAscentColumnWidths, verifyPeakColumnWidths } from './verify-ascent-column-widths.mjs';
import { verifyAscentFilters } from './verify-ascent-filters.mjs';
import { verifyProfileFeedback, verifyBuddyPresentation, verifyPendingMembership, verifyCardFeedback } from './verify-climber-transitions.mjs';
import type { Page, Route } from 'playwright';

/* eslint-disable @typescript-eslint/no-shadow -- page-world callbacks take the outer value as their serialized argument under its own name. */
// Fixture types. Node strips these annotations in place, so each page-world
// callback's source is unchanged when Playwright serializes it.
type FixtureElement = HTMLInputElement & HTMLDetailsElement & HTMLImageElement;
type FixtureRect = { x: number; y: number; width: number; height: number; [edge: string]: number };
type FixtureMessage = { type?: string; [field: string]: unknown };
type FixtureState = Record<string, unknown>;
type FixtureHook = { hook(...values: unknown[]): unknown }['hook'];
type FixtureControl = Record<string, FixtureHook>;
type FixtureFactory = { make(...values: unknown[]): FixtureControl }['make'];
type FixtureProgress = { phase: string; progress: { completed: number; [field: string]: unknown }; [field: string]: unknown };
type FixtureSnapshot = { revision: unknown; state: Record<string, { enabled: boolean }>; [field: string]: unknown };
declare global {
    var __backupCalls: number;
    var __backupUpdate: boolean;
    var __backupWrites: number;
    var __calculator: FixtureControl;
    var __cancelNode: Element | null;
    var __captionText: FixtureControl;
    var __chart: FixtureControl;
    var __createHourlyChart: FixtureFactory;
    var __finishBackup: FixtureHook;
    var __finishBackupCheck: FixtureHook;
    var __finishCancel: FixtureHook;
    var __finishClear: FixtureHook;
    var __finishImport: FixtureHook;
    var __finishOpen: FixtureHook;
    var __finishPermission: FixtureHook;
    var __finishPreference: FixtureHook;
    var __finishTrack: FixtureHook;
    var __finishUnitSave: FixtureHook;
    var __focusedAction: Element | null;
    var __holdUnitSave: boolean;
    var __layoutRequests: FixtureMessage[];
    var __layoutSnapshot: FixtureSnapshot;
    var __linkText: FixtureControl;
    var __messages: FixtureMessage[];
    var __open: FixtureMessage;
    var __pendingControl: Element | null;
    var __permissionCalls: number;
    var __pickerText: FixtureControl;
    var __preferenceWrites: number;
    var __prepareBackup: FixtureHook;
    var __progress: FixtureProgress;
    var __renderBackupProgress: FixtureHook;
    var __renderSun: FixtureHook;
    var __reservePicker: FixtureFactory;
    var __reserveReport: FixtureFactory;
    var __sun: Record<string, FixtureControl & FixtureFactory>;
}
type LayoutVariant = { name: string; theme: string; width: number; zoom: number; surface: string; browser: string; [field: string]: unknown };

const output = process.env.BPB_JITTER_ARTIFACTS;
const captureRequested = verificationScreenshots();
if (output) await mkdir(output, { recursive: true });
const assets = new Map();
let fixtureDirectory: string;
async function asset(file: string) {
    if (!assets.has(file)) assets.set(file, await readFile(path.join(projectRoot, 'dist', file)));
    return assets.get(file);
}
export const geometry = async (page: Page, selector: string) => page.locator(selector).evaluate((element: FixtureElement) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
});
function stable(before: FixtureRect | null, after: FixtureRect | null, label: string, keys = ['x', 'y', 'width', 'height']) {
    for (const key of keys) assert.ok(Math.abs(before![key] - after![key]) <= 1,
        `${label}: ${key} shifted ${after![key] - before![key]}px; ${JSON.stringify({ before, after })}`);
}
async function assertActionFocus(page: Page, selector: string, label: string) {
    // Let native disabling settle; checking in the click turn misses Chrome blur.
    await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    assert.equal(await page.locator(selector).evaluate((element: FixtureElement) => document.activeElement === element), true, label);
}
async function capture(page: Page, label: string, reference = false) {
    if (output && captureRequested(reference)) await page.screenshot({ path: path.join(output, `${label}.png`) });
}
async function load(page: Page, origin: string, file: string, initialize: (context: { theme: string }) => unknown, argument: { theme: string }) {
    await page.addInitScript(initialize, argument);
    await page.goto(`${origin}/dist/${file}`);
}
async function popupCase(page: Page, origin: string, variant: LayoutVariant) {
    await load(page, origin, 'popup/popup.html', ({ theme }: { theme: string }) => {
        const job = { phase: 'ready', provider: 'garmin', activityId: '777', hasCachedGpx: true, selectedIds: [1],
            trackSummary: { originalPointCount: 50, retainedPointCount: 50, maxDeviationM: 0 },
            matches: [{ id: 1, name: 'A very long mountain name for a narrow popup', classification: 'strong', confidence: 98,
                evidence: { distanceM: 2, trackQuality: 1 } }] };
        globalThis.chrome = {
            tabs: { query: async () => [{ id: 9 }], create: async () => ({}), update: async () => ({}) },
            storage: { sync: { get: async () => ({ bpbSettings: { theme } }), set: async () => {} },
                onChanged: { addListener() {}, removeListener() {} } },
            runtime: { openOptionsPage: async () => {}, sendMessage: async (message: FixtureMessage) => {
                if (['CAPTURE_START', 'CAPTURE_STATUS'].includes(message.type!)) return job;
                if (message.type === 'CAPTURE_OPEN_DRAFTS') return new Promise(resolve => {
                    globalThis.__finishOpen = (fail?: unknown) => resolve(fail
                        ? { phase: 'error', error: { message: 'Drafts could not be opened. Try again.' } }
                        : { job: { ...job, phase: 'opened' }, groupWarning: true });
                });
                if (message.type === 'CAPTURE_CLEAR') return new Promise(resolve => {
                    globalThis.__finishClear = () => resolve({ ok: false, error: { message: 'The captured track could not be deleted. Try again.' } });
                });
                return { ok: true };
            } },
        } as unknown as typeof chrome;
    }, variant);
    await page.locator('#open-drafts').filter({ hasText: 'Open 1 draft' }).waitFor();
    const button = '#open-drafts';
    const before = await geometry(page, button);
    await page.locator(button).press('Enter');
    await page.waitForFunction(() => typeof globalThis.__finishOpen === 'function');
    stable(before, await geometry(page, button), 'popup pending');
    await assertActionFocus(page, button, 'popup pending focus');
    assert.equal(await page.locator('#peak-list input').isDisabled(), true, 'pending draft request freezes selection');
    assert.equal(await page.locator('#clear-capture').getAttribute('aria-disabled'), 'true');
    await page.evaluate(() => globalThis.__finishOpen(true));
    await page.waitForFunction(() => (document.getElementById('open-drafts') as FixtureElement)!.getAttribute('aria-disabled') === 'false');
    stable(before, await geometry(page, button), 'popup error');
    await assertActionFocus(page, button, 'popup error focus');
    assert.equal(await page.locator('#peak-list input').isDisabled(), false, 'failed draft request releases selection');
    assert.equal(await page.locator('#clear-capture').getAttribute('aria-disabled'), 'false');
    await page.locator(button).press('Enter');
    await page.waitForFunction(() => (document.getElementById('open-drafts') as FixtureElement)!.getAttribute('aria-disabled') === 'true');
    await page.evaluate(() => globalThis.__finishOpen(false));
    await page.locator(button).filter({ hasText: 'Show opened drafts' }).waitFor();
    stable(before, await geometry(page, button), 'popup grouped completion');
    const clearBefore = await geometry(page, '#clear-capture');
    await page.locator('#clear-capture').press('Enter');
    await page.waitForFunction(() => typeof globalThis.__finishClear === 'function');
    stable(clearBefore, await geometry(page, '#clear-capture'), 'popup clear pending');
    await assertActionFocus(page, '#clear-capture', 'popup delete pending focus');
    await page.evaluate(() => globalThis.__finishClear());
    await page.locator('#clear-capture').filter({ hasText: 'Delete captured track data' }).waitFor();
    stable(clearBefore, await geometry(page, '#clear-capture'), 'popup clear error');
    await assertActionFocus(page, '#clear-capture', 'popup delete error focus');
    await capture(page, `${variant.name}-popup-error`, true);
    await page.clock.install();
    await load(page, origin, 'popup/popup.html', ({ theme }: { theme: string }) => {
        globalThis.__progress = { phase: 'searching-summits', provider: 'garmin', progress: { completed: 1, total: 12 } };
        globalThis.chrome = { tabs: { query: async () => [{ id: 9 }] },
            storage: { sync: { get: async () => ({ bpbSettings: { theme } }) }, onChanged: { addListener() {}, removeListener() {} } },
            runtime: { sendMessage: async (message: FixtureMessage) => {
                if (message.type === 'CAPTURE_CANCEL') return new Promise(resolve => { globalThis.__finishCancel = () => resolve({ ok: true }); });
                return globalThis.__progress;
            } } } as unknown as typeof chrome;
    }, variant);
    const cancel = page.locator('#state button');
    await cancel.filter({ hasText: 'Cancel' }).waitFor();
    await cancel.focus();
    await cancel.evaluate((element: FixtureElement) => { globalThis.__cancelNode = element; });
    const cancelBounds = await cancel.boundingBox();
    for (const phase of ['checking-peakbagger', 'waiting-provider', 'searching-summits']) {
        await page.evaluate((phase: string) => { globalThis.__progress.phase = phase; globalThis.__progress.progress.completed++; }, phase);
        await page.clock.runFor(500);
        assert.equal(await cancel.evaluate((element: FixtureElement) => element === globalThis.__cancelNode && document.activeElement === element), true,
            'capture progress preserves focused Cancel node');
        stable(cancelBounds, await cancel.boundingBox(), `capture progress ${phase}`);
    }
    await capture(page, `${variant.name}-popup-progress`);
    await cancel.press('Enter');
    await page.waitForFunction(() => typeof globalThis.__finishCancel === 'function');
    assert.equal(await cancel.evaluate((element: FixtureElement) => document.activeElement === element), true, 'cancellation keeps focus');
    stable(cancelBounds, await cancel.boundingBox(), 'cancelling');
    await page.evaluate(() => globalThis.__finishCancel());
    await cancel.filter({ hasText: 'Start again' }).waitFor();
    assert.equal(await cancel.evaluate((element: FixtureElement) => document.activeElement === element), true, 'completion focuses next action');
    await capture(page, `${variant.name}-popup-cancelled`);
}
async function accessCase(page: Page, origin: string, variant: LayoutVariant) {
    for (const id of ['gaia', 'onx', 'alltrails', 'caltopo']) {
        await load(page, origin, `${id}/access.html`, ({ theme }: { theme: string }) => {
            globalThis.chrome = {
                storage: { sync: { get: async () => ({ bpbSettings: { theme } }) },
                    onChanged: { addListener() {}, removeListener() {} } },
                permissions: { request: () => new Promise((resolve, reject) => {
                    globalThis.__permissionCalls = (globalThis.__permissionCalls || 0) + 1;
                    globalThis.__finishPermission = (result: unknown) => result === 'error' ? reject(new Error('Unavailable')) : resolve(result);
                }) },
            } as unknown as typeof chrome;
        }, variant);
        const selector = `#allow-${id}`;
        const before = await geometry(page, selector);
        for (const result of ['error', false, true]) {
            await page.locator(selector).press('Enter');
            await page.waitForFunction((id: string) => (document.getElementById(`allow-${id}`) as FixtureElement)!.getAttribute('aria-disabled') === 'true', id);
            stable(before, await geometry(page, selector), `${id} pending`);
            await assertActionFocus(page, selector, `${id} permission pending focus`);
            const calls = await page.evaluate(() => globalThis.__permissionCalls);
            await page.locator(selector).press('Enter');
            await page.locator(selector).press('Space');
            assert.equal(await page.evaluate(() => globalThis.__permissionCalls), calls, 'pending permission cannot repeat');
            await page.evaluate((result: unknown) => globalThis.__finishPermission(result), result);
            await page.waitForFunction(({ id, result }: { id: string; result: unknown }) => result === true
                ? !(document.getElementById(`close-${id}`) as FixtureElement)!.hidden
                : (document.getElementById(`allow-${id}`) as FixtureElement)!.getAttribute('aria-disabled') === 'false', { id, result });
            stable(before, await geometry(page, selector), `${id} ${result}`);
            await assertActionFocus(page, result === true ? `#close-${id}` : selector, `${id} permission result focus`);
        }
        await capture(page, `${variant.name}-${id}-access`);
    }
}
async function handoffCase(page: Page, origin: string, variant: LayoutVariant) {
    await page.route(`${origin}/climber/ascent.aspx?aid=7654321`, (route: Route) => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><meta charset="utf-8"><style>body{margin:20px;font:14px Arial}html[data-bpb-theme="dark"] body{background:#202222;color:#eee}#gpxlinks{max-width:900px;text-align:center}</style>'
        + '<a href="/climber/AscentEdit.aspx?aid=7654321">Edit ascent</a><p id="gpxlinks"><a href="/climber/GPXFile.aspx?aid=7654321&sep=1">Download this GPS track</a></p>' }));
    await page.addInitScript(({ theme }: { theme: string }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { storage: { sync: { get: async () => ({ bpbSettings: { theme } }) },
            onChanged: { addListener() {}, removeListener() {} } }, runtime: { sendMessage: async (message: FixtureMessage) => {
            if (message.type!.endsWith('_PERMISSION_REQUEST')) return new Promise(resolve => {
                globalThis.__permissionCalls = (globalThis.__permissionCalls || 0) + 1;
                globalThis.__finishPermission = () => resolve({ ok: true });
            });
            if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'fixture' };
            if (message.type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'fixture' };
            if (message.type!.endsWith('_IMPORT_PREPARE')) return new Promise(resolve => {
                globalThis.__finishImport = (success: boolean) => resolve({ ok: success, supplied: success, targetTabId: 9, attemptId: message.attemptId,
                    message: success ? 'Your track is ready in the map. Review the preview and confirm when ready.'
                        : 'The map could not prepare this track. Check your connection and try the transfer again.' });
            });
            return { ok: true };
        } } } as unknown as typeof chrome;
    }, variant);
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
    await page.addStyleTag({ content: (await asset('css/ascent-gaia.css')).toString() });
    await page.addScriptTag({ content: (await asset('content/ascent-gaia.js')).toString() });
    await page.locator('.bpb-map-handoff-button').first().waitFor();
    for (const id of ['gaia', 'onx', 'alltrails', 'caltopo']) {
        const selector = `[data-provider="${id}"]`;
        const before = await geometry(page, selector);
        const allBefore = await page.locator('.bpb-map-handoff-button').evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
            const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
        }));
        for (const success of [false, true]) {
            await page.locator(selector).press('Enter');
            await page.waitForFunction(() => typeof globalThis.__finishPermission === 'function');
            stable(before, await geometry(page, selector), `${id} preparing`);
            await assertActionFocus(page, selector, `${id} transfer pending focus`);
            const calls = await page.evaluate(() => globalThis.__permissionCalls);
            await page.locator(selector).press('Enter');
            await page.locator(selector).press('Space');
            assert.equal(await page.evaluate(() => globalThis.__permissionCalls), calls, 'pending transfer cannot repeat');
            await page.evaluate(() => { globalThis.__finishImport = null!; globalThis.__finishPermission(); });
            await page.waitForFunction(() => typeof globalThis.__finishImport === 'function');
            stable(before, await geometry(page, selector), `${id} opening`);
            await page.evaluate((success: boolean) => globalThis.__finishImport(success), success);
            await page.waitForFunction((id: string) => document.querySelector<FixtureElement>(`[data-provider="${id}"]`)!.getAttribute('aria-disabled') === 'false', id);
            stable(before, await geometry(page, selector), `${id} completed ${success}`);
            await assertActionFocus(page, selector, `${id} completed focus`);
            const allAfter = await page.locator('.bpb-map-handoff-button').evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
                const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
            }));
            allBefore.forEach((rect: FixtureRect, index: number) => stable(rect, allAfter[index], `${id} neighboring action ${index}`));
        }
    }
    await capture(page, `${variant.name}-handoff`);
    await page.addStyleTag({ content: (await asset('css/card.css')).toString() });
    await page.addStyleTag({ content: (await asset('css/ascent-weather.css')).toString() });
    await page.locator('#gpxlinks').evaluate((element: FixtureElement) => { element.id = 'bpb-ascent-gpx-details'; });
    const collapsed = await geometry(page, '[data-provider="gaia"]');
    await page.click('[data-provider="gaia"]');
    await page.evaluate(() => globalThis.__finishPermission());
    await page.waitForFunction(() => document.querySelector<FixtureElement>('[data-provider="gaia"]')!.textContent.includes('Opening'));
    stable(collapsed, await geometry(page, '[data-provider="gaia"]'), 'handoff GPX details pending');
    await page.locator('a[href*="AscentEdit"]').focus();
    await page.evaluate(() => globalThis.__finishImport(true));
    await page.waitForFunction(() => document.querySelector<FixtureElement>('[data-provider="gaia"]')!.getAttribute('aria-disabled') === 'false');
    stable(collapsed, await geometry(page, '[data-provider="gaia"]'), 'handoff GPX details completion');
    await assertActionFocus(page, 'a[href*="AscentEdit"]', 'transfer completion respects focus moved elsewhere');
}
async function ascentBackupCase(page: Page, origin: string, variant: LayoutVariant) {
    const html = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    const edit = new JSDOM(await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascentedit.html'), 'utf8'));
    (edit.window.document.getElementById('PeakListBox') as FixtureElement).innerHTML = '<option value="2296" selected>Mount Rainier</option>';
    (edit.window.document.getElementById('DateText') as FixtureElement).setAttribute('value', '2026-07-12');
    (edit.window.document.getElementById('PointFt') as FixtureElement).setAttribute('value', '14411');
    const editHtml = edit.serialize();
    edit.window.close();
    await page.route('**/climber/ascent.aspx?aid=7654321', (route: Route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/climber/ascentedit.aspx**', (route: Route) => route.fulfill({ contentType: 'text/html', body: editHtml }));
    await page.route('**/climber/GPXFile.aspx**', (route: Route) => route.fulfill({ contentType: 'application/gpx+xml',
        body: '<gpx><trk><trkseg></trkseg></trk></gpx>' }));
    await page.addInitScript(({ theme }: { theme: string }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.0' }), sendMessage: async (message: FixtureMessage) => {
            if (message.type === 'GITHUB_BACKUP_STATUS') return { enabled: true, connected: true, auto: false };
            if (message.type === 'GITHUB_CHECK_ASCENT_BACKUP') return new Promise(resolve => {
                globalThis.__finishBackupCheck = (current: unknown) => resolve({ ok: true, current });
            });
            if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'fixture' };
            if (message.type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'fixture' };
            if (message.type === 'GITHUB_BACKUP_ASCENT') return new Promise(resolve => {
                globalThis.__backupWrites = (globalThis.__backupWrites || 0) + 1;
                globalThis.__finishBackup = (ok: boolean) => resolve(ok ? { ok: true, result: { commitUrl: 'https://github.com/example/backup/commit/123', isUpdate: !!globalThis.__backupUpdate } }
                    : { ok: false, error: { code: 'network', message: 'A long backup failure. Check your connection before trying this ascent again.' } });
            });
            return { ok: true };
        } } } as unknown as typeof chrome;
    }, variant);
    await page.clock.install();
    const action = '.bpb-gh-btn';
    const slot = '.bpb-gh-action';
    const neighbors = ['#owneractions > a:first-child', '#owneractions > a:nth-child(2)', '#jitter-native-photos'];
    const mount = async (scale: number) => {
        await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
        await page.addStyleTag({ content: darkCss });
        await page.addStyleTag({ content: (await asset('css/ascent-backup.css')).toString()
            + `\n.bpb-gh-control { font-size: ${11 * scale}px; }` });
        await page.addScriptTag({ content: (await asset('content/ascent-backup.js')).toString() });
        await page.waitForFunction(() => typeof globalThis.__finishBackupCheck === 'function');
        await page.evaluate(() => {
            const photos = document.createElement('a'); photos.id = 'jitter-native-photos';
            photos.href = '#fixture-photos'; photos.textContent = 'Add Photos';
            document.querySelector<FixtureElement>('.bpb-gh-control')!.after(document.createTextNode(' '), photos);
        });
    };
    const plainCompletion = async () => {
        const status = page.getByRole('status').filter({ hasText: /Backed up ✓|Backup updated ✓/ });
        await status.waitFor();
        assert.equal(await page.locator('.bpb-gh-control').getByRole('button').count(), 0,
            'completed backup must expose status text instead of a button');
        const before = await status.evaluate((element: FixtureElement) => {
            const style = getComputedStyle(element);
            return { tag: element.tagName, cursor: style.cursor, background: style.backgroundColor, border: style.borderTopWidth };
        });
        assert.equal(before.tag, 'SPAN');
        assert.equal(before.cursor, 'default');
        assert.equal(before.background, 'rgba(0, 0, 0, 0)');
        assert.equal(before.border, '0px');
        const writes = await page.evaluate(() => globalThis.__backupWrites || 0);
        await status.hover();
        assert.deepEqual(await status.evaluate((element: FixtureElement) => {
            const style = getComputedStyle(element);
            return { tag: element.tagName, cursor: style.cursor, background: style.backgroundColor, border: style.borderTopWidth };
        }), before, 'status hover must not acquire button affordances');
        await status.click();
        assert.equal(await page.evaluate(() => globalThis.__backupWrites || 0), writes, 'clicking status must not write');
        if (await page.locator('.bpb-gh-link').count()) {
            const layout = await page.locator('.bpb-gh-control').evaluate((element: FixtureElement) => {
                const status = element.querySelector<FixtureElement>('.bpb-gh-status')!.getBoundingClientRect();
                const link = element.querySelector<FixtureElement>('.bpb-gh-link')!.getBoundingClientRect();
                const bounds = element.getBoundingClientRect();
                return { status: { x: status.x, right: status.right, centerY: status.y + status.height / 2 },
                    link: { x: link.x, right: link.right, centerY: link.y + link.height / 2 }, right: bounds.right };
            });
            assert.ok(Math.abs(layout.link.centerY - layout.status.centerY) <= 1,
                `commit link must share the completion row: ${JSON.stringify(layout)}`);
            assert.ok(layout.link.x >= layout.status.right + 4 && layout.link.right <= layout.right + 1,
                `commit link must follow the status without overlap or clipping: ${JSON.stringify(layout)}`);
        }
    };
    for (const scale of [1, 2]) {
        await mount(scale);
        const checking = await geometry(page, slot);
        const checkingControl = await geometry(page, '.bpb-gh-control');
        const checkingNeighbors = await Promise.all(neighbors.map(selector => geometry(page, selector)));
        const checkingScroll = await page.evaluate(() => [window.scrollX, window.scrollY]);
        assert.equal(await page.locator('.bpb-gh-control').getByRole('button').count(), 0,
            'a passive GitHub check must expose plain status instead of an inert button');
        const checkingStatus = page.getByRole('status').filter({ hasText: 'Checking GitHub…' });
        await checkingStatus.waitFor();
        const readStatusStyle = (element: FixtureElement) => {
            const style = getComputedStyle(element);
            return { tag: element.tagName, cursor: style.cursor, background: style.backgroundColor, border: style.borderTopWidth };
        };
        const checkingStyle = await checkingStatus.evaluate(readStatusStyle);
        assert.deepEqual(checkingStyle, { tag: 'SPAN', cursor: 'default', background: 'rgba(0, 0, 0, 0)', border: '0px' });
        await checkingStatus.hover();
        assert.deepEqual(await checkingStatus.evaluate(readStatusStyle), checkingStyle);
        await capture(page, `${variant.name}-ascent-checking-${scale}`, true);
        await page.evaluate(() => globalThis.__finishBackupCheck(false));
        await page.getByRole('button', { name: 'Back up ascent and TR' }).waitFor();
        const before = await geometry(page, slot);
        const controlBefore = await geometry(page, '.bpb-gh-control');
        stable(checking, before, `ascent passive check text ${scale}`);
        stable(checkingControl, controlBefore, `ascent passive check group text ${scale}`);
        for (const [index, selector] of neighbors.entries()) {
            stable(checkingNeighbors[index], await geometry(page, selector), `ascent check neighboring link ${index}`);
        }
        assert.deepEqual(await page.evaluate(() => [window.scrollX, window.scrollY]), checkingScroll);
        const neighborBefore = await Promise.all(neighbors.map(selector => geometry(page, selector)));
        for (const success of [false, true]) {
            await page.locator(action).press('Enter');
            await page.waitForFunction(() => typeof globalThis.__finishBackup === 'function');
            stable(before, await geometry(page, slot), 'ascent backup pending');
            assert.equal(await page.locator(action).evaluate((element: FixtureElement) => getComputedStyle(element).cursor), 'default');
            await page.clock.fastForward(20_001);
            await page.locator('.bpb-gh-feedback').filter({ hasText: 'longer than usual' }).waitFor();
            stable(before, await geometry(page, slot), 'ascent slow backup');
            await page.evaluate((success: boolean) => { globalThis.__finishBackup(success); globalThis.__finishBackup = null!; }, success);
            if (success) await plainCompletion();
            else await page.getByRole('button', { name: 'Try again' }).waitFor();
            stable(before, await geometry(page, slot), `ascent backup complete ${success} text ${scale}`);
            if (success) stable(controlBefore, await geometry(page, '.bpb-gh-control'), `ascent completed row text ${scale}`);
            for (const [index, selector] of neighbors.entries()) {
                const after = await geometry(page, selector);
                if (!success && index === 2) {
                    // A necessary error grows below the anchored action. If
                    // the host wraps its following link onto another line,
                    // that line may move by exactly the disclosed error size.
                    stable(neighborBefore[index], after, 'wrapped photo link error', ['x', 'width', 'height']);
                    const expansion = (await geometry(page, '.bpb-gh-control')).height - controlBefore.height;
                    assert.ok(Math.abs(after.y - neighborBefore[index].y) <= 1
                        || Math.abs(after.y - neighborBefore[index].y - expansion) <= 1,
                    'only a necessary below-action error expansion may move a wrapped native link');
                } else stable(neighborBefore[index], after, `ascent neighboring link ${index}`);
            }
        }
        await capture(page, `${variant.name}-ascent-backup-${scale}`);
        await mount(scale);
        const currentBefore = await geometry(page, slot);
        await page.evaluate(() => globalThis.__finishBackupCheck(true));
        await plainCompletion();
        stable(currentBefore, await geometry(page, slot), `ascent already backed up text ${scale}`);
        assert.equal(await page.evaluate(() => globalThis.__backupWrites || 0), 0, 'passive completion must never write');
        await capture(page, `${variant.name}-ascent-current-${scale}`);
        await mount(scale);
        await page.evaluate(() => { globalThis.__backupUpdate = true; globalThis.__finishBackupCheck(false); });
        await page.getByRole('button', { name: 'Back up ascent and TR' }).waitFor();
        const updateBefore = await geometry(page, '.bpb-gh-control');
        const updateNeighbors = await Promise.all(neighbors.map(selector => geometry(page, selector)));
        await page.locator(action).press('Enter');
        await page.waitForFunction(() => typeof globalThis.__finishBackup === 'function');
        await page.evaluate(() => globalThis.__finishBackup(true));
        await page.getByRole('status').filter({ hasText: 'Backup updated ✓' }).waitFor();
        await plainCompletion();
        stable(updateBefore, await geometry(page, '.bpb-gh-control'), `ascent updated row text ${scale}`);
        for (const [index, selector] of neighbors.entries()) {
            stable(updateNeighbors[index], await geometry(page, selector), `ascent updated neighboring link ${index}`);
        }
        await capture(page, `${variant.name}-ascent-updated-${scale}`);
    }
}
async function profileBackupCase(page: Page, origin: string, variant: LayoutVariant) {
    const html = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascents.html'), 'utf8');
    await page.route('**/climber/ClimbListC.aspx**', (route: Route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.addInitScript(({ theme }: { theme: string }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { runtime: { sendMessage: async (message: FixtureMessage) => message.type === 'GITHUB_BACKUP_STATUS'
            ? { enabled: true, connected: true, repo: { fullName: 'fixture/backup' } } : { ok: true } } } as unknown as typeof chrome;
    }, variant);
    await page.goto(`${origin}/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999`);
    await page.addStyleTag({ content: darkCss });
    await page.addStyleTag({ content: (await asset('css/profile-backup.css')).toString() });
    const source = (await asset('content/profile-backup.js')).toString();
    const seam = 'const responseText = (url, kind, signal) =>';
    assert.ok(source.includes(seam), 'profile callback fixture seam');
    // Expose the actual view callback in this fixture only, avoiding live writes.
    await page.addScriptTag({ content: source.replace(seam, `globalThis.__renderBackupProgress = renderState;
        globalThis.__prepareBackup = renderPreparing;
        ${seam}`) });
    await page.locator('#bpb-profile-backup .bpb-profile-primary').waitFor();
    const action = '#bpb-profile-backup .bpb-profile-actions button';
    for (const width of variant.width === 1280 ? [1280, 2048, 4052] : [variant.width]) {
        await page.setViewportSize({ width, height: 900 });
        await capture(page, `${variant.name}-profile-idle-${width}`);
        const primary = await geometry(page, `${action}:first-child`);
        const secondary = await geometry(page, `${action}:nth-child(2)`);
        assert.ok(primary.width <= 260 && secondary.width <= 180,
            `profile actions must stay compact at ${width}px: ${JSON.stringify({ primary, secondary })}`);
        assert.ok(secondary.width < primary.width, 'the secondary action should not occupy a primary-sized slot');
    }
    await page.setViewportSize({ width: variant.width, height: 900 });
    const idle = await page.locator(action).evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
        const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
    }));
    await page.getByRole('button', { name: 'Refresh all', exact: true }).click();
    const confirmation = await page.locator(action).evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
        const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
    }));
    idle.forEach((rect: FixtureRect, index: number) => stable(rect, confirmation[index], `profile refresh confirmation ${index}`));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Back up all ascents and TRs', exact: true }).waitFor();
    await page.evaluate(() => globalThis.__prepareBackup({}));
    const preparing = await page.locator(action).evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
        const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
    }));
    idle.forEach((rect: FixtureRect, index: number) => stable(rect, preparing[index], `profile preparing ${index}`));
    const state = { status: 'running', current: null, completed: 1, total: 99, fetched: 1, buffered: 0, uploading: 0,
        failures: [], backedUp: 0, skipped: 0, notReached: 98 };
    await page.evaluate((state: FixtureState) => globalThis.__renderBackupProgress(state), state);
    const before = await page.locator(action).evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
        const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
    }));
    idle.forEach((rect: FixtureRect, index: number) => stable(rect, before[index], `profile running ${index}`));
    const panelBefore = await geometry(page, '#bpb-profile-backup');
    await page.locator(action).first().focus();
    await page.evaluate(() => { globalThis.__focusedAction = document.activeElement; });
    for (let tick = 0; tick < 20; tick++) {
        await page.evaluate((state: FixtureState) => globalThis.__renderBackupProgress(state), { ...state, completed: tick,
            current: { peakName: tick % 2 ? 'Short peak' : 'An extremely long mountain name repeated through progress updates without moving the active buttons' } });
        const after = await page.locator(action).evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
            const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
        }));
        before.forEach((rect: FixtureRect, index: number) => stable(rect, after[index], `profile progress ${tick} action ${index}`));
        assert.equal(await page.evaluate(() => document.activeElement === globalThis.__focusedAction), true, 'progress preserves focused node');
        stable(panelBefore, await geometry(page, '#bpb-profile-backup'), `profile progress panel ${tick}`);
    }
    for (const status of ['pause-requested', 'paused', 'cancel-requested']) {
        await page.evaluate((state: FixtureState) => globalThis.__renderBackupProgress(state), { ...state, status, pauseReason: 'github', pauseError: null });
        const controls = await page.locator(action).evaluateAll((elements: FixtureElement[]) => elements.map((element: FixtureElement) => {
            const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
        }));
        controls.forEach((rect: FixtureRect, index: number) => stable(before[status === 'cancel-requested' ? 1 : index], rect, `profile ${status}`));
        if (status !== 'paused') {
            const pendingPanel = await geometry(page, '#bpb-profile-backup');
            await page.evaluate(() => { globalThis.__pendingControl = document.querySelector<FixtureElement>('#bpb-profile-backup button'); });
            for (let tick = 0; tick < 5; tick++) {
                await page.evaluate((state: FixtureState) => globalThis.__renderBackupProgress(state), { ...state, status, uploading: tick % 2, completed: tick });
                assert.equal(await page.evaluate(() => globalThis.__pendingControl === document.querySelector<FixtureElement>('#bpb-profile-backup button')), true, 'pending ticks preserve controls');
                stable(pendingPanel, await geometry(page, '#bpb-profile-backup'), `profile pending panel ${status} ${tick}`);
            }
        }
    }
    await capture(page, `${variant.name}-profile-backup`);
}
async function settingsCase(page: Page, origin: string, variant: LayoutVariant) {
    await load(page, origin, 'options/options.html', ({ theme }: { theme: string }) => {
        const settings = { theme, units: 'auto', enable3dMap: true };
        const listeners: ((...changes: unknown[]) => void)[] = [];
        const area = { get: async () => ({ bpbSettings: settings }), set: async (value: { bpbSettings?: object }) => {
            const oldValue = { ...settings }; Object.assign(settings, value.bpbSettings);
            listeners.forEach(listener => listener({ bpbSettings: { oldValue, newValue: { ...settings } } }, 'sync'));
        }, remove: async () => {} };
        globalThis.chrome = { storage: { sync: area, local: area, session: area,
            onChanged: { addListener: (listener: () => void) => listeners.push(listener), removeListener() {} } },
        permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.0' }), getURL: (file: string) => new URL(`/dist/${file}`, location.origin).href,
            sendMessage: async (message: FixtureMessage) => {
                if (message.type === 'SETTINGS_PATCH') {
                    if (globalThis.__holdUnitSave) return new Promise(resolve => {
                        globalThis.__finishUnitSave = (success: boolean) => {
                            if (success) Object.assign(settings, message.patch);
                            globalThis.__finishUnitSave = null!;
                            resolve(success ? { ok: true, settings: { ...settings } } : { ok: false });
                        };
                    });
                    Object.assign(settings, message.patch); return { ok: true, settings: { ...settings } };
                }
                return { ok: true, configured: false, connected: false };
            } } } as unknown as typeof chrome;
    }, variant);
    await page.locator('#unit-example-gpx').filter({ hasText: '12.4 mi' }).waitFor();
    await page.locator('.content').evaluate((content: FixtureElement) => {
        content.style.scrollBehavior = 'auto';
        const fixture = document.createElement('section'); fixture.id = 'jitter-component-fixture';
        fixture.innerHTML = '<div class="github-code"><span class="github-code-value">AAAA-BBBB</span><span class="github-code-copy">Copy</span></div>'
            + '<div class="draft-actions"><button class="secondary" data-action="copy"><span>Copy Markdown</span></button><button class="secondary">Delete</button></div>'
            + '<div class="favorites-source-filter"><button>All <span>123</span></button><button>Custom <span>99</span></button></div>';
        content.append(fixture);
    });
    for (const zoom of [1, 2]) {
        // Browser zoom reduces the CSS viewport and re-evaluates media queries.
        // CSS zoom on body alone misses that reflow and clips narrow fixtures.
        await page.setViewportSize({ width: variant.width, height: 900 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        let gripLeft;
        for (const id of ['map-provider-order', 'beta-peak-order', 'beta-personal-order']) {
            const list = page.locator(`#${id}`);
            const row = list.locator('..');
            if (zoom === 2) await row.evaluate((element: FixtureElement) => {
                for (const text of element.querySelectorAll<FixtureElement>('.title, .desc, .order-setting-label')) {
                    text.style.fontSize = `${parseFloat(getComputedStyle(text).fontSize) * 2}px`;
                }
            });
            await row.scrollIntoViewIfNeeded();
            if (output && captureRequested()) await row.screenshot({ path: path.join(output, `${variant.name}-${id}-${zoom}.png`) });
            const label = await row.locator('.label').boundingBox();
            const bounds = await list.boundingBox();
            const grip = await list.locator('.order-grip').first().boundingBox();
            assert.ok(bounds!.y >= label!.y + label!.height + 8, `${id}: the reorder list must sit below its description`);
            assert.ok(Math.abs(bounds!.x - label!.x) <= 1, `${id}: the list must align with its heading`);
            if (gripLeft !== undefined) assert.ok(Math.abs(grip!.x - gripLeft) <= 1, `${id}: all reorder lists must share a grip alignment`);
            gripLeft = grip!.x;
            assert.ok(bounds!.x + bounds!.width <= (await row.boundingBox())!.x + (await row.boundingBox())!.width,
                `${id}: the reorder list must fit within its setting row`);
            const handle = list.locator('li').nth(1).locator('.order-grip');
            const item = await handle.locator('..').getAttribute('data-order-item');
            await handle.scrollIntoViewIfNeeded();
            const before = await row.boundingBox();
            await page.evaluate(() => { globalThis.__holdUnitSave = true; });
            for (const success of [false, true]) {
                await handle.press('ArrowUp');
                await page.waitForFunction(() => typeof globalThis.__finishUnitSave === 'function');
                stable(before, await row.boundingBox(), `${id} pending zoom ${zoom}`);
                await assertActionFocus(page, `#${id} [data-order-item="${item}"] .order-grip`, `${id} pending reorder focus`);
                await page.evaluate((success: boolean) => globalThis.__finishUnitSave(success), success);
                await page.waitForFunction(({ id, item, success }: { id: string; item: string | null; success: boolean }) => {
                    const list = (document.getElementById(id) as FixtureElement);
                    return list!.querySelector<FixtureElement>('.order-grip')!.getAttribute('aria-disabled') === 'false'
                        && ((list!.firstElementChild as HTMLElement).dataset.orderItem === item) === success;
                }, { id, item, success });
                stable(before, await row.boundingBox(), `${id} save ${success} zoom ${zoom}`);
            }
            await page.evaluate(() => { globalThis.__holdUnitSave = false; });
            await row.evaluate((element: FixtureElement) => {
                element.querySelectorAll<FixtureElement>('.title, .desc, .order-setting-label').forEach((text: FixtureElement) => { text.style.fontSize = ''; });
            });
        }
        await page.setViewportSize({ width: Math.floor(variant.width / zoom), height: Math.floor(900 / zoom) });
        await page.locator('#units').scrollIntoViewIfNeeded();
        const selectors = ['#units', '#general-units .card', '.unit-example', '#unit-customize summary'];
        const before = await Promise.all(selectors.map(selector => geometry(page, selector)));
        const checkUnitsStable = async (label: string) => {
            for (const [index, selector] of selectors.entries()) {
                stable(before[index], await geometry(page, selector), `${selector} ${label} zoom ${zoom}`);
            }
        };
        for (const [units, gpx, weather] of [
            ['metric', '20.0 km · 800 m ascent', '9°C · 4.2 mm · 16 km/h'],
            ['imperial', '12.4 mi · 2625 ft ascent', '48°F · 0.17 in · 10 mph'],
            ['auto', '12.4 mi · 2625 ft ascent', '48°F · 0.17 in · 10 mph'],
        ]) {
            await page.selectOption('#units', units);
            await page.waitForFunction(({ gpx, weather }: { gpx: string; weather: unknown }) => (document.getElementById('unit-example-gpx') as FixtureElement)!.textContent === gpx
                && (document.getElementById('unit-example-weather') as FixtureElement)!.textContent === weather, { gpx, weather });
            await checkUnitsStable(`units example ${units}`);
            assert.equal(await page.locator('#unit-customize').evaluate((details: FixtureElement) => details.open), false,
                'default changes keep the customization disclosure closed');
        }
        await page.locator('.unit-example').evaluate((element: FixtureElement) => {
            const card = element.closest<FixtureElement>('.card');
            const preview = element.getBoundingClientRect();
            const bounds = card!.getBoundingClientRect();
            if (!card || preview.top < bounds.top || preview.bottom > bounds.bottom) throw new Error('unit preview is detached from its controls');
            for (const child of element.querySelectorAll<FixtureElement>('dt, dd, .unit-example-heading')) {
                const rect = child.getBoundingClientRect();
                if (rect.left < preview.left || rect.right > preview.right || child.scrollWidth > child.clientWidth + 1) {
                    throw new Error(`unit preview clipped ${child.textContent} at ${JSON.stringify(rect.toJSON())}`);
                }
            }
        });
        await page.evaluate(() => { globalThis.__holdUnitSave = true; });
        for (const success of [false, true]) {
            await page.selectOption('#units', 'metric');
            await page.waitForFunction(() => typeof globalThis.__finishUnitSave === 'function'
                && (document.getElementById('unit-example-gpx') as FixtureElement)!.textContent === '20.0 km · 800 m ascent');
            await checkUnitsStable('pending save');
            await page.evaluate((success: boolean) => globalThis.__finishUnitSave(success), success);
            await page.waitForFunction((success: boolean) => (document.getElementById('units') as FixtureElement)!.value === (success ? 'metric' : 'auto')
                && (document.getElementById('unit-example-gpx') as FixtureElement)!.textContent === (success ? '20.0 km · 800 m ascent' : '12.4 mi · 2625 ft ascent')
                && (document.getElementById('status-error') as FixtureElement)!.hidden === success, success);
            await checkUnitsStable(success ? 'retry saved' : 'failed save restored');
        }
        await page.evaluate(() => { globalThis.__holdUnitSave = false; });
        if (output && captureRequested()) await page.locator('#status').waitFor({ state: 'hidden' });
        await page.locator('#general-units').evaluate((element: FixtureElement) => element.scrollIntoView({ block: 'start' }));
        await capture(page, `${variant.name}-units-collapsed-${zoom}`);
        if (output && captureRequested()) {
            if (zoom === 1) await page.locator('#general-units').screenshot({ path: path.join(output, `${variant.name}-units-card-${zoom}.png`) });
            await page.locator('.unit-example').scrollIntoViewIfNeeded();
            await page.locator('.unit-example').screenshot({ path: path.join(output, `${variant.name}-units-preview-${zoom}.png`) });
        }
        await page.locator('#unit-customize summary').press('Enter');
        await page.waitForFunction(() => (document.getElementById('unit-customize') as FixtureElement)!.open);
        const previewBefore = await geometry(page, '.unit-example');
        const cardBefore = await geometry(page, '#general-units .card');
        await page.selectOption('#temperature-units', 'imperial');
        await page.selectOption('#precipitation-units', 'imperial');
        await page.locator('#unit-example-weather').filter({ hasText: '48°F · 0.17 in · 16 km/h' }).waitFor();
        stable(previewBefore, await geometry(page, '.unit-example'), `mixed unit preview zoom ${zoom}`, ['width', 'height']);
        stable(cardBefore, await geometry(page, '#general-units .card'), `mixed unit card zoom ${zoom}`, ['width', 'height']);
        if (output && captureRequested()) await page.locator('#status').waitFor({ state: 'hidden' });
        await page.locator('#general-units').evaluate((element: FixtureElement) => element.scrollIntoView({ block: 'start' }));
        await capture(page, `${variant.name}-units-custom-${zoom}`);
        await page.locator('#unit-reset').press('Enter');
        await page.locator('#unit-example-weather').filter({ hasText: '9°C · 4.2 mm · 16 km/h' }).waitFor();
        await page.locator('#unit-customize summary').press('Enter');
        await page.waitForFunction(() => !(document.getElementById('unit-customize') as FixtureElement)!.open);
        // Finish the prior unit action before independent component probes.
        // Its toast dock precedes the synthetic fixture and changes its flow.
        await page.locator('#status').waitFor({ state: 'hidden' });
        for (const id of ['terrain-cache-usage', 'settings-backup-github-status', 'favorites-github-status', 'ignored-github-status', 'photos-github-status']) {
            await page.locator(`#${id}`).evaluate((element: FixtureElement) => {
                const row = element.closest<FixtureElement>('.row'); row!.hidden = false;
                row!.querySelectorAll<FixtureElement>('.control').forEach((control: FixtureElement) => { control.hidden = false; });
            });
            const row = page.locator(`#${id}`).locator('..');
            await row.scrollIntoViewIfNeeded();
            const action = row.locator('button, input').first();
            const rect = await action.boundingBox();
            await page.locator(`#${id}`).evaluate((element: FixtureElement) => { element.textContent = 'A long error from the connected backup service. Check your connection and review the current backup before retrying. '.repeat(3); });
            stable(rect, await action.boundingBox(), `${id} feedback zoom ${zoom}`);
        }
        const nav = page.locator('.nav-item').first();
        const navBefore = await nav.boundingBox();
        await nav.evaluate((element: FixtureElement) => { element.toggleAttribute('aria-current', !element.hasAttribute('aria-current')); });
        stable(navBefore, await nav.boundingBox(), `navigation selected zoom ${zoom}`);
        await page.locator('#jitter-component-fixture').scrollIntoViewIfNeeded();
        for (const [selector, labels] of [['.github-code-copy', ['Copied', 'Select and copy']], ['[data-action="copy"] > span', ['Copied', 'Copy Markdown']]]) {
            const target = page.locator(`#jitter-component-fixture ${selector}`);
            const parent = target.locator('..');
            const rect = await parent.boundingBox();
            for (const label of labels) {
                await target.evaluate((element: FixtureElement, label: string) => { element.textContent = label; }, label);
                stable(rect, await parent.boundingBox(), `${selector} ${label} zoom ${zoom}`);
            }
        }
        const filter = page.locator('#jitter-component-fixture .favorites-source-filter button').first();
        const filterRect = await filter.boundingBox();
        await filter.evaluate((element: FixtureElement) => { element.setAttribute('aria-pressed', 'true'); });
        stable(filterRect, await filter.boundingBox(), `favorites selected zoom ${zoom}`);
    }
    await page.setViewportSize({ width: variant.width, height: 900 });
    await capture(page, `${variant.name}-settings`, true);
}
async function photoBackupCase(page: Page, origin: string, variant: LayoutVariant) {
    await load(page, origin, 'photos/photos.html?mode=library', ({ theme }: { theme: string }) => {
        const area = { get: async () => ({ bpbSettings: { theme } }), set: async () => {}, remove: async () => {} };
        globalThis.__backupCalls = 0;
        globalThis.chrome = { storage: { sync: area, local: area, onChanged: { addListener() {}, removeListener() {} } },
            runtime: { getURL: (file: string) => new URL(`/dist/${file}`, location.origin).href,
                sendMessage: async (message: FixtureMessage) => {
                    if (message.type === 'GITHUB_PHOTOS_BACKUP') {
                        globalThis.__backupCalls++;
                        return new Promise(resolve => { globalThis.__finishBackup = (reply: unknown) => { globalThis.__finishBackup = null!; resolve(reply); }; });
                    }
                    if (message.type === 'GITHUB_PHOTOS_STATUS') return { ok: true, connected: true,
                        repo: { fullName: 'fixture/photo-backup' }, state: null };
                    return { ok: true, configured: false };
                } } } as unknown as typeof chrome;
    }, variant);
    await page.locator('#library-empty').waitFor();
    const action = '#backup-library';
    for (const scale of [1, 2]) {
        await page.addStyleTag({ content: `.backup-card button { font-size: ${14 * scale}px; }` });
        await page.locator(action).scrollIntoViewIfNeeded();
        const selectors = [action, '.backup-card', '#photo-backup-heading', '#library-list'];
        const before = await Promise.all(selectors.map(selector => geometry(page, selector)));
        const scroll = await page.evaluate(() => document.scrollingElement!.scrollTop);
        for (const success of [false, true]) {
            const calls = await page.evaluate(() => globalThis.__backupCalls);
            await page.locator(action).press('Enter');
            await page.waitForFunction(() => typeof globalThis.__finishBackup === 'function');
            await assertActionFocus(page, action, 'photo library pending focus');
            await page.keyboard.press('Enter'); await page.keyboard.press('Space');
            assert.equal(await page.evaluate(() => globalThis.__backupCalls), calls + 1, 'one photo backup request');
            for (const [index, selector] of selectors.entries()) stable(before[index], await geometry(page, selector), `${selector}: pending ${scale}`);
            await capture(page, `${variant.name}-photo-backup-pending-${scale}`);
            if (success) await page.locator('#library-search').focus();
            await page.evaluate((success: boolean) => globalThis.__finishBackup(success ? { ok: true }
                : { ok: false, error: { message: 'The photo-library backup failed. Check your connection and try again.' } }), success);
            await page.waitForFunction(() => (document.getElementById('backup-library') as FixtureElement)!.getAttribute('aria-busy') === 'false');
            await assertActionFocus(page, success ? '#library-search' : action, 'photo library completed focus');
            for (const [index, selector] of selectors.entries()) stable(before[index], await geometry(page, selector), `${selector}: complete ${scale}`);
            assert.ok(Math.abs(scroll - await page.evaluate(() => document.scrollingElement!.scrollTop)) <= 1, 'photo library reading position');
        }
    }
}
async function photoCase(page: Page, origin: string, variant: LayoutVariant) {
    const html = (await asset('photos/photos.html')).toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    await page.route(`${origin}/dist/photos/photos.html`, (route: Route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${origin}/dist/photos/photos.html`);
    await page.evaluate(({ theme }: { theme: string }) => {
        document.documentElement.dataset.bpbTheme = theme;
        (document.getElementById('editor-view') as FixtureElement)!.hidden = false;
        document.querySelector<FixtureElement>('.editor-footer')!.closest<FixtureElement>('[hidden]')?.removeAttribute('hidden');
        (document.getElementById('jpeg-quality-control') as FixtureElement)!.hidden = false;
    }, variant);
    // Report context: the finish group ends on Upload, set apart by the gap,
    // the arrangement arrangeFinishActions() makes once for a report session.
    await page.evaluate(() => {
        const group = document.getElementById('finish-actions')!;
        group.append(group.querySelector('.finish-gap')!, document.getElementById('upload-insert')!,
            document.getElementById('finish-status')!);
        const upload = document.getElementById('upload-insert')!;
        upload.dataset.sizingLabel = 'Upload and insert…';
        upload.querySelector('span')!.textContent = 'Upload and insert…';
        upload.classList.replace('quiet', 'primary');
        document.getElementById('finish-status')!.dataset.sizingLabel = 'Upload and insert…';
    });
    const upload = '#upload-insert';
    await page.locator(upload).scrollIntoViewIfNeeded();
    // Page coordinates exclude deliberate scrolling to reach a recovery field.
    const rect = async (selector: string) => page.locator(selector).evaluate((element: FixtureElement) => {
        const r = element.getBoundingClientRect(); return { x: r.x + globalThis.scrollX, y: r.y + globalThis.scrollY, width: r.width, height: r.height };
    });
    const actions = ['#copy-image', '#export-image', upload];
    const before = Object.fromEntries(await Promise.all(actions.map(async id => [id, await rect(id)] as const)));
    const actionsStable = async (label: string, ids = actions) => {
        for (const id of ids) stable(before[id], await rect(id), `${label}: ${id}`);
    };
    const exportRect = before['#export-image'], uploadRect = before[upload];
    // Publishing stands apart from the local actions: more than the ordinary
    // 8px between neighbours, unless the row has wrapped.
    if (Math.abs(exportRect.y - uploadRect.y) < 1) {
        const spacing = uploadRect.x - (exportRect.x + exportRect.width);
        if (spacing < 20) throw new Error(`photo finish: Upload is not set apart from Export (${spacing}px)`);
    }
    for (const message of ['Estimating size…', '25.6 MB JPEG', 'Size unavailable']) {
        await page.evaluate((message: string) => {
            document.getElementById('upload-estimate')!.textContent = message;
            document.getElementById('upload-estimate-note')!.textContent = 'A long image warning and recovery message that wraps on narrow layouts';
            document.getElementById('output-summary')!.textContent = `JPEG · ${message}`;
            document.getElementById('save-status')!.textContent = 'The draft could not be saved yet. Check local storage and try again.';
        }, message);
        await actionsStable(`photo estimate ${message}`);
    }
    await page.evaluate(() => {
        const note = document.getElementById('finish-note')!;
        note.hidden = false;
        document.getElementById('finish-note-text')!.textContent
            = 'Reports need a hosted image. Connect ImgBB to insert it, or export it and host it anywhere.';
        document.getElementById('editor-status')!.textContent = 'Downloading a-very-long-photo-title-for-the-north-ridge-topo.jpg · 12.4 MB';
    });
    await actionsStable('photo finish note');
    for (const [id, labels] of [['#copy-image', ['Copying…', 'Copied', 'Copy image']], ['#export-image', ['Exporting…', 'Export image']]] as const) {
        for (const label of labels) {
            await page.locator(`${id} > span`).evaluate((element: FixtureElement, label: string) => { element.textContent = label; }, label);
            await actionsStable(`photo ${id} ${label}`);
        }
    }
    await page.locator(upload).hover();
    await actionsStable('photo upload hover');
    await page.locator(upload).evaluate((element: FixtureElement) => { element.dispatchEvent(new globalThis.PointerEvent('pointerdown')); });
    await actionsStable('photo upload pointerdown');
    // Completion swaps the action for a plain status of the same footprint.
    await page.evaluate(() => {
        document.getElementById('upload-insert')!.hidden = true;
        const status = document.getElementById('finish-status')!;
        status.innerHTML = '<span>Inserted</span>';
        status.hidden = false;
    });
    await actionsStable('photo Upload to Inserted', ['#copy-image', '#export-image']);
    stable(uploadRect, await rect('#finish-status'), 'photo Inserted status takes the upload footprint', ['x', 'y', 'height']);
    await capture(page, `${variant.name}-photo-footer`);
    await page.evaluate(() => {
        const toast = (document.getElementById('toast') as FixtureElement); toast!.hidden = false;
        (document.getElementById('toast-message') as FixtureElement)!.textContent = 'Your image is ready. Copy the URL.';
        const action = (document.getElementById('toast-action') as FixtureElement); action!.hidden = false; action!.dataset.sizingLabel = 'Try copy again';
        action!.innerHTML = '<span>Copy URL</span>';
    });
    const action = '#toast-action';
    const actionRect = await geometry(page, action);
    for (const label of ['Copy again', 'Try copy again']) {
        await page.locator(`${action} > span`).evaluate((element: FixtureElement, label: string) => { element.textContent = label; }, label);
        await page.locator('#toast-message').evaluate((element: FixtureElement) => { element.textContent = 'Copy unavailable. The complete URL is selected for manual copying. '.repeat(3); });
        await page.locator('#toast-copy-value, #toast-copy-status').evaluateAll((elements: FixtureElement[]) => elements.forEach((element: FixtureElement) => { element.hidden = false; }));
        stable(actionRect, await geometry(page, action), `photo toast ${label}`);
    }
    await capture(page, `${variant.name}-photo-toast`);
}
async function weatherCase(page: Page, origin: string, variant: LayoutVariant) {
    await page.goto(`${origin}/dist/photos/guide.html`);
    await page.evaluate(({ theme }: { theme: string }) => {
        document.documentElement.dataset.bpbTheme = theme;
        document.body.innerHTML = '<section id="bpb-peak-weather"><div id="jitter-hours"></div></section>';
    }, variant);
    await page.addStyleTag({ content: (await asset('css/card.css')).toString() });
    await page.addStyleTag({ content: (await asset('css/peak-weather.css')).toString() });
    const source = (await asset('content/peak-weather.js')).toString();
    const end = source.lastIndexOf('})();');
    assert.ok(end > 0, 'hourly shipped bundle seam');
    await page.addScriptTag({ content: source.slice(0, end) + 'globalThis.__createHourlyChart = createPeakHourlyChart;' + source.slice(end) });
    for (const zoom of [1, 2]) {
        await page.locator('#bpb-peak-weather').evaluate((element: FixtureElement, zoom: number) => {
            element.style.fontSize = `${13 * zoom}px`;
            element.querySelectorAll<FixtureElement>('.bpb-week-readout').forEach((readout: FixtureElement) => { readout.style.fontSize = `${12 * zoom}px`; });
        }, zoom);
        await page.evaluate(() => {
            const start = Date.parse('2025-01-01T18:15:00Z'), end = start + 24 * 3600_000;
            globalThis.__chart?.dispose();
            globalThis.__chart = globalThis.__createHourlyChart({ container: (document.getElementById('jitter-hours') as FixtureElement),
                day: { window: { date: '2025-01-02', start, end, cutoff: end } },
                samples: Array.from({ length: 26 }, (_, index) => ({ time: Math.floor(start / 3600_000) * 3600_000 + index * 3600_000,
                    temperature: -15 + index, precipitation: index / 10, wind: index * 10, gust: null })),
                zone: { timeZone: 'Asia/Kathmandu', offsetMs: 20700000 }, metric: 'temperature', referenceLabel: 'Location', onMetric() {},
                format: (value: number, key: string) => `${value.toFixed(1)} ${key === 'temperature' ? '°C' : key === 'precipitation' ? 'mm' : 'km/h'}` });
        });
        assert.match((await page.locator('.bpb-week-sub').textContent())!, /Local time at selected point/);
        const frame = '.bpb-week-chart';
        await page.locator('.bpb-week-readout').evaluate((element: FixtureElement, zoom: number) => { element.style.fontSize = `${12 * zoom}px`; }, zoom);
        const before = await geometry(page, frame);
        for (const metric of ['temperature', 'precipitation', 'wind', 'gust']) {
            await page.click(`[data-metric="${metric}"]`);
            stable(before, await geometry(page, frame), `weather ${metric} zoom ${zoom}`);
            if (metric !== 'gust') {
                await page.locator(frame).focus();
                for (const key of ['Home', 'End', 'ArrowLeft', 'Escape']) {
                    await page.keyboard.press(key);
                    stable(before, await geometry(page, frame), `weather reading ${metric} ${key} zoom ${zoom}`);
                }
                const rect = await geometry(page, frame);
                await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
                stable(before, await geometry(page, frame), `weather hover ${metric}`);
            }
        }
        await capture(page, `${variant.name}-weather-${zoom}`);
    }
}
async function reportFilterCase(page: Page, origin: string, variant: LayoutVariant) {
    await page.route('https://**/*', (route: Route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    // Keep native icon dimensions; failed image/alt-text layout is unrelated
    // to the report table's real content widths.
    await page.route(/\/image\/(Suc|UnSuc|GPS)\.gif/i, (route: Route) => route.fulfill({ contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${/GPS/i.test(route.request().url()) ? 25 : 16}" height="16"><rect width="100%" height="100%" fill="green"/></svg>` }));
    const html = (await readFile(path.join(projectRoot, 'test/fixtures/pages/peak-rainier.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('**/Peak.aspx**', (route: Route) => route.fulfill({ body: html, contentType: 'text/html' }));
    await page.addInitScript(({ theme }: { theme: string }) => {
        const listeners = new Set<(...changes: unknown[]) => void>(), local = { bpbPeakReportFilter: { schemaVersion: 1, favoritesOnly: false },
            bpbFavoriteClimbers: { schemaVersion: 1, entries: [{ cid: 38769, name: 'Favorite', source: 'manual', addedAt: 1 }] } };
        globalThis.__preferenceWrites = 0;
        globalThis.chrome = { storage: {
            local: { get: async () => local }, sync: { get: async () => ({ bpbSettings: { theme, favoritesSource: 'custom' } }) },
            onChanged: { addListener: (fn: (...changes: unknown[]) => void) => listeners.add(fn), removeListener: (fn: (...changes: unknown[]) => void) => listeners.delete(fn) } },
        runtime: { getURL: (file: string) => `${location.origin}/dist/${file}`, sendMessage: (message: FixtureMessage) => {
            if (message.type !== 'PEAK_REPORT_PREFERENCE') return Promise.resolve({ ok: true });
            globalThis.__preferenceWrites++;
            return new Promise(resolve => { globalThis.__finishPreference = (failure: boolean) => {
                if (!failure) {
                    local.bpbPeakReportFilter = { schemaVersion: 1, favoritesOnly: message.favoritesOnly as boolean };
                    listeners.forEach(fn => fn({ bpbPeakReportFilter: { newValue: local.bpbPeakReportFilter } }, 'local'));
                }
                resolve({ ok: !failure });
            }; });
        } } } as unknown as typeof chrome;
    }, variant);
    await page.goto(`${origin}/Peak.aspx?pid=2296`);
    await page.evaluate((theme: string) => { document.documentElement.dataset.bpbTheme = theme; }, variant.theme);
    await page.addStyleTag({ content: darkCss });
    await page.addScriptTag({ content: (await asset('content/peak-report-filter.js')).toString() });
    const button = page.locator('.bpb-report-favorites'); await button.filter({ hasText: 'Favorite climbers · 1' }).waitFor();
    await page.waitForFunction(() => [...document.images].every(image => image.complete));
    const assertNaturalColumns = async (label: string) => {
        const widths = await page.locator('#bpb-selected-reports').evaluate(async (table: FixtureElement) => {
            // Compare with the native table under the same host styles and
            // available width, without the extension's table-specific rules.
            const native = table.cloneNode(true) as FixtureElement;
            native.removeAttribute('id'); native.style.visibility = 'hidden';
            table.after(native);
            const columns = (element: FixtureElement) => [...(element as unknown as HTMLTableElement).rows[0].cells].map(cell => cell.getBoundingClientRect().width);
            try {
                await Promise.all([...native.querySelectorAll<FixtureElement>('img')].map(image => image.decode().catch(() => {})));
                return { actual: columns(table), native: columns(native) };
            }
            finally { native.remove(); }
        });
        assert.equal(widths.actual.length, 6, `${label}: six report columns`);
        for (const [index, width] of widths.native.entries()) assert.ok(Math.abs(widths.actual[index] - width) <= 1,
            `${label}: column ${index} must hug its content as the native table does: ${JSON.stringify(widths)}`);
    };
    await assertNaturalColumns('all reports');
    await button.scrollIntoViewIfNeeded(); await button.focus();
    const scrollBefore = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight }));
    await capture(page, `${variant.name}-report-filter-before`);
    const before = await geometry(page, '.bpb-report-favorites');
    await button.press('Enter');
    await page.waitForFunction(() => typeof globalThis.__finishPreference === 'function');
    assert.equal(await button.getAttribute('aria-disabled'), 'true');
    await assertActionFocus(page, '.bpb-report-favorites', 'report preference pending focus');
    await assertNaturalColumns('filtered reports pending');
    await capture(page, `${variant.name}-report-filter-pending`);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore.y, 'filtering preserves the reading position');
    stable(before, await geometry(page, '.bpb-report-favorites'), 'report preference pending');
    await button.evaluate((node: FixtureElement) => node.click());
    assert.equal(await page.evaluate(() => globalThis.__preferenceWrites), 1);
    await page.evaluate(() => globalThis.__finishPreference(true));
    await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-report-favorites')!.getAttribute('aria-disabled') === 'false');
    await assertActionFocus(page, '.bpb-report-favorites', 'report preference error focus');
    await assertNaturalColumns('filtered reports error');
    stable(before, await geometry(page, '.bpb-report-favorites'), 'report preference error');
    await page.getByRole('button', { name: 'Retry', exact: true }).press('Enter');
    await page.waitForFunction(() => globalThis.__preferenceWrites === 2);
    await page.evaluate(() => globalThis.__finishPreference(false));
    await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-report-favorites')!.getAttribute('aria-disabled') === 'false');
    assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).evaluate((node: FixtureElement) => document.activeElement === node), true, 'retry retains completion focus');
    assert.match((await page.locator('#bpb-peak-report-tools').textContent())!, /1 of 30/);
    await assertNaturalColumns('filtered reports complete');
    await capture(page, `${variant.name}-report-filter`, true);
}
async function sunCase(page: Page, origin: string, variant: LayoutVariant) {
    await page.goto(`${origin}/dist/photos/guide.html`);
    await page.evaluate(({ theme }: { theme: string }) => {
        document.head.querySelectorAll<FixtureElement>('style,link[rel="stylesheet"]').forEach(node => node.remove());
        document.documentElement.dataset.bpbTheme = theme;
        document.body.innerHTML = '<main id="sun-mount" style="margin:16px;max-width:720px"></main>';
    }, variant);
    await page.addStyleTag({ content: (await asset('css/sun-calculator.css')).toString() });
    const source = (await asset('content/peak-map.js')).toString(), end = source.lastIndexOf('})();');
    assert.ok(end > 0, 'Sun calculator shipped seam');
    await page.addScriptTag({ content: source.slice(0, end) + 'globalThis.__sun = { createSunCalculator, mountainTime, sunPosition };' + source.slice(end) });
    await page.evaluate(() => {
        const { createSunCalculator, mountainTime, sunPosition } = globalThis.__sun;
        globalThis.__calculator = createSunCalculator({ mount: (document.getElementById('sun-mount') as FixtureElement), mode: 'peak' });
        globalThis.__calculator.setTheme(document.documentElement.dataset.bpbTheme);
        globalThis.__renderSun = (lat: number, date: string) => {
            const lon = 15, zone = mountainTime.resolve(lat, lon), minute = 120;
            const instant = mountainTime.civilToInstant(zone, date, minute) as unknown as { ms: number };
            globalThis.__calculator.render({ mode: 'peak', subject: { lat, lon }, zone, date, minute, instant,
                dateSource: 'Selected date', timeSource: 'Selected time', mapBearing: 0, theme: document.documentElement.dataset.bpbTheme,
                result: sunPosition.calculate({ lat, lon, zone, date, ms: instant.ms }) });
        };
        globalThis.__renderSun(63, '2026-12-24');
    });
    await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-sun-calculator__toggle')!.getAttribute('aria-expanded') === 'true');
    await page.locator('.bpb-sun-calculator__moon-events-text').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-sun-calculator__moon-events-text')!.textContent.includes('2026-12-22'));
    await capture(page, `${variant.name}-sun-distant-date`);
    await page.evaluate(() => globalThis.__renderSun(66, '2026-12-23'));
    await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-sun-calculator__moon-events-text')!.textContent.includes('above the level horizon all day'));
    await capture(page, `${variant.name}-sun-all-day`, true);
}
async function gpxSourceCase(page: Page, origin: string, variant: LayoutVariant) {
    await page.goto(`${origin}/dist/photos/guide.html`);
    await page.evaluate(({ theme }: { theme: string }) => {
        // The photo guide's global hidden override would mask the analyzer bug.
        document.head.querySelectorAll<FixtureElement>('style,link[rel="stylesheet"]').forEach(element => element.remove());
        document.documentElement.dataset.bpbTheme = theme;
        document.body.innerHTML = '<main style="margin:16px;max-width:600px"><div id="bpb-gpx-analysis">'
            + '<section id="bpb-gpx-segment-details"><button class="bpb-gpx-segment-view" hidden data-label="Show all source segments"><span>Show all source segments</span></button>'
            + '<p>168 points used. One segment needs review; no points excluded.</p></section></div><p id="source-following">Following reading position</p></main>';
        (document.getElementById('bpb-gpx-analysis') as FixtureElement)!.dataset.theme = theme;
    }, variant);
    await page.addStyleTag({ content: gpxPanelCss });
    for (const zoom of [1, 2]) {
        await page.locator('main').evaluate((element: FixtureElement, zoom: number) => { element.style.zoom = zoom as unknown as string; }, zoom);
        const control = page.locator('.bpb-gpx-segment-view');
        assert.equal(await control.isVisible(), false, 'warning-only GPX must not display its hidden source-view control');
        assert.equal(await control.evaluate((element: FixtureElement) => element.getClientRects().length), 0, 'hidden source view reserves no empty button gap');
        const hiddenBefore = await geometry(page, '#source-following');
        await control.evaluate((element: FixtureElement) => { element.hidden = false; });
        await control.waitFor({ state: 'visible' });
        const before = await geometry(page, '.bpb-gpx-segment-view');
        const following = await geometry(page, '#source-following');
        for (const label of ['Use interpreted view', 'Show all source segments']) {
            await control.evaluate((element: FixtureElement, label: string) => { element.firstElementChild!.textContent = label; }, label);
            stable(before, await geometry(page, '.bpb-gpx-segment-view'), `GPX source label ${label} zoom ${zoom}`);
            stable(following, await geometry(page, '#source-following'), 'GPX source label reading position');
        }
        await control.evaluate((element: FixtureElement) => { element.hidden = true; });
        stable(hiddenBefore, await geometry(page, '#source-following'), 'GPX warning-only state restored');
        await capture(page, `${variant.name}-gpx-warning-${zoom}`);
    }
}
async function mapCase(page: Page, origin: string, variant: LayoutVariant) {
    await page.goto(`${origin}/dist/photos/guide.html`);
    await page.evaluate(({ theme }: { theme: string }) => {
        document.head.querySelectorAll<FixtureElement>('style,link[rel="stylesheet"]').forEach(element => element.remove());
        document.documentElement.dataset.bpbTheme = theme;
        document.body.innerHTML = '<h1 id="map-heading">Dynamic Map</h1><div id="bpb-terrain-frame" style="height:360px;background:#c4cdc3"></div><h2 id="map-following">Following native content</h2>'
            + '<div id="bpb-gpx-analysis"><div class="bpb-gpx-header" style="display:grid">'
            + '<div class="bpb-gpx-controls"><button>Units</button></div><section id="bpb-gpx-segment-details">'
            + '<button class="bpb-gpx-segment-view" data-label="Show all source segments"><span>Show all source segments</span></button><p>Interpreted view</p></section>'
            + '<button class="bpb-gpx-retry">Try loading again</button><div class="bpb-gpx-stats">Metrics</div></div>'
            + '<canvas style="width:100%;height:150px"></canvas><div class="bpb-gpx-coordinate-controls"><button class="bpb-gpx-copy-coordinates">Copy coordinates</button><div class="bpb-gpx-hint">Choose a point</div></div></div>'
            + '<p>Following analyzer content</p>';
    }, variant);
    await page.addStyleTag({ content: gpxPanelCss });
    await page.addStyleTag({ content: 'body{margin:16px;font:14px Arial}' });
    await page.addStyleTag({ content: (await asset('css/map-layers.css')).toString() });
    await page.evaluate(() => {
        // The shipped owner/control run normally. Only the isolated station
        // service and authorized terrain renderer are replaced by protocol stubs.
        globalThis.__layoutRequests = [];
        window.addEventListener('message', event => {
            const data = event.data;
            if (data?.__bpbTerrain && data.dir === 'toCS' && data.type === 'layers') globalThis.__layoutSnapshot = data.snapshot;
            if (data?.__bpbMapLayers && data.dir === 'toCS' && data.type === 'stations') globalThis.__layoutRequests.push(data);
        });
    });
    await page.addScriptTag({ content: (await asset('content/map-layers.js')).toString() });
    await page.evaluate(() => {
        window.postMessage({ __bpbTerrain: true, dir: 'toPage', type: 'loaded' }, location.origin);
        window.postMessage({ __bpbTerrain: true, dir: 'toPage', type: 'layerView', bounds: [-122,46,-121,47], zoom: 16 }, location.origin);
    });
    await page.waitForFunction(() => Boolean(globalThis.__layoutSnapshot));
    assert.equal(await page.locator('.bpb-map-layers').isVisible(), false, 'pending preferences cannot expose editable defaults');
    const nativeBeforePreferences = await geometry(page, '#map-following');
    await page.evaluate(() => window.postMessage({ __bpbMapLayers: true, dir: 'toPage', type: 'preferences', snotel: true,
        preferences: { sentinel: 31, slope: 42, land: 73 } }, location.origin));
    const trigger = '.bpb-layers-trigger';
    await page.locator(trigger).waitFor();
    stable(nativeBeforePreferences, await geometry(page, '#map-following'), 'preference readiness preserves native reading position');
    const triggerBefore = await geometry(page, trigger);
    await page.locator(trigger).focus(); await page.keyboard.press('Enter');
    await page.locator('.bpb-layers-panel').waitFor();
    stable(triggerBefore, await geometry(page, trigger), 'opening Overlays keeps its trigger anchored');
    for (const scale of [1, 2]) {
        await page.locator('.bpb-map-layers').evaluate((element: FixtureElement, scale: number) => { element.style.fontSize = `${13 * scale}px`; }, scale);
        const selectors = [trigger, ...['sentinel', 'slope', 'land', 'snotel'].map(id => `[data-layer="${id}"]`), '#map-heading', '#bpb-terrain-frame', '#map-following'];
        let baseline = await Promise.all(selectors.map(selector => geometry(page, selector)));
        const scroll = await page.evaluate(() => [window.scrollX, window.scrollY]);
        const anchored = async (label: string) => {
            for (let index = 0; index < selectors.length; index++) stable(baseline[index], await geometry(page, selectors[index]), `${label} ${selectors[index]}`);
            assert.deepEqual(await page.evaluate(() => [window.scrollX, window.scrollY]), scroll, `${label} reading position`);
        };
        for (const id of ['sentinel', 'slope', 'land', 'snotel']) {
            const checkbox = page.locator(`[data-layer="${id}"] input`);
            if (!await checkbox.isChecked()) { await checkbox.focus(); await page.keyboard.press('Space'); }
            await page.waitForFunction((id: string) => globalThis.__layoutSnapshot?.state[id].enabled, id);
            const disclosure = page.locator(`[data-layer="${id}"] button`);
            if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
            // Details follow the schema's overlay order, which gains layers over time.
            const detailIndex = await page.locator('.bpb-layers-row').evaluateAll((rows: FixtureElement[], id: string) => rows.findIndex((row: FixtureElement) => row.dataset.layer === id), id);
            const detail = `.bpb-layers-detail:nth-child(${detailIndex + 1})`;
            const retry = `${detail} .bpb-layers-retry`;
            const status = async (failure: boolean) => {
                await page.evaluate(({ id, failure }: { id: string; failure: boolean }) => {
                    if (id === 'snotel') {
                        const requestId = globalThis.__layoutRequests.at(-1)!.requestId;
                        window.postMessage({ __bpbMapLayers: true, dir: 'toPage', type: 'stations', requestId,
                            ...(failure ? { error: true } : { stations: [] }) }, location.origin);
                    } else window.postMessage({ __bpbTerrain: true, dir: 'toPage', type: 'layerStatus', id,
                        revision: globalThis.__layoutSnapshot.revision, pending: false, error: failure, retry: failure,
                        captureError: id === 'sentinel' && failure,
                        message: failure ? 'Some imagery could not load. Check your connection and try again. '.repeat(3) : 'Loaded',
                        ...(id === 'sentinel' ? { capture: 'latest', captures: [{ id: 'latest', label: 'Latest · 10-07 18:27 · ☁ 100%' },
                            { id: 'older', label: '2026-10-06 18:27 · ☁ ?' }] } : {}) }, location.origin);
                }, { id, failure });
                await page.waitForFunction(({ id, failure }: { id: string; failure: boolean }) => document.querySelector<FixtureElement>(`[data-layer="${id}"]`)!.dataset.status === (failure ? 'error' : ''), { id, failure })
                    .catch(async (error: Error) => { throw new Error(`${id} ${failure ? 'failure' : 'success'} did not settle: ${await page.locator(`[data-layer="${id}"]`).textContent()}; requests=${await page.evaluate(() => globalThis.__layoutRequests.map((request: FixtureMessage) => request.requestId))}`, { cause: error }); });
            };
            if (id === 'snotel') await page.waitForFunction(() => globalThis.__layoutRequests.length > 0);
            await status(true);
            // A disclosure or keyboard navigation may deliberately scroll a
            // tall menu to expose its action. Measure the activation after
            // that navigation, then require every async state to stay put.
            await page.locator(retry).scrollIntoViewIfNeeded(); await page.locator(retry).focus();
            for (const index of [0, 5, 6, 7]) stable(baseline[index], await geometry(page, selectors[index]), `${id} disclosure preserves native content`);
            baseline = await Promise.all(selectors.map(selector => geometry(page, selector)));
            const retryBefore = await geometry(page, retry);
            const startRetry = async () => {
                const count = await page.evaluate(() => globalThis.__layoutRequests.length);
                await page.locator(retry).focus(); await page.keyboard.press('Enter');
                await page.waitForFunction((retry: string) => document.querySelector<FixtureElement>(retry)!.getAttribute('aria-disabled') === 'true', retry);
                if (id === 'snotel') await page.waitForFunction((count: number) => globalThis.__layoutRequests.length > count, count);
            };
            await startRetry();
            stable(retryBefore, await geometry(page, retry), `${id} pending retry`);
            await anchored(`${id} pending ${scale}x`);
            await page.keyboard.press('Enter'); // Busy activation must not duplicate work.
            await status(true); stable(retryBefore, await geometry(page, retry), `${id} repeated error retry`);
            await anchored(`${id} repeated failure ${scale}x`);
            await startRetry();
            await status(false); await anchored(`${id} success ${scale}x`);
            await page.locator(retry).blur();
            assert.equal(await page.locator(retry).isVisible(), false, 'completion is not a clickable placeholder');
            if (id === 'sentinel') {
                const select = page.locator(`${detail} select`);
                // Firefox exposes the native select by scrolling its tall menu.
                // That requested navigation precedes the capture transaction;
                // preserve native page geometry, then measure the settled field.
                await select.scrollIntoViewIfNeeded(); await select.focus();
                for (const index of [0, 5, 6, 7]) stable(baseline[index], await geometry(page, selectors[index]), 'capture navigation preserves native content');
                baseline = await Promise.all(selectors.map(selector => geometry(page, selector)));
                const before = await geometry(page, `${detail} select`);
                await select.selectOption('older'); await anchored('capture selection');
                stable(before, await geometry(page, `${detail} select`), 'capture picker');
                assert.equal(await select.locator('option').count(), 2);
            }
            await capture(page, `${variant.name}-overlays-${id}-${scale}x`);
        }
    }
    await page.locator('.bpb-map-layers').evaluate((element: FixtureElement) => { element.style.fontSize = '13px'; });
    await page.locator(trigger).click();
    stable(triggerBefore, await geometry(page, trigger), 'closing Overlays keeps its trigger anchored');
    await page.locator('.bpb-map-layers').evaluate((element: FixtureElement) => element.remove());
    const selectors = ['.bpb-gpx-segment-view', '.bpb-gpx-controls button'];
    const baseline = await Promise.all(selectors.map(selector => geometry(page, selector)));
    await page.locator('.bpb-gpx-segment-view > span').evaluate((element: FixtureElement) => { element.textContent = 'Use interpreted view'; });
    await page.locator('.bpb-gpx-stats, #bpb-gpx-segment-details p').evaluateAll((elements: FixtureElement[]) => elements.forEach((element: FixtureElement) => {
        element.textContent = 'Long diagnostic and coordinate recovery information that wraps over several lines. '.repeat(4);
    }));
    for (let index = 0; index < selectors.length; index++) stable(baseline[index], await geometry(page, selectors[index]), `GPX ${selectors[index]}`);
    await page.locator('#bpb-gpx-segment-details').evaluate((element: FixtureElement) => { element.hidden = true; });
    const retryBefore = await geometry(page, '.bpb-gpx-retry');
    await page.locator('.bpb-gpx-stats').evaluate((element: FixtureElement) => { element.textContent = 'Analyzing GPX data…'; });
    stable(retryBefore, await geometry(page, '.bpb-gpx-retry'), 'GPX loading retry');
    const copyBefore = await geometry(page, '.bpb-gpx-copy-coordinates'), plotBefore = await geometry(page, '#bpb-gpx-analysis canvas');
    await page.locator('.bpb-gpx-hint').evaluate((element: FixtureElement) => { element.textContent = 'Coordinate copying is unavailable. Select the complete coordinates and use your system copy shortcut. '.repeat(4); });
    stable(copyBefore, await geometry(page, '.bpb-gpx-copy-coordinates'), 'GPX coordinate recovery');
    stable(plotBefore, await geometry(page, '#bpb-gpx-analysis canvas'), 'GPX coordinate recovery plot');
    await page.addStyleTag({ content: (await asset('css/terrain-map.css')).toString() });
    await page.evaluate(() => {
        document.body.innerHTML = '<div class="bpb-terrain-consent-backdrop"><section class="bpb-terrain-consent-dialog"><h2>Turn on 3D maps?</h2><p>Map requests go to the displayed tile providers.</p><div class="bpb-terrain-consent-actions"><button class="bpb-terrain-consent-secondary">Not now</button><button class="bpb-terrain-consent-primary"><span>Enable and open 3D</span></button></div><p class="bpb-terrain-consent-error"></p></section></div>';
    });
    const button = '.bpb-terrain-consent-primary', consentBefore = await geometry(page, button);
    for (const label of ['Enabling…', 'Try again']) {
        await page.locator(`${button} > span`).evaluate((element: FixtureElement, label: string) => { element.textContent = label; }, label);
        await page.locator('.bpb-terrain-consent-error').evaluate((element: FixtureElement) => { element.textContent = '3D maps could not be enabled. Try again or use Better Peakbagger Settings.'; });
        stable(consentBefore, await geometry(page, button), `terrain consent ${label}`);
    }
    await capture(page, `${variant.name}-consent`);
}
async function profileTransitionCase(page: Page, origin: string, variant: LayoutVariant) {
    for (const textScale of [1, 2]) {
        for (const check of [verifyProfileFeedback, verifyBuddyPresentation, verifyPendingMembership]) {
            const target = await page.context().newPage();
            try { await check(target, origin, { ...variant, textScale }); }
            finally { await target.close(); }
        }
        for (const anchor of [20, 440, 820]) {
            const target = await page.context().newPage();
            try { await verifyCardFeedback(target, origin, { ...variant, textScale }, false, anchor); }
            finally { await target.close(); }
        }
        for (const anchor of [20, 270, 500]) {
            const target = await page.context().newPage();
            try {
                await target.setViewportSize({ width: variant.width, height: 540 });
                await verifyCardFeedback(target, origin, { ...variant, textScale, name: `${variant.name}-h540` }, false, anchor);
            } finally { await target.close(); }
        }
    }
}
async function uploadCase(page: Page, origin: string, variant: LayoutVariant) {
    const html = (await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascentedit.html'), 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('**/climber/ascentedit.aspx**', (route: Route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.addInitScript(({ theme }: { theme: string }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { storage: { local: { get: async () => ({}) }, sync: { get: async () => ({ bpbSettings: { theme } }) },
            onChanged: { addListener() {}, removeListener() {} } }, runtime: { getManifest: () => ({ version: '4.0.0' }), getURL: (file: string) => `${location.origin}/${file}`,
            onMessage: { addListener() {}, removeListener() {} }, sendMessage: async (message: FixtureMessage) => {
                if (message.type === 'GPX_PROCESS_START') return new Promise(resolve => {
                    globalThis.__finishTrack = () => resolve({ phase: 'error', pageSessionId: message.pageSessionId,
                        selectionGeneration: message.selectionGeneration, selectionNonce: message.selectionNonce,
                        error: { message: 'This track could not be processed. Check your connection and try again. '.repeat(3) } });
                });
                return { ok: true };
            } } } as unknown as typeof chrome;
    }, variant);
    await page.goto(`${origin}/climber/ascentedit.aspx?pid=2296`);
    await page.addStyleTag({ content: (await asset('css/ascent-upload.css')).toString() });
    await page.addStyleTag({ content: (await asset('css/report-editor.css')).toString() });
    await page.addScriptTag({ content: (await asset('vendor/marked.umd.js')).toString() });
    const source = (await asset('content/ascent-editor.js')).toString(), end = source.lastIndexOf('})();');
    await page.addScriptTag({ content: source.slice(0, end) + 'globalThis.__reservePicker = createStableText;' + source.slice(end) });
    await page.locator('.bpb-re-surface[contenteditable="true"]').waitFor();
    const documentRect = (selector: string) => page.locator(selector).evaluate((element: FixtureElement) => {
        const r = element.getBoundingClientRect(); return { x: r.x + globalThis.scrollX, y: r.y + globalThis.scrollY, width: r.width, height: r.height };
    });
    const originalPreview = await documentRect('#GPXPreview');
    const originalRemove = await documentRect('#GPXRemove');
    const file = path.join(fixtureDirectory, `upload-${variant.name}.gpx`);
    await writeFile(file, '<gpx><trk><trkseg><trkpt lat="46.8" lon="-121.7"><ele>100</ele><time>2025-01-01T01:00:00Z</time></trkpt><trkpt lat="46.9" lon="-121.8"><ele>200</ele><time>2025-01-01T02:00:00Z</time></trkpt></trkseg></trk></gpx>');
    await page.locator('#GPXUpload').setInputFiles(file);
    const action = '.bpb-process-button';
    await page.locator(action).waitFor().catch(async (error: Error) => { throw new Error(`${error.message}; upload state: ${await page.locator('.bpb-upload-status').allTextContents()}`); }); await page.locator(action).scrollIntoViewIfNeeded();
    const rect = () => documentRect(action);
    const before = await rect();
    await page.click(action);
    await page.waitForFunction(() => typeof globalThis.__finishTrack === 'function');
    stable(before, await rect(), 'GPX Process pending');
    await page.evaluate(() => globalThis.__finishTrack());
    await page.locator('#GPXPreview').waitFor();
    stable(originalPreview, await documentRect('#GPXPreview'), 'GPX native fallback after failure');
    stable(originalRemove, await documentRect('#GPXRemove'), 'GPX neighboring Remove after failure');
    await page.locator('.bpb-process-retry').waitFor();
    await capture(page, `${variant.name}-process`);
    await page.evaluate(() => { globalThis.__finishTrack = null!; });
    await page.locator('.bpb-process-retry').press('Enter');
    await page.waitForFunction(() => typeof globalThis.__finishTrack === 'function');
    await page.evaluate(() => globalThis.__finishTrack());
    await page.locator('.bpb-process-retry').waitFor();
    stable(originalPreview, await documentRect('#GPXPreview'), 'GPX retry fallback');
    stable(originalRemove, await documentRect('#GPXRemove'), 'GPX retry neighboring Remove');
    await page.evaluate(() => {
        const card = document.createElement('div'); card.className = 'bpb-summit-card';
        card.innerHTML = '<div class="bpb-summit-actions"><button class="bpb-summit-apply">Fill this ascent</button><button class="bpb-summit-cancel">Cancel</button></div>';
        document.body.append(card);
        globalThis.__pickerText = globalThis.__reservePicker(card.querySelector<FixtureElement>('.bpb-summit-apply'));
        globalThis.__pickerText.reserve(['Fill this ascent', 'Open 8 drafts', 'Fill + open 8 drafts']);
    });
    const picker = '.bpb-summit-apply'; await page.locator(picker).scrollIntoViewIfNeeded();
    const pickerBefore = await geometry(page, picker), cancelBefore = await geometry(page, '.bpb-summit-cancel');
    for (const label of ['Open 1 draft', 'Fill + open 8 drafts', 'Fill this ascent']) {
        await page.evaluate((label: string) => globalThis.__pickerText.set(label), label);
        stable(pickerBefore, await geometry(page, picker), `summit picker ${label}`);
        stable(cancelBefore, await geometry(page, '.bpb-summit-cancel'), 'summit neighboring Cancel');
    }
}
// The baseline replaces only the upload module with its committed predecessor,
// without resetting the worktree. Its first assertion must detect exposed times.
async function timestampCase(page: Page, origin: string, variant: LayoutVariant) {
    const html = (await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascentedit.html'), 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('**/climber/ascentedit.aspx**', (route: Route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.addInitScript(({ theme }: { theme: string }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.__messages = [];
        globalThis.chrome = { storage: { local: { get: async () => ({}) },
            sync: { get: async () => ({ bpbSettings: { theme, removeGpxTimestamps: true, enableReportEditor: false } }) },
            onChanged: { addListener() {}, removeListener() {} } }, runtime: { getManifest: () => ({ version: '4.0.1' }),
            onMessage: { addListener() {}, removeListener() {} }, sendMessage: async (message: FixtureMessage) => {
                globalThis.__messages.push(message);
                if (message.type === 'GPX_PROCESS_START') return new Promise(resolve => {
                    globalThis.__finishTrack = () => resolve({ phase: 'error', pageSessionId: message.pageSessionId,
                        selectionGeneration: message.selectionGeneration, selectionNonce: message.selectionNonce,
                        error: { message: 'Summit lookup is unavailable. Attach this file or choose it again to retry.' } });
                });
                return { ok: true };
            } } } as unknown as typeof chrome;
    }, variant);
    await page.goto(`${origin}/climber/ascentedit.aspx?pid=2296`);
    await page.addStyleTag({ content: darkCss });
    await page.addStyleTag({ content: (await asset('css/ascent-upload.css')).toString() });
    await page.addScriptTag({ content: (await asset('vendor/marked.umd.js')).toString() });
    let bundle = (await asset('content/ascent-editor.js')).toString();
    if (process.env.BPB_TIMESTAMP_BASELINE) {
        const { execFileSync } = await import('node:child_process');
        const { build } = await import('esbuild');
        assert.match(process.env.BPB_TIMESTAMP_BASELINE, /^[a-f0-9]{40}$/, 'Baseline must name a full commit SHA');
        const original = execFileSync('git', ['show', `${process.env.BPB_TIMESTAMP_BASELINE}:src/ascent/ascent-upload.js`], { cwd: projectRoot, encoding: 'utf8' });
        const built = await build({ stdin: { contents: original, resolveDir: path.join(projectRoot, 'src/ascent') },
            bundle: true, write: false, format: 'iife', platform: 'browser' });
        bundle = built.outputFiles[0].text;
    }
    await page.addScriptTag({ content: bundle });
    const gpx = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>2026-01-01T01:00:00Z</time></metadata><trk><trkseg><trkpt lat="46.8" lon="-121.7"><ele>100</ele><time>2026-01-01T01:00:00Z</time></trkpt><trkpt lat="46.801" lon="-121.7"><ele>200</ele><time>2026-01-01T02:00:00Z</time></trkpt></trkseg></trk></gpx>';
    const file = path.join(fixtureDirectory, `private-times-${variant.name}.gpx`);
    await writeFile(file, gpx);
    await page.locator('#GPXUpload').setInputFiles(file);
    await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-process-button, .bpb-upload-status-error'));
    assert.equal(await page.locator('.bpb-upload-status-error').count(), 0,
        await page.locator('.bpb-upload-status-error').allTextContents().then((texts: string[]) => texts.join(' ')));
    await page.locator('.bpb-process-button').waitFor();
    const readUpload = () => page.locator('#GPXUpload').evaluate((input: FixtureElement) => input.files![0].text());
    assert.doesNotMatch(await readUpload(), /<time>/, 'native upload must omit timestamps before Attach or Save');
    const choice = page.locator('#bpb-include-timestamps-once');
    await page.locator('.bpb-timestamp-choice').scrollIntoViewIfNeeded();
    const snapshot = () => page.evaluate(() => {
        const rect = (selector: string) => { const r = document.querySelector<FixtureElement>(selector)!.getBoundingClientRect();
            return { x: r.x + globalThis.scrollX, y: r.y + globalThis.scrollY, width: r.width, height: r.height }; };
        return { action: rect('.bpb-upload-actions'), heading: rect('h1'), following: rect('#JournalText'), scroll: globalThis.scrollY };
    });
    const assertStable = async (before: Awaited<ReturnType<typeof snapshot>>, label: string) => {
        const after = await snapshot();
        for (const key of ['action', 'heading', 'following'] as const) stable(before[key], after[key], `${label} ${key}`);
        assert.ok(Math.abs(before.scroll - after.scroll) <= 1, `${label} moved the reading position`);
    };
    await choice.focus();
    const before = await snapshot();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (document.getElementById('bpb-include-timestamps-once') as FixtureElement)!.getAttribute('aria-disabled') === 'false');
    assert.match(await readUpload(), /<time>/);
    assert.equal(await choice.evaluate((input: FixtureElement) => document.activeElement === input), true, 'keyboard focus survives file preparation');
    await assertStable(before, 'exception enabled');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (document.getElementById('bpb-include-timestamps-once') as FixtureElement)!.getAttribute('aria-disabled') === 'false');
    assert.doesNotMatch(await readUpload(), /<time>/);
    await assertStable(before, 'exception cleared');
    await capture(page, `${variant.name}-timestamp-upload`);
    await page.locator('.bpb-process-button').click();
    await page.waitForFunction(() => typeof globalThis.__finishTrack === 'function');
    assert.equal(await choice.getAttribute('aria-disabled'), 'true');
    await choice.click({ force: true });
    await choice.focus();
    await page.keyboard.press('Space');
    assert.equal(await choice.isChecked(), false, 'busy choice blocks duplicate activation');
    await assertStable(before, 'slow processing');
    const analysis = await page.evaluate(() => globalThis.__messages.find((message: FixtureMessage) => message.type === 'GPX_PROCESS_START'));
    assert.ok((analysis as unknown as { segments: { time: number }[][] }).segments[0][0].time > 0, 'analysis still receives the original timestamps');
    await page.evaluate(() => globalThis.__finishTrack());
    await page.locator('.bpb-upload-status-error').waitFor();
    assert.doesNotMatch(await readUpload(), /<time>/, 'failure fallback remains timeless');
    await choice.check();
    await page.waitForFunction(() => (document.getElementById('bpb-include-timestamps-once') as FixtureElement)!.getAttribute('aria-disabled') === 'false');
    assert.match(await readUpload(), /<time>/);
    const nextFile = path.join(fixtureDirectory, `next-file-${variant.name}.gpx`);
    await writeFile(nextFile, gpx);
    await page.locator('#GPXUpload').setInputFiles(nextFile);
    await page.locator('.bpb-process-button').waitFor();
    assert.equal(await choice.isChecked(), false, 'new files reset the exception');
    assert.doesNotMatch(await readUpload(), /<time>/);

    // Use a fresh page for the capture popup so the ascent API stub stays local.
    const popup = await page.context().newPage();
    // A real action popup expands with zoom; keep its intrinsic 390px width.
    await popup.setViewportSize({ width: Math.max(Math.floor(variant.width / variant.zoom), 390), height: Math.floor(900 / variant.zoom) });
    popup.setDefaultTimeout(10000);
    popup.on('pageerror', (error: Error) => console.error(`timestamp popup: ${error.message}`));
    try {
        await popup.addInitScript(({ theme }: { theme: string }) => {
            const job = { phase: 'ready', provider: 'strava', activityId: '777', hasCachedGpx: true,
                timestampChoiceAvailable: true, timestampsRemoved: true, selectedIds: [1],
                trackSummary: { originalPointCount: 50, retainedPointCount: 50, maxDeviationM: 0 },
                matches: [{ id: 1, name: 'North Summit', classification: 'strong', confidence: 98, evidence: { distanceM: 2 } }] };
            globalThis.chrome = { tabs: { query: async () => [{ id: 9 }] },
                storage: { local: { get: async () => ({}) }, sync: { get: async () => ({ bpbSettings: { theme } }) }, onChanged: { addListener() {}, removeListener() {} } },
                runtime: { sendMessage: async (message: FixtureMessage) => {
                    if (['CAPTURE_START', 'CAPTURE_STATUS'].includes(message.type!)) return structuredClone(job);
                    if (message.type === 'CAPTURE_OPEN_DRAFTS') return new Promise(resolve => {
                        globalThis.__open = message;
                        globalThis.__finishOpen = (fail?: unknown) => resolve(fail ? { phase: 'error', error: { message: 'Could not open drafts. Try again.' } }
                            : { job: { ...job, phase: 'opened', includeTimestampsOnce: message.includeTimestampsOnce, timestampsRemoved: !message.includeTimestampsOnce } });
                    });
                    return { ok: true };
                } } } as unknown as typeof chrome;
        }, variant);
        await popup.goto(`${origin}/dist/popup/popup.html`);
        await popup.waitForFunction(() => (document.getElementById('open-drafts') as FixtureElement)?.textContent.includes('Open 1 draft'), null, { timeout: 10000 })
            .catch(async (error: Error) => { throw new Error(`${error.message}; popup state: ${await popup.locator('body').innerText()}`); });
        const action = '#open-drafts', exception = popup.locator('#include-timestamps-once');
        const initial = await geometry(popup, action);
        await exception.check();
        stable(initial, await geometry(popup, action), 'capture exception toggle');
        await popup.locator(action).click();
        await popup.waitForFunction(() => typeof globalThis.__finishOpen === 'function');
        assert.equal(await exception.isDisabled(), true);
        assert.equal(await popup.evaluate(() => globalThis.__open.includeTimestampsOnce), true);
        stable(initial, await geometry(popup, action), 'capture pending');
        await popup.evaluate(() => globalThis.__finishOpen(true));
        await popup.waitForFunction(() => !(document.getElementById('open-drafts') as FixtureElement)!.disabled);
        assert.equal(await exception.isChecked(), true, 'retry keeps this capture choice');
        stable(initial, await geometry(popup, action), 'capture error');
        await popup.locator(action).click();
        await popup.evaluate(() => globalThis.__finishOpen(false));
        await popup.locator(action).filter({ hasText: 'Show opened drafts' }).waitFor();
        assert.equal(await exception.isDisabled(), true);
        stable(initial, await geometry(popup, action), 'capture completion');
        await capture(popup, `${variant.name}-timestamp-capture`);
    } finally { await popup.close(); }
    const options = await page.context().newPage();
    try {
        const markup = (await asset('options/options.html')).toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        await options.route('**/dist/options/options.html', (route: Route) => route.fulfill({ contentType: 'text/html', body: markup }));
        await options.goto(`${origin}/dist/options/options.html`);
        await options.evaluate(({ theme }: { theme: string }) => {
            document.documentElement.dataset.bpbTheme = theme;
            (document.getElementById('remove-gpx-timestamps') as FixtureElement)!.checked = true;
        }, variant);
        await options.locator('#remove-gpx-timestamps').scrollIntoViewIfNeeded();
        await capture(options, `${variant.name}-timestamp-options`);
    } finally { await options.close(); }
}

async function reportCase(page: Page, origin: string, variant: LayoutVariant) {
    await page.addInitScript(() => {
        const area = { get: async () => ({ bpbSettings: {} }), set: async () => {} };
        globalThis.chrome = { runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.0' }),
            getURL: (file: string) => new URL(`/dist/${file}`, location.origin).href,
            onMessage: { addListener() {}, removeListener() {} }, sendMessage: async () => ({ ok: true }) },
        storage: { sync: area, local: area, onChanged: { addListener() {}, removeListener() {} } } } as unknown as typeof chrome;
    });
    await page.goto(`${origin}/dist/photos/guide.html`);
    await page.evaluate(({ theme }: { theme: string }) => {
        document.documentElement.dataset.bpbTheme = theme;
        document.body.innerHTML = '<div class="bpb-re" id="bpb-report-editor" style="margin:350px 16px 0"><div class="bpb-re-toolbar"><div class="bpb-re-bar">Editor toolbar</div><div class="bpb-re-contextual"><div class="bpb-re-box bpb-re-linkbox"><input value="https://example.com"><button class="bpb-re-linkapply">Add link</button><button class="bpb-re-linkremove" hidden>Remove link</button><div class="bpb-re-field-error" hidden></div></div></div></div><div class="bpb-re-surface" style="height:120px">Report</div><div class="bpb-re-save-recovery"><span>This draft isn’t saved. Keep this page open until saving works.</span><button class="bpb-re-save-copy">Copy Markdown</button><span class="bpb-re-save-feedback"></span><textarea class="bpb-re-save-manual" hidden></textarea></div><div class="bpb-re-foot"><span class="bpb-re-status">Draft saved</span><button class="bpb-re-manage">Manage TR drafts</button></div></div>';
    }, variant);
    await page.addStyleTag({ content: (await asset('css/report-editor.css')).toString() });
    const source = (await asset('content/ascent-editor.js')).toString(), end = source.lastIndexOf('})();');
    await page.addScriptTag({ content: (await asset('vendor/marked.umd.js')).toString() });
    await page.addScriptTag({ content: source.slice(0, end) + 'globalThis.__reserveReport = createStableText;' + source.slice(end) });
    await page.evaluate(() => {
        globalThis.__linkText = globalThis.__reserveReport(document.querySelector<FixtureElement>('.bpb-re-linkapply'));
        globalThis.__linkText.reserve(['Add link', 'Update link']);
    });
    const selectors = ['.bpb-re-linkapply', '.bpb-re-linkbox input', '.bpb-re-surface', '.bpb-re-save-copy', '.bpb-re-manage'];
    const before = await Promise.all(selectors.map(selector => geometry(page, selector)));
    await page.evaluate(() => {
        globalThis.__linkText.set('Update link'); document.querySelector<FixtureElement>('.bpb-re-linkremove')!.hidden = false;
        const error = document.querySelector<FixtureElement>('.bpb-re-field-error'); error!.hidden = false;
        error!.textContent = 'This link uses a scheme that cannot be saved. Enter a complete HTTPS address and try again. '.repeat(3);
    });
    for (let index = 0; index < 3; index++) stable(before[index], await geometry(page, selectors[index]), `report ${selectors[index]}`);
    const manageBefore = await geometry(page, '.bpb-re-manage');
    await page.locator('.bpb-re-status').evaluate((element: FixtureElement) => { element.textContent = 'The draft manager could not be opened. Please check your browser and try again. '.repeat(2); });
    stable(manageBefore, await geometry(page, '.bpb-re-manage'), 'report manager feedback');
    const copyBefore = await geometry(page, '.bpb-re-save-copy');
    await page.locator('.bpb-re-save-feedback').evaluate((element: FixtureElement) => { element.textContent = 'Clipboard unavailable. The complete report is selected below for manual copying.'; });
    stable(copyBefore, await geometry(page, '.bpb-re-save-copy'), 'report recovery copy');
    await capture(page, `${variant.name}-report-validation`, true);
    await page.evaluate(() => {
        document.querySelector<FixtureElement>('.bpb-re-linkbox')!.hidden = true;
        const caption = document.createElement('div'); caption.className = 'bpb-re-box bpb-re-captionbar';
        caption.innerHTML = '<button class="bpb-re-tablebtn">Add caption</button><button class="bpb-re-tablebtn" hidden>Remove caption</button>';
        document.querySelector<FixtureElement>('.bpb-re-contextual')!.append(caption);
        globalThis.__captionText = globalThis.__reserveReport(caption.firstElementChild);
        globalThis.__captionText.reserve(['Add caption', 'Edit caption']);
    });
    for (const fontSize of [12, 24]) {
        await page.addStyleTag({ content: `.bpb-re-captionbar,.bpb-re-captionbar::after,.bpb-re-captionbar button{font-size:${fontSize}px !important}` });
        const captionSelectors = ['.bpb-re-captionbar', '.bpb-re-captionbar button:first-child', '.bpb-re-toolbar', '.bpb-re-surface'];
        const captionBefore = await Promise.all(captionSelectors.map(selector => geometry(page, selector)));
        assert.ok(captionBefore[1].width < fontSize * 12, 'caption actions must be compact, not half-toolbar-width buttons');
        assert.equal(await page.locator('.bpb-re-captionbar button:nth-child(2)').isVisible(), false);
        for (const active of [true, false, true, false]) {
            await page.evaluate((active: boolean) => {
                globalThis.__captionText.set(active ? 'Edit caption' : 'Add caption');
                document.querySelector<FixtureElement>('.bpb-re-captionbar button:nth-child(2)')!.hidden = !active;
            }, active);
            for (let index = 0; index < captionSelectors.length; index++)
                stable(captionBefore[index], await geometry(page, captionSelectors[index]), `report caption ${captionSelectors[index]} font ${fontSize}`);
            if (active) {
                const remove = await geometry(page, '.bpb-re-captionbar button:nth-child(2)');
                assert.ok(remove.width < fontSize * 12, 'remove caption remains compact');
                assert.ok(remove.x + remove.width <= captionBefore[0].x + captionBefore[0].width + 1, 'caption actions must not overflow');
                await capture(page, `${variant.name}-report-caption-${fontSize}`);
            }
        }
    }
    await capture(page, `${variant.name}-report-feedback`);
}
const cases: Record<string, (page: Page, origin: string, variant: LayoutVariant) => Promise<unknown>> = { 'report-filter': reportFilterCase, sun: sunCase, 'photo-report-edit': (page: Page, origin: string, variant: LayoutVariant) => verifyPhotoReportEdit(page, origin, variant, { capture }), popup: popupCase, access: accessCase, handoff: handoffCase, 'ascent-backup': ascentBackupCase, 'profile-backup': profileBackupCase, settings: settingsCase, 'settings-actions': (page: Page, origin: string, variant: LayoutVariant) => verifySettingsActions(page, origin, variant, { capture }), photos: photoCase, 'photo-backup': photoBackupCase, weather: weatherCase,
    'climber-files': (page: Page, origin: string, variant: LayoutVariant) => verifyClimberFiles(page, origin, variant, { capture }),
    'weather-models': (page: Page, origin: string, variant: LayoutVariant) => verifyPeakWeatherRefresh(page, origin, variant, { asset, capture }),
    'ascent-columns': (page: Page, origin: string, variant: LayoutVariant) => verifyAscentColumnWidths(page, origin, variant, { asset, capture }),
    'ascent-filters': (page: Page, origin: string, variant: LayoutVariant) => verifyAscentFilters(page, origin, variant, { asset, capture }),
    'peak-columns': (page: Page, origin: string, variant: LayoutVariant) => verifyPeakColumnWidths(page, origin, variant, { asset, capture }),
    'gpx-source': gpxSourceCase, maps: mapCase, climbers: profileTransitionCase, upload: uploadCase, timestamps: timestampCase, reports: reportCase,
    captions: (page: Page, origin: string, variant: LayoutVariant) => verifyReportCaptionStability(page, origin, variant, { asset, capture }) };
const plan = layoutVerificationPlan(process.argv.slice(2), Object.keys(cases));
const resources = createResourceStack();
let failure = null, executedCases = 0;
try {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-jitter-fixture-'));
    fixtureDirectory = temporaryRoot;
    resources.defer('jitter fixture directory', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot } as unknown as Parameters<typeof createBrowserFixtureServer>[0]);
    resources.defer('jitter fixture server', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]] as const) {
        const selectedCases = plan.cases.filter(value => value.browser === name);
        if (!selectedCases.length) continue;
        if (engine === chromium) assertChromeLaunchAllowed();
        const browser = await engine.launch({ headless: true, ...(engine === chromium
            ? { channel: 'chromium', args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
            : { firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }) });
        try {
            for (const variant of selectedCases) {
                const { surface, theme, width, zoom } = variant, check = cases[surface];
                const startedAt = performance.now();
                const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: Math.floor(width / zoom), height: Math.floor(900 / zoom) }, deviceScaleFactor: zoom, colorScheme: theme });
                try {
                    await context.route(`${origin}/dist/**`, async (route: Route) => {
                        const file = new URL(route.request().url()).pathname.slice('/dist/'.length);
                        if (file.includes('..')) return route.abort();
                        try { await route.fulfill({ body: await asset(file), contentType: fixtureContentType(file) }); }
                        catch { await route.fulfill({ status: 404, body: 'Missing shipped fixture asset' }); }
                    });
                    const page = await context.newPage();
                    page.setDefaultTimeout(10000);
                    const pageErrors: string[] = [];
                    page.on('pageerror', (error: Error) => pageErrors.push(error.message));
                    await check(page, origin, variant);
                    // Exercise disposal while the page can still provide
                    // evidence; context.close() otherwise hides cleanup errors.
                    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
                    assert.deepEqual(pageErrors, [], `${surface}: fixture bootstrap or lifecycle failed`);
                    executedCases++;
                    console.log(JSON.stringify({ browser: name, version: browser.version(), hidden: true,
                        surface, theme, viewport: `${Math.floor(width / zoom)}x${Math.floor(900 / zoom)}`, deviceScaleFactor: zoom, layoutZoom: zoom, durationMs: Math.round(performance.now() - startedAt), result: 'passed' }));
                } catch (error) {
                    await retainBrowserFailure({ context, fixtureOrigin: origin,
                        directory: output ? path.join(output, `${variant.name}-${surface}-failure`) : undefined } as Parameters<typeof retainBrowserFailure>[0]);
                    throw error;
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    }
    assert.equal(executedCases, plan.cases.length, 'every selected layout case must execute');
    console.log(JSON.stringify({ verification: 'layout-stability', shard: plan.shard, executedCases }));
} catch (error) { failure = error; }
await resources.dispose(failure as null);
