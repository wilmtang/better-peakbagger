// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureDom } from '../helpers/fixture-dom.mts';

import { peakbaggerCloudflare as Cloudflare } from '../../src/peakbagger/peakbagger-cloudflare.ts';

test('document challenge detection uses page evidence, not report prose or background Cloudflare scripts', () => {
    for (const [html, expected] of [
        ['<title>Just a moment...</title>', true],
        ['<title>  just a moment…  </title>', true],
        ['<title>Peakbagger</title><form id="challenge-form"></form>', true],
        ['<title>Peakbagger</title><div id="cf-challenge-running"></div>', true],
        ['<title>Ascent of Mount Rainier</title><p>Just a moment... Cloudflare verified the browser.</p>', false],
        ['<title>Ascent of Mount Rainier</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>', false],
        ['<title>Just a moment on the summit</title>', false],
    ] as const) {
        const env = new FixtureDom(html);
        try { assert.equal(Cloudflare.isChallengeDocument(env.window.document), expected, html); }
        finally { env.window.close(); }
    }
});
