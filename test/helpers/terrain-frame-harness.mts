/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Classic IIFE entry point for terrain-map.browser.mts: runs the real terrain
// frame runtime against a test-supplied MapLibre stub and authorization hook.

import type * as MapLibre from 'maplibre-gl';
import { startTerrainFrame } from '../../src/terrain/terrain-frame-runtime.ts';

type HarnessGlobals = typeof globalThis & {
    maplibregl: typeof MapLibre;
    authorizeTerrain?: (request: { token?: unknown; action: string }) => boolean | Promise<boolean>;
    __testLayerBasemaps?: unknown;
};

const globals = globalThis as HarnessGlobals;
const originalPost = window.parent.postMessage.bind(window.parent);
(window.parent as unknown as { postMessage: (message: unknown, ...args: unknown[]) => void }).postMessage = (message: unknown, ...args: unknown[]) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'layerBasemaps') {
        globals.__testLayerBasemaps = message;
    }
    return (originalPost as (message: unknown, ...args: unknown[]) => void)(message, ...args);
};
startTerrainFrame(globals.maplibregl, {
    authorize: ((request: { token?: unknown; action: string }) => (globals.authorizeTerrain ? globals.authorizeTerrain(request) : true)) as unknown as (request: { token?: unknown; action: string }) => Promise<boolean>,
});
