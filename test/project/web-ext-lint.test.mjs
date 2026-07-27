// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    evaluateWebExtLint,
    WEB_EXT_WARNING_BASELINE
} from '../../scripts/check-web-ext-lint.mjs';

const reportFor = warnings => ({
    summary: { errors: 0, notices: 0, warnings: warnings.length },
    errors: [],
    notices: [],
    warnings: warnings.map(({ code, file, line, column }) => ({ code, file, line, column }))
});

test('the web-ext lint gate accepts only exact warning locations with owners', async () => {
    const accepted = evaluateWebExtLint(reportFor(WEB_EXT_WARNING_BASELINE));
    assert.equal(accepted.length, 6);
    assert.ok(accepted.every(warning => warning.owner && warning.reason));

    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(packageJson.scripts.lint,
        'npm run build && node scripts/check-web-ext-lint.mjs');
});

test('the web-ext lint gate rejects new, moved, duplicate, error, and notice output', () => {
    const extra = reportFor([
        ...WEB_EXT_WARNING_BASELINE,
        { code: 'UNSAFE_VAR_ASSIGNMENT', file: 'content/new.js', line: 1, column: 1 }
    ]);
    assert.throws(() => evaluateWebExtLint(extra), /new warnings/);

    const moved = reportFor(WEB_EXT_WARNING_BASELINE.map((warning, index) =>
        index === 1 ? { ...warning, column: warning.column + 1 } : warning));
    assert.throws(() => evaluateWebExtLint(moved), /new warnings.*baseline warnings disappeared or moved/);

    const duplicate = reportFor([...WEB_EXT_WARNING_BASELINE, WEB_EXT_WARNING_BASELINE[0]]);
    assert.throws(() => evaluateWebExtLint(duplicate), /warning count mismatch/);

    assert.throws(() => evaluateWebExtLint({
        ...reportFor(WEB_EXT_WARNING_BASELINE),
        summary: { errors: 1, notices: 0, warnings: 6 },
        errors: [{ code: 'BROKEN' }]
    }), /reported 1 errors/);
    assert.throws(() => evaluateWebExtLint({
        ...reportFor(WEB_EXT_WARNING_BASELINE),
        summary: { errors: 0, notices: 1, warnings: 6 },
        notices: [{ code: 'NEW_NOTICE' }]
    }), /reported 1 unowned notices/);
});
