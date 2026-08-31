// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixtureCertificate } from '../../scripts/browser-verification-fixtures.mjs';
import {
    closeServer,
    createResourceStack,
    listenServer,
    manageChildProcess,
    quitWebDriver,
} from '../../scripts/resource-stack.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('verifier resources clean up LIFO and one rejection cannot skip the rest', async () => {
    const order = [];
    const resources = createResourceStack();
    resources.defer('first', () => { order.push('first'); });
    resources.defer('rejecting', () => {
        order.push('rejecting');
        throw new Error('blocked');
    });
    resources.defer('last', () => { order.push('last'); });

    await assert.rejects(resources.dispose(), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /rejecting/);
        assert.match(
            error.message,
            /One or more verifier resources failed to clean up:\n- Cleanup failed for rejecting: blocked/,
        );
        return true;
    });
    assert.deepEqual(order, ['last', 'rejecting', 'first']);
});

test('cleanup failures annotate but never replace the primary verifier failure', async () => {
    const primary = new Error('assertion failed');
    const resources = createResourceStack();
    resources.defer('broken finalizer', async () => { throw new Error('cleanup failed'); });

    await assert.rejects(resources.dispose(primary), error => {
        assert.equal(error, primary);
        assert.match(error.message, /^assertion failed/);
        assert.equal(error.cleanupErrors.length, 1);
        return true;
    });
});

test('a hanging finalizer times out without blocking later cleanup', async () => {
    const order = [];
    const resources = createResourceStack({ finalizerTimeoutMs: 20 });
    resources.defer('later', () => { order.push('later'); });
    resources.defer('hung', () => new Promise(() => {}));
    resources.defer('earlier', () => { order.push('earlier'); });

    await assert.rejects(resources.dispose(), error => {
        assert.match(error.errors[0].message, /hung cleanup did not finish/);
        return true;
    });
    assert.deepEqual(order, ['earlier', 'later']);
});

test('an invalid child path is contained and leaves other resources cleanable', async () => {
    const resources = createResourceStack();
    const order = [];
    resources.defer('outer', () => { order.push('outer'); });
    const child = spawn('/definitely-not-a-better-peakbagger-browser');
    const childState = manageChildProcess(resources, child, 'invalid browser');
    await new Promise(resolve => child.once('close', resolve));

    assert.match(childState.error?.message || '', /ENOENT/);
    await resources.dispose();
    assert.deepEqual(order, ['outer']);
});

test('a child that ignores termination cannot skip later cleanup', async () => {
    const resources = createResourceStack();
    const order = [];
    resources.defer('outer', () => { order.push('outer'); });
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 12345;
    child.kill = signal => {
        order.push(signal);
        return true;
    };
    manageChildProcess(resources, child, 'hung browser', { graceMs: 5 });

    await assert.rejects(resources.dispose(), error => {
        assert.match(error.errors[0].message, /did not exit after SIGKILL/);
        return true;
    });
    assert.deepEqual(order, ['SIGTERM', 'SIGKILL', 'outer']);
});

test('quitting an already-closed WebDriver session is idempotent', async () => {
    await quitWebDriver({
        quit: async () => {
            throw new Error('WebDriver session does not exist, or is not active');
        },
    });
    await assert.rejects(quitWebDriver({
        quit: async () => { throw new Error('geckodriver connection failed'); },
    }), /geckodriver connection failed/);
});

test('invalid OpenSSL and certificate reads leave no key material behind', async t => {
    await t.test('owned directory after invalid OpenSSL path', async () => {
        const label = `resource-stack-${process.pid}-${Date.now()}`;
        await assert.rejects(createFixtureCertificate({
            label,
            opensslPath: '/definitely-not-openssl',
        }), /Could not create/);
        const leftovers = (await readdir(tmpdir()))
            .filter(name => name.startsWith(`better-peakbagger-${label}-cert-`));
        assert.deepEqual(leftovers, []);
    });

    await t.test('invalid OpenSSL path', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'bpb-cert-open-'));
        try {
            await assert.rejects(createFixtureCertificate({
                directory,
                opensslPath: '/definitely-not-openssl',
            }), /Could not create/);
            assert.deepEqual(await readdir(directory), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    await t.test('certificate read failure', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'bpb-cert-read-'));
        try {
            await assert.rejects(createFixtureCertificate({
                directory,
                readCertificate: async () => { throw new Error('injected read failure'); },
            }), /injected read failure/);
            assert.deepEqual(await readdir(directory), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

test('a listen failure is observable and the failed server remains cleanable', async () => {
    const server = createServer();
    await assert.rejects(listenServer(server, 0, 'not-a-real-bpb-host.invalid'));
    await closeServer(server);
    assert.equal(server.listening, false);
});

test('browser verifiers use the shared resource stack and condition-based analyzer readiness', async () => {
    const verifierPaths = [
        'scripts/verify-extension.mjs',
        'scripts/verify-firefox-extension.mjs',
        'scripts/verify-firefox-terrain.mjs',
        'scripts/verify-terrain-lod.mjs',
        'scripts/verify-terrain-visual.mjs',
        'scripts/render-showcase.mjs',
    ];
    const sources = await Promise.all(verifierPaths.map(async verifierPath => ({
        verifierPath,
        source: await readFile(path.join(projectRoot, verifierPath), 'utf8'),
    })));
    for (const { verifierPath, source } of sources) {
        assert.match(source, /createResourceStack\(/, `${verifierPath} must own resources through the shared stack`);
    }

    const chromeVerifier = sources.find(entry => entry.verifierPath === 'scripts/verify-extension.mjs').source;
    assert.doesNotMatch(chromeVerifier, /waitForTimeout\(2_?000\)/);
    const workerProbeEnd = chromeVerifier.indexOf('// --- Extension-owned photo editor');
    assert.notEqual(workerProbeEnd, -1);
    const workerProbe = chromeVerifier.slice(0, workerProbeEnd);
    assert.match(workerProbe,
        /if \(!extensionId\) \{[\s\S]*chrome:\/\/extensions-internals\/[\s\S]*location === 'COMMAND_LINE'[\s\S]*disable_reasons\?\.length === 0/,
        'a quiet MV3 worker must be addressed through Chrome\'s actual command-line extension registry');
    assert.match(workerProbe,
        /registeredPath = await realpath\(extensionRecord\.path\)[\s\S]*expectedPath = await realpath\(dist\)[\s\S]*registeredPath === expectedPath/,
        'the registry path must be canonicalized before comparing macOS /private/var and /var aliases');
    assert.ok(workerProbe.indexOf("chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS'")
        < workerProbe.indexOf("check(!!worker, 'the extension service worker never started after a coordinator message')"),
    'the verifier must send a real coordinator message before requiring the lazy worker target');
    assert.match(chromeVerifier, /waitForFunction\([\s\S]*Interactive Stats:/);
    assert.match(chromeVerifier,
        /name: 'Restore draft'[\s\S]{0,900}markdownVisible[\s\S]{0,500}restoring the draft did not reach a visible Markdown editor/,
        'draft recovery must reach its visible Markdown postcondition before the verifier types into CodeMirror');
    assert.match(chromeVerifier,
        /disabledFrameElement\.contentFrame\(\)\.locator\('body'\)[\s\S]{0,200}waitFor\(/,
        'the disabled terrain forgery must follow its live frame and accept a browser-level API denial');
    const helperLeaseProbe = chromeVerifier.slice(
        chromeVerifier.indexOf('const helperLeaseState ='),
        chromeVerifier.indexOf('await captureTransportPage.close();'),
    );
    const adoptionFlow = helperLeaseProbe.slice(
        helperLeaseProbe.indexOf('await chrome.tabs.update(transportTab.id, { active: true });'),
        helperLeaseProbe.indexOf('const adoptedLeases ='),
    );
    assert.match(adoptionFlow,
        /transportTab[\s\S]*'durable helper adoption'\);[\s\S]*chrome\.tabs\.update\(optionsTab/,
        'the helper must become durably adopted before the verifier leaves its tab');
    assert.match(chromeVerifier, /current value:/);
    assert.match(chromeVerifier, /priorFailures: \[\.\.\.failures\]/,
        'terminal Chrome readiness errors must retain earlier accumulated surface failures');
    assert.match(chromeVerifier,
        /const mapLayers = [^;]+;[\s\S]{0,320}if \(!Array\.isArray\(mapLayers\)\) return false;/,
        'terminal Analyzer checks must wait for the separately loading map-layer seam');
    const retryProbeStart = chromeVerifier.indexOf('const unavailableCases =');
    const retryProbeEnd = chromeVerifier.indexOf('const offPage = await openAscent();');
    assert.notEqual(retryProbeStart, -1);
    assert.notEqual(retryProbeEnd, -1);
    const retryProbe = chromeVerifier.slice(retryProbeStart, retryProbeEnd);
    assert.ok(retryProbe.indexOf("['retry', /temporarily unavailable/i, true]")
        < retryProbe.indexOf("['signed-out', /sign in/i, true]"),
    'the retry fixture must reuse the first already-injected Analyzer error page');
    assert.match(retryProbe,
        /if \(analyzerCase === 'retry'\) \{[\s\S]*await page\.keyboard\.press\('Enter'\);/,
        'the retry fixture must activate its already-focused proven error control');
    assert.match(retryProbe,
        /const unavailablePage = await context\.newPage\(\);[\s\S]*const page = unavailablePage;/,
        'terminal Analyzer cases must reuse one injected browser target');
    assert.doesNotMatch(retryProbe, /for \([^\n]+unavailableCases\) \{\s*const page = await context\.newPage\(\)/,
        'terminal Analyzer cases must not churn through disposable browser targets');
    assert.doesNotMatch(retryProbe, /openRetryPage|retryPage\.reload/,
        'the retry fixture must not create an unnecessary late target or mask missing injection');
    assert.ok(chromeVerifier.indexOf('await verifyTerminalAnalyzerFailures();')
        > chromeVerifier.indexOf('await sourcePage.close();'),
    'the exhaustive terminal matrix must run after sequential user-flow surfaces');
    const buddyClick = chromeVerifier.indexOf("await optionsPage.locator('#favorites-merge-buddies').click();");
    assert.notEqual(buddyClick, -1);
    const buddyReadiness = chromeVerifier.slice(Math.max(0, buddyClick - 500), buddyClick);
    assert.match(buddyReadiness, /await optionsPage\.bringToFront\(\)/);
    assert.match(buddyReadiness, /chrome\.tabs\.getCurrent\(\)\)\?\.active === true/,
        'the Buddy fallback must start from the active user-visible extension page');
    assert.match(
        chromeVerifier,
        /waitForFunction\([\s\S]*settings-backup-confirmation[\s\S]*settings and saved API keys/,
    );
    const firefoxVerifier = sources.find(
        entry => entry.verifierPath === 'scripts/verify-firefox-extension.mjs'
    ).source;
    assert.match(firefoxVerifier,
        /const profileBackupState = await driver\.wait\(async \(\) => \{[\s\S]*primary === 'Back up all ascents'/,
        'the Firefox profile-backup check must wait for asserted content, not merely its container');
    assert.match(firefoxVerifier,
        /const settingsControl = await driver\.findElement\(By\.css\('\.pbaf-settings-link'\)\);\s*\/\/[\s\S]{0,300}settingsControl\.sendKeys\(Key\.ENTER\)/,
        'the Firefox verifier must not use an intercept-prone element click for initial Settings activation');
    assert.match(firefoxVerifier,
        /const restoredFromBfcache = [\s\S]{0,900}const cleanRemount = [\s\S]{0,700}assertState\(restoredFromBfcache \|\| cleanRemount,/,
        'Firefox history traversal must accept either exact BFCache restoration or one clean remount');
    for (const verifierPath of ['scripts/verify-terrain-lod.mjs', 'scripts/verify-terrain-visual.mjs']) {
        const source = sources.find(entry => entry.verifierPath === verifierPath).source;
        assert.match(source, /manageChildProcess\(resources, chrome/,
            `${verifierPath} must attach a child error boundary before awaiting startup`);
    }
});
