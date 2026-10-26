// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Investigation only: synthetic report code/cookies on a local HTTPS fixture.
/* global document, MutationObserver */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrowserFixtureServer, projectRoot } from '../../../../scripts/browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from '../../../../scripts/chrome-launch-guard.mjs';
import { createResourceStack } from '../../../../scripts/resource-stack.mjs';

if (process.argv.length > 2) throw new Error('Usage: node docs/plans/experiments/instagram-report/security-probe.mjs');
const resources = createResourceStack();
try {
    const profile = await mkdtemp(path.join(tmpdir(), 'bpb-report-security-'));
    resources.defer('profile', () => rm(profile, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot: profile });
    resources.defer('fixture', () => fixture.close());
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
        args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1',
            `--disable-extensions-except=${projectRoot}/dist`, `--load-extension=${projectRoot}/dist`],
    });
    resources.defer('browser', () => context.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    await context.addCookies([
        { name: 'bpb_probe', value: 'synthetic', url: origin, secure: true },
        { name: 'bpb_probe_private', value: 'synthetic', url: origin, secure: true, httpOnly: true },
    ]);
    const payload = '<script data-probe>'
        + "document.documentElement.dataset.probeInline='ran';"
        + "document.documentElement.dataset.probeCookie=String(document.cookie.includes('bpb_probe=synthetic'));"
        + "document.documentElement.dataset.probeHttpOnly=String(document.cookie.includes('bpb_probe_private='));"
        + '</script><img src="/probe-missing" onerror="document.documentElement.dataset.probeEvent=\'ran\'">'
        + '<iframe title="Synthetic probe" srcdoc="&lt;script&gt;'
        + "parent.document.documentElement.dataset.probeFrame='ran'&lt;/script&gt;\"></iframe>";
    const html = (await readFile(path.join(projectRoot, 'test/fixtures/pages/ascent-ignored-report.html'), 'utf8'))
        .replace('Synthetic report text', `${payload}Synthetic report text`);
    // No provider, analytics or live Peakbagger requests are allowed.
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.protocol === 'chrome-extension:') return route.continue();
        if (url.origin !== origin) return route.abort();
        if (url.pathname !== '/climber/ascent.aspx') return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'text/html', body: html,
            headers: url.searchParams.get('policy') === 'strict' ? {
                'Content-Security-Policy': "script-src 'none'; object-src 'none'; base-uri 'none'",
            } : {},
        });
    });
    const results = [];
    for (const mode of ['unprotected', 'observer', 'strict']) {
        const page = await context.newPage();
        if (mode === 'observer') await page.addInitScript(() => {
            // Deliberately script-only: test the tempting "remove scripts" fix,
            // without claiming that every possible DOM sanitizer behaves alike.
            new MutationObserver(records => {
                for (const record of records) for (const node of record.addedNodes) {
                    if (node.nodeType === 1 && node.matches('script[data-probe]')) node.remove();
                }
            }).observe(document, { childList: true, subtree: true });
        });
        await page.goto(`${origin}/climber/ascent.aspx?aid=7654321&policy=${mode}`);
        await page.waitForFunction(() => document.readyState === 'complete');
        const result = await page.evaluate(() => ({ ...document.documentElement.dataset,
            probeNode: !!document.querySelector('script[data-probe]') }));
        assert(['light', 'dark'].includes(result.bpbTheme), 'the real extension theme script must run');
        results.push({ mode, inline: result.probeInline || 'blocked',
            cookieReadable: result.probeCookie || 'not read', httpOnlyReadable: result.probeHttpOnly || 'not read',
            event: result.probeEvent || 'blocked', frame: result.probeFrame || 'blocked', probeNode: result.probeNode });
        await page.close();
    }
    assert.deepEqual(results.map(({ inline, event, frame }) => [inline, event, frame]), [
        ['ran', 'ran', 'ran'], ['blocked', 'ran', 'ran'], ['blocked', 'blocked', 'blocked'],
    ]);
    assert.equal(results[0].cookieReadable, 'true');
    assert.equal(results[0].httpOnlyReadable, 'false');
    assert.equal(results[1].probeNode, false);
    console.log(JSON.stringify({ browser: context.browser().version(), hidden: true, viewport: [1000, 760],
        extension: 'real unpacked dist', results }));
} finally {
    await resources.dispose();
}
