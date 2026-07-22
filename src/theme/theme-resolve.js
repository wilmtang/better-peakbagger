// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const DARK_QUERY = '(prefers-color-scheme: dark)';

const resolve = (preference, matchMedia = null) => {
    if (preference === 'light' || preference === 'dark') return preference;
    try {
        const readSystemTheme = typeof matchMedia === 'function'
            ? matchMedia
            : (typeof globalThis.matchMedia === 'function'
                ? query => globalThis.matchMedia(query)
                : null);
        return readSystemTheme && readSystemTheme(DARK_QUERY).matches ? 'dark' : 'light';
    } catch {
        return 'light';
    }
};

export const themeResolve = { resolve };
