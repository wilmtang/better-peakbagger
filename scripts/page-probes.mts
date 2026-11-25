/// <reference lib="dom" />
/// <reference types="chrome" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Page-side verifier probes and their state shapes. Each probe is serialized
// into the page through Playwright or WebDriver, so it must stay self-contained;
// this module imports nothing, so browser tests can load it directly.

export const surfaceSelectors = Object.freeze({
    analyzer: '#bpb-gpx-analysis',
    editor: '#bpb-report-editor',
    reportPhoto: '#bpb-report-editor .bpb-re-surface .bpb-re-image-resize img',
    profileBackup: '#bpb-profile-backup',
    terrainToggle: '#bpb-terrain-toggle',
});

export interface ToggleAnchorRect {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
}

export interface DraftsManagerReadinessState {
    url: string;
    readyState: DocumentReadyState;
    heading: string;
    hasList: boolean;
    hasStorage: boolean;
    ready: boolean;
}

export interface AnalyzerBfcacheState {
    token: string | null;
    hidePersisted: boolean | null;
    showPersisted: boolean | null;
    settingsGets: number | null;
    panels: number;
    calculators: number;
    viewports: number;
    toggles: number;
}

export interface AnalyzerChartState {
    labels: (string | undefined)[];
    pointCounts: number[];
    pointBudget: number;
    breakCounts: number[];
    animation: unknown;
}

export interface ScaleChartState {
    pointCounts: number[];
    pointBudget: number;
    sourceIndexes: number[];
    rawElevations: number[];
    animation: unknown;
}

export interface SunCalculatorGeometryState {
    summary: string;
    layoutState: string;
    calculatorHeight: number | null;
    toggleHeight: number | null;
    panelHeight: number | null;
    layoutHeight: number | null;
    controlsHeight: number | null;
    dateFieldHeight: number | null;
    timeFieldHeight: number | null;
    readingHeight: number | null;
    compassHeight: number | null;
    factsHeight: number | null;
    directionHeight: number | null;
    elevationHeight: number | null;
    moonHeight: number | null;
    eventsHeight: number | null;
    limitationHeight: number | null;
    canvasTop: number | null;
    canvasHeight: number | null;
    overflowingText: string[];
    overflowingContainers: string[];
}

interface ScaleRawPoint {
    sourceIndex: number;
    rawEleM: number;
}

interface ProbeChartPoint {
    _raw?: ScaleRawPoint | null;
}

interface ProbeChart {
    data: {
        datasets: {
            label?: string;
            data: (ProbeChartPoint | null | undefined)[];
        }[];
    };
    options: { animation: unknown };
}

interface ChartGlobal {
    Chart?: { getChart?(canvas: HTMLCanvasElement): ProbeChart | null | undefined };
}

export type ExtensionGlobal = typeof globalThis & {
    browser?: typeof chrome;
    chrome?: typeof chrome;
};

interface BfcacheProbe {
    hidePersisted: boolean | null;
    showPersisted: boolean | null;
    settingsGets: number;
}

interface BfcacheProbeWindow extends Window {
    __bpbBfcacheProbe?: BfcacheProbe;
}

// Mode changes may alter the gap to different renderers' zoom stacks, but
// must keep the active pointer target anchored. Allow one CSS pixel rounding.
export function assertMapToggleAnchor(
    before: ToggleAnchorRect | null | undefined,
    after: ToggleAnchorRect | null | undefined,
): void {
    for (const key of ['left', 'top', 'width', 'height'] as const) {
        const beforeValue = before?.[key];
        const afterValue = after?.[key];
        if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue)
            || Math.abs((beforeValue as number) - (afterValue as number)) > 1) {
            throw new Error(`Map mode toggle moved or resized: ${JSON.stringify({ before, after })}`);
        }
    }
}

// Self-contained for serialization into either browser protocol. Both broad
// verifiers must enforce the independent card row and native-map ownership.
export function readPeakSunPlacement(): boolean {
    const iframe = document.getElementById('Gmap');
    const sun = document.querySelector('.bpb-sun-calculator[data-bpb-peak-card="sun"]');
    const row = sun?.closest('tr');
    const iframeRow = iframe?.closest('tr');
    return Boolean(iframe && iframeRow && row?.id === 'bpb-peak-sun-row'
        && row.closest('table') === iframe.closest('table')
        && row.rowIndex > iframeRow.rowIndex
        && iframe.closest('td')?.querySelector('a[href*="BigMap"]'));
}

// These probes run inside the page, through either Playwright or WebDriver.
// Keep them browser-neutral and free of module-scope dependencies so the same
// function can be serialized for Firefox without drifting from Chrome.
export function webdriverScript(
    pageFunction: (...args: never[]) => unknown,
    ...args: unknown[]
): string {
    if (typeof pageFunction !== 'function') throw new TypeError('A page function is required');
    const serializedArgs = args.map(value => JSON.stringify(value) ?? 'undefined').join(', ');
    return `return (${pageFunction.toString()})(${serializedArgs});`;
}

export function readDraftsManagerReadiness(expectedUrl: string): DraftsManagerReadinessState {
    const api = (globalThis as ExtensionGlobal).browser || (globalThis as ExtensionGlobal).chrome;
    const state = {
        url: window.location.href,
        readyState: document.readyState,
        heading: document.querySelector('h1')?.textContent || '',
        hasList: Boolean(document.querySelector('.drafts-list')),
        hasStorage: typeof api?.storage?.local?.set === 'function',
    };
    return {
        ...state,
        ready: state.url === expectedUrl && state.readyState === 'complete'
            && state.heading === 'Trip report drafts' && state.hasList && state.hasStorage,
    };
}

export function installAnalyzerBfcacheProbe(): void {
    const probeWindow = window as BfcacheProbeWindow;
    const panel = document.getElementById('bpb-gpx-analysis')!;
    panel.dataset.bfcacheProbe = 'preserve-this-document';
    probeWindow.__bpbBfcacheProbe = {
        hidePersisted: null,
        showPersisted: null,
        settingsGets: 0,
    };
    window.addEventListener('pagehide', event => {
        probeWindow.__bpbBfcacheProbe!.hidePersisted = event.persisted;
    });
    window.addEventListener('pageshow', event => {
        if (probeWindow.__bpbBfcacheProbe!.hidePersisted !== null) {
            probeWindow.__bpbBfcacheProbe!.showPersisted = event.persisted;
        }
    });
    window.addEventListener('message', event => {
        if (event.source === window && event.data?.__bpb === true
            && event.data?.dir === 'toCS' && event.data?.kind === 'get') {
            probeWindow.__bpbBfcacheProbe!.settingsGets++;
        }
    });
}

export function readAnalyzerBfcacheState(expectedRouteColor: string): AnalyzerBfcacheState | false {
    const panel = document.getElementById('bpb-gpx-analysis');
    const probe = (window as BfcacheProbeWindow).__bpbBfcacheProbe;
    const control = document.getElementById('bpb-map-route-color') as HTMLInputElement | null;
    return panel && control?.value === expectedRouteColor ? {
        token: panel.dataset.bfcacheProbe || null,
        hidePersisted: probe?.hidePersisted ?? null,
        showPersisted: probe?.showPersisted ?? null,
        settingsGets: probe?.settingsGets ?? null,
        panels: document.querySelectorAll('#bpb-gpx-analysis').length,
        calculators: document.querySelectorAll('.bpb-sun-calculator').length,
        viewports: document.querySelectorAll('#bpb-map-viewport').length,
        toggles: document.querySelectorAll('#bpb-terrain-toggle').length,
    } : false;
}

export function readAnalyzerChartState(): AnalyzerChartState | null {
    const canvas = document.querySelector<HTMLCanvasElement>('#bpb-gpx-analysis canvas');
    const chart = canvas ? (globalThis as unknown as ChartGlobal).Chart?.getChart?.(canvas) : null;
    if (!chart) return null;
    return {
        labels: chart.data.datasets.map(dataset => dataset.label),
        pointCounts: chart.data.datasets.map(dataset => dataset.data.length),
        pointBudget: Math.max(256, Math.min(1200,
            Math.ceil(canvas!.parentElement!.getBoundingClientRect().width))),
        breakCounts: chart.data.datasets.map(dataset =>
            dataset.data.filter(point => point?._raw === null).length),
        animation: chart.options.animation,
    };
}

export function readScaleChartState(): ScaleChartState | false {
    const canvas = document.querySelector<HTMLCanvasElement>('#bpb-gpx-analysis canvas');
    const chart = canvas ? (globalThis as unknown as ChartGlobal).Chart?.getChart?.(canvas) : null;
    if (!chart?.data?.datasets?.length) return false;
    const raw = chart.data.datasets[0].data
        .map(point => point?._raw)
        .filter((point): point is ScaleRawPoint => Boolean(point));
    const pointBudget = Math.max(256, Math.min(1200,
        Math.ceil(canvas!.parentElement!.getBoundingClientRect().width)));
    const state: ScaleChartState = {
        pointCounts: chart.data.datasets.map(dataset =>
            dataset.data.filter(point => point?._raw).length),
        pointBudget,
        sourceIndexes: raw.map(point => point.sourceIndex),
        rawElevations: raw.map(point => point.rawEleM),
        animation: chart.options.animation,
    };
    return state.pointCounts.every(count => count >= 2 && count <= pointBudget) ? state : false;
}

export function readSunCalculatorGeometry(): SunCalculatorGeometryState {
    const calculator = document.querySelector<HTMLElement>('.bpb-sun-calculator');
    const toggle = calculator?.querySelector('.bpb-sun-calculator__toggle');
    const panel = calculator?.querySelector('.bpb-sun-calculator__panel');
    const canvas = document.querySelector('#bpb-gpx-analysis canvas');
    const height = (selector: string): number | null =>
        calculator?.querySelector(selector)?.getBoundingClientRect().height ?? null;
    const overflowingText = [
        '.bpb-sun-calculator__summary',
        '.bpb-sun-calculator__date-value',
        '.bpb-sun-calculator__clock',
        '.bpb-sun-calculator__meta--date',
        '.bpb-sun-calculator__meta--time',
        '.bpb-sun-calculator__direction .bpb-sun-calculator__fact-value',
        '.bpb-sun-calculator__elevation .bpb-sun-calculator__fact-value',
        '.bpb-sun-calculator__moon-value',
        '.bpb-sun-calculator__moon-illumination',
        '.bpb-sun-calculator__moon-position',
        '.bpb-sun-calculator__moon-events-text',
        '.bpb-sun-calculator__events',
        '.bpb-sun-calculator__limitation',
    ].filter(selector => {
        const element = calculator?.querySelector(selector);
        return element && element.getClientRects().length > 0
            && (element.scrollWidth > element.clientWidth + 1
                || element.scrollHeight > element.clientHeight + 1);
    });
    const overflowingContainers = [
        '.bpb-sun-calculator__panel',
        '.bpb-sun-calculator__layout',
        '.bpb-sun-calculator__controls',
        '.bpb-sun-calculator__field:first-child',
        '.bpb-sun-calculator__field:last-child',
        '.bpb-sun-calculator__reading',
        '.bpb-sun-calculator__facts',
        '.bpb-sun-calculator__direction',
        '.bpb-sun-calculator__elevation',
        '.bpb-sun-calculator__moon',
        '.bpb-sun-calculator__events',
    ].filter(selector => {
        const element = calculator?.querySelector(selector);
        return element && element.getClientRects().length > 0
            && (element.scrollWidth > element.clientWidth + 1
                || element.scrollHeight > element.clientHeight + 1);
    });
    return {
        summary: calculator?.querySelector('.bpb-sun-calculator__summary')?.textContent || '',
        layoutState: calculator?.dataset.layoutState || '',
        calculatorHeight: calculator?.getBoundingClientRect().height ?? null,
        toggleHeight: toggle?.getBoundingClientRect().height ?? null,
        panelHeight: panel?.getBoundingClientRect().height ?? null,
        layoutHeight: height('.bpb-sun-calculator__layout'),
        controlsHeight: height('.bpb-sun-calculator__controls'),
        dateFieldHeight: height('.bpb-sun-calculator__field:first-child'),
        timeFieldHeight: height('.bpb-sun-calculator__field:last-child'),
        readingHeight: height('.bpb-sun-calculator__reading'),
        compassHeight: height('.bpb-sun-calculator__compass'),
        factsHeight: height('.bpb-sun-calculator__facts'),
        directionHeight: height('.bpb-sun-calculator__direction'),
        elevationHeight: height('.bpb-sun-calculator__elevation'),
        moonHeight: height('.bpb-sun-calculator__moon'),
        eventsHeight: height('.bpb-sun-calculator__events'),
        limitationHeight: height('.bpb-sun-calculator__limitation'),
        canvasTop: canvas?.getBoundingClientRect().top ?? null,
        canvasHeight: canvas?.getBoundingClientRect().height ?? null,
        overflowingText,
        overflowingContainers,
    };
}

// The snow card sits in the weather card's stack, directly after it.
export const readSnowCardPlacement = () => {
    const weather = document.getElementById('bpb-peak-weather-row');
    const snow = document.getElementById('bpb-peak-snow-row');
    const rows = Array.from(snow?.parentElement?.children || []);
    return {
        sameStack: !!weather && !!snow && weather.parentElement === snow.parentElement,
        followsWeather: weather !== null && snow !== null && rows.indexOf(weather) >= 0 && rows.indexOf(weather) < rows.indexOf(snow),
        order: rows.map(row => row.id).filter(Boolean),
    };
};
