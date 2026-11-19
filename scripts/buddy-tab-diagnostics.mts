// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />

/* global chrome, window */

// Run only in the disposable verifier's extension page. Preserve native calls
// and callbacks while retaining the tab transition that precedes a failed read.
export function installBuddyTabDiagnostics() {
    type TabMethodName = 'query' | 'create' | 'update';
    type TabMethod = (...args: unknown[]) => unknown;
    type DiagnosticsEvent = { at: number; event: string } & Record<string, unknown>;
    const events: DiagnosticsEvent[] = [];
    const originals: Partial<Record<TabMethodName, TabMethod>> = {};
    const tabs = chrome.tabs as unknown as Record<TabMethodName, TabMethod>;
    const tabState = (tab: unknown) => tab ? Object.fromEntries(
        (['id', 'url', 'pendingUrl', 'status', 'active', 'windowId'] as const).map(
            key => [key, (tab as Record<string, unknown>)[key]],
        ),
    ) : tab;
    const record = (event: string, details: Record<string, unknown>) => {
        events.push({ at: Date.now(), event, ...details });
        if (events.length > 100) events.shift();
    };
    for (const name of ['query', 'create', 'update'] as const) {
        const original = tabs[name];
        originals[name] = original;
        tabs[name] = function (...args: unknown[]) {
            record(name, { args: args.filter(value => typeof value !== 'function') });
            const callback = args.at(-1);
            if (typeof callback === 'function') args[args.length - 1] = (value: unknown) => {
                record(`${name}-reply`, {
                    value: Array.isArray(value) ? value.map(tabState) : tabState(value),
                    error: chrome.runtime.lastError?.message,
                });
                (callback as (reply: unknown) => void)(value);
            };
            try { return original.apply(chrome.tabs, args); }
            catch (error) {
                const message = typeof error === 'object' && error !== null && 'message' in error
                    && typeof (error as { message: unknown }).message === 'string'
                    ? (error as { message: string }).message
                    : String(error);
                record(`${name}-throw`, { error: message });
                throw error;
            }
        };
    }
    const updated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) =>
        record('updated', { id, change, tab: tabState(tab) });
    chrome.tabs.onUpdated.addListener(updated);
    (window as unknown as {
        __bpbBuddyTabDiagnostics: { events: DiagnosticsEvent[]; restore(): void };
    }).__bpbBuddyTabDiagnostics = {
        events,
        restore() {
            for (const [name, original] of Object.entries(originals)) {
                if (original) tabs[name as TabMethodName] = original;
            }
            chrome.tabs.onUpdated.removeListener(updated);
        },
    };
}
