// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';
import {
    applySkillUpdate, blobHash, main, mergeSkillMarkdown, parseProvenance,
    planSkillUpdate, selectSkillFiles, SKILL_PATH,
} from '../../scripts/update-ui-ux-skill.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = '.claude/skills/ui-ux-pro-max';
const previous = 'a'.repeat(40);
const revision = 'b'.repeat(40);
const provenance = `# Upstream source

- Repository: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Revision: \`${previous}\`
- Source directory: \`${source}\`
- Installed: 2026-10-22
- Updated: 2026-10-22
`;
const upstreamMarkdown = '# Skill\n\nSearch guidance.\n\n## Details\n\nOriginal guidance.\n';
const localMarkdown = upstreamMarkdown.replace('## Details', '## Better Peakbagger integration\n\nFollow AGENTS.md.\n\n## Details');

function tree(files) {
    return {
        truncated: false,
        tree: [...files].map(([file, content]) => ({
            path: file === 'LICENSE' ? file : `${source}/${file}`,
            type: 'blob', mode: '100644', size: Buffer.byteLength(content), sha: blobHash(content),
        })),
    };
}

async function fixture(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-skill-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const files = new Map([
        ['SKILL.md', upstreamMarkdown], ['LICENSE', 'MIT notice\n'],
        ['scripts/core.py', 'old core\n'], ['scripts/search.py', 'old search\n'],
        ['scripts/validate_data.py', 'old validator\n'],
        ['data/keep.csv', 'old data\n'], ['data/remove.csv', 'obsolete\n'],
        ['references/guide.md', 'reference\n'],
    ]);
    for (const [file, content] of files) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), file === 'SKILL.md' ? localMarkdown : content);
    }
    await writeFile(path.join(directory, 'UPSTREAM.md'), provenance);
    return { directory, files };
}

function options(directory, baseFiles, headFiles) {
    return {
        root: directory, revision, date: new Date('2026-10-31T15:00:00Z'),
        baseTree: tree(baseFiles), headTree: tree(headFiles),
        readUpstream: async (commit, file) => (commit === previous ? baseFiles : headFiles)
            .get(file.slice(source.length + 1)),
    };
}

test('skill updates add, change and remove upstream files while preserving local integration', async t => {
    const { directory, files } = await fixture(t);
    const next = new Map(files);
    next.set('scripts/core.py', 'new core\n');
    next.set('data/add.csv', 'new data\n');
    next.delete('data/remove.csv');
    next.set('scripts/tests/test_upstream.py', 'not part of the installed copy\n');
    next.set('SKILL.md', upstreamMarkdown.replace('Original guidance.', 'Updated guidance.'));
    const changes = await planSkillUpdate(options(directory, files, next));
    assert.equal(await readFile(path.join(directory, 'scripts/core.py'), 'utf8'), 'old core\n',
        'planning must not change files before all downloads and merges succeed');
    await applySkillUpdate(directory, changes);
    assert.equal(await readFile(path.join(directory, 'scripts/core.py'), 'utf8'), 'new core\n');
    assert.equal(await readFile(path.join(directory, 'data/add.csv'), 'utf8'), 'new data\n');
    await assert.rejects(readFile(path.join(directory, 'data/remove.csv')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(directory, 'scripts/tests/test_upstream.py')), { code: 'ENOENT' });
    const markdown = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
    assert.ok(markdown.includes('Follow AGENTS.md.'));
    assert.ok(markdown.includes('Updated guidance.'));
    assert.equal(await readFile(path.join(directory, 'LICENSE'), 'utf8'), files.get('LICENSE'));
    const updated = await readFile(path.join(directory, 'UPSTREAM.md'), 'utf8');
    assert.equal(parseProvenance(updated), revision);
    assert.ok(updated.includes('- Installed: 2026-10-22'));
    assert.ok(updated.includes('- Updated: 2026-10-31'));
});

test('unchanged upstream instructions retain the complete local skill verbatim', async t => {
    const { directory, files } = await fixture(t);
    await mkdir(path.join(directory, 'scripts/__pycache__'));
    await writeFile(path.join(directory, 'scripts/__pycache__/core.cpython.pyc'), 'local Python cache');
    await writeFile(path.join(directory, 'scripts/core.pyc'), 'legacy Python cache');
    const changes = await planSkillUpdate(options(directory, files, files));
    assert.deepEqual(changes.map(change => change.file), ['UPSTREAM.md']);
    await applySkillUpdate(directory, changes);
    assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), localMarkdown);
    assert.deepEqual(await planSkillUpdate(options(directory, files, files)), [],
        'repeating the same pinned update must be a no-op');
});

test('a conflicting instruction update fails without altering the installed copy', async t => {
    const { directory, files } = await fixture(t);
    const next = new Map(files);
    await writeFile(path.join(directory, 'SKILL.md'), upstreamMarkdown.replace('Original guidance.', 'Local policy.'));
    next.set('SKILL.md', upstreamMarkdown.replace('Original guidance.', 'Conflicting policy.'));
    await assert.rejects(planSkillUpdate(options(directory, files, next)), /conflicts with local guidance/);
    assert.equal(await readFile(path.join(directory, 'UPSTREAM.md'), 'utf8'), provenance);
});

test('modified, missing and extra local upstream files stop an update', async t => {
    for (const kind of ['modified', 'missing', 'extra']) {
        await t.test(kind, async subtest => {
            const { directory, files } = await fixture(subtest);
            if (kind === 'modified') await writeFile(path.join(directory, 'scripts/core.py'), 'local changes\n');
            if (kind === 'missing') await rm(path.join(directory, 'scripts/core.py'));
            if (kind === 'extra') await writeFile(path.join(directory, 'scripts/extra.py'), 'local helper\n');
            await assert.rejects(planSkillUpdate(options(directory, files, files)), /[Ll]ocal upstream file/);
            assert.equal(await readFile(path.join(directory, 'UPSTREAM.md'), 'utf8'), provenance);
        });
    }
});

test('license changes and corrupted downloads cannot be integrated', async t => {
    const { directory, files } = await fixture(t);
    const next = new Map(files);
    next.set('LICENSE', 'different terms\n');
    await assert.rejects(planSkillUpdate(options(directory, files, next)), /license changed/);
    next.set('LICENSE', files.get('LICENSE'));
    next.set('scripts/core.py', 'new core\n');
    const corrupt = { ...options(directory, files, next), readUpstream: async () => 'corrupt download\n' };
    await assert.rejects(planSkillUpdate(corrupt), /did not match its pinned blob/);
    assert.equal(await readFile(path.join(directory, 'scripts/core.py'), 'utf8'), 'old core\n');
});

test('upstream traversal, symlinks, incomplete trees and unsupported helpers fail closed', async t => {
    const { files } = await fixture(t);
    const snapshot = tree(files);
    assert.throws(() => selectSkillFiles({ ...snapshot, truncated: true }), /Incomplete/);
    assert.throws(() => selectSkillFiles({ tree: [] }), /missing/);
    for (const entry of [
        { path: `${source}/data/../../escape.csv`, type: 'blob', mode: '100644' },
        { path: `${source}/scripts/link.py`, type: 'blob', mode: '120000' },
        { path: `${source}/scripts/execute.sh`, type: 'blob', mode: '100644' },
    ]) {
        assert.throws(() => selectSkillFiles({ tree: [...snapshot.tree, entry] }), /Unsafe|Unsupported/);
    }
});

test('unexpected local symlinks cannot redirect update writes', async t => {
    const { directory, files } = await fixture(t);
    await rm(path.join(directory, 'data/keep.csv'));
    await symlink(path.join(directory, 'LICENSE'), path.join(directory, 'data/keep.csv'));
    await assert.rejects(planSkillUpdate(options(directory, files, files)), /Unexpected local symlink/);
});

test('top-level skill symlinks cannot redirect an instruction merge outside the skill', async t => {
    const { directory, files } = await fixture(t);
    await rm(path.join(directory, 'SKILL.md'));
    await symlink(path.join(directory, 'LICENSE'), path.join(directory, 'SKILL.md'));
    await assert.rejects(planSkillUpdate(options(directory, files, files)), /Expected a regular local file/);
});

test('provenance and CLI selections reject ambiguity instead of silently succeeding', async () => {
    assert.equal(parseProvenance(provenance), previous);
    assert.throws(() => parseProvenance(`${provenance}- Revision: \`${revision}\`\n`), /Unrecognized/);
    assert.throws(() => parseProvenance(provenance.replace('nextlevelbuilder/', 'other-owner/')), /Unrecognized/);
    await assert.rejects(main(['--unknown']), /Usage:/);
    await assert.rejects(main(['--check', '--check']), /Usage:/);
    assert.equal((await mergeSkillMarkdown('local\n', 'base\n', 'base\n')).toString(), 'local\n');
});

function python(args) {
    const result = spawnSync('python3', ['-B', ...args], {
        cwd: tmpdir(), encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

test('the installed skill validates its datasets and supports normal and isolated Python search', async () => {
    const scripts = path.join(root, SKILL_PATH, 'scripts');
    assert.match(python([path.join(scripts, 'validate_data.py')]), /OK: validated/);
    for (const isolated of [false, true]) {
        const result = JSON.parse(python([
            ...(isolated ? ['-I'] : []), path.join(scripts, 'search.py'),
            'keyboard focus modal', '--domain', 'ux', '--json',
        ]));
        assert.equal(result.domain, 'ux');
        assert.ok(result.count > 0);
    }
    for (const [stack, query] of [
        ['react', 'react 3d canvas effect cleanup'],
        ['html-tailwind', 'tailwind 2xl breakpoint'],
        ['angular', 'angular 2fa login form'],
    ]) {
        const result = JSON.parse(python(['-I', path.join(scripts, 'search.py'), query, '--stack', stack, '--json']));
        assert.ok(result.count > 0, query);
        assert.ok(result.results.every(row => row.Status !== 'deprecated'), query);
    }
    const design = JSON.parse(python([
        '-I', path.join(scripts, 'search.py'), 'internal analytics dashboard', '--design-system', '--json',
    ]));
    assert.ok(design && !design.error);
});

test('the shared discovery link and skill metadata remain valid', async () => {
    assert.equal(await realpath(path.join(root, '.claude/skills/ui-ux-pro-max')), path.join(root, SKILL_PATH));
    const markdown = await readFile(path.join(root, SKILL_PATH, 'SKILL.md'), 'utf8');
    const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter);
    const metadata = yaml.load(frontmatter[1]);
    assert.equal(metadata.name, 'ui-ux-pro-max');
    assert.equal(typeof metadata.description, 'string');
    assert.ok(metadata.description.length > 0 && metadata.description.length <= 1024);
});

test('automated updates use normal PR checks and verify native auto-merge at the proposed head', async () => {
    const workflow = yaml.load(await readFile(path.join(root, '.github/workflows/update-ui-ux-skill.yml'), 'utf8'));
    assert.ok(workflow.on.schedule.length > 0);
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.deepEqual(workflow.on.push.branches, ['main']);
    assert.deepEqual(workflow.permissions, { contents: 'read', 'pull-requests': 'read' });
    assert.ok(workflow.jobs.update.if.includes("github.ref == 'refs/heads/main'"));
    const steps = workflow.jobs.update.steps;
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, 'main');
    assert.equal(checkout.with['persist-credentials'], false);
    for (const step of steps) {
        if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
        if (step.run) {
            const syntax = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
            assert.equal(syntax.status, 0, `${step.name}: ${syntax.stderr}`);
        }
    }
    const integrate = steps.find(step => step.run?.includes('node scripts/update-ui-ux-skill.mjs'));
    assert.ok(integrate && !integrate.env, 'upstream integration must not receive the publishing credential');
    assert.ok(!steps.some(step => /python3|npm (?:test|run)/.test(step.run || '')),
        'candidate helpers execute only in ordinary read-only PR checks');
    const publish = steps.find(step => step.uses?.startsWith('peter-evans/create-pull-request@'));
    assert.ok(publish);
    assert.equal(publish.with.branch, 'codex/update-ui-ux-skill');
    assert.equal(publish.with.token, '${{ secrets.SKILL_UPDATE_TOKEN }}');
    assert.equal(publish.with['add-paths'], SKILL_PATH);
    const merge = steps.find(step => step.run?.includes('gh pr merge'));
    assert.match(merge.run, /--auto --merge/);
    assert.match(merge.run, /--match-head-commit "\$HEAD_SHA"/);
    assert.match(merge.run, /Merge branch 'codex\/update-ui-ux-skill' into main/);
    assert.match(merge.run, /autoMergeRequest\.mergeMethod == "MERGE"/);
    assert.ok(merge.if.includes("pull-request-operation != 'closed'"), 'a closed no-longer-needed update must not be merged');
    assert.doesNotMatch(merge.run, /--admin|--squash|--rebase/);
});
