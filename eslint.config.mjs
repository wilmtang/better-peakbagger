import globals from 'globals';

const rules = {
    'no-undef': 'error',
    'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
    }],
    eqeqeq: ['error', 'smart'],
};

export default [
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
        files: ['src/**/*.js', 'options/**/*.js', 'popup/**/*.js'],
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
