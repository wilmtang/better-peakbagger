// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    COPIED_RUNTIME_PACKAGES,
    copiedRuntimeChanged,
    copiedRuntimeVersions,
} from '../../scripts/copied-runtime-impact.mjs';

const lock = (overrides = {}) => ({
    packages: Object.fromEntries(COPIED_RUNTIME_PACKAGES.map((packageName) => [
        `node_modules/${packageName}`,
        { version: overrides[packageName] || '1.0.0' },
    ])),
});

test('copied runtime impact compares only resolved shipped versions', () => {
    assert.equal(copiedRuntimeChanged(lock(), lock()), false);
    for (const packageName of COPIED_RUNTIME_PACKAGES) {
        assert.equal(copiedRuntimeChanged(lock(), lock({ [packageName]: '1.0.1' })), true,
            `${packageName} changes must trigger GPU checks`);
    }

    const unrelated = lock();
    unrelated.packages['node_modules/eslint'] = { version: '99.0.0' };
    assert.equal(copiedRuntimeChanged(lock(), unrelated), false);
});

test('adding or removing a copied runtime is treated as a runtime change', () => {
    const removed = lock();
    delete removed.packages['node_modules/marked'];
    assert.equal(copiedRuntimeChanged(lock(), removed), true);
    assert.equal(copiedRuntimeVersions(removed).marked, null);
    assert.throws(() => copiedRuntimeVersions({}), /no packages inventory/);
});
