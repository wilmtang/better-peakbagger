// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'nextlevelbuilder/ui-ux-pro-max-skill';
const SOURCE = '.claude/skills/ui-ux-pro-max';
export const SKILL_PATH = '.agents/skills/ui-ux-pro-max';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const REQUIRED_FILES = ['SKILL.md', 'scripts/search.py', 'scripts/core.py', 'scripts/validate_data.py'];

export interface GitTreeEntry {
    path: string;
    type: string;
    mode: string;
    size?: number;
    sha?: string;
}

export interface ValidatedSkillTreeEntry extends GitTreeEntry {
    size: number;
    sha: string;
}

export interface GitTree {
    truncated?: boolean;
    tree?: GitTreeEntry[];
}

export type SkillChange =
    | { file: string; content: Buffer; mode: string }
    | { file: string; content: null };

export interface PlanSkillUpdateOptions {
    root: string;
    baseTree: GitTree;
    headTree: GitTree;
    revision: string;
    readUpstream: (commit: string, filePath: string) => Promise<string | Uint8Array>;
    date: Date;
}

export function blobHash(content: string | Uint8Array): string {
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

export function parseProvenance(content: string): string {
    const revisions = [...content.matchAll(/^- Revision: `([a-f0-9]{40})`$/gm)];
    if (revisions.length !== 1
        || !content.includes(`- Repository: https://github.com/${REPOSITORY}\n`)
        || !content.includes(`- Source directory: \`${SOURCE}\`\n`)) {
        throw new Error('Unrecognized skill provenance; update the integration manually.');
    }
    return revisions[0][1];
}

export function selectSkillFiles(tree: GitTree): Map<string, ValidatedSkillTreeEntry> {
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete upstream tree.');
    const files = new Map<string, ValidatedSkillTreeEntry>();
    let totalBytes = 0;
    for (const entry of tree.tree) {
        if (!entry.path.startsWith(`${SOURCE}/`) || entry.type === 'tree') continue;
        const relative = entry.path.slice(SOURCE.length + 1);
        if (relative.split('/').some(part => !part || part === '.' || part === '..')
            || relative.includes('\\')) throw new Error(`Unsafe upstream path: ${relative}`);
        const selected = relative === 'SKILL.md'
            || relative.startsWith('data/') || relative.startsWith('references/')
            || (relative.startsWith('scripts/') && !relative.startsWith('scripts/tests/'));
        if (!selected) continue;
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
            || (relative.startsWith('scripts/') && !relative.endsWith('.py'))) {
            throw new Error(`Unsupported upstream file: ${relative}`);
        }
        if (typeof entry.sha !== 'string' || !/^[a-f0-9]{40}$/.test(entry.sha)
            || typeof entry.size !== 'number'
            || !Number.isSafeInteger(entry.size) || entry.size < 0
            || entry.size > MAX_FILE_BYTES || files.has(relative)) {
            throw new Error(`Invalid upstream file metadata: ${relative}`);
        }
        totalBytes += entry.size;
        files.set(relative, { ...entry, size: entry.size, sha: entry.sha });
    }
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Upstream skill exceeds the size limit.');
    for (const file of REQUIRED_FILES) {
        if (!files.has(file)) throw new Error(`Upstream skill is missing ${file}.`);
    }
    return files;
}

async function installedFiles(root: string): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>();
    async function visit(relative: string): Promise<void> {
        const target = path.join(root, relative);
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) throw new Error(`Unexpected local symlink: ${relative}`);
        if (stat.isDirectory()) {
            for (const name of await readdir(target)) {
                if (name === '__pycache__' || name.endsWith('.pyc')) continue;
                await visit(`${relative}/${name}`);
            }
        } else if (stat.isFile()) {
            files.set(relative, await readFile(target));
        } else {
            throw new Error(`Unsupported local file: ${relative}`);
        }
    }
    for (const directory of ['scripts', 'data', 'references']) await visit(directory);
    return files;
}

export async function mergeSkillMarkdown(
    local: string | Uint8Array,
    base: string | Uint8Array,
    upstream: string | Uint8Array,
): Promise<Buffer> {
    const temporary = await mkdtemp(path.join(tmpdir(), 'bpb-skill-merge-'));
    try {
        const files = ['local', 'base', 'upstream'].map(name => path.join(temporary, name));
        const contents = [local, base, upstream];
        await Promise.all(files.map((file, index) => writeFile(file, contents[index])));
        const result = spawnSync('git', ['merge-file', '-p', '--', ...files], {
            encoding: 'utf8', maxBuffer: MAX_FILE_BYTES,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error('Upstream SKILL.md conflicts with local guidance; resolve it manually.');
        }
        return Buffer.from(result.stdout);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

// Prepare every byte before writing anything. Download failures, local changes,
// unsupported layouts, license changes and merge conflicts leave the copy intact.
export async function planSkillUpdate({
    root,
    baseTree,
    headTree,
    revision,
    readUpstream,
    date,
}: PlanSkillUpdateOptions): Promise<SkillChange[]> {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full upstream commit SHA.');
    const provenance = await readFile(path.join(root, 'UPSTREAM.md'), 'utf8');
    const previous = parseProvenance(provenance);
    if (previous === revision) return [];
    for (const file of ['SKILL.md', 'LICENSE', 'UPSTREAM.md']) {
        if (!(await lstat(path.join(root, file))).isFile()) {
            throw new Error(`Expected a regular local file: ${file}`);
        }
    }
    const base = selectSkillFiles(baseTree);
    const head = selectSkillFiles(headTree);
    const local = await installedFiles(root);
    for (const [file, bytes] of local) {
        const baseEntry = base.get(file);
        if (!baseEntry || blobHash(bytes) !== baseEntry.sha) {
            throw new Error(`Local upstream file has changed: ${file}`);
        }
    }
    for (const file of base.keys()) {
        if (file !== 'SKILL.md' && !local.has(file)) throw new Error(`Missing local upstream file: ${file}`);
    }
    const license = headTree.tree?.find(entry => entry.path === 'LICENSE');
    if (license?.type !== 'blob' || license.mode !== '100644'
        || blobHash(await readFile(path.join(root, 'LICENSE'))) !== license.sha) {
        throw new Error('Upstream license changed; review it manually.');
    }
    async function download(commit: string, entry: ValidatedSkillTreeEntry): Promise<Buffer> {
        const raw = await readUpstream(commit, entry.path);
        const bytes = typeof raw === 'string'
            ? Buffer.from(raw)
            : Buffer.from(raw);
        if (bytes.length !== entry.size || blobHash(bytes) !== entry.sha) {
            throw new Error(`Upstream download did not match its pinned blob: ${entry.path}`);
        }
        return bytes;
    }
    const changes: SkillChange[] = [];
    for (const [file, entry] of head) {
        if (file === 'SKILL.md') continue;
        const localBytes = local.get(file);
        if (localBytes && blobHash(localBytes) === entry.sha
            && base.get(file)?.mode === entry.mode) continue;
        changes.push({ file, content: await download(revision, entry), mode: entry.mode });
    }
    for (const file of local.keys()) {
        if (!head.has(file)) changes.push({ file, content: null });
    }
    const baseSkill = base.get('SKILL.md')!;
    const headSkill = head.get('SKILL.md')!;
    if (baseSkill.sha !== headSkill.sha) {
        const content = await mergeSkillMarkdown(
            await readFile(path.join(root, 'SKILL.md')),
            await download(previous, baseSkill),
            await download(revision, headSkill),
        );
        changes.push({ file: 'SKILL.md', content, mode: '100644' });
    }
    let updated = provenance.replace(`- Revision: \`${previous}\``, `- Revision: \`${revision}\``);
    const updatedLine = `- Updated: ${date.toISOString().slice(0, 10)}`;
    if (/^- Updated: .+$/m.test(updated)) updated = updated.replace(/^- Updated: .+$/m, updatedLine);
    else updated = updated.replace(/^(- Installed: .+)$/m, `$1\n${updatedLine}`);
    changes.push({ file: 'UPSTREAM.md', content: Buffer.from(updated), mode: '100644' });
    return changes;
}

export async function applySkillUpdate(root: string, changes: readonly SkillChange[]): Promise<void> {
    for (const change of changes) {
        const target = path.join(root, change.file);
        if (change.content === null) await rm(target);
        else {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, change.content);
            await chmod(target, change.mode === '100755' ? 0o755 : 0o644);
        }
    }
}

async function upstreamBytes(url: string): Promise<Buffer> {
    const response = await fetch(url, {
        redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'better-peakbagger-skill-updater' },
    });
    if (!response.ok) throw new Error(`Upstream request failed (${response.status}): ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_TOTAL_BYTES) throw new Error('Upstream response exceeds the size limit.');
    return bytes;
}

async function upstreamJson<T>(url: string): Promise<T> {
    return JSON.parse((await upstreamBytes(url)).toString('utf8')) as T;
}

function assertCleanSkill(repositoryRoot: string): void {
    const status = spawnSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--', SKILL_PATH], {
        cwd: repositoryRoot, encoding: 'utf8',
    });
    if (status.error) throw status.error;
    if (status.status !== 0 || status.stdout.trim()) throw new Error('The skill working tree must be clean.');
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
    if (args.some(arg => arg !== '--check') || args.length > 1) {
        throw new Error('Usage: node scripts/update-ui-ux-skill.mts [--check]');
    }
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const root = path.join(repositoryRoot, SKILL_PATH);
    if (!(await lstat(root)).isDirectory()) throw new Error('Expected the canonical skill directory.');
    assertCleanSkill(repositoryRoot);
    const previous = parseProvenance(await readFile(path.join(root, 'UPSTREAM.md'), 'utf8'));
    const api = `https://api.github.com/repos/${REPOSITORY}`;
    const { sha: revision } = await upstreamJson<{ sha: string }>(`${api}/commits/main`);
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid upstream head.');
    if (previous === revision) {
        console.log(JSON.stringify({ previous, revision, changed: false, files: [] }));
        return;
    }
    const comparison = await upstreamJson<{
        status: string;
        merge_base_commit?: { sha?: string };
    }>(`${api}/compare/${previous}...${revision}`);
    if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== previous) {
        throw new Error('Upstream history diverged from the installed revision; review it manually.');
    }
    const [baseTree, headTree] = await Promise.all([previous, revision].map(commit =>
        upstreamJson<GitTree>(`${api}/git/trees/${commit}?recursive=1`)));
    const changes = await planSkillUpdate({
        root, baseTree, headTree, revision, date: new Date(),
        readUpstream: (commit, file) => upstreamBytes(
            `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file}`,
        ),
    });
    if (!args.includes('--check')) {
        assertCleanSkill(repositoryRoot);
        await applySkillUpdate(root, changes);
    }
    console.log(JSON.stringify({ previous, revision, changed: changes.length > 0, files: changes.map(change => change.file) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
