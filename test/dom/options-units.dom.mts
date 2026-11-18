/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// M6: the production Units Svelte island inside options/options.html handles
// defaults, mixed overrides, default switches, reset, slow/repeated saves,
// failed-save rollback, external storage updates, keyboard navigation,
// BFCache suspend/resume/dispose, and narrow/zoom/dark geometry in Chromium
// and Firefox. Run with `npm run verify -- dom`.

import assert from 'node:assert/strict';
import { defineDomSuite, type DomContext } from '../../scripts/dom-tier.mts';

type Page = DomContext['page'];
const OPTIONS = '/dist/options/options.html';

interface StubChrome {
    storage: {
        sync: {
            get(keys?: unknown): Promise<Record<string, unknown>>;
            set(patch: Record<string, unknown>): Promise<void>;
        };
    };
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
    };
}

interface PendingSave {
    readonly message: unknown;
    readonly index: number;
    finish(mode: 'resolve' | 'reject'): Promise<void>;
}

const openOptions = async ({ open, page }: DomContext) => {
    await open(OPTIONS);
    await page.locator('#general-units #units').waitFor();
};

const readUnitState = (page: Page) => page.evaluate(() => {
    const units = document.getElementById('units') as HTMLSelectElement;
    const distance = document.getElementById('distance-units') as HTMLSelectElement;
    const elevation = document.getElementById('elevation-units') as HTMLSelectElement;
    const temperature = document.getElementById('temperature-units') as HTMLSelectElement;
    const precipitation = document.getElementById('precipitation-units') as HTMLSelectElement;
    const wind = document.getElementById('wind-units') as HTMLSelectElement;
    const details = document.getElementById('unit-customize') as HTMLDetailsElement;
    const reset = document.getElementById('unit-reset') as HTMLButtonElement;
    const gpx = document.getElementById('unit-example-gpx')?.textContent ?? '';
    const weather = document.getElementById('unit-example-weather')?.textContent ?? '';
    const heading = document.querySelector('.unit-example-heading')?.textContent ?? '';
    const customCount = document.querySelector('.unit-custom-count')?.textContent ?? '';
    const statusError = document.getElementById('status-error') as HTMLElement | null;
    return {
        units: units.value,
        distance: distance.value,
        elevation: elevation.value,
        temperature: temperature.value,
        precipitation: precipitation.value,
        wind: wind.value,
        distanceDefaultOption: distance.options[0]?.textContent ?? '',
        temperatureDefaultOption: temperature.options[0]?.textContent ?? '',
        windDefaultOption: wind.options[0]?.textContent ?? '',
        detailsOpen: details.open,
        resetDisabled: reset.disabled,
        gpx,
        weather,
        heading,
        customCount,
        statusErrorHidden: statusError?.hidden ?? true,
        hostChildren: document.querySelector('[data-unit-settings]')?.children.length ?? 0,
    };
});

const readStoredSettings = (page: Page) => page.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: StubChrome }).chrome;
    const data = await api.storage.sync.get('bpbSettings');
    return (data.bpbSettings ?? {}) as Record<string, unknown>;
});

const measureUnitsGeometry = (page: Page) => page.evaluate(() => {
    const capture = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const rect = element.getBoundingClientRect();
        return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            overflowX: element.scrollWidth - element.clientWidth,
        };
    };
    return {
        card: capture('#general-units .card'),
        example: capture('.unit-example'),
        heading: capture('.unit-example-heading > span'),
        gpx: capture('#unit-example-gpx > span'),
        weather: capture('#unit-example-weather > span'),
        summary: capture('#unit-customize summary'),
        following: capture('#capture-settings-heading'),
    };
});

export default defineDomSuite({
    name: 'options units',
    cases: [
        {
            name: 'renders legacy defaults cleanly with collapsed customization',
            stub: { settings: { units: 'metric' } },
            async run(context) {
                await openOptions(context);
                const state = await readUnitState(context.page);
                assert.equal(state.units, 'metric');
                assert.equal(state.detailsOpen, false);
                assert.equal(state.customCount, 'All use default');
                assert.equal(state.resetDisabled, true);
                assert.equal(state.temperature, 'default');
                assert.equal(state.temperatureDefaultOption, 'Default (°C)');
                assert.equal(state.heading, 'Example readings');
                assert.equal(state.gpx, '20.0 km · 800 m ascent');
                assert.equal(state.weather, '9°C · 4.2 mm · 16 km/h');
            },
        },
        {
            name: 'auto-opens saved mixed units, preserves overrides across default switches and manual collapse, and supports keyboard reset',
            stub: {
                settings: {
                    units: 'imperial',
                    temperatureUnits: 'metric',
                    precipitationUnits: 'metric',
                    elevationUnits: 'imperial',
                    theme: 'dark',
                },
            },
            async run(context) {
                await openOptions(context);
                const { page } = context;

                await page.waitForFunction(() => (document.getElementById('unit-customize') as HTMLDetailsElement | null)?.open === true);
                const initial = await readUnitState(page);
                assert.equal(initial.customCount, '3 custom units');
                assert.equal(initial.resetDisabled, false);
                assert.equal(initial.gpx, '12.4 mi · 2625 ft ascent');
                assert.equal(initial.weather, '9°C · 4.2 mm · 10 mph');

                await page.selectOption('#units', 'metric');
                await page.waitForFunction(async () => {
                    const sync = await (globalThis as unknown as { chrome: StubChrome }).chrome.storage.sync.get('bpbSettings');
                    return (sync.bpbSettings as Record<string, unknown> | undefined)?.units === 'metric';
                });
                const afterMetric = await readUnitState(page);
                assert.equal(afterMetric.temperature, 'metric');
                assert.equal(afterMetric.elevation, 'imperial');
                assert.equal(afterMetric.gpx, '20.0 km · 2625 ft ascent');
                assert.equal(afterMetric.weather, '9°C · 4.2 mm · 16 km/h');

                // Manual collapse stays closed across unrelated saves.
                await page.locator('#unit-customize summary').press('Enter');
                await page.waitForFunction(() => !(document.getElementById('unit-customize') as HTMLDetailsElement).open);
                await page.selectOption('#theme', 'light');
                await page.waitForFunction(async () => {
                    const sync = await (globalThis as unknown as { chrome: StubChrome }).chrome.storage.sync.get('bpbSettings');
                    return (sync.bpbSettings as Record<string, unknown> | undefined)?.theme === 'light';
                });
                assert.equal((await readUnitState(page)).detailsOpen, false, 'unrelated saves preserve manual disclosure collapse');

                // Keyboard reopen + keyboard reset resets only measurement overrides.
                await page.locator('#unit-customize summary').press('Space');
                await page.waitForFunction(() => (document.getElementById('unit-customize') as HTMLDetailsElement).open);
                await page.locator('#unit-reset').press('Enter');
                await page.waitForFunction(async () => {
                    const sync = await (globalThis as unknown as { chrome: StubChrome }).chrome.storage.sync.get('bpbSettings');
                    const settings = (sync.bpbSettings ?? {}) as Record<string, unknown>;
                    return settings.temperatureUnits === 'default' && settings.elevationUnits === 'default';
                });
                const afterReset = await readUnitState(page);
                assert.equal(afterReset.units, 'metric');
                assert.equal(afterReset.elevation, 'default');
                assert.equal(afterReset.customCount, 'All use default');
                assert.equal(afterReset.resetDisabled, true);

                await page.selectOption('#units', 'auto');
                await page.waitForFunction(() => document.getElementById('wind-units')?.querySelector('option')?.textContent === 'Default (Peakbagger)');
                const afterAuto = await readUnitState(page);
                assert.equal(afterAuto.heading, 'Example readings · Imperial Peakbagger page');
            },
        },
        {
            name: 'handles failed-save rollback, slow repeated saves, and external updates at narrow zoom and BFCache transitions',
            viewport: { width: 390, height: 900 },
            stub: { settings: { units: 'imperial', theme: 'light' } },
            async run(context) {
                await openOptions(context);
                const { page } = context;

                // Verify layout stability under 200% CSS zoom in narrow viewport too.
                await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
                const beforeGeometry = await measureUnitsGeometry(page);

                // Install controllable SETTINGS_PATCH queue on the real page chrome stub.
                await page.evaluate(() => {
                    const api = (globalThis as unknown as { chrome: StubChrome }).chrome;
                    const original = api.runtime.sendMessage.bind(api.runtime);
                    const pending: PendingSave[] = [];
                    Object.defineProperty(globalThis, '__bpbPendingUnitSaves', { value: pending, configurable: true });
                    api.runtime.sendMessage = (message: unknown) => {
                        if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'SETTINGS_PATCH') {
                            return original(message);
                        }
                        return new Promise((resolve, reject) => {
                            const index = pending.length;
                            pending.push({
                                message,
                                index,
                                async finish(mode) {
                                    if (mode === 'reject') {
                                        reject(new Error('fixture write failure'));
                                        return;
                                    }
                                    resolve(await original(message));
                                },
                            });
                        });
                    };
                });

                // 1. Slow save optimistically updates DOM, then rolls back on failure without geometry shift.
                await page.selectOption('#units', 'metric');
                await page.waitForFunction(() => (globalThis as unknown as { __bpbPendingUnitSaves: PendingSave[] }).__bpbPendingUnitSaves.length === 1);
                assert.equal((await readUnitState(page)).gpx, '20.0 km · 800 m ascent');
                const pendingGeometry = await measureUnitsGeometry(page);
                for (const key of ['card', 'example', 'summary', 'following'] as const) {
                    assert.ok(Math.abs(beforeGeometry[key].height - pendingGeometry[key].height) <= 1,
                        `${key} height shifted during pending save: ${beforeGeometry[key].height} -> ${pendingGeometry[key].height}`);
                    assert.ok(Math.abs(beforeGeometry[key].y - pendingGeometry[key].y) <= 1,
                        `${key} y shifted during pending save: ${beforeGeometry[key].y} -> ${pendingGeometry[key].y}`);
                }
                for (const textPart of ['heading', 'gpx', 'weather'] as const) {
                    assert.ok(pendingGeometry[textPart].overflowX <= 1, `${textPart} clipped at 390px/200% zoom`);
                }

                await page.evaluate(() => (globalThis as unknown as { __bpbPendingUnitSaves: PendingSave[] }).__bpbPendingUnitSaves[0]!.finish('reject'));
                await page.waitForFunction(() => !(document.getElementById('status-error') as HTMLElement).hidden);
                const rolledBack = await readUnitState(page);
                assert.equal(rolledBack.units, 'imperial');
                assert.equal(rolledBack.gpx, '12.4 mi · 2625 ft ascent');
                assert.equal(rolledBack.statusErrorHidden, false);
                assert.equal((await readStoredSettings(page)).units, 'imperial');

                // 2. Repeated changes queued while a slow save is still in flight settle to the final state.
                await page.selectOption('#units', 'metric');
                await page.locator('#unit-customize summary').click();
                await page.selectOption('#distance-units', 'imperial');
                await page.waitForFunction(() => (globalThis as unknown as { __bpbPendingUnitSaves: PendingSave[] }).__bpbPendingUnitSaves.length === 2);
                await page.evaluate(() => (globalThis as unknown as { __bpbPendingUnitSaves: PendingSave[] }).__bpbPendingUnitSaves[1]!.finish('resolve'));
                await page.waitForFunction(() => (globalThis as unknown as { __bpbPendingUnitSaves: PendingSave[] }).__bpbPendingUnitSaves.length === 3);
                await page.evaluate(() => (globalThis as unknown as { __bpbPendingUnitSaves: PendingSave[] }).__bpbPendingUnitSaves[2]!.finish('resolve'));
                await page.waitForFunction(async () => {
                    const sync = await (globalThis as unknown as { chrome: StubChrome }).chrome.storage.sync.get('bpbSettings');
                    const settings = (sync.bpbSettings ?? {}) as Record<string, unknown>;
                    return settings.units === 'metric'
                        && settings.distanceUnits === 'imperial'
                        && (document.getElementById('distance-units') as HTMLSelectElement).value === 'imperial'
                        && document.getElementById('unit-example-gpx')?.textContent === '12.4 mi · 800 m ascent';
                });
                const queued = await readUnitState(page);
                assert.equal(queued.units, 'metric');
                assert.equal(queued.distance, 'imperial');
                assert.equal(queued.gpx, '12.4 mi · 800 m ascent');

                // 3. BFCache suspend holds external updates until pageshow resumes; final pagehide disposes only the island.
                await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
                await page.evaluate(async () => {
                    const api = (globalThis as unknown as { chrome: StubChrome }).chrome;
                    const current = ((await api.storage.sync.get('bpbSettings')).bpbSettings ?? {}) as Record<string, unknown>;
                    await api.storage.sync.set({
                        bpbSettings: { ...current, elevationUnits: 'imperial', windUnits: 'imperial', theme: 'dark' },
                    });
                });
                // Theme outside the island updated via options.js, while the suspended island held its props.
                await page.waitForFunction(() => document.documentElement.dataset.bpbTheme === 'dark');
                assert.equal((await readUnitState(page)).gpx, '12.4 mi · 800 m ascent', 'suspended island must not re-render while hidden');

                await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
                const resumed = await readUnitState(page);
                assert.equal(resumed.elevation, 'imperial');
                assert.equal(resumed.wind, 'imperial');
                assert.equal(resumed.customCount, '3 custom units');
                assert.equal(resumed.gpx, '12.4 mi · 2625 ft ascent');

                // Desktop width sanity check with dark theme & no clipping.
                await page.setViewportSize({ width: 1280, height: 900 });
                await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
                const desktopGeo = await measureUnitsGeometry(page);
                assert.ok(desktopGeo.example.overflowX <= 1);
                assert.ok(desktopGeo.card.width > 0 && desktopGeo.summary.height > 0);

                // Final pagehide disposes only the Units Svelte island, keeping outer shell and sibling sections intact.
                await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
                await page.waitForFunction(() => (document.querySelector('[data-unit-settings]')?.children.length ?? 1) === 0);
                assert.equal(await page.locator('#general-units-heading').textContent(), 'Units');
                assert.ok(await page.locator('#theme').isVisible(), 'unrelated options controls stay intact after island disposal');
            },
        },
    ],
});
