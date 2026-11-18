// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one launch definition for hidden Playwright verification browsers. It
// owns the disposable root, the macOS Seatbelt preflight, Chrome for Testing
// in new headless (never chrome-headless-shell, which has no extension
// support), the exclusive unpacked-extension flags, the host-resolver rules
// that point a real Peakbagger hostname at the local HTTPS fixture, and the
// deferred teardown. Callers pass only what differs: viewport, trust
// arguments, extra hosts and any other Playwright option.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, type BrowserContext } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

export interface DeferringResources { defer(label: string, finalizer: () => unknown): void }
export type PersistentLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

export const PEAKBAGGER_HOST = 'www.peakbagger.com';
export const PEAKBAGGER_HOST_RULE = `${PEAKBAGGER_HOST} 127.0.0.1`;

/** Creates a disposable directory that is removed when `resources` is disposed. */
export async function createVerificationRoot(resources: DeferringResources, prefix: string, label = `${prefix} temporary files`): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    resources.defer(label, () => rm(root, { recursive: true, force: true }));
    return root;
}

export interface ChromeLaunch extends PersistentLaunchOptions {
    /** Unpacked extension directory to load, exclusively. */
    extension?: string;
    /** Host-resolver mappings such as `www.peakbagger.com 127.0.0.1:8443`. */
    hosts?: readonly string[];
    /** The fixture certificate's per-launch trust arguments. */
    trustArgs?: readonly string[];
    /** An exact Chrome binary (for example the declared floor); Chrome for Testing otherwise. */
    chromeBinary?: string;
}

export function chromeLaunchOptions({ extension, hosts = [], trustArgs = [], chromeBinary, args = [], ...options }: ChromeLaunch): PersistentLaunchOptions {
    return {
        ...(chromeBinary ? { executablePath: chromeBinary } : { channel: 'chromium' }),
        headless: true,
        ...options,
        args: [
            ...trustArgs,
            ...args,
            ...(hosts.length ? [`--host-resolver-rules=${hosts.map(rule => `MAP ${rule}`).join(',')}`] : []),
            ...(extension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : []),
        ],
    };
}

/** Launches hidden Chrome after the Seatbelt preflight and defers closing it. */
export async function launchVerificationChrome(resources: DeferringResources, label: string, profile: string, launch: ChromeLaunch = {}): Promise<BrowserContext> {
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(profile, chromeLaunchOptions(launch));
    resources.defer(label, () => context.close());
    return context;
}

export interface FirefoxLaunch extends PersistentLaunchOptions {
    /** Domains `network.dns.localDomains` resolves to this machine. */
    localDomains?: readonly string[];
}

export function firefoxLaunchOptions({ localDomains = [PEAKBAGGER_HOST], firefoxUserPrefs = {}, ...options }: FirefoxLaunch): PersistentLaunchOptions {
    return {
        headless: true,
        // Firefox has no per-launch certificate trust flag; this context is
        // disposable and only ever reaches the local fixture hosts.
        ignoreHTTPSErrors: true,
        ...options,
        firefoxUserPrefs: { ...(localDomains.length ? { 'network.dns.localDomains': localDomains.join(',') } : {}), ...firefoxUserPrefs },
    };
}

/** Launches hidden Playwright Firefox and defers closing it. */
export async function launchVerificationFirefox(resources: DeferringResources, label: string, profile: string, launch: FirefoxLaunch = {}): Promise<BrowserContext> {
    const context = await firefox.launchPersistentContext(profile, firefoxLaunchOptions(launch));
    resources.defer(label, () => context.close());
    return context;
}
