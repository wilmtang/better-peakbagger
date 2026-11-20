// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The built worker's local-file GPX pipeline with its extension API and
// network stubbed, shared by the worker-only Node cases and the end-to-end
// browser case. Callers choose how the worker bundle is evaluated.

import assert from 'node:assert/strict';
import { createCaptureWriteFaults, type CaptureWriteFaults } from './capture-write-faults.mts';

export const PAGE_URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=77';
export const SENDER = { tab: { id: 5, windowId: 9 }, url: PAGE_URL };

export const SEGMENTS = [[
    { lat: 0, lon: -0.001, ele: 100, time: Date.UTC(2026, 6, 1, 15, 0), invalidTime: false },
    { lat: 0, lon: 0, ele: 130, time: Date.UTC(2026, 6, 1, 16, 0), invalidTime: false },
    { lat: 0, lon: 0.001, ele: 100, time: Date.UTC(2026, 6, 1, 17, 0), invalidTime: false }
]];
export type Values = Record<string, unknown>;
// The worker's session records and replies, as these cases read them. Each
// route returns its own subset; a case asserts a field it expects absent.
export interface CaptureJob {
    phase: string; id: string; provider: string; boundPid: number; cid: string; selectionNonce: string;
    selectionGeneration: number; payloadKey: string; uploadGpx: string; tripName: string;
    trackSummary: { originalPointCount: number }; expiresAt: number; dayStats: unknown[]; matches: ReplyMatch[]; [field: string]: unknown;
}
export interface DraftTab { pid: string | number; cid: string | number; jobId: string; previewOrder: number; suffix: string; tripInfo: { name: string }; focusOnReady: boolean; [field: string]: unknown }
export interface SessionValues { bpbCaptureJobs: Record<string, CaptureJob>; bpbDraftTabs: Record<string, DraftTab>; [key: string]: unknown }
export interface ReplyMatch { id: number; classification: string; selected: boolean; date: string; time: unknown; draftFields: Values }
export interface WorkerReply {
    ok: boolean; phase: string; jobId: string; action: string; error: { code: string; message: string };
    matches: ReplyMatch[]; boundPid: number; boundFallback: { id: number; selected: boolean; closestApproachM: number };
    gpx: string; fields: Values & { date: string; suffix: string; upDistanceM: number }; peakName: string;
    pid: string; cid: string; applyLeaseToken: string; tabIds: number[]; suffix: string; previewOrder: unknown;
    preserved: unknown; uploadGpx: unknown; tripInfo: unknown; selectionNonce: string; selectionGeneration: number;
    preserveExistingFields: boolean; pageSessionId: string; [field: string]: unknown;
}
export interface Faults extends CaptureWriteFaults { tabCreateAt?: number | null; tabCreateAtMessage?: string; tabNavigateAt?: number | null; tabNavigateAtMessage?: string; [fault: string]: unknown }
interface Tab { id: number; windowId?: number; url?: string; active?: boolean; status?: string }
interface Sender { tab?: { id: number; windowId?: number }; url?: string }
type PageResult = Values & { kind: string };
type Listener = (message: unknown, sender: Values, respond: (reply: WorkerReply) => void) => unknown;
interface HarnessOptions {
    peakXml?: string | null; settings?: Values; failPeakFetch?: boolean;
    beforePeakFetch?: ((call: { options: { signal: AbortSignal }; number: number }) => Promise<unknown> | null | undefined | void) | null;
    syncGetError?: string | null; beforeSyncGet?: ((calls: number) => unknown) | null;
    setTimeoutImpl?: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown; faults?: Faults;
    loginHtml?: string; loginFailure?: string | null; sessionInitial?: Partial<SessionValues>;
    // Evaluates dist/background.js with these globals and nothing it would not have.
    runWorker: (globals: WorkerGlobals) => void;
}
export interface WorkerGlobals { browser: unknown; fetch: unknown; setTimeout: unknown }

export const uploadSelection = (generation: number) => ({
    pageSessionId: 'explicit-page-session',
    selectionGeneration: generation,
    selectionNonce: `selection-${generation}-nonce`,
});

export const createHarness = ({ peakXml = null, settings = {}, failPeakFetch = false, beforePeakFetch = null,
    syncGetError = null, beforeSyncGet = null, setTimeoutImpl = setTimeout, faults = {},
    loginHtml = '<div>Logged in: Test Climber | <a href="climber/climber.aspx?cid=77">My Home Page</a></div>', loginFailure = null,
    sessionInitial = {}, runWorker }: HarnessOptions) => {
    const values = structuredClone(sessionInitial) as SessionValues;
    const localValues: Values = {};
    const syncValues: Values = { bpbSettings: structuredClone(settings) };
    const tabs = new Map<number, Tab>([[5, { id: 5, windowId: 9, url: PAGE_URL, active: true }]]);
    let nextTabId = 100;
    const tabMessages: { tabId: number; message: Values }[] = [];
    const fetchCalls: string[] = [];
    const grouped: Values[] = [];
    const groupUpdates: [number, Values][] = [];
    const navigations: { tabId: number; url: string; draftRegistered: boolean }[] = [];
    const removedTabs: number[] = [];
    const runtimeMessages: Values[] = [];
    const workerFetchCalls: string[] = [];
    const peakbaggerPageInjected = new Set<number>();
    const peakbaggerPageRequests = new Map<string, AbortController>();
    let syncGetCalls = 0;
    let tabCreateCalls = 0;
    let tabNavigationCalls = 0;
    const checkSessionWrite = createCaptureWriteFaults(faults);
    const sessionSetPatches: Values[] = [];

    const browser = {
        storage: {
            session: {
                get: async (key: string | null) => key === null
                    ? structuredClone(values)
                    : { [key]: structuredClone(values[key]) },
                set: async (patch: Partial<SessionValues>) => {
                    checkSessionWrite(patch);
                    sessionSetPatches.push(structuredClone(patch));
                    Object.assign(values, structuredClone(patch));
                },
                remove: async (keys: string | string[]) => {
                    (Array.isArray(keys) ? keys : [keys]).forEach(key => { delete values[key]; });
                },
            },
            sync: {
                get: async (key: string) => {
                    syncGetCalls++;
                    if (beforeSyncGet) await beforeSyncGet(syncGetCalls);
                    if (syncGetError) throw new Error(syncGetError);
                    return { [key]: structuredClone(syncValues[key]) };
                },
                set: async (patch: Values) => Object.assign(syncValues, structuredClone(patch))
            },
            local: {
                get: async (key: string) => ({ [key]: structuredClone(localValues[key]) }),
                set: async (patch: Values) => Object.assign(localValues, structuredClone(patch))
            },
            onChanged: { addListener: () => {} }
        },
        runtime: {
            id: 'test-extension',
            getURL: (path: string) => `chrome-extension://test-extension/${path}`,
            onMessage: { listeners: [] as Listener[], addListener(listener: Listener) { this.listeners.push(listener); } },
        },
        scripting: {
            executeScript: async (details: { files?: string[]; func?: unknown; args?: unknown[]; target: { tabId: number } }) => {
                if (details.files) {
                    if (details.files.includes('peakbagger-page.js')) {
                        peakbaggerPageInjected.add(details.target.tabId);
                    }
                    return [];
                }
                const functionSource = String(details.func);
                if (functionSource.includes('BPBPeakbaggerPage?.version')) {
                    return [{ result: peakbaggerPageInjected.has(details.target.tabId) }];
                }
                if (functionSource.includes('BPBPeakbaggerPage?.cancel')) {
                    const requestId = details.args?.[0] as string;
                    const controller = peakbaggerPageRequests.get(requestId);
                    controller?.abort();
                    return [{ result: !!controller }];
                }
                if (functionSource.includes('api.request')
                    && functionSource.includes('bridge')
                    && functionSource.includes('missing')) {
                    if (!peakbaggerPageInjected.has(details.target.tabId)) {
                        return [{ result: { bridge: 'missing' } }];
                    }
                    const [, requestId, url, kind] = details.args as [unknown, string, string, string];
                    const controller = new AbortController();
                    peakbaggerPageRequests.set(requestId, controller);
                    const value = await requestPeakbaggerPage(url, { kind, signal: controller.signal });
                    peakbaggerPageRequests.delete(requestId);
                    return [{ result: { bridge: 'result', value } }];
                }
                return [];
            },
        },
        action: {
            setBadgeBackgroundColor: async () => {},
            setBadgeText: async () => {}
        },
        tabs: {
            get: async (tabId: number) => structuredClone(tabs.get(tabId)),
            create: async (details: { windowId?: number; url?: string; active?: boolean }) => {
                tabCreateCalls++;
                if (faults.tabCreateAt === tabCreateCalls) {
                    const message = faults.tabCreateAtMessage || `tab create ${tabCreateCalls} failed`;
                    faults.tabCreateAt = null;
                    throw new Error(message);
                }
                const tab = { id: nextTabId++, windowId: details.windowId, url: details.url, active: details.active, status: 'complete' };
                tabs.set(tab.id, tab);
                return structuredClone(tab);
            },
            remove: async (tabId: number) => {
                removedTabs.push(tabId);
                tabs.delete(tabId);
            },
            update: async (tabId: number, patch: Partial<Tab>) => {
                if (patch.url) {
                    tabNavigationCalls++;
                    if (faults.tabNavigateAt === tabNavigationCalls) {
                        const message = faults.tabNavigateAtMessage || `tab navigation ${tabNavigationCalls} failed`;
                        faults.tabNavigateAt = null;
                        throw new Error(message);
                    }
                    // Pin the invariant that a draft is registered before its
                    // tab's URL ever changes.
                    navigations.push({
                        tabId,
                        url: patch.url,
                        draftRegistered: !!(values.bpbDraftTabs || {})[String(tabId)]
                    });
                }
                Object.assign(tabs.get(tabId)!, patch);
                return structuredClone(tabs.get(tabId));
            },
            sendMessage: async (tabId: number, message: Values) => { tabMessages.push({ tabId, message: structuredClone(message) }); return true; },
            onRemoved: { addListener: () => {} },
            onUpdated: { addListener: () => {}, removeListener: () => {} }
        },
        tabGroups: { update: async (groupId: number, patch: Values) => groupUpdates.push([groupId, structuredClone(patch)]) },
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
    };

    const requestPeakbaggerPage = async (url: string, { kind, signal }: { kind: string; signal: AbortSignal }): Promise<PageResult> => {
        const value = String(url);
        fetchCalls.push(value);
        const cancelled = () => ({
            kind: 'transient', requestedUrl: value, url: value, status: 0, redirected: false,
            error: { source: 'peakbagger', code: 'cancelled', resource: kind },
        });
        try {
            if (value.includes('/Default.aspx')) {
                if (loginFailure) {
                    return {
                        kind: loginFailure === 'cloudflare' ? 'challenged' : 'transient',
                        requestedUrl: value,
                        url: value,
                        status: loginFailure === 'cloudflare' ? 403 : 0,
                        redirected: false,
                        error: { source: 'peakbagger', code: loginFailure, resource: kind },
                    };
                }
                return {
                    kind: 'ok', requestedUrl: value, url: value, status: 200, redirected: false,
                    text: loginHtml,
                };
            }
            if (!value.includes('/Async/pllbb2.aspx')) throw new Error(`Unexpected page request: ${value}`);
            if (beforePeakFetch) {
                const pending = beforePeakFetch({
                    options: { signal },
                    number: fetchCalls.filter(call => call.includes('/Async/pllbb2.aspx')).length,
                });
                if (pending) {
                    await Promise.race([
                        pending,
                        new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
                    ]);
                }
            }
            if (signal.aborted) return cancelled();
            if (failPeakFetch) throw new Error('network unreachable');
            return {
                kind: 'ok', requestedUrl: value, url: value, status: 200, redirected: false,
                text: peakXml || '<p><t i="7" n="Test Peak" a="0" o="0" e="426.51" r="100" l="Test Range"/></p>',
            };
        } catch (_error) {
            if (signal.aborted) return cancelled();
            return {
                kind: 'transient', requestedUrl: value, url: value, status: 0, redirected: false,
                error: { source: 'peakbagger', code: 'network', resource: kind },
            };
        }
    };

    const fetch = async (url: unknown) => {
        const value = String(url);
        workerFetchCalls.push(value);
        throw new Error(`Unexpected worker fetch: ${value}`);
    };

    (browser.tabs as Values).group = async (details: Values) => { grouped.push(structuredClone(details)); return 3; };

    // The caller runs the built worker with exactly these stubbed globals.
    runWorker({ browser, fetch, setTimeout: setTimeoutImpl });
    const listener = browser.runtime.onMessage.listeners[0];
    const rawSend = (message: Values, sender: Sender = SENDER) => new Promise<WorkerReply>(resolve => {
        runtimeMessages.push(structuredClone(message));
        assert.equal(listener(message, { id: 'test-extension',
            ...(sender.tab ? { frameId: 0, documentId: `gpx-document-${sender.tab.id}` } : {}),
            ...sender }, resolve), true);
    });
    let selectionGeneration = 0;
    let currentSelection: Values | null = null;
    const send = async (message: Values, sender: Sender = SENDER) => {
        let routed = message;
        if (message?.type === 'GPX_PROCESS_START' && !message.pageSessionId) {
            currentSelection = {
                pageSessionId: 'test-page-session',
                selectionGeneration: ++selectionGeneration,
                selectionNonce: `selection-${selectionGeneration}-nonce`,
            };
            await rawSend({ type: 'GPX_PROCESS_INVALIDATE', ...currentSelection }, sender);
            routed = { ...message, ...currentSelection };
        } else if (message?.type === 'GPX_PROCESS_APPLY' && !message.pageSessionId && currentSelection) {
            routed = { ...message, ...currentSelection };
        }
        return rawSend(routed, sender);
    };
    return {
        send, rawSend, values, tabs, tabMessages, fetchCalls, workerFetchCalls,
        grouped, groupUpdates, navigations, removedTabs,
        runtimeMessages, sessionSetPatches,
        syncGetCalls: () => syncGetCalls, faults,
    };
};

export type Harness = ReturnType<typeof createHarness>;
export const storedCaptureGpx = (harness: Harness, tabId = 5) => {
    const job = harness.values.bpbCaptureJobs?.[String(tabId)];
    return job?.payloadKey ? (harness.values[job.payloadKey] as { gpx?: string } | undefined)?.gpx : undefined;
};
