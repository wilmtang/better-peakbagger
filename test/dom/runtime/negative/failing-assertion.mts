// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runner self-check: a failing assertion must fail the run.
import assert from 'node:assert/strict';
import test from 'node:test';

test('passes', () => {});
test('fails an assertion', () => { assert.deepEqual({ a: 1 }, { a: 2 }); });
