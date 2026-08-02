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

// Split a link target into its path and its fragment. `path` is null for a
// same-document `#anchor`; `fragment` is null when the link carries none.
const normalizeLinkTarget = raw => {
    const trimmed = raw.trim();
    const target = trimmed.startsWith('<')
        ? /^<([^>]+)>/.exec(trimmed)?.[1]
        : /^[^\s]+/.exec(trimmed)?.[0];
    if (!target || target.startsWith('/') || target.startsWith('//')
        || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
    const hash = target.indexOf('#');
    const rawPath = hash < 0 ? target : target.slice(0, hash);
    const fragment = hash < 0 ? null : target.slice(hash + 1) || null;
    let file = rawPath.split('?', 1)[0];
    try { file = decodeURIComponent(file); } catch { /* keep the raw spelling */ }
    if (!file && !fragment) return null;
    return { path: file || null, fragment };
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

// GitHub's heading slugs: drop inline formatting, lower-case, remove everything
// that is not a letter, number, underscore, hyphen, or space, then turn each
// remaining space into a hyphen. Spaces are not collapsed first, so a heading
// with an em dash keeps the double hyphen its surrounding spaces produce.
// Repeated slugs in one document gain -1, -2, ... in document order.
const slugify = heading => heading
    .replace(/!?\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');

const headingSlugs = markdown => {
    const slugs = new Set();
    const seen = new Map();
    for (const line of withoutFencedCode(markdown).split('\n')) {
        const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
        if (!heading) continue;
        const base = slugify(heading[1]);
        if (!base) continue;
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        slugs.add(count ? `${base}-${count}` : base);
    }
    // GitHub also honours an explicit id on an anchor or heading.
    for (const match of markdown.matchAll(/(?:id|name)=["']([^"']+)["']/g)) slugs.add(match[1]);
    return slugs;
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

const inDirectory = async directory => (await readdir(path.join(root, directory)))
    .filter(name => name.endsWith('.md'))
    .map(name => path.join(directory, name));

const maintainedDocuments = async () => [
    ...ROOT_LIVING_DOCS,
    ...await inDirectory('docs'),
    ...await inDirectory('docs/plans'),
].sort();

// Every checked-in Markdown file, archive included. Archived notes are
// point-in-time records whose prose, file names, and line references are
// allowed to be stale — but a link that resolves to nothing costs a reader the
// same time either way, which is why they are held to link resolution and not
// to the backticked repository paths in their prose.
const allDocuments = async () => [
    ...await maintainedDocuments(),
    ...await inDirectory('docs/archive'),
].sort();

test('maintained-document target extraction distinguishes links and repository paths', () => {
    const sample = [
        '[design](docs/design.md#contract)',
        '[site](https://example.com/docs/design.md)',
        '[here](#local-anchor)',
        '`src/example.js` and `storage.local`',
        '```js',
        '`test/not-a-doc-reference.test.mjs`',
        '```',
    ].join('\n');
    assert.deepEqual(relativeLinks(sample), [
        { path: 'docs/design.md', fragment: 'contract' },
        { path: null, fragment: 'local-anchor' },
    ]);
    assert.deepEqual(repositoryPaths(sample), ['src/example.js']);
});

test('heading slugs follow GitHub rules', () => {
    const sample = [
        '# Sidebar section navigation',
        "### F13 — The bar's theme has two owners — **fixed**",
        '## Deep dive: `settings-schema.js`',
        '## Repeat',
        '## Repeat',
    ].join('\n');
    assert.deepEqual([...headingSlugs(sample)], [
        'sidebar-section-navigation',
        // Punctuation is dropped without collapsing the spaces around it, so
        // the em dashes leave double hyphens behind.
        'f13--the-bars-theme-has-two-owners--fixed',
        'deep-dive-settings-schemajs',
        'repeat',
        'repeat-1',
    ]);
});

test('every relative link resolves, in maintained and archived documents alike', async () => {
    const maintained = new Set(await maintainedDocuments());
    const slugCache = new Map();
    const slugsFor = async absolute => {
        if (!slugCache.has(absolute)) {
            slugCache.set(absolute, headingSlugs(await readFile(absolute, 'utf8')));
        }
        return slugCache.get(absolute);
    };

    const missing = [];
    for (const relativeDocument of await allDocuments()) {
        const absoluteDocument = path.join(root, relativeDocument);
        const markdown = await readFile(absoluteDocument, 'utf8');

        for (const { path: target, fragment } of relativeLinks(markdown)) {
            const absolute = target
                ? path.resolve(path.dirname(absoluteDocument), target)
                : absoluteDocument;
            if (target) {
                try {
                    await access(absolute);
                } catch {
                    missing.push(`${relativeDocument}: ${path.relative(root, absolute)}`);
                    continue;
                }
            }
            // A fragment is only checkable when it points into Markdown we own.
            if (!fragment || !absolute.endsWith('.md')) continue;
            if (!(await slugsFor(absolute)).has(fragment)) {
                missing.push(
                    `${relativeDocument}: ${path.relative(root, absolute)}#${fragment} (no such heading)`);
            }
        }

        // Backticked repository paths are prose about the current tree, so only
        // maintained documents are held to them.
        if (!maintained.has(relativeDocument)) continue;
        for (const target of new Set(repositoryPaths(markdown))) {
            const absolute = path.resolve(root, target);
            try {
                await access(absolute);
            } catch {
                missing.push(`${relativeDocument}: ${path.relative(root, absolute)}`);
            }
        }
    }
    assert.deepEqual(missing, [],
        `documentation points at missing targets:\n${missing.join('\n')}`);
});
