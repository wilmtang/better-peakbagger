// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runner self-check: a hung after hook must fail the run rather than hang it.
import test from 'node:test';

test('hangs in an after hook', { timeout: 200 }, t => { t.after(() => new Promise(() => {})); });
