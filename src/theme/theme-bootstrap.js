// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The site theme has a deliberately tiny first stage. Chromium can paint a
// cache-served Peakbagger page before the full settings/theme bundle has been
// parsed, so this module owns only the synchronous page-local mirror and a
// temporary neutral-dark fallback. The full theme replaces the fallback after
// its complete stylesheet and dynamic color watcher are ready.

export const THEME_CACHE_KEY = 'bpbThemePref';
export const EARLY_THEME_STYLE_ID = 'bpb-site-dark-fallback';

const earlyDarkCss = `
html[data-bpb-theme="dark"] {
    color-scheme: dark !important;
    background: #181a1b !important;
}
html[data-bpb-theme="dark"] body,
html[data-bpb-theme="dark"] body :not(iframe) {
    background-color: #181a1b !important;
    border-color: #3a3f45 !important;
    color: #e6e1d8 !important;
}
html[data-bpb-theme="dark"] body {
    background-image: none !important;
}
`;

export const readThemeMirror = storage => {
    try {
        return storage?.getItem(THEME_CACHE_KEY) ?? null;
    } catch {
        return null;
    }
};

export const applyEarlyTheme = ({
    document,
    resolveTheme,
    storage = globalThis.localStorage,
} = {}) => {
    const root = document?.documentElement;
    if (!root || typeof resolveTheme !== 'function') return null;

    const theme = resolveTheme(readThemeMirror(storage));
    if (theme === 'dark' && !document.getElementById(EARLY_THEME_STYLE_ID)) {
        const style = document.createElement('style');
        style.id = EARLY_THEME_STYLE_ID;
        style.textContent = earlyDarkCss;
        // The stylesheet must exist before the marker that activates it.
        root.appendChild(style);
    }
    root.setAttribute('data-bpb-theme', theme);
    return theme;
};
