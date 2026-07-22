// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { themeResolve as ThemeResolve } from '../../src/theme/theme-resolve.js';

test('theme resolution preserves explicit preferences and resolves system once', () => {
    const darkSystem = query => ({ matches: query === '(prefers-color-scheme: dark)' });
    const lightSystem = () => ({ matches: false });
    assert.equal(ThemeResolve.resolve('light', darkSystem), 'light');
    assert.equal(ThemeResolve.resolve('dark', lightSystem), 'dark');
    assert.equal(ThemeResolve.resolve('system', darkSystem), 'dark');
    assert.equal(ThemeResolve.resolve(null, lightSystem), 'light');
    assert.equal(ThemeResolve.resolve('system', () => { throw new Error('unavailable'); }), 'light');
});

test('theme consumers delegate instead of keeping local system-resolution copies', async () => {
    const files = [
        '../../src/settings/settings.js',
        '../../src/gpx/gpx-analyzer.js',
        '../../src/maps/big-map.js',
        '../../src/maps/peak-map.js',
    ];
    for (const file of files) {
        const source = await readFile(new URL(file, import.meta.url), 'utf8');
        assert.match(source, /ThemeResolve\.resolve\(/, `${file} must delegate theme resolution`);
        assert.doesNotMatch(source, /prefers-color-scheme:\s*dark/,
            `${file} must not carry its own system-theme query`);
    }
});
