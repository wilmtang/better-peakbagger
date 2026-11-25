// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('shared panels and the source editor paint the root and contain their actual scroll containers', async () => {
    const panel = await readFile(new URL('../../src/theme/panel.css', import.meta.url), 'utf8');
    const editor = await readFile(new URL('../../src/maps/custom-overlay-editor.css', import.meta.url), 'utf8');
    assert.match(panel, /html\s*\{[^}]*background:\s*var\(--bg\)[^}]*overscroll-behavior-y:\s*none/);
    assert.match(panel, /\.content,\s*\.side-nav\s*\{\s*overscroll-behavior-y:\s*none/);
    assert.match(editor, /html\s*\{[^}]*background:\s*var\(--paper\)[^}]*overscroll-behavior-y:\s*none/);
});
