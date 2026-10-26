// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registered only with optional Instagram access. Even then, inspect/change a
// theme only after a configuration message from our actual packaged parent.
// No caption text, media URL, cookies or provider content crosses that boundary.
export function installInstagramDisplay(doc, extensionOrigin) {
    const win = doc.defaultView;
    if (win.parent === win || win.location.origin !== 'https://www.instagram.com'
        || !/^\/(?:p|reel)\/[A-Za-z0-9_-]{1,64}\/embed\/captioned\/$/.test(win.location.pathname)) return null;
    const disable = () => doc.documentElement.removeAttribute('data-bpb-instagram-theme');
    const receive = event => {
        if (event.source !== win.parent || event.origin !== extensionOrigin || event.data?.__bpbInstagramDisplay !== true) return;
        if (event.data.enabled !== true) { disable(); return; }
        if (!['light', 'dark'].includes(event.data.theme)) return;
        doc.documentElement.dataset.bpbInstagramTheme = event.data.theme;
    };
    win.addEventListener('message', receive);
    const dispose = () => { disable(); win.removeEventListener('message', receive); };
    win.addEventListener('pagehide', dispose, { once: true });
    win.parent.postMessage({ __bpbInstagramProvider: 'ready' }, extensionOrigin);
    return { dispose };
}

if (typeof document !== 'undefined') {
    const api = globalThis.browser || globalThis.chrome;
    if (api?.runtime?.getURL) {
        const url = new URL(api.runtime.getURL(''));
        installInstagramDisplay(document, `${url.protocol}//${url.host}`);
    }
}
