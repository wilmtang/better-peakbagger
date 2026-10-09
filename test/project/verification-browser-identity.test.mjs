// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVerificationBrowser, playwrightChromiumVersion } from '../../scripts/verification-browser-identity.mjs';

const firefox = { name: 'firefox', version: '157.0.1', expectedName: 'firefox', expectedVersion: '157.0.1' };

test('the live version must match the installed browser, including patch versions', () => {
    assert.match(assertVerificationBrowser(firefox), /matches installed/);
    assert.throws(() => assertVerificationBrowser({ ...firefox, version: '154.0' }), /launched 154/);
    assert.throws(() => assertVerificationBrowser({ ...firefox, version: '157.0.2' }), /launched 157.0.2/);
    assert.throws(() => assertVerificationBrowser({ ...firefox, name: 'chrome' }), /launched chrome/);
    assert.doesNotThrow(() => assertVerificationBrowser({ ...firefox, version: '152.0', expectedVersion: '152.0.0' }));
});

test('missing or nonnumeric version contracts fail closed in CI', () => {
    assert.throws(() => assertVerificationBrowser({ ...firefox, expectedVersion: '', required: true }), /CI requires/);
    for (const version of ['latest', '', '157.0.1extra', undefined]) {
        assert.throws(() => assertVerificationBrowser({ ...firefox, version }), /Invalid/);
        if (version) assert.throws(() => assertVerificationBrowser({ ...firefox, expectedVersion: version }), /Invalid/);
    }
    assert.match(assertVerificationBrowser({ ...firefox, expectedVersion: undefined, required: false }), /observed locally/);
});

test('Chrome identity comes from the locked full Chromium metadata, never headless shell', () => {
    assert.equal(playwrightChromiumVersion({ browsers: [
        { name: 'chromium-headless-shell', browserVersion: '99.0.0.1' },
        { name: 'chromium', browserVersion: '153.0.8010.12' },
    ] }), '153.0.8010.12');
    assert.throws(() => playwrightChromiumVersion({ browsers: [] }), /Invalid/);
});
