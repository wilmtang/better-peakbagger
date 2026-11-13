import globals from 'globals';
import { defineConfig } from 'eslint/config';
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

const rules: Linter.RulesRecord = {
    'no-undef': 'error',
    'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
    }],
    eqeqeq: ['error', 'smart'],
    // src/ was already uniformly single-quoted and 4-space indented; the
    // release and Firefox-verification scripts had drifted to double quotes
    // (verify-firefox-extension.mts alone: 437 double to 24 single). Nothing
    // enforced either convention, so the split was invisible in review.
    quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: false }],
    indent: ['error', 4, { SwitchCase: 0 }],
    semi: ['error', 'always'],
    'comma-dangle': ['error', 'only-multiline'],
    'no-trailing-spaces': 'error',
    'eol-last': ['error', 'always'],
    // A binding declared empty and filled in later, while a closure already
    // refers to it, is a deliberate pattern in the fixture servers; const
    // cannot express it without moving the declaration past its first reader.
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    'no-var': 'error',
};

const typescriptFiles = ['**/*.ts', '**/*.mts'];
// Authored runtime roots only; test fixtures are linted by their own checks.
const svelteFiles = ['src/**/*.svelte', 'options/**/*.svelte', 'popup/**/*.svelte', 'photos/**/*.svelte',
    'src/**/*.svelte.ts', 'options/**/*.svelte.ts', 'popup/**/*.svelte.ts', 'photos/**/*.svelte.ts'];

export default defineConfig([
    {
        // The config file lints itself: it matched no `files` glob before, so
        // it was the one source file in the repository with no rules applied.
        files: ['*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules,
    },
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'store-assets/**',
            'test/fixtures/**',
            'web-ext-artifacts/**',
            '.claude/**',
        ],
    },
    {
        files: ['src/**/*.js', 'options/**/*.js', 'popup/**/*.js', 'photos/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.webextensions },
        },
        rules: {
            ...rules,
            // Runtime source only. A shadow here is not a style question: in
            // photos.js a route-drag callback named its parameter `point` over
            // the pointer position, so its untouched branch returned the same
            // identifier meaning the opposite value, and in terrain-map.js the
            // settings *store* import was shadowed by a settings *snapshot* in
            // three places. Test and script files shadow harmless locals like
            // `dom` and `path` freely, and are left alone.
            'no-shadow': 'error',
        },
    },
    {
        files: ['src/gpx/gpx-analyzer.js'],
        languageOptions: {
            globals: { Chart: 'readonly' },
        },
    },
    {
        files: ['scripts/**/*.mjs', 'test/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules,
    },
    {
        files: ['scripts/verify-extension.mts'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
        },
    },
    ...tseslint.configs.recommended.map(config => ({ ...config, files: typescriptFiles })),
    {
        files: typescriptFiles,
        rules: {
            ...rules,
            'no-undef': 'off',
            'no-unused-vars': 'off',
            'no-shadow': 'off',
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_', caughtErrors: 'none',
            }],
            '@typescript-eslint/no-shadow': 'error',
        },
    },
    {
        files: ['src/**/*.ts', 'options/**/*.ts', 'popup/**/*.ts', 'photos/**/*.ts'],
        languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
    },
    // Svelte components and rune modules. Component scripts must be TypeScript
    // (the plugin's block-lang rule), parsed by typescript-eslint inside the
    // Svelte parser, with the same TypeScript rules as plain modules.
    ...svelte.configs.recommended.map(config => config.files ? { ...config, files: svelteFiles } : config),
    {
        files: svelteFiles,
        languageOptions: {
            globals: { ...globals.browser, ...globals.webextensions },
            parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.svelte'] },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: {
            ...rules,
            ...Object.assign({}, ...tseslint.configs.recommended.map(config => config.rules ?? {})),
            'no-undef': 'off',
            'no-unused-vars': 'off',
            'no-shadow': 'off',
            // Svelte markup does not follow the script indentation rule.
            indent: 'off',
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_', caughtErrors: 'none',
            }],
            '@typescript-eslint/no-shadow': 'error',
            'svelte/block-lang': ['error', { script: 'ts', style: null }],
        },
    },
    {
        files: ['*.mts', 'scripts/**/*.{ts,mts}', 'test/**/*.{ts,mts}',
            'docs/**/*.{ts,mts}', 'store-assets/**/*.{ts,mts}'],
        languageOptions: { globals: globals.node },
    },
]);
