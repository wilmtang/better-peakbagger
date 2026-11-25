// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';

export function required<T>(value: T, message?: string): NonNullable<T> {
    assert.ok(value != null, message);
    return value;
}
