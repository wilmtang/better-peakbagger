// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { peakbaggerCloudflare as Cloudflare } from '../../src/peakbagger/peakbagger-cloudflare.js';
import { walkFiles } from '../helpers/walk-files.mjs';

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

test('runtime Cloudflare signatures and Peakbagger human-check copy remain centralized', async () => {
    const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
    const files = (await walkFiles(sourceRoot, file => file.endsWith('.js')))
        .filter(file => !['peakbagger-cloudflare.js', 'provider-response.js'].includes(path.basename(file)));
    const source = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
    assert.doesNotMatch(source, /cf-mitigated|_cf_chl_opt|cf-chl-|challenge-platform|Just a moment/);
    assert.doesNotMatch(source, /Peakbagger is asking for a human check|Complete check on Peakbagger/);

    const providerClassifier = await readFile(
        fileURLToPath(new URL('../../src/capture/provider-response.js', import.meta.url)),
        'utf8',
    );
    assert.match(providerClassifier, /cf-mitigated/,
        'the provider boundary owns its separate documented response marker');
    assert.doesNotMatch(providerClassifier, /Peakbagger is asking for a human check|Complete check on Peakbagger/);
});
