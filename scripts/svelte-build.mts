// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one definition of how Svelte components and rune modules compile. Every
// esbuild bundle in scripts/build.mts receives this plugin, so a component an
// entry imports compiles with the same options in development, minified and
// watch builds; bundles that import no Svelte are unaffected.
//
// - Runes mode everywhere, so components cannot fall back to legacy reactivity.
// - Production client output (`dev: false`) for every build, including watch:
//   development builds must exercise the code that ships.
// - Styles are injected by the component at mount rather than emitted as a
//   separate CSS output, so a bundle keeps exactly one output file. Whether a
//   page's CSP admits that is M6's question, not this compiler's.
// - `.svelte.ts` modules are type-stripped with a plain TS transform: the
//   bundle options' `sourcemap: 'linked'` is not a transform option.

import esbuildSvelte from 'esbuild-svelte';
import type { Plugin } from 'esbuild';
import type { CompileOptions, ModuleCompileOptions } from 'svelte/compiler';

export const SVELTE_COMPILER_OPTIONS = Object.freeze({
    runes: true,
    dev: false,
    css: 'injected',
    generate: 'client',
} satisfies CompileOptions);

export const SVELTE_MODULE_COMPILER_OPTIONS = Object.freeze({
    dev: false,
    generate: 'client',
} satisfies ModuleCompileOptions);

// Node loads the package's CommonJS build, whose module.exports is the plugin
// factory; its declarations describe an ES default export instead, which
// NodeNext resolution types as `{ default }`.
const sveltePlugin = esbuildSvelte as unknown as typeof esbuildSvelte.default;

export const sveltePlugins = (): Plugin[] => [sveltePlugin({
    compilerOptions: { ...SVELTE_COMPILER_OPTIONS },
    moduleCompilerOptions: { ...SVELTE_MODULE_COMPILER_OPTIONS },
    esbuildTsTransformOptions: {},
})];
