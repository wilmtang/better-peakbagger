// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference types="chrome" />

// Compares candidate unpacked-extension loading strategies in Chrome for
// Testing against one HTTPS Peakbagger fixture:
//   - cli-default: the current verification-launch.mts flags
//   - cli-ignore-disable-extensions: omits Playwright's default --disable-extensions
//   - cdp-load-unpacked: loads dist/ over pipe CDP via Extensions.loadUnpacked
//
// Designed for the manual Linux CI probe workflow so one short run distinguishes
// unregistered extensions, slow registration, content-script failures and dead
// MV3 workers without executing the full 10-minute smoke suite.

import { access, appendFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserFixtureServer, waitForCondition } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertVerificationBrowser } from './verification-browser-identity.mjs';
import {
    createVerificationRoot,
    launchVerificationChrome,
    PEAKBAGGER_HOST_RULE,
    type ChromeLaunch,
} from './verification-launch.mts';

export const PROBE_MODES = [
    'cli-default',
    'cli-ignore-disable-extensions',
    'cdp-load-unpacked',
] as const;

export type ProbeMode = (typeof PROBE_MODES)[number];

export interface ParsedProbeArgs {
    modes: ProbeMode[];
    output: string | null;
    headed: boolean;
    requireAll: boolean;
}

export interface ProbeLaunchSpec {
    mode: ProbeMode;
    launch: ChromeLaunch;
    cdpLoadPath: string | null;
}

export interface ProbeRegistrySummary {
    totalRecords: number;
    id: string;
    location: string | null;
    registryStatus: string | null;
    disableReasons: unknown[];
    manifestVersion: number | null;
    pathMatches: boolean;
}

export interface ProbeModeEvaluationInput {
    extensionId: string | null;
    cdpError: string | null;
    registry: ProbeRegistrySummary | null;
    contentScript: {
        injected: boolean;
        theme: string | null;
        mapLinks: boolean;
    };
    worker: {
        ok: boolean;
        workerStarted: boolean;
        extensionIdMatch: boolean;
        error: string | null;
    };
    error: string | null;
    teardownError: string | null;
}

export interface ProbeModeResult extends ProbeModeEvaluationInput {
    mode: ProbeMode;
    passed: boolean;
    durationMs: number;
    browserVersion: string | null;
    cdpExtensionId: string | null;
    registryRawRecords: number | null;
    browserLogs: string[];
}

export interface ProbeReport {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    headed: boolean;
    requireAll: boolean;
    overallPassed: boolean;
    results: ProbeModeResult[];
}

const USAGE = 'Usage: node scripts/probe-chrome-extension-load.mts '
    + '[--mode=all|cli-default|cli-ignore-disable-extensions|cdp-load-unpacked] '
    + '[--output=FILE] [--headed] [--require-all]';

const MAX_BROWSER_LOG_LINES = 80;

export function parseProbeArgs(argv: readonly string[]): ParsedProbeArgs {
    let modeArg: string | null = null;
    let output: string | null = null;
    let headed = false;
    let requireAll = false;
    for (const arg of argv) {
        if (arg.startsWith('--mode=')) {
            if (modeArg !== null) throw new Error(USAGE);
            modeArg = arg.slice('--mode='.length);
        } else if (arg.startsWith('--output=')) {
            const value = arg.slice('--output='.length).trim();
            if (output !== null || !value) throw new Error(USAGE);
            output = value;
        } else if (arg === '--headed') {
            if (headed) throw new Error(USAGE);
            headed = true;
        } else if (arg === '--require-all') {
            if (requireAll) throw new Error(USAGE);
            requireAll = true;
        } else {
            throw new Error(USAGE);
        }
    }
    const selected = modeArg ?? 'all';
    if (selected === 'all') {
        return { modes: [...PROBE_MODES], output, headed, requireAll };
    }
    if ((PROBE_MODES as readonly string[]).includes(selected)) {
        return { modes: [selected as ProbeMode], output, headed, requireAll };
    }
    throw new Error(USAGE);
}

export function probeLaunchSpec(
    mode: ProbeMode,
    dist: string,
    options: {
        headed?: boolean;
        chromeBinary?: string;
        trustArgs?: readonly string[];
        hosts?: readonly string[];
    } = {},
): ProbeLaunchSpec {
    const {
        headed = false,
        chromeBinary,
        trustArgs = [],
        hosts = [PEAKBAGGER_HOST_RULE],
    } = options;
    const common: ChromeLaunch = {
        ...(chromeBinary ? { chromeBinary } : {}),
        headless: !headed,
        viewport: { width: 1000, height: 760 },
        trustArgs,
        hosts,
    };
    if (mode === 'cli-default') {
        return {
            mode,
            cdpLoadPath: null,
            launch: {
                ...common,
                ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
                extension: dist,
            },
        };
    }
    if (mode === 'cli-ignore-disable-extensions') {
        return {
            mode,
            cdpLoadPath: null,
            launch: {
                ...common,
                ignoreDefaultArgs: ['--disable-extensions', '--enable-unsafe-swiftshader'],
                extension: dist,
            },
        };
    }
    return {
        mode,
        cdpLoadPath: dist,
        launch: {
            ...common,
            ignoreDefaultArgs: ['--disable-extensions', '--enable-unsafe-swiftshader'],
            args: ['--enable-unsafe-extension-debugging'],
        },
    };
}

export function evaluateProbeMode(candidate: ProbeModeEvaluationInput): boolean {
    if (!candidate.extensionId) return false;
    if (candidate.cdpError !== null || candidate.error !== null || candidate.teardownError !== null) {
        return false;
    }
    const registryHealthy = candidate.registry !== null
        && candidate.registry.id === candidate.extensionId
        && candidate.registry.pathMatches
        && (!candidate.registry.registryStatus || candidate.registry.registryStatus === 'ENABLED')
        && candidate.registry.disableReasons.length === 0
        && candidate.registry.manifestVersion === 3;
    const contentScriptHealthy = candidate.contentScript.injected
        && Boolean(candidate.contentScript.theme)
        && candidate.contentScript.mapLinks;
    const workerHealthy = candidate.worker.ok
        && candidate.worker.workerStarted
        && candidate.worker.extensionIdMatch;
    return registryHealthy && contentScriptHealthy && workerHealthy;
}

export function evaluateProbeSuccess(
    results: readonly Pick<ProbeModeResult, 'passed' | 'teardownError'>[],
    requireAll: boolean,
): boolean {
    if (results.length === 0) return false;
    if (results.some(result => result.teardownError !== null)) return false;
    return requireAll
        ? results.every(result => result.passed)
        : results.some(result => result.passed);
}

export function formatProbeMarkdown(report: ProbeReport): string {
    const lines = [
        '### Chrome unpacked-extension load probe',
        '',
        `- Platform: \`${report.platform}/${report.arch}\` (Node \`${report.nodeVersion}\`, ${report.headed ? 'headed' : 'headless'})`,
        `- Overall: **${report.overallPassed ? 'PASS' : 'FAIL'}** (${report.requireAll ? 'all modes required' : 'at least one mode required'})`,
        '',
        '| Mode | Result | Browser | Registry | Content script | Service worker | Duration | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const item of report.results) {
        const registryLabel = item.registry
            ? `${item.registry.location ?? 'unknown'} (${item.registry.registryStatus ?? 'no-status'})`
            : `missing (${item.registryRawRecords ?? 0} records)`;
        const hasTheme = Boolean(item.contentScript.theme);
        const contentLabel = hasTheme && item.contentScript.mapLinks
            ? `yes (theme=${item.contentScript.theme}, mapLinks=yes)`
            : hasTheme || item.contentScript.mapLinks
                ? `partial (theme=${item.contentScript.theme ?? 'none'}, mapLinks=${item.contentScript.mapLinks ? 'yes' : 'no'})`
                : 'no';
        const workerLabel = item.worker.ok && item.worker.workerStarted && item.worker.extensionIdMatch ? 'yes' : 'no';
        const note = (item.teardownError ?? item.error ?? item.cdpError ?? item.worker.error ?? '')
            .replace(/\r?\n/g, ' ')
            .slice(0, 160)
            .replace(/[\\|]/g, '\\$&');
        lines.push(
            `| \`${item.mode}\` | ${item.passed ? 'PASS' : 'FAIL'} | ${item.browserVersion ?? 'n/a'} `
            + `| ${registryLabel} | ${contentLabel} | ${workerLabel} | ${item.durationMs}ms | ${note || 'ok'} |`,
        );
    }
    lines.push('');
    return lines.join('\n');
}

interface RawRegistryRecord {
    id?: unknown;
    name?: unknown;
    location?: unknown;
    path?: unknown;
    registry_status?: unknown;
    disable_reasons?: unknown;
    manifest_version?: unknown;
}

async function pollExtensionsInternals(
    registryPage: { goto(url: string): Promise<unknown>; evaluate<T>(fn: () => T): Promise<T> },
): Promise<{ total: number | null; found: RawRegistryRecord | null }> {
    let lastTotal: number | null = null;
    try {
        return await waitForCondition(async () => {
            await registryPage.goto('chrome://extensions-internals/');
            const snapshot = await registryPage.evaluate(() => {
                try {
                    const records = JSON.parse(document.body.innerText) as unknown;
                    if (!Array.isArray(records)) return { total: null, found: null };
                    const found = (records as RawRegistryRecord[]).find(item => item?.name === 'Better Peakbagger') ?? null;
                    return { total: records.length, found };
                } catch {
                    return { total: null, found: null };
                }
            });
            lastTotal = snapshot.total;
            return snapshot.found ? snapshot : false;
        }, {
            description: 'Better Peakbagger entry in chrome://extensions-internals/',
            timeoutMs: 10_000,
            intervalMs: 150,
        }) as Promise<{ total: number | null; found: RawRegistryRecord | null }>;
    } catch {
        return { total: lastTotal, found: null };
    }
}

async function runSingleMode(
    mode: ProbeMode,
    dist: string,
    expectedDistPath: string,
    fixture: { port: number; chromeTrustArgs: readonly string[] },
    options: { headed: boolean; chromeBinary?: string },
): Promise<ProbeModeResult> {
    const startedAt = Date.now();
    const browserLogs: string[] = [];
    const modeResources = createResourceStack();
    const result: ProbeModeResult = {
        mode,
        passed: false,
        durationMs: 0,
        browserVersion: null,
        extensionId: null,
        cdpExtensionId: null,
        cdpError: null,
        registry: null,
        registryRawRecords: null,
        contentScript: { injected: false, theme: null, mapLinks: false },
        worker: { ok: false, workerStarted: false, extensionIdMatch: false, error: null },
        browserLogs,
        error: null,
        teardownError: null,
    };
    try {
        const profile = await createVerificationRoot(
            modeResources,
            `bpb-chrome-load-probe-${mode}-`,
            `${mode} probe profile`,
        );
        const spec = probeLaunchSpec(mode, dist, {
            headed: options.headed,
            chromeBinary: options.chromeBinary,
            trustArgs: fixture.chromeTrustArgs,
            hosts: [PEAKBAGGER_HOST_RULE],
        });
        const context = await launchVerificationChrome(modeResources, `${mode} Chrome context`, profile, {
            ...spec.launch,
            logger: {
                isEnabled: (name: string) => name === 'browser',
                log: (_name: string, severity: string, message: string | Error) => {
                    if (browserLogs.length < MAX_BROWSER_LOG_LINES) {
                        browserLogs.push(`[${severity}] ${String(message)}`);
                    }
                },
            },
        });
        const browser = context.browser()!;
        result.browserVersion = browser.version();
        assertVerificationBrowser({
            name: browser.browserType().name(),
            version: result.browserVersion,
            expectedName: 'chromium',
            expectedVersion: process.env.BPB_EXPECT_CHROME_VERSION,
        });

        if (spec.cdpLoadPath) {
            const cdpSession = await browser.newBrowserCDPSession();
            modeResources.defer(`${mode} browser CDP session`, () => cdpSession.detach());
            try {
                const loaded = await cdpSession.send(
                    'Extensions.loadUnpacked' as never,
                    { path: spec.cdpLoadPath } as never,
                ) as { id?: unknown };
                if (typeof loaded?.id === 'string' && loaded.id.length > 0) {
                    result.cdpExtensionId = loaded.id;
                } else {
                    result.cdpError = `Extensions.loadUnpacked returned unexpected payload: ${JSON.stringify(loaded)}`;
                }
            } catch (error) {
                result.cdpError = error instanceof Error ? error.message : String(error);
            }
        }

        const registryPage = await context.newPage();
        const registrySnapshot = await pollExtensionsInternals(registryPage);
        result.registryRawRecords = registrySnapshot.total;
        if (registrySnapshot.found && typeof registrySnapshot.found.id === 'string') {
            const record = registrySnapshot.found;
            const recordId = registrySnapshot.found.id;
            const resolvedRecordPath = typeof record.path === 'string'
                ? await realpath(record.path).catch(() => String(record.path))
                : '';
            result.registry = {
                totalRecords: registrySnapshot.total ?? 0,
                id: recordId,
                location: typeof record.location === 'string' ? record.location : null,
                registryStatus: typeof record.registry_status === 'string' ? record.registry_status : null,
                disableReasons: Array.isArray(record.disable_reasons) ? record.disable_reasons : [],
                manifestVersion: typeof record.manifest_version === 'number' ? record.manifest_version : null,
                pathMatches: resolvedRecordPath === expectedDistPath,
            };
        }
        await registryPage.close();

        const initialWorker = context.serviceWorkers()[0];
        result.extensionId = result.cdpExtensionId
            ?? (initialWorker ? new URL(initialWorker.url()).host : null)
            ?? result.registry?.id
            ?? null;

        const peakPage = await context.newPage();
        await peakPage.goto(`https://www.peakbagger.com:${fixture.port}/peak.aspx?pid=1`, { waitUntil: 'load' });
        const contentProbe = await peakPage.waitForFunction(() => {
            const theme = document.documentElement.dataset.bpbTheme ?? null;
            const mapLinks = Boolean(document.getElementById('bpb-peak-map-links'));
            return theme && mapLinks ? { injected: true, theme, mapLinks } : false;
        }, null, { timeout: 10_000 })
            .then(handle => handle.jsonValue() as Promise<{ injected: boolean; theme: string | null; mapLinks: boolean }>)
            .catch(async () => peakPage.evaluate(() => {
                const theme = document.documentElement.dataset.bpbTheme ?? null;
                const mapLinks = Boolean(document.getElementById('bpb-peak-map-links'));
                return {
                    injected: Boolean(theme) && mapLinks,
                    theme,
                    mapLinks,
                };
            }));
        result.contentScript = contentProbe;
        await peakPage.close();

        if (result.extensionId) {
            const optionsPage = await context.newPage();
            await optionsPage.goto(`chrome-extension://${result.extensionId}/options/options.html`);
            const reply = await optionsPage.evaluate(async () =>
                chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: -1 })
                    .then(value => ({ ok: true, value: value ?? null, extensionId: chrome.runtime.id, error: null }))
                    .catch(error => ({ ok: false, value: null, extensionId: null, error: String(error) })));
            const startedWorker = context.serviceWorkers()[0]
                ?? await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
            result.worker = {
                ok: Boolean(reply.ok),
                workerStarted: Boolean(startedWorker),
                extensionIdMatch: reply.extensionId === result.extensionId,
                error: reply.error,
            };
            await optionsPage.close();
        }
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    }
    try {
        await modeResources.dispose(null);
    } catch (disposeError) {
        const detail = disposeError instanceof Error ? disposeError.message : String(disposeError);
        result.teardownError = detail;
        result.error = result.error ? `${result.error}; teardown failed: ${detail}` : `teardown failed: ${detail}`;
    }
    result.passed = evaluateProbeMode(result);
    result.durationMs = Date.now() - startedAt;
    return result;
}

async function main(): Promise<void> {
    const parsed = parseProbeArgs(process.argv.slice(2));
    assertChromeLaunchAllowed();
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const dist = process.env.BPB_VERIFY_EXTENSION_SOURCE
        ? path.resolve(process.env.BPB_VERIFY_EXTENSION_SOURCE)
        : path.join(root, 'dist');
    await access(path.join(dist, 'manifest.json')).catch(() => {
        throw new Error(`Missing ${path.join(dist, 'manifest.json')}. Run npm run build before probing extension loading.`);
    });
    const expectedDistPath = await realpath(dist);
    const chromeBinary = process.env.CHROME_BIN ? path.resolve(process.env.CHROME_BIN) : undefined;

    const sharedResources = createResourceStack();
    let fatalError: unknown = null;
    let report: ProbeReport | null = null;
    try {
        const fixtureRoot = await createVerificationRoot(
            sharedResources,
            'bpb-chrome-load-fixture-',
            'Chrome load probe fixture root',
        );
        const fixture = await createBrowserFixtureServer({ temporaryRoot: fixtureRoot } as never);
        sharedResources.defer('Chrome load probe HTTPS fixture', () => fixture.close());

        const results: ProbeModeResult[] = [];
        for (const mode of parsed.modes) {
            results.push(await runSingleMode(mode, dist, expectedDistPath, fixture, {
                headed: parsed.headed,
                chromeBinary,
            }));
        }
        report = {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            headed: parsed.headed,
            requireAll: parsed.requireAll,
            overallPassed: evaluateProbeSuccess(results, parsed.requireAll),
            results,
        };
        if (parsed.output) {
            const outputPath = path.resolve(parsed.output);
            await mkdir(path.dirname(outputPath), { recursive: true });
            await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
        }
        if (process.env.GITHUB_STEP_SUMMARY) {
            await appendFile(process.env.GITHUB_STEP_SUMMARY, formatProbeMarkdown(report));
        }
        console.log(JSON.stringify(report, null, 2));
        if (!report.overallPassed) {
            const teardownFailed = results.some(item => item.teardownError !== null);
            fatalError = new Error(
                teardownFailed
                    ? 'Chrome extension load probe failed resource teardown'
                    : `Chrome extension load probe failed (${parsed.requireAll ? 'all modes required' : 'no mode succeeded'})`,
            );
        }
    } catch (error) {
        fatalError = error;
    }
    await sharedResources.dispose(fatalError as null);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
