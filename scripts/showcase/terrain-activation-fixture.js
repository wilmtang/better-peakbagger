// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// The hardware terrain showcase runs production bundles as ordinary page
// scripts, without an extension worker. Model the worker's one-use activation
// capabilities narrowly enough that the real bridge and frame handshake still
// runs, while leaving authorization decisions observable to the verifier.
(() => {
  const capabilities = new Map();
  globalThis.__bpbTerrainFixtureCapabilities = capabilities;
  globalThis.__bpbTerrainFixtureAuthorizationAttempts = 0;
  globalThis.__bpbTerrainFixtureIssueAttempts = 0;

  const runtime = globalThis.chrome && globalThis.chrome.runtime;
  if (!runtime) throw new Error('Terrain activation fixture requires chrome.runtime');
  runtime.sendMessage = async message => {
    if (message?.type === 'TERRAIN_ACTIVATION_ISSUE'
      && (message.action === 'init' || message.action === 'prefetch')) {
      globalThis.__bpbTerrainFixtureIssueAttempts++;
      const token = crypto.randomUUID();
      capabilities.set(token, message.action);
      return { ok: true, token, expiresAt: Date.now() + 5_000 };
    }
    if (message?.type === 'TERRAIN_PREFETCH') {
      const action = capabilities.get(message.activation);
      capabilities.delete(message.activation);
      return { ok: action === 'prefetch' };
    }
    return { ok: false };
  };
})();
