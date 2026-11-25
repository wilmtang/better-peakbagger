// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mts';

for (const id of ['gaia', 'onx', 'alltrails', 'caltopo']) {
    test(`${id} packages the access page with its synchronous theme first`, async () => {
        const html = await readFile(new URL(`../../src/${id}/access.html`, import.meta.url), 'utf8');
        assert.deepEqual(ENTRIES.find(entry => entry.out === `${id}/access.js`)?.sources,
            [`${id}/${id}-import.ts`, `${id}/access.ts`]);
        assert.deepEqual(ENTRIES.find(entry => entry.out === `${id}/access-head.js`)?.sources,
            ['settings/settings-schema.ts', 'settings/settings.ts', 'theme/panel-theme.ts']);
        assert.ok(COPY_FILES.some(entry => entry[1] === `${id}/access.html`));
        assert.match(html, /<script src="access-head\.js"><\/script>\s*<link rel="stylesheet" href="\.\.\/css\/panel\.css">/);
    });
}
