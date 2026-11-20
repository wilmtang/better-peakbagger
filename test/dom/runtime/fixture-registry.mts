/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every open fixture window an in-page test created, so page-wide test
// services (mocked timers, error capture) also reach windows created later,
// and the runtime can close them all when a test ends.

type Listener = (window: Window) => void;
const windows = new Map<Window, () => void>();
const listeners = new Set<Listener>();

export const fixtureWindows = {
    add(window: Window, close: () => void) {
        windows.set(window, close);
        for (const listener of listeners) listener(window);
    },
    delete(window: Window) { windows.delete(window); },
    subscribe(listener: Listener): () => void {
        for (const window of windows.keys()) listener(window);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    // Clears each window's web storage (its origin may differ from the test
    // page's) and closes it.
    closeAll() {
        for (const [window, close] of [...windows]) {
            try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* an opaque or closed document */ }
            close();
        }
        windows.clear();
    },
};
