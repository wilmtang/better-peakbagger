// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    evaluateWebExtLint,
    WEB_EXT_WARNING_BASELINE
} from '../../scripts/check-web-ext-lint.mjs';

// web-ext reports one object per occurrence; the baseline collapses repeats of
// one (code, file) into a count. Expand it back, and give each occurrence a
// distinct line/column so the assertions below prove positions are ignored
// rather than merely absent.
const occurrences = (baseline = WEB_EXT_WARNING_BASELINE) => baseline.flatMap(
    ({ code, file, count = 1 }, entryIndex) => Array.from({ length: count }, (_value, index) => ({
        code,
        file,
        line: 100 + entryIndex,
        column: 200 + index
    }))
);

const reportFor = warnings => ({
    summary: { errors: 0, notices: 0, warnings: warnings.length },
    errors: [],
    notices: [],
    warnings
});

test('the web-ext lint gate accepts exactly the owned warnings per file', async () => {
    const accepted = evaluateWebExtLint(reportFor(occurrences()));
    assert.equal(accepted.length, 5);
    assert.equal(accepted.reduce((sum, warning) => sum + warning.count, 0), 8);
    assert.ok(accepted.every(warning => warning.owner && warning.reason));

    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(packageJson.scripts.lint,
        'npm run build && node scripts/check-web-ext-lint.mjs');
});

// The point of dropping line/column: a bundle whose byte offsets moved is not
// a lint regression, and re-baselining one was pure ceremony.
test('the web-ext lint gate ignores generated line and column drift', () => {
    const moved = occurrences().map(warning => ({
        ...warning,
        line: warning.line + 4173,
        column: warning.column + 91
    }));
    assert.equal(evaluateWebExtLint(reportFor(moved)).length, 5);
});

test('the web-ext lint gate rejects new, extra, missing, error, and notice output', () => {
    const extra = reportFor([
        ...occurrences(),
        { code: 'UNSAFE_VAR_ASSIGNMENT', file: 'content/new.js', line: 1, column: 1 }
    ]);
    assert.throws(() => evaluateWebExtLint(extra), /new warnings: UNSAFE_VAR_ASSIGNMENT content\/new\.js \(1, owned 0\)/);

    // One more occurrence in an already-owned file is still a new warning:
    // the count, not the position, is what the baseline promises.
    const duplicate = reportFor([...occurrences(), occurrences()[0]]);
    assert.throws(() => evaluateWebExtLint(duplicate), /new warnings: BACKGROUND_SERVICE_WORKER_IGNORED manifest\.json \(2, owned 1\)/);

    const dropped = reportFor(occurrences().slice(1));
    assert.throws(() => evaluateWebExtLint(dropped), /baseline warnings disappeared: BACKGROUND_SERVICE_WORKER_IGNORED manifest\.json \(0, owned 1\)/);

    // A vendored file that keeps its code but loses one of its occurrences
    // must still fail; collapsing to a per-file boolean would hide it.
    const partial = reportFor(occurrences().filter((warning, index) => index !== 3));
    assert.throws(() => evaluateWebExtLint(partial), /baseline warnings disappeared: UNSAFE_VAR_ASSIGNMENT vendor\/maplibre-gl\.js \(2, owned 3\)/);

    assert.throws(() => evaluateWebExtLint({
        ...reportFor(occurrences()),
        summary: { errors: 1, notices: 0, warnings: 6 },
        errors: [{ code: 'BROKEN' }]
    }), /reported 1 errors/);
    assert.throws(() => evaluateWebExtLint({
        ...reportFor(occurrences()),
        summary: { errors: 0, notices: 1, warnings: 6 },
        notices: [{ code: 'NEW_NOTICE' }]
    }), /reported 1 unowned notices/);
    assert.throws(() => evaluateWebExtLint({
        ...reportFor(occurrences()),
        summary: { errors: 0, notices: 0, warnings: 5 }
    }), /warning count mismatch: summary 5, reported 8/);
});
