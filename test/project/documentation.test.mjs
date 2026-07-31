// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT_LIVING_DOCS = [
    'ACKNOWLEDGEMENTS.md',
    'AGENTS.md',
    'CLAUDE.md',
    'PRIVACY.md',
    'README.md',
    'ROADMAP.md',
];
const REPOSITORY_PATH_PREFIX =
    /^(?:src|test|docs|scripts|options|popup|photos|terrain)\//;
const REPOSITORY_ROOT_FILE =
    /^(?:manifest\.json|package(?:-lock)?\.json|README\.md|PRIVACY\.md|ROADMAP\.md)$/;

const withoutFencedCode = markdown =>
    markdown.replace(/^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)\s*$/gm, '');

const normalizeLinkTarget = raw => {
    const trimmed = raw.trim();
    const target = trimmed.startsWith('<')
        ? /^<([^>]+)>/.exec(trimmed)?.[1]
        : /^[^\s]+/.exec(trimmed)?.[0];
    if (!target || target.startsWith('#') || target.startsWith('/')
        || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
    try {
        return decodeURIComponent(target.split(/[?#]/, 1)[0]);
    } catch {
        return target.split(/[?#]/, 1)[0];
    }
};

const relativeLinks = markdown => {
    const text = withoutFencedCode(markdown);
    const targets = [];
    for (const match of text.matchAll(/!?\[[^\]]*]\((<[^>]+>|[^)\n]+)\)/g)) {
        const target = normalizeLinkTarget(match[1]);
        if (target) targets.push(target);
    }
    for (const match of text.matchAll(/^\s*\[[^\]]+]:\s*(<[^>]+>|[^\s]+)\s*$/gm)) {
        const target = normalizeLinkTarget(match[1]);
        if (target) targets.push(target);
    }
    return targets;
};

const repositoryPaths = markdown => {
    const text = withoutFencedCode(markdown);
    const targets = [];
    for (const match of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
        const target = match[1].split(/[?#]/, 1)[0];
        if ((REPOSITORY_PATH_PREFIX.test(target) || REPOSITORY_ROOT_FILE.test(target))
            && !/[*{}<>]/.test(target)) targets.push(target);
    }
    return targets;
};

const maintainedDocuments = async () => {
    const inDirectory = async directory => (await readdir(path.join(root, directory)))
        .filter(name => name.endsWith('.md'))
        .map(name => path.join(directory, name));
    return [
        ...ROOT_LIVING_DOCS,
        ...await inDirectory('docs'),
        ...await inDirectory('docs/plans'),
    ].sort();
};

test('maintained-document target extraction distinguishes links and repository paths', () => {
    const sample = [
        '[design](docs/design.md#contract)',
        '[site](https://example.com/docs/design.md)',
        '`src/example.js` and `storage.local`',
        '```js',
        '`test/not-a-doc-reference.test.mjs`',
        '```',
    ].join('\n');
    assert.deepEqual(relativeLinks(sample), ['docs/design.md']);
    assert.deepEqual(repositoryPaths(sample), ['src/example.js']);
});

test('maintained relative links and exact repository paths resolve', async () => {
    const missing = [];
    for (const relativeDocument of await maintainedDocuments()) {
        const absoluteDocument = path.join(root, relativeDocument);
        const markdown = await readFile(absoluteDocument, 'utf8');
        const targets = [
            ...relativeLinks(markdown).map(target =>
                path.resolve(path.dirname(absoluteDocument), target)),
            ...repositoryPaths(markdown).map(target => path.resolve(root, target)),
        ];
        for (const target of new Set(targets)) {
            try {
                await access(target);
            } catch {
                missing.push(`${relativeDocument}: ${path.relative(root, target)}`);
            }
        }
    }
    assert.deepEqual(missing, [],
        `maintained documentation points at missing targets:\n${missing.join('\n')}`);
});
