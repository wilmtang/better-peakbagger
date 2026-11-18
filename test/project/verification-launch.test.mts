// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    chromeLaunchOptions, firefoxLaunchOptions, PEAKBAGGER_HOST_RULE,
} from '../../scripts/verification-launch.mts';

test('Chrome launches use Chrome for Testing in new headless with exclusive extension and host flags', () => {
    assert.deepEqual(chromeLaunchOptions({
        extension: '/tmp/dist', hosts: [PEAKBAGGER_HOST_RULE, 'tiles.example.com 127.0.0.1:9000'],
        trustArgs: ['--trust'], args: ['--no-proxy-server'], viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
    }), {
        channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: ['--trust', '--no-proxy-server',
            '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1,MAP tiles.example.com 127.0.0.1:9000',
            '--disable-extensions-except=/tmp/dist', '--load-extension=/tmp/dist'],
    });
});

test('an exact Chrome binary replaces the channel, and nothing is added when nothing is asked for', () => {
    assert.deepEqual(chromeLaunchOptions({ chromeBinary: '/opt/chrome-128' }), {
        executablePath: '/opt/chrome-128', headless: true, args: [],
    });
    assert.deepEqual(chromeLaunchOptions({}), { channel: 'chromium', headless: true, args: [] });
});

test('Firefox launches resolve the Peakbagger host locally and keep caller preferences', () => {
    assert.deepEqual(firefoxLaunchOptions({ firefoxUserPrefs: { 'webgl.disable-angle': false } }), {
        headless: true, ignoreHTTPSErrors: true,
        firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com', 'webgl.disable-angle': false },
    });
    assert.deepEqual(firefoxLaunchOptions({ localDomains: [] }).firefoxUserPrefs, {});
});

test('the shared launcher runs the Seatbelt preflight before every Chrome launch', async () => {
    const source = await readFile(new URL('../../scripts/verification-launch.mts', import.meta.url), 'utf8');
    const launch = source.indexOf('chromium.launchPersistentContext(');
    assert.notEqual(launch, -1);
    assert.match(source.slice(Math.max(0, launch - 180), launch), /assertChromeLaunchAllowed\(\);/);
});
