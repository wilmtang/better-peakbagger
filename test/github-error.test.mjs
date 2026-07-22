// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { githubError as GithubError } from '../src/github-error.js';
import { githubErrors as GithubErrors } from '../src/github-errors.js';

test('every typed GitHub auth and backup failure has specific user-facing copy', () => {
    const codes = new Set([
        ...Object.values(GithubErrors.ERROR_CODES),
        'no-token', 'not-connected', 'no-repo', 'no-data', 'disabled',
    ]);
    for (const code of codes) {
        const text = GithubError.message({ code, message: 'GitHub supplied this exact detail.' });
        assert.ok(text.length > 20, `${code} must explain the failure`);
        assert.doesNotMatch(text, /something went wrong/i, `${code} must not use vague catch-all copy`);
    }
});

test('unexpected GitHub details are normalized, bounded, and shown as plain text', () => {
    assert.equal(
        GithubError.message({ code: 'unknown', message: '  Service   temporarily\n unavailable.  ' }),
        'GitHub reported: Service temporarily unavailable.',
    );
    const bounded = GithubError.message({ code: 'invalid', message: 'x'.repeat(500) });
    assert.ok(bounded.endsWith('…'));
    assert.ok(bounded.length < 260);
    assert.equal(
        GithubError.message({ code: 'unknown', message: '<!doctype html><title>Gateway error</title>' }),
        'GitHub did not return an error description. Reload the page and try again.',
    );
});
