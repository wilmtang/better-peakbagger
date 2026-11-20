// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runner self-check: a file that throws while loading must fail the run.
import test from 'node:test';

test('never runs', () => {});
throw new Error('load failure');
