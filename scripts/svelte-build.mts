// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one definition of how Svelte components and rune modules compile. Every
// esbuild bundle in scripts/build.mts receives these plugins, so a component
// an entry imports compiles with the same options in development, minified
// and watch builds; bundles that import no Svelte are unaffected.
//
// - Runes mode everywhere, so components cannot fall back to legacy reactivity.
// - Production client output (`dev: false`) for every build, including watch:
//   development builds must exercise the code that ships. Svelte's runtime
//   reads its own DEV flag from `esm-env/development`, whose fallback consults
//   `globalThis.process`; that import alone is pinned to `false.js`, so a
//   harness setting NODE_ENV cannot flip the runtime onto development paths.
//   (A global `production` resolve condition would also change unrelated
//   bundles.)
// - Scoped style class names hash the CSS, not the file path, which
//   esbuild-svelte passes relative to process.cwd(); builds from different
//   working directories are byte-identical.
// - Styles are injected by the component at mount rather than emitted as a
//   separate CSS output, so a bundle keeps exactly one output file. Whether a
//   page's CSP admits that is M6's question, not this compiler's.
// - `.svelte.ts` modules are type-stripped with a plain TS transform: the
//   bundle options' `sourcemap: 'linked'` is not a transform option. Their
//   source maps therefore point at the stripped JavaScript, labelled with the
//   `.ts` name; lines can differ from the authored file.
// - The plugin's mtime cache is off: watch must never publish a stale compile
//   after a restore that keeps an older or equal timestamp.

import { createRequire } from 'node:module';
import path from 'node:path';
import esbuildSvelte from 'esbuild-svelte';
import type { Plugin } from 'esbuild';
import type { CompileOptions, ModuleCompileOptions } from 'svelte/compiler';

export const SVELTE_COMPILER_OPTIONS = Object.freeze({
    runes: true,
    dev: false,
    css: 'injected',
    generate: 'client',
    cssHash: ({ css, hash }) => `svelte-${hash(css)}`,
} satisfies CompileOptions);

export const SVELTE_MODULE_COMPILER_OPTIONS = Object.freeze({
    dev: false,
    generate: 'client',
} satisfies ModuleCompileOptions);

// Node loads the package's CommonJS build, whose module.exports is the plugin
// factory; its declarations describe an ES default export instead, which
// NodeNext resolution types as `{ default }`.
const sveltePlugin = esbuildSvelte as unknown as typeof esbuildSvelte.default;

const require = createRequire(import.meta.url);
// The `production` target of the `esm-env/development` export Svelte resolves;
// the package does not export the file itself, so locate it beside its entry.
export const SVELTE_DEV_FLAG_MODULE = path.join(path.dirname(require.resolve('esm-env', {
    paths: [path.dirname(require.resolve('svelte/package.json'))],
})), 'false.js');

const svelteProductionFlag = (): Plugin => ({
    name: 'svelte-production-flag',
    setup(build) {
        build.onResolve({ filter: /^esm-env\/development$/ }, () => ({ path: SVELTE_DEV_FLAG_MODULE }));
    },
});

export const sveltePlugins = (): Plugin[] => [svelteProductionFlag(), sveltePlugin({
    compilerOptions: { ...SVELTE_COMPILER_OPTIONS },
    moduleCompilerOptions: { ...SVELTE_MODULE_COMPILER_OPTIONS },
    esbuildTsTransformOptions: {},
    cache: false,
})];
