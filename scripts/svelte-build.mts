// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared Svelte compiler settings for both development and minified Vite
// output. The Vite plugin applies these to components and rune modules.
//
// - Runes mode everywhere, so components cannot fall back to legacy reactivity.
// - Production client output (`dev: false`) for every build, including watch:
//   development builds must exercise the code that ships. Svelte's runtime
//   reads its own DEV flag from `esm-env/development`, whose fallback consults
//   `globalThis.process`; that import alone is pinned to `false.js`, so a
//   harness setting NODE_ENV cannot flip the runtime onto development paths.
//   (A global `production` resolve condition would also change unrelated
//   bundles.)
// - Scoped style class names hash the CSS so workspace paths do not leak into
//   the generated class names.
// - Styles are injected by the component at mount rather than emitted as a
//   separate CSS output, so a bundle keeps exactly one output file.

import { createRequire } from 'node:module';
import path from 'node:path';
import type { CompileOptions, ModuleCompileOptions } from 'svelte/compiler';

export const SVELTE_COMPILER_OPTIONS = Object.freeze({
    runes: true,
    dev: false,
    fragments: 'tree',
    discloseVersion: false,
    css: 'injected',
    generate: 'client',
    cssHash: ({ css, hash }) => `svelte-${hash(css)}`,
} satisfies CompileOptions);

export const SVELTE_MODULE_COMPILER_OPTIONS = Object.freeze({
    dev: false,
    generate: 'client',
} satisfies ModuleCompileOptions);

const require = createRequire(import.meta.url);
// The `production` target of the `esm-env/development` export Svelte resolves;
// the package does not export the file itself, so locate it beside its entry.
export const SVELTE_DEV_FLAG_MODULE = path.join(path.dirname(require.resolve('esm-env', {
    paths: [path.dirname(require.resolve('svelte/package.json'))],
})), 'false.js');
