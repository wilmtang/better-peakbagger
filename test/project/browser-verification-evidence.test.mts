// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixtureEvidenceUrl, retainBrowserFailure, verificationScreenshots, watchFixtureRequests } from '../../scripts/browser-verification-evidence.mts';

// The evidence helpers are JavaScript whose parameter types are inferred from
// their defaults; these are the option bags and arguments the tests exercise.
const retain = retainBrowserFailure as unknown as (options: Record<string, unknown>) => Promise<void>;
const evidenceUrl = fixtureEvidenceUrl as (value: string, fixtureOrigin: string, extensionBaseUrl?: string | null) => string | null;
interface ScreenshotOptions { mask: unknown[]; fullPage: boolean }

test('reference mode suppresses passing intermediate screenshots without disabling reference captures', () => {
    assert.equal(verificationScreenshots('references')(), false);
    assert.equal(verificationScreenshots('references')(true), true);
    assert.equal(verificationScreenshots('failure')(true), false);
    assert.equal(verificationScreenshots('all')(), true);
    assert.throws(() => verificationScreenshots('typo'), /Unknown verification screenshot mode/);
});

test('explicit Firefox screenshot transport is restricted to the fixture origin', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-fixture-evidence-'));
    const captures: string[] = [];
    try {
        for (const url of [`${origin}/peak.aspx`, 'https://live.example/peak.aspx', 'moz-extension://verification-only/options/options.html']) {
            await retain({ directory, fixtureOrigin: origin, extensionBaseUrl: 'moz-extension://verification-only/',
                fixtureScreenshot: async (file: string) => captures.push(file), driver: {
                    getCapabilities: async () => ({ getBrowserVersion: () => '158' }),
                    getCurrentUrl: async () => url, executeScript: async () => ({ readyState: 'complete' }),
                } });
        }
        assert.deepEqual(captures, [path.join(directory, 'failed-page.png')]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

const origin = 'https://www.peakbagger.com:12345';

test('failure evidence excludes other origins and URL credentials, queries, and fragments', () => {
    assert.equal(evidenceUrl(`${origin}/climber/ascentedit.aspx?token=secret#private`, origin),
        `${origin}/climber/ascentedit.aspx`);
    assert.equal(evidenceUrl('https://user:password@www.peakbagger.com:12345/a', origin), `${origin}/a`);
    assert.equal(evidenceUrl('https://www.peakbagger.com/a', origin), null);
    assert.equal(evidenceUrl('https://connect.garmin.com/modern/activity/1', origin), null);
    assert.equal(evidenceUrl('not a URL', origin), null);
});

test('Firefox failure evidence includes only the identified isolated extension without URL secrets', async () => {
    const extensionBaseUrl = 'moz-extension://verification-only/';
    const target = `${extensionBaseUrl}options/options.html`;
    assert.equal(evidenceUrl(`${target}?token=secret#github`, origin, extensionBaseUrl), target);
    assert.equal(evidenceUrl('moz-extension://another-extension/options/options.html', origin, extensionBaseUrl), null);
    assert.equal(evidenceUrl('chrome-extension://verification-only/options/options.html', origin, extensionBaseUrl), null);
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-extension-evidence-'));
    try {
        await retain({ directory, fixtureOrigin: origin, extensionBaseUrl, driver: {
            getCapabilities: async () => ({ getBrowserVersion: () => '157' }),
            getCurrentUrl: async () => `${target}?token=secret#github`,
            executeScript: async () => ({ readyState: 'complete', formFields: 17 }),
            takeScreenshot: () => assert.fail('unmasked extension screenshot'),
        } });
        const evidence = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
        assert.equal(evidence.pages[0].url, target);
        assert.equal(evidence.pages[0].state.formFields, 17);
        assert.doesNotMatch(JSON.stringify(evidence), /secret|token|github/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('pending and failed request evidence remains bounded without storing requests or bodies', () => {
    const context = new EventEmitter();
    const read = watchFixtureRequests(context, origin);
    const requests = Array.from({ length: 100 }, (_, index) => ({
        url: () => `${origin}/image-${index}?secret=private`, resourceType: () => 'image',
        postData: () => { throw new Error('must not read a body'); },
    }));
    for (const request of requests) context.emit('request', request);
    assert.equal(read().pending.length, 64);
    context.emit('requestfinished', requests[0]);
    for (const request of requests) context.emit('requestfailed', request);
    assert.equal(read().pending.length, 0);
    assert.equal(read().failed.length, 32);
    assert.doesNotMatch(JSON.stringify(read()), /secret|private|postData/);
});

test('an inaccessible page cannot block evidence for other pages or teardown', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-evidence-'));
    let screenshotOptions: ScreenshotOptions | undefined;
    const page = {
        url: () => `${origin}/ok?secret=private`,
        evaluate: async () => ({ readyState: 'complete', canvases: 1 }),
        locator: (selector: string) => selector,
        screenshot: async (options: ScreenshotOptions) => { screenshotOptions = options; },
    };
    try {
        await retain({ directory, fixtureOrigin: origin, timeoutMs: 20, context: {
            browser: () => ({ version: () => 'test browser' }),
            pages: () => [
                { ...page, url: () => `${origin}/hung`, evaluate: () => new Promise(() => {}) },
                { ...page, url: () => 'https://live.example/private', evaluate: () => assert.fail('live page') },
                page,
            ],
        } });
        const evidence = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
        assert.equal(evidence.pages.length, 2);
        assert.equal(evidence.pages[0].inaccessible, true);
        assert.equal(evidence.pages[1].state.canvases, 1);
        assert.deepEqual(screenshotOptions!.mask, ['input,textarea,[contenteditable]']);
        assert.equal(screenshotOptions!.fullPage, false);
        assert.doesNotMatch(JSON.stringify(evidence), /secret|private|live\.example/);
        // A destination write failure also resolves: the caller's primary
        // error remains the one supplied to its resource-stack teardown.
        await retain({ directory: path.join(directory, 'state.json'), context: {} });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('Firefox evidence retains structural state without screenshotting form values', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-firefox-evidence-'));
    try {
        await retain({ directory, fixtureOrigin: origin, driver: {
            getCapabilities: async () => ({ getBrowserVersion: () => '157' }),
            getCurrentUrl: async () => `${origin}/edit?secret=private`,
            executeScript: async () => ({ readyState: 'interactive', formFields: 12 }),
            takeScreenshot: () => assert.fail('unmasked screenshot'),
        } });
        const evidence = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
        assert.equal(evidence.browser, '157');
        assert.equal(evidence.pages[0].state.formFields, 12);
        assert.doesNotMatch(JSON.stringify(evidence), /secret|private/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('CI preserves pipeline failures and uploads bounded browser evidence only on failure', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
    assert.match(workflow, /defaults:\s+run:\s+shell: bash/);
    assert.equal(workflow.match(/name: Retain browser failure evidence\s+if: failure\(\)/g)?.length, 7);
    assert.equal(workflow.match(/BPB_VERIFY_ARTIFACTS: browser-evidence/g)?.length, 8);
    assert.match(workflow, /npm run verify -- terrain chrome browser-evidence\/terrain 2>&1 \| tee/);
    assert.doesNotMatch(workflow, /continue-on-error: true/);
});
