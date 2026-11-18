// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registered only with optional Instagram access. Even then, inspect/change a
// theme only after a configuration message from our actual packaged parent.
// No caption text, media URL, cookies or provider content crosses that boundary.

export interface InstagramDisplayHandle {
    dispose(): void;
}

interface InstagramProviderExtension {
    runtime?: {
        getURL?: (path: string) => string;
    };
}

export function installInstagramDisplay(doc: Document, extensionOrigin: string): InstagramDisplayHandle | null {
    const win = doc.defaultView;
    if (!win || win.parent === win || win.location.origin !== 'https://www.instagram.com'
        || !/^\/(?:p|reel)\/[A-Za-z0-9_-]{1,64}\/embed\/captioned\/$/.test(win.location.pathname)) return null;
    const disable = (): void => doc.documentElement.removeAttribute('data-bpb-instagram-theme');
    const receive = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        if (event.source !== win.parent || event.origin !== extensionOrigin || !data || typeof data !== 'object') return;
        const payload = data as { __bpbInstagramDisplay?: unknown; enabled?: unknown; theme?: unknown };
        if (payload.__bpbInstagramDisplay !== true) return;
        if (payload.enabled !== true) { disable(); return; }
        if (payload.theme !== 'light' && payload.theme !== 'dark') return;
        doc.documentElement.dataset.bpbInstagramTheme = payload.theme;
    };
    win.addEventListener('message', receive);
    const dispose = (): void => { disable(); win.removeEventListener('message', receive); };
    win.addEventListener('pagehide', dispose, { once: true });
    win.parent.postMessage({ __bpbInstagramProvider: 'ready' }, extensionOrigin);
    return { dispose };
}

if (typeof document !== 'undefined') {
    const extensionGlobals = globalThis as {
        browser?: InstagramProviderExtension;
        chrome?: InstagramProviderExtension;
    };
    const api = extensionGlobals.browser || extensionGlobals.chrome;
    if (api?.runtime?.getURL) {
        const url = new URL(api.runtime.getURL(''));
        installInstagramDisplay(document, `${url.protocol}//${url.host}`);
    }
}
