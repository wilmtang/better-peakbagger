// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFormattingLocale } from '../../scripts/verify-peak-weather-interactions.mjs';

test('the formatting probe accepts a browser omitting its default region', () => {
    for (const [actual, expected] of [['en', 'en-US'], ['de', 'de-DE'], ['en-US', 'en-US']]) {
        assertFormattingLocale(actual, expected);
    }
    const clock = locale => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
        .format(new Date('2026-07-12T21:45:00Z'));
    assert.equal(clock('en'), clock('en-US'));
    assert.notEqual(clock('en'), clock('en-GB'));
});

test('different regions, scripts, languages and formatting extensions still fail', () => {
    for (const [actual, expected] of [
        ['en-GB', 'en-US'], ['fr-CA', 'fr-FR'], ['de', 'en-US'],
        ['sr-Latn', 'sr-Cyrl'], ['en-US-u-hc-h23', 'en-US'],
    ]) {
        assert.throws(() => assertFormattingLocale(actual, expected), /real browser formatting locale/);
    }
});
