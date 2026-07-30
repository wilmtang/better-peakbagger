// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { githubError as GithubError } from '../../src/github/github-error-copy.js';
import { githubErrors as GithubErrors } from '../../src/github/github-errors.js';

test('every typed GitHub auth and backup failure has specific user-facing copy', () => {
    const codes = new Set([
        ...Object.values(GithubErrors.ERROR_CODES),
        'no-token', 'not-connected', 'no-repo', 'no-data', 'settings-unavailable', 'disabled',
    ]);
    for (const code of codes) {
        const text = GithubError.message({ code, message: 'GitHub supplied this exact detail.' });
        assert.ok(text.length > 20, `${code} must explain the failure`);
        assert.doesNotMatch(text, /something went wrong/i, `${code} must not use vague catch-all copy`);
    }
});

test('a GitHub outage reads as an outage, not as a page worth reloading', () => {
    // The regression this pins: 5xx used to classify as `unknown`, and GitHub
    // answers an outage with an HTML page that the detail cleaner strips — so
    // the user was told to reload a page GitHub could not serve either way.
    assert.equal(
        GithubError.message({ code: 'server', status: 502, message: '<html>Bad gateway</html>' }),
        'GitHub is temporarily unavailable (HTTP 502). Try again in a few minutes.',
    );
    assert.equal(
        GithubError.message({ code: 'server', message: '' }),
        'GitHub is temporarily unavailable. Try again in a few minutes.',
    );
});

test('a rate limit says when to come back whenever GitHub states the window', () => {
    assert.equal(
        GithubError.message({ code: 'rate-limit', retryAfterSeconds: 1800 }),
        'GitHub is rate-limiting requests. Try again in about 30 minutes.',
    );
    assert.equal(
        GithubError.message({ code: 'rate-limit', retryAfterSeconds: 3600 }),
        'GitHub is rate-limiting requests. Try again in about an hour.',
    );
    assert.equal(
        GithubError.message({ code: 'rate-limit', retryAfterSeconds: 45 }),
        'GitHub is rate-limiting requests. Try again in about a minute.',
    );
    // Without a stated window the copy must not invent one.
    assert.equal(
        GithubError.message({ code: 'rate-limit' }),
        'GitHub is temporarily rate-limiting requests. Wait a few minutes, then try again.',
    );
});

test('a timed-out write never claims nothing was saved', () => {
    const text = GithubError.message({ code: 'timeout' });
    assert.match(text, /took too long/i);
    assert.doesNotMatch(text, /nothing was (saved|changed|committed)/i);
});

test('settings-read failures never expose storage exception details', () => {
    assert.equal(
        GithubError.message({
            code: 'settings-unavailable',
            message: 'SYNC_SETTINGS_EXCEPTION_SENTINEL',
        }),
        'Settings could not be read, so no backup was changed.',
    );
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
