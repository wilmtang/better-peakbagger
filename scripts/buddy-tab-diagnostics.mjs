// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global chrome, window */

// Run only in the disposable verifier's extension page. Preserve native calls
// and callbacks while retaining the tab transition that precedes a failed read.
export function installBuddyTabDiagnostics() {
    const events = [];
    const originals = {};
    const tabState = tab => tab && Object.fromEntries(
        ['id', 'url', 'pendingUrl', 'status', 'active', 'windowId'].map(key => [key, tab[key]])
    );
    const record = (event, details) => {
        events.push({ at: Date.now(), event, ...details });
        if (events.length > 100) events.shift();
    };
    for (const name of ['query', 'create', 'update']) {
        const original = chrome.tabs[name];
        originals[name] = original;
        chrome.tabs[name] = function (...args) {
            record(name, { args: args.filter(value => typeof value !== 'function') });
            const callback = args.at(-1);
            if (typeof callback === 'function') args[args.length - 1] = value => {
                record(`${name}-reply`, { value: Array.isArray(value) ? value.map(tabState) : tabState(value),
                    error: chrome.runtime.lastError?.message });
                callback(value);
            };
            try { return original.apply(chrome.tabs, args); }
            catch (error) { record(`${name}-throw`, { error: error.message }); throw error; }
        };
    }
    const updated = (id, change, tab) => record('updated', { id, change, tab: tabState(tab) });
    chrome.tabs.onUpdated.addListener(updated);
    window.__bpbBuddyTabDiagnostics = { events, restore() {
        for (const [name, original] of Object.entries(originals)) chrome.tabs[name] = original;
        chrome.tabs.onUpdated.removeListener(updated);
    } };
}
