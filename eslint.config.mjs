import globals from 'globals';

const rules = {
    'no-undef': 'error',
    'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
    }],
    eqeqeq: ['error', 'smart'],
    // src/ was already uniformly single-quoted and 4-space indented; the
    // release and Firefox-verification scripts had drifted to double quotes
    // (verify-firefox-extension.mjs alone: 437 double to 24 single). Nothing
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

export default [
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
        rules,
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
        files: ['scripts/verify-extension.mjs'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
        },
    },
];
