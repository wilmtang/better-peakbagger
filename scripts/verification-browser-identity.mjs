// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Compare the live browser, not its installer log. Firefox may otherwise be
// discovered from a preinstalled runner binary despite a successful setup step.
function normalizedVersion(value) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(value)) {
        throw new Error(`Invalid verification browser version: ${JSON.stringify(value)}`);
    }
    const parts = value.split('.').map(Number);
    while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
    return parts.join('.');
}

export function assertVerificationBrowser({ name, version, expectedName, expectedVersion,
    required = Boolean(process.env.CI) }) {
    if (name !== expectedName) throw new Error(`Expected ${expectedName}, launched ${name}`);
    const actual = normalizedVersion(version);
    if (!expectedVersion) {
        if (required) throw new Error(`CI requires an exact expected ${expectedName} version`);
        return `${name} ${version} (observed locally; no expected version supplied)`;
    }
    if (actual !== normalizedVersion(expectedVersion)) {
        throw new Error(`Expected ${expectedName} ${expectedVersion}, launched ${version}`);
    }
    return `${name} ${version} (matches installed ${expectedVersion})`;
}

export function playwrightChromiumVersion(metadata) {
    const version = metadata?.browsers?.find(browser => browser.name === 'chromium')?.browserVersion;
    normalizedVersion(version);
    return version;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    if (process.argv[2] !== '--playwright-chromium' || process.argv.length !== 3) {
        throw new Error('Usage: verification-browser-identity.mjs --playwright-chromium');
    }
    const require = createRequire(import.meta.url);
    const metadataPath = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
    console.log(`BPB_EXPECT_CHROME_VERSION=${playwrightChromiumVersion(JSON.parse(readFileSync(metadataPath, 'utf8')))}`);
}
