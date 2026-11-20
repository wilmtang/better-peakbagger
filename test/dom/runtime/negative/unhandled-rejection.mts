// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runner self-check: an unhandled rejection must fail the run.
import test from 'node:test';

test('leaves a rejection unhandled', async () => {
    void Promise.reject(new Error('unhandled'));
    await new Promise(resolve => setTimeout(resolve, 50));
});
