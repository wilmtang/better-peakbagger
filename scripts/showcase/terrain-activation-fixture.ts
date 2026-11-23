/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// The hardware terrain showcase runs production bundles as ordinary page
// scripts, without an extension worker. Model the worker's one-use activation
// capabilities narrowly enough that the real bridge and frame handshake still
// runs, while leaving authorization decisions observable to the verifier.
// Fixture servers serve it as /scripts/showcase/terrain-activation-fixture.js,
// transpiled (browser-verification-fixtures.mts resolveFixtureFile).
interface ActivationMessage { type?: string; action?: string; activation?: string }
interface FixtureRuntime { sendMessage?: (message: ActivationMessage) => unknown }
// Only the globals this fixture reads and writes; `chrome` is the page's stub.
interface FixtureGlobals {
  chrome?: { runtime?: FixtureRuntime };
  __bpbTerrainFixtureCapabilities: Map<string, string>;
  __bpbTerrainFixtureAuthorizationAttempts: number;
  __bpbTerrainFixtureIssueAttempts: number;
}
(() => {
    const globals = globalThis as unknown as FixtureGlobals;
    const capabilities = new Map<string, string>();
    globals.__bpbTerrainFixtureCapabilities = capabilities;
    globals.__bpbTerrainFixtureAuthorizationAttempts = 0;
    globals.__bpbTerrainFixtureIssueAttempts = 0;

    const runtime = globals.chrome && globals.chrome.runtime;
    if (!runtime) throw new Error('Terrain activation fixture requires chrome.runtime');
    const fallback = runtime.sendMessage;
    runtime.sendMessage = async (message: ActivationMessage) => {
        if (message?.type === 'TERRAIN_ACTIVATION_ISSUE'
      && (message.action === 'init' || message.action === 'prefetch')) {
            globals.__bpbTerrainFixtureIssueAttempts++;
            const token = crypto.randomUUID();
            capabilities.set(token, message.action);
            return { ok: true, token, expiresAt: Date.now() + 5_000 };
        }
        if (message?.type === 'TERRAIN_PREFETCH') {
            const action = capabilities.get(message.activation ?? '');
            capabilities.delete(message.activation ?? '');
            return { ok: action === 'prefetch' };
        }
        return fallback ? fallback(message) : { ok: false };
    };
})();
