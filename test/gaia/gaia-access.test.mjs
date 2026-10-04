// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COPY_FILES } from '../../scripts/build-config.mjs';

test('access pages share Gaia packaged theme tokens rather than defining another palette', async () => {
    assert.ok(COPY_FILES.some(entry => entry[1] === 'css/gaia-access.css'));
    const css = await readFile(new URL('../../src/gaia/access.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /--(?:light|dark)-(?:bg|card|border|text|accent)/);
});
