// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { peakbaggerCloudflare as Cloudflare } from '../src/peakbagger-cloudflare.js';

test('managed-challenge detection matches peakbagger-cli response evidence', () => {
    assert.equal(Cloudflare.isManagedChallenge(403, { 'cf-mitigated': 'challenge' }, '<html/>'), true);
    assert.equal(Cloudflare.isManagedChallenge(
        403, {}, '<html><title>Just a moment...</title></html>'
    ), true);

    assert.equal(Cloudflare.isManagedChallenge(
        200,
        { 'cf-mitigated': 'challenge' },
        '<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>'
    ), false, 'Cloudflare metadata cannot turn a successful response into a challenge');
    assert.equal(Cloudflare.isManagedChallenge(403, {}, '<html><h1>Forbidden</h1></html>'), false,
        'a bare 403 remains an ordinary HTTP failure');
    assert.equal(Cloudflare.isManagedChallenge(
        403, {}, `${'x'.repeat(Cloudflare.BODY_PROBE_LENGTH)}Just a moment`
    ), false, 'the body fallback is deliberately bounded like peakbagger-cli');
});

test('human-check copy and recovery action have one owner', () => {
    assert.match(Cloudflare.copy.message, /asking for a human check/i);
    assert.deepEqual(Cloudflare.recovery({ url: 'https://www.peakbagger.com/peak.aspx?pid=1' }), {
        label: 'Complete check on Peakbagger',
        href: 'https://www.peakbagger.com/peak.aspx?pid=1',
    });
});

test('runtime Cloudflare signatures and human-check copy remain centralized', async () => {
    const files = (await readdir(new URL('../src/', import.meta.url)))
        .filter(name => name.endsWith('.js') && name !== 'peakbagger-cloudflare.js');
    const source = (await Promise.all(files.map(name =>
        readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')))).join('\n');
    assert.doesNotMatch(source, /cf-mitigated|_cf_chl_opt|cf-chl-|challenge-platform|Just a moment/);
    assert.doesNotMatch(source, /Peakbagger is asking for a human check|Complete check on Peakbagger/);
});
