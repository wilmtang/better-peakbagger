// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ResolvedTheme = 'light' | 'dark';
export type ThemeMediaMatcher = (query: string) => { matches: boolean };

const DARK_QUERY = '(prefers-color-scheme: dark)';

const resolve = (
    preference: unknown,
    matchMedia: ThemeMediaMatcher | null = null,
): ResolvedTheme => {
    if (preference === 'light' || preference === 'dark') return preference;
    try {
        const readSystemTheme: ThemeMediaMatcher | null = typeof matchMedia === 'function'
            ? matchMedia
            : (typeof globalThis.matchMedia === 'function'
                ? (query: string) => globalThis.matchMedia(query)
                : null);
        return readSystemTheme && readSystemTheme(DARK_QUERY).matches ? 'dark' : 'light';
    } catch {
        return 'light';
    }
};

export const themeResolve = { resolve };
