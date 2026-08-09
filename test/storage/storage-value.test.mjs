// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { storageValue as StorageValue } from '../../src/storage/storage-value.js';

test('storage value equality is semantic for JSON-shaped records', () => {
    assert.equal(StorageValue.same(
        { token: 'same', repo: { owner: 'ada', name: 'peaks' }, scopes: ['read', 'write'] },
        { scopes: ['read', 'write'], repo: { name: 'peaks', owner: 'ada' }, token: 'same' }
    ), true);
    assert.equal(StorageValue.same(
        { token: 'same', repo: { owner: 'ada', name: 'peaks' }, scopes: ['read', 'write'] },
        { token: 'newer', repo: { owner: 'ada', name: 'peaks' }, scopes: ['read', 'write'] }
    ), false);
    assert.equal(StorageValue.same(['read', 'write'], ['write', 'read']), false);
    assert.equal(StorageValue.same(null, {}), false);
});
