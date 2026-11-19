// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import type {
    GpxHandoffCallerOptions,
    GpxHandoffImportProvider,
    GpxHandoffImportResult,
} from '../../src/background/gpx-handoff-routes.ts';

export interface MapImportHarnessOptions {
    outcome?: GpxHandoffImportResult;
    redirectUrl?: string;
}

interface HarnessProvider<Routes> {
    createRoutes(options: GpxHandoffCallerOptions): Routes;
    permission: chrome.permissions.Permissions;
    action: string;
}

interface FixtureTab {
    id: number;
    windowId?: number;
    url?: string;
    status: 'complete';
}

type PrepareImport = GpxHandoffImportProvider['prepareImport'];
type ImportArguments = Parameters<PrepareImport>;
type ImportInjection = Extract<chrome.scripting.ScriptInjection<ImportArguments, ReturnType<PrepareImport>>, { args: ImportArguments }>;
type ConsumedGrant = Parameters<GpxHandoffCallerOptions['trustedActions']['consumeGrant']>;

export const savedAscentSender = {
    tab: {
        id: 7, windowId: 9, index: 0, groupId: -1, lastAccessed: 0,
        active: true, highlighted: true, selected: true, pinned: false,
        frozen: false, incognito: false, discarded: false, autoDiscardable: true,
    },
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=42',
} satisfies chrome.runtime.MessageSender;

export const createMapImportHarness = <Routes,>(
    { createRoutes, permission, action }: HarnessProvider<Routes>,
    { outcome = { ok: true, supplied: true, code: 'prepared', message: 'Ready.' }, redirectUrl }: MapImportHarnessOptions = {},
) => {
    const tabs = new Map<number, FixtureTab>();
    const created: chrome.tabs.CreateProperties[] = [];
    const injections: ImportInjection[] = [];
    const consumed: ConsumedGrant[] = [];
    let nextId = 20;
    const ext = {
        permissions: {
            request: async (request: chrome.permissions.Permissions) => { assert.deepEqual(request, permission); return true; },
            contains: async (request: chrome.permissions.Permissions) => { assert.deepEqual(request, permission); return true; },
        },
        runtime: { getURL: (path: string) => `moz-extension://test/${path}` },
        tabs: {
            create: async (details: chrome.tabs.CreateProperties) => {
                created.push(details);
                const tab: FixtureTab = {
                    id: nextId++,
                    windowId: details.windowId,
                    url: redirectUrl || details.url,
                    status: 'complete',
                };
                tabs.set(tab.id, tab);
                return { ...tab };
            },
            get: async (id: number) => ({ ...tabs.get(id) }),
            update: async () => {},
        },
        windows: { update: async () => {} },
        scripting: {
            executeScript: async (details: ImportInjection) => { injections.push(details); return [{ result: outcome }]; },
        },
    };
    const routes = createRoutes({
        // Only the APIs called by the handoff routes are present in this fixture.
        ext: ext as unknown as typeof chrome,
        isPeakbaggerSender: value => value?.url?.startsWith('https://www.peakbagger.com/') === true,
        trustedActions: {
            consumeGrant: async (...args) => { consumed.push(args); return true; },
        },
        action,
    });
    return { ext, routes, created, injections, consumed };
};
