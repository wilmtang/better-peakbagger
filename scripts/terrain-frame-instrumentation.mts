// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dependency-free, so the verifiers and the browser tests share it.

// The terrain verifiers load terrain/terrain.html directly rather than through
// the extension, so they have to supply the chrome.runtime URL resolver the real
// frame gets from its extension origin. This was copied byte-for-byte between
// them; if the copies ever drifted, Chrome and Firefox would render materially
// different frames while still reporting the same pass.
//
// `chrome.runtime.getURL` is what the frame's MapLibre worker resolves against,
// and dist/ is where the fixture serves it. The production frame also re-reads
// the feature gate before starting, so the harness supplies the same enabled
// schema record as its host-page fixtures.
export const instrumentTerrainFrameHtml = (html: string): string => html
    .replace('</head>', `  <script>
    globalThis.chrome = {
      runtime: { getURL: resource => new URL('/dist/' + resource, location.origin).href },
      storage: {
        sync: { get: async () => ({ bpbSettings: { enable3dMap: true } }) },
        local: { get: async () => ({}) },
        onChanged: { addListener: () => {}, removeListener: () => {} }
      }
    };
  </script>
</head>`);

// The Map proxy exposes only the fixture's instance, so a check can prove the
// mocked DEM decoded into non-flat terrain. Instrument the served module rather
// than adding a production test hook or publishing MapLibre internals.
export const instrumentTerrainFrameModule = (source: string): string => {
    const start = 'startTerrainFrame(maplibre);';
    if (!source.includes(start)) {
        throw new Error('Terrain frame module no longer exposes the expected fixture injection point');
    }
    return source.replace(start, `(() => {
    const InstrumentedMap = new Proxy(maplibre.Map, {
      construct(Target, args, newTarget) {
        const instance = Reflect.construct(Target, args, newTarget);
        globalThis.__bpbTerrainTestMap = instance;
        return instance;
      }
    });
    const authorizeFixtureActivation = async ({ token, action }) => {
      const owner = window.parent;
      owner.__bpbTerrainFixtureAuthorizationAttempts =
        (owner.__bpbTerrainFixtureAuthorizationAttempts || 0) + 1;
      const capabilities = owner.__bpbTerrainFixtureCapabilities;
      const usable = capabilities && typeof capabilities.get === 'function'
        && typeof capabilities.delete === 'function';
      const issuedAction = usable ? capabilities.get(token) : null;
      if (usable) capabilities.delete(token);
      return action === 'init' && issuedAction === 'init';
    };
    startTerrainFrame({ ...maplibre, Map: InstrumentedMap }, { authorize: authorizeFixtureActivation });
    })();`);
};
