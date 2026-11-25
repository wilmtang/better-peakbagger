// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference types="chrome" />
/* global document, location, scrollY, innerWidth, innerHeight, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict';
import { waitForCondition as untypedWaitForCondition } from './browser-verification-fixtures.mts';

const waitForCondition = untypedWaitForCondition as unknown as <T>(
    read: () => T | Promise<T>,
    options: { description: string; timeoutMs?: number; isReady?: (value: T) => boolean },
) => Promise<T>;

type PageEvaluate = (fn: (arg: never) => unknown, arg?: unknown) => Promise<unknown>;
type Box = { x: number; y: number; width: number; height: number };

export interface SettingsFragmentLanding {
    hash: string;
    missing?: boolean;
    scroll?: number;
    expected?: number;
    targetTop?: number;
    paneTop?: number;
    paneBottom?: number;
    current?: string;
    owner?: string;
    rootScroll?: number;
    bodyScroll?: number;
    behavior?: string;
    viewport?: { width: number; height: number };
}

interface ScrollTrackingState {
    current: string;
    visible: boolean;
    row: Box;
    frame: Box;
    nav: Box;
    content: Box;
    rootScroll: number;
    bodyScroll: number;
    contentScroll: number;
    navScroll: { top: number; left: number };
    focus: string;
    viewport: { width: number; height: number };
}

export interface SettingsScrollTrackingOptions {
    evaluate: PageEvaluate;
    navigate: (hash: string) => Promise<unknown>;
    resize: (width: number, height: number) => Promise<unknown>;
    configure: (prefs: { theme: string; enableReportEditor: boolean; enableGarminInbox: boolean }) => Promise<unknown>;
    screenshot?: ((name: string) => Promise<unknown>) | undefined;
}

export interface SettingsFragmentOptions extends SettingsScrollTrackingOptions {
    reload: () => Promise<unknown>;
    back: () => Promise<unknown>;
    forward: () => Promise<unknown>;
    keyboardLink: (hash: string) => Promise<unknown>;
}

export function readSettingsFragmentLanding(): SettingsFragmentLanding {
    const pane = document.querySelector<HTMLElement>('.content')!, target = document.getElementById(location.hash.slice(1));
    if (!target) return { hash: location.hash, missing: true };
    const box = target.getBoundingClientRect(), frame = pane.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    const owner = [...document.querySelectorAll<HTMLAnchorElement>('.side-nav a')].reverse().find(link => {
        const group = document.getElementById(link.hash.slice(1));
        return group === target || group?.contains(target);
    });
    return {
        hash: location.hash,
        scroll: pane.scrollTop,
        expected: Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight, pane.scrollTop + box.top - frame.top - margin)),
        targetTop: box.top,
        paneTop: frame.top,
        paneBottom: frame.bottom,
        current: document.querySelector<HTMLAnchorElement>('.side-nav [aria-current]')?.hash,
        owner: owner?.hash,
        rootScroll: scrollY,
        bodyScroll: document.body.scrollTop,
        behavior: pane.style.scrollBehavior,
        viewport: { width: innerWidth, height: innerHeight },
    };
}

export const settingsFragmentLanded = (value: unknown, hash: string): boolean => {
    if (!value || typeof value !== 'object') return false;
    const landing = value as SettingsFragmentLanding;
    return landing.hash === hash && !landing.missing
        && landing.scroll !== undefined && landing.expected !== undefined
        && Math.abs(landing.scroll - landing.expected) <= 1
        && landing.current === landing.owner
        && landing.rootScroll === 0 && landing.bodyScroll === 0 && landing.behavior === '';
};

const readScrollTracking = (): ScrollTrackingState => {
    const nav = document.querySelector('.side-nav')!, list = nav.querySelector('.nav-list')!;
    const content = document.querySelector('.content')!, active = nav.querySelector<HTMLAnchorElement>('[aria-current]')!;
    const link = active.getClientRects().length ? active
        : active.closest('li')!.parentElement!.closest('li')!.querySelector<HTMLAnchorElement>('.nav-item')!;
    const scroller = getComputedStyle(list).overflowX === 'auto' ? list : nav;
    const rect = (node: Element): Box => {
        const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
    };
    const row = link.getBoundingClientRect(), frame = scroller.getBoundingClientRect();
    return {
        current: active.hash,
        visible: row.width > 0 && row.height > 0
            && row.top >= frame.top - 1 && row.bottom <= frame.bottom + 1
            && row.left >= frame.left - 1 && row.right <= frame.right + 1,
        row: rect(link),
        frame: rect(scroller),
        nav: rect(nav),
        content: rect(content),
        rootScroll: scrollY,
        bodyScroll: document.body.scrollTop,
        contentScroll: content.scrollTop,
        navScroll: { top: scroller.scrollTop, left: scroller.scrollLeft },
        focus: document.activeElement!.id,
        viewport: { width: innerWidth, height: innerHeight },
    };
};

// Exercise passive scrolling independently of fragment/click navigation. The
// real extension supplies settings and layout; no navigation or geometry stubs.
export async function verifySettingsScrollTracking({ evaluate, navigate, resize, configure, screenshot }: SettingsScrollTrackingOptions) {
    const evalPage = <T, A = never>(fn: (arg: A) => T, arg?: A) =>
        evaluate(fn as (arg: never) => unknown, arg) as Promise<Awaited<T>>;
    let cases = 0; const viewports: { width: number; height: number }[] = [];
    for (const [width, height, theme, enlarged] of [[1000, 760, 'light', false], [1000, 420, 'dark', false],
        [375, 760, 'light', false], [1000, 760, 'dark', true], [375, 760, 'dark', true]] as const) {
        const label = `scroll-${width}-${height}-${theme}${enlarged ? '-large-text' : ''}`;
        await resize(width, height);
        await configure({ theme, enableReportEditor: true, enableGarminInbox: true });
        await navigate('');
        await waitForCondition(() => evalPage(() => (document.getElementById('enable-garmin-inbox') as HTMLInputElement).checked
            && !document.getElementById('capture-garmin')!.hidden), { description: `${label}/settings ready` });
        await evalPage(isEnlarged => {
            if (isEnlarged) for (const node of document.querySelectorAll<HTMLElement>('.side-nav a, .side-nav h1, .side-nav p')) {
                node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
            }
            document.getElementById('theme')!.focus({ preventScroll: true });
        }, enlarged);
        for (const id of ['general-units', 'map-chart-map', 'github-settings-backup', 'about',
            'github-connection', 'map-chart-chart', 'general-features', 'general']) {
            await evalPage(sectionId => {
                const content = document.querySelector('.content')!, target = document.getElementById(sectionId)!;
                content.scrollTo({
                    top: content.scrollTop + target.getBoundingClientRect().top
                        - content.getBoundingClientRect().top - 24,
                    behavior: 'instant',
                });
            }, id);
            const before = await evalPage(readScrollTracking);
            await waitForCondition(() => evalPage(readScrollTracking), {
                description: `${label}/${id}/active section`, isReady: state => state.current === `#${id}`,
            });
            const state = await evalPage(readScrollTracking), detail = `${label}/${id}: ${JSON.stringify(state)}`;
            assert.equal(state.visible, true, `active navigation row left its scroll viewport; ${detail}`);
            assert.equal(state.focus, 'theme', `passive navigation stole keyboard focus; ${detail}`);
            assert.equal(state.rootScroll, 0, detail); assert.equal(state.bodyScroll, 0, detail);
            assert.ok(Math.abs(state.contentScroll - before.contentScroll) <= 1, `revealing navigation moved the reading position; ${detail}`);
            for (const pane of ['nav', 'content'] as const) for (const dimension of ['x', 'y', 'width', 'height'] as const) {
                assert.ok(Math.abs(state[pane][dimension] - before[pane][dimension]) <= 1, `revealing navigation moved ${pane}.${dimension}; ${detail}`);
            }
            cases++;
            if (['github-settings-backup', 'map-chart-chart'].includes(id)) await screenshot?.(`${label}-${id}`);
        }
        // Readers may inspect another part of the menu. Small content scrolls
        // within the same section must not keep pulling the sidebar back.
        await evalPage(() => {
            const nav = document.querySelector('.side-nav')!, list = nav.querySelector('.nav-list')!;
            nav.scrollTop = nav.scrollHeight; list.scrollLeft = list.scrollWidth;
            document.querySelector('.content')!.scrollTo({ top: 4, behavior: 'instant' });
        });
        const manual = await evalPage(readScrollTracking);
        await evalPage(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const settled = await evalPage(readScrollTracking);
        assert.equal(settled.current, '#general', label);
        assert.deepEqual(settled.navScroll, manual.navScroll, `${label}: repeated scrolls must preserve manual menu browsing`);
        cases++; viewports.push(settled.viewport);
    }
    assert.equal(cases, 45, 'scroll tracking must execute every direction, viewport and text-size case');
    return { cases, viewports, passiveScroll: true, focusPreserved: true, enlargedNavigationText: true };
}

export async function verifySettingsFragments({ evaluate, navigate, reload, back, forward, resize, keyboardLink, configure, screenshot }: SettingsFragmentOptions) {
    const evalPage = <T, A = never>(fn: (arg: A) => T, arg?: A) =>
        evaluate(fn as (arg: never) => unknown, arg) as Promise<Awaited<T>>;
    let cases = 0; const viewports: ({ width: number; height: number } | undefined)[] = [];
    const land = async (hash: string, label: string) => {
        const read = () => evalPage(readSettingsFragmentLanding);
        try { await waitForCondition(read, { description: label, timeoutMs: 5000, isReady: value => settingsFragmentLanded(value, hash) }); }
        catch (error) { assert.fail(`${label}: anchored content did not land: ${JSON.stringify(await read())}. ${error instanceof Error ? error.message : String(error)}`); }
        cases++; return read();
    };
    for (const [width, theme, expanded] of [[1000, 'light', true], [375, 'dark', true], [1000, 'dark', false], [375, 'light', false]] as const) {
        const label = `${width}-${theme}-${expanded ? 'expanded' : 'compact'}`;
        await resize(width, 760);
        await configure({ theme, enableReportEditor: expanded, enableGarminInbox: expanded });
        for (const hash of ['#capture-view', '#map-chart-chart', '#map-chart-map', '#custom-map-layers', '#ignored-github', '#about']) {
            await navigate(hash); await land(hash, `${label}/${hash}/open`);
            await reload(); await land(hash, `${label}/${hash}/refresh`);
            await evalPage(() => document.querySelector('.content')!.scrollTo({ top: 0, behavior: 'instant' }));
            await reload();
            const state = await land(hash, `${label}/${hash}/refresh-after-manual-scroll`);
            if (hash === '#capture-view') await screenshot?.(`${label}-trip-report-viewing`);
            if (hash === '#map-chart-chart') { viewports.push(state.viewport); await screenshot?.(`${label}-chart`); }
        }
        await navigate('#map-chart-chart'); await land('#map-chart-chart', `${label}/history-start`);
        if (width === 1000) await keyboardLink('#custom-map-layers');
        else await evalPage(() => { location.hash = '#custom-map-layers'; });
        await land('#custom-map-layers', `${label}/hash-navigation`);
        await back(); await land('#map-chart-chart', `${label}/back`);
        await forward(); await land('#custom-map-layers', `${label}/forward`);
        await reload(); await land('#custom-map-layers', `${label}/refresh-after-history`);
        // Settings updates after navigation must not keep snapping to the URL.
        await evalPage(async () => {
            document.querySelector('.content')!.scrollTo({ top: 0, behavior: 'instant' });
            const api = (globalThis as { browser?: typeof chrome }).browser || globalThis.chrome;
            const saved = await api.storage.sync.get('bpbSettings') as { bpbSettings: { theme?: string; [key: string]: unknown } };
            await api.storage.sync.set({ bpbSettings: { ...saved.bpbSettings, theme: saved.bpbSettings.theme === 'light' ? 'dark' : 'light' } });
        });
        await waitForCondition(() => evalPage(() => ({
            scroll: document.querySelector('.content')!.scrollTop,
            theme: document.documentElement.dataset.bpbTheme,
        })), {
            description: `${label}/manual reading survives settings updates`,
            isReady: value => value.theme !== theme && value.scroll === 0,
        });
        cases++;
    }
    assert.equal(cases, 96, 'fragment verification must execute its load, refresh and history cases');
    return { cases, viewports, anchors: 6, refresh: true, backForward: true, manualReading: true };
}
