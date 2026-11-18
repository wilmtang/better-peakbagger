// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GitHub Git Data client for the ascent and TR backup (pure).
//
// Pushes one or more ascents, or one or more root files, as one atomic commit
// through GitHub's Git Data API:
// resolve the branch, read its tip, POST a tree based on the latest commit
// (adding new file contents and removing stale or renamed-away owned files),
// POST the commit, and fast-forward the ref. Small file contents ride directly
// in the tree request so a profile batch does not spend one mutation per file;
// unusually large files keep the explicit blob path. A non-fast-forward race
// re-reads the ref and rebuilds the whole batch after bounded backoff. GitHub
// does not permit creating a ref in an empty repository, so that one case is
// bootstrapped with a marker-only Contents API commit before the ordinary
// atomic commit.
//
// This module performs network I/O, but only through an *injected* fetch and an
// injected token: it holds no globals, no chrome APIs, and no ambient
// credentials, so the background worker owns the token and messaging while the
// commit mechanics stay unit-testable against a scripted fetch stub. Every
// failure surfaces as the shared GithubError with a stable code
// so callers map one actionable sentence per case (see the error taxonomy in
// docs/github-ascent-backup.md). Idempotent to inject more than once.

import { githubBackup as Backup } from './github-backup.ts';
import {
    githubApi as GithubApi,
    type GithubApiClient,
    type GithubFetch,
    type GithubRequestOptions,
} from './github-api.ts';
import { githubErrors as GithubErrors } from './github-errors.ts';

export interface CreateGithubClientOptions {
    fetch?: GithubFetch;
    token?: string | null;
    owner?: string;
    repo?: string;
    branch?: string | null;
    sleep?: (ms: number) => Promise<unknown>;
    inlineFileLimitBytes?: number;
    signal?: AbortSignal | null;
}

export interface AscentBackupSnapshot {
    ascent?: {
        id?: unknown;
        date?: unknown;
        suffix?: unknown;
        type?: unknown;
        route?: unknown;
        routeDown?: unknown;
        externalUrl?: unknown;
        gainFt?: unknown;
        lossFt?: unknown;
        distanceUpMi?: unknown;
        distanceDnMi?: unknown;
        extraGainFt?: unknown;
        extraLossFt?: unknown;
        timeUp?: unknown;
        timeDn?: unknown;
        nightsOut?: unknown;
        startFt?: unknown;
        endFt?: unknown;
        pointFt?: unknown;
        quality?: unknown;
        gear?: unknown;
        companions?: unknown;
        weather?: unknown;
    };
    peak?: {
        id?: unknown;
        name?: unknown;
        elevationFt?: unknown;
        location?: unknown;
    };
    report?: unknown;
    backup?: {
        extensionVersion?: unknown;
        syncedAt?: unknown;
    };
}

export interface AscentBackupEntry {
    snapshot: AscentBackupSnapshot;
    gpx?: unknown;
}

export interface RootFileInput {
    path: string;
    content: string;
    verify?: (current: string | null | undefined) => unknown | Promise<unknown>;
}

export interface RootFileUpdateContext {
    head: string;
    fileSha: string | null;
    branch: string;
}

export interface UpdateRootFileOptions {
    maxBytes?: number | null;
    beforeCommit?: (() => unknown | Promise<unknown>) | null;
}

interface GitTreeNode {
    path: string;
    type: string;
    sha?: string;
    size?: number;
}

interface GitTreeResponse {
    tree: GitTreeNode[];
    truncated?: boolean;
}

interface GitBlobResponse {
    sha?: string;
    content?: string;
    encoding?: string;
}

interface RepoInfoResponse {
    archived?: boolean;
    permissions?: { push?: boolean };
    default_branch?: string;
    size?: number;
}

interface GitRefResponse {
    object?: { sha?: string };
}

interface GitCommitResponse {
    sha: string;
    html_url?: string;
    tree?: { sha?: string };
}

interface ContentsFileResponse {
    type?: string;
    encoding?: string;
    content?: string;
}

interface ContentsInitResponse {
    commit?: {
        sha?: string;
        tree?: { sha?: string };
    };
}

interface BackupRecord {
    leaf: string;
    path: string;
    treeSha: string;
}

interface HeadState {
    baseCommitSha: string;
    baseTreeSha: string;
    root: GitTreeResponse;
}

interface RootTreeInspection {
    kind: 'backup' | 'existing' | 'empty';
    marker: boolean;
    records: BackupRecord[];
    rootEntryCount: number;
}

interface ResolvedRepo {
    info: RepoInfoResponse;
    targetBranch: string;
}

type GitTreeWriteEntry =
    | { path: string; mode: typeof BLOB_MODE; type: 'blob'; content: string }
    | { path: string; mode: typeof BLOB_MODE; type: 'blob'; sha: string | null };

const { ERROR_CODES, GithubError } = GithubErrors;
const BLOB_MODE = '100644' as const;
const CONFLICT_RETRY_DELAYS = [500, 2000, 5000] as const;
const DEFAULT_INLINE_FILE_LIMIT_BYTES = 1024 * 1024;
const REPOSITORY_MARKER_PATH = '.better-peakbagger.json';
const REPOSITORY_MARKER_CONTENT = `${JSON.stringify({
    schemaVersion: 1,
    type: 'better-peakbagger-backup',
    layout: 'repository-root',
}, null, 2)}\n`;
const REPOSITORY_MARKER_BASE64 = btoa(REPOSITORY_MARKER_CONTENT);
const OWNED_FOLDER_FILES = new Set(['report.md', 'ascent.json', 'track.gpx']);

const createGithubClient = ({
    fetch,
    token,
    owner,
    repo,
    branch = null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    inlineFileLimitBytes = DEFAULT_INLINE_FILE_LIMIT_BYTES,
    signal = null,
}: CreateGithubClientOptions = {}) => {
    // One injected clock for both retry policies: the transport's transient
    // read backoff and this module's conflict backoff are steps of the same
    // caller-owned operation, so a caller that can control one must not be
    // left paying real seconds for the other.
    const api = GithubApi.createGithubApi({ fetch, token, sleep, signal });
    if (!owner || !repo) throw new TypeError('github client requires owner and repo');
    if (!Number.isFinite(inlineFileLimitBytes) || inlineFileLimitBytes < 0) {
        throw new TypeError('github client requires a non-negative inline file limit');
    }

    const repoBase = `${GithubApi.API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const request: GithubApiClient['request'] = ((
        method: string,
        path: string,
        options: GithubRequestOptions = {},
    ) => api.request(
        method,
        path.startsWith('http') ? path : `${repoBase}${path}`,
        options,
    )) as GithubApiClient['request'];

    // A tree read, one level unless recursive. Missing trees surface as
    // read-phase errors (no-access) rather than throwing raw.
    const readTree = async (sha: string, { recursive = false }: { recursive?: boolean } = {}): Promise<GitTreeResponse> => {
        const result = await request<GitTreeResponse>('GET', `/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, { phase: 'read' });
        if (!result || !Array.isArray(result.tree)) {
            throw new GithubError(ERROR_CODES.INVALID, 'GitHub returned an invalid repository tree.');
        }
        if (result.truncated === true) {
            throw new GithubError(ERROR_CODES.INVALID,
                'GitHub truncated the repository tree. Reduce the backup repository size before trying again.');
        }
        return result;
    };

    // Root-level mountain folders plus the validated marker are the only
    // repository layout. Keeping one representation avoids ambiguous
    // ownership and makes repository inspection fail closed.
    const inspectRootTree = async (root: GitTreeResponse): Promise<RootTreeInspection> => {
        const entries = (root && root.tree) || [];
        const markerEntry = entries.find(node => node.path === REPOSITORY_MARKER_PATH);
        if (markerEntry && markerEntry.type !== 'blob') {
            throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                `The repository already uses ${REPOSITORY_MARKER_PATH} for something else.`);
        }
        if (markerEntry) {
            const markerBlob = await request<GitBlobResponse>('GET', `/git/blobs/${markerEntry.sha}`, { phase: 'read' });
            const content = markerBlob && typeof markerBlob.content === 'string'
                ? markerBlob.content.replace(/\s/g, '')
                : '';
            if (!markerBlob || markerBlob.encoding !== 'base64' || content !== REPOSITORY_MARKER_BASE64) {
                throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                    `The repository's ${REPOSITORY_MARKER_PATH} file is not a Better Peakbagger marker.`);
            }
        }

        const rootFolders: BackupRecord[] = entries
            .filter(node => node.type === 'tree' && Backup.isBackupFolderName(node.path))
            .map(node => ({ leaf: node.path, path: node.path, treeSha: node.sha as string }));

        // Without our marker, root folders that look exactly like the paths
        // we own are ambiguous. Refuse to adopt and potentially prune them.
        if (!markerEntry && rootFolders.length) {
            throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                'This repository already contains root folders that look like Better Peakbagger backups.');
        }

        const records = rootFolders;
        const kind = markerEntry ? 'backup' : entries.length ? 'existing' : 'empty';
        return {
            kind,
            marker: !!markerEntry,
            records,
            rootEntryCount: entries.length,
        };
    };

    const matchingRecords = (records: BackupRecord[], ascentId: unknown): BackupRecord[] => {
        if (ascentId == null) return [];
        const suffix = `-a${ascentId}`;
        return records.filter(record => Backup.isBackupFolderName(record.leaf) && record.leaf.endsWith(suffix));
    };

    // Only files Better Peakbagger itself owns are pruned. User-added notes
    // or other content survive an in-place refresh or folder rename.
    const oldFolderOwnedPaths = async (record: BackupRecord | null | undefined): Promise<string[]> => {
        if (!record) return [];
        const sub = await readTree(record.treeSha, { recursive: true });
        return (sub.tree || [])
            .filter(node => node.type === 'blob' && OWNED_FOLDER_FILES.has(node.path))
            .map(node => `${record.path}/${node.path}`);
    };

    // Resolve the target branch and fail closed on read-only / no-push repos
    // before writing anything, so those cases get a clean pre-flight error
    // instead of a confusing mid-push rejection.
    const resolveRepo = async (): Promise<ResolvedRepo> => {
        const info = await request<RepoInfoResponse>('GET', '', { phase: 'read' });
        if (info.archived) {
            throw new GithubError(ERROR_CODES.ARCHIVED, 'The backup repository is archived and read-only.', { status: 403 });
        }
        if (info.permissions && info.permissions.push === false) {
            throw new GithubError(ERROR_CODES.NO_ACCESS, 'This token cannot write to the backup repository.', { status: 403 });
        }
        return { info, targetBranch: branch || info.default_branch || 'main' };
    };

    const readHead = async ({ info, targetBranch }: ResolvedRepo): Promise<HeadState | null> => {
        let ref: GitRefResponse | null;
        try {
            ref = await request<GitRefResponse>('GET', `/git/ref/heads/${encodeURIComponent(targetBranch)}`, {
                phase: 'ref', allowNotFound: true,
            });
        } catch (error) {
            // GitHub's refs endpoint returns 409 (not 404) for a repository
            // with no commits. Treat only that exact response as an absent
            // head; other conflicts must keep failing closed.
            const errObj = error && typeof error === 'object' ? (error as { status?: unknown; message?: unknown }) : null;
            if (errObj && errObj.status === 409 && /git repository is empty/i.test(String(errObj.message || ''))) ref = null;
            else throw error;
        }
        if (!ref) {
            if (Number(info.size) === 0) return null;
            throw new GithubError(ERROR_CODES.BRANCH_MISSING,
                'The backup repository has no branch to commit to yet.', { status: 404 });
        }
        const baseCommitSha = (ref.object && ref.object.sha) as string;
        const baseCommit = await request<GitCommitResponse>('GET', `/git/commits/${baseCommitSha}`, { phase: 'read' });
        const baseTreeSha = (baseCommit.tree && baseCommit.tree.sha) as string;
        const root = await readTree(baseTreeSha);
        return { baseCommitSha, baseTreeSha, root };
    };

    // GitHub's Git References API explicitly refuses to create the first
    // branch in an empty repository. Seed only our ownership marker through
    // the Contents API, then keep every ascent on the atomic Git Data path.
    const initializeEmptyRepository = async ({ targetBranch }: { targetBranch: string }): Promise<HeadState> => {
        const initialized = await request<ContentsInitResponse>('PUT', `/contents/${encodeURIComponent(REPOSITORY_MARKER_PATH)}`, {
            body: {
                message: 'Initialize Better Peakbagger backup',
                content: REPOSITORY_MARKER_BASE64,
                branch: targetBranch,
            },
            phase: 'write',
        });
        const commit = initialized && initialized.commit;
        const baseCommitSha = commit && commit.sha;
        const baseTreeSha = commit && commit.tree && commit.tree.sha;
        if (!baseCommitSha || !baseTreeSha) {
            throw new GithubError(ERROR_CODES.INVALID,
                'GitHub did not return the initialized repository commit.');
        }
        return { baseCommitSha, baseTreeSha, root: await readTree(baseTreeSha) };
    };

    const inspectRepository = async () => {
        const resolved = await resolveRepo();
        const head = await readHead(resolved);
        if (!head) {
            return {
                kind: 'empty' as const, branch: resolved.targetBranch, hasBranch: false,
                folderCount: 0,
            };
        }
        const state = await inspectRootTree(head.root);
        return {
            kind: state.kind,
            branch: resolved.targetBranch,
            hasBranch: true,
            folderCount: state.records.length,
        };
    };

    const writeBlob = async (content: string): Promise<{ sha: string }> => request<{ sha: string }>('POST', '/git/blobs', {
        body: { content, encoding: 'utf-8' },
        phase: 'write',
    });

    const contentBytes = (content: string): number => new TextEncoder().encode(content).byteLength;

    const rootFilePath = (path: unknown): string => {
        if (typeof path !== 'string' || !path || path === '.' || path === '..'
                || path.includes('/') || path.includes('\\') || path === REPOSITORY_MARKER_PATH) {
            throw new TypeError('github client requires a non-reserved root file path');
        }
        return path;
    };

    const decodeBase64Utf8 = (value: string): string => {
        try {
            const binary = atob(value.replace(/\s/g, ''));
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (cause) {
            throw new GithubError(ERROR_CODES.INVALID,
                'GitHub returned invalid base64 file content.', { cause });
        }
    };

    const readBlobText = async (sha: string): Promise<string> => {
        const blob = await request<GitBlobResponse>('GET', `/git/blobs/${sha}`, { phase: 'read' });
        if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
            throw new GithubError(ERROR_CODES.INVALID,
                'GitHub returned an invalid backup file.');
        }
        return decodeBase64Utf8(blob.content);
    };

    const readBoundedRawBlobText = async (
        sha: string,
        { maxBytes, expectedSize = null }: { maxBytes?: number; expectedSize?: number | null } = {},
    ): Promise<string> => {
        if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new TypeError('github client requires a positive root-file byte limit');
        }
        if (expectedSize != null && (typeof expectedSize !== 'number' || !Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
            throw new GithubError(ERROR_CODES.INVALID,
                'GitHub returned an invalid backup file size.');
        }
        if (expectedSize != null && expectedSize > maxBytes) {
            throw new GithubError(ERROR_CODES.INVALID,
                'The GitHub backup file is larger than this recovery operation can safely process.');
        }
        const text = await request('GET', `/git/blobs/${sha}`, {
            phase: 'read',
            accept: 'application/vnd.github.raw+json',
            responseType: 'text',
            maxBytes,
            maxChars: maxBytes,
        });
        if (expectedSize != null && contentBytes(text) !== expectedSize) {
            throw new GithubError(ERROR_CODES.INVALID,
                'GitHub returned a backup file whose size did not match its repository entry.');
        }
        return text;
    };

    const normalizeBatch = (entries: AscentBackupEntry[]): AscentBackupEntry[] => {
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new TypeError('github client requires at least one ascent and TR backup');
        }
        const seen = new Set<number>();
        return entries.map(entry => {
            const snapshot = entry && entry.snapshot;
            const ascentId = snapshot && snapshot.ascent ? Number(snapshot.ascent.id) : NaN;
            if (!Number.isFinite(ascentId) || ascentId <= 0 || seen.has(ascentId)) {
                throw new TypeError('github client requires unique positive ascent ids');
            }
            seen.add(ascentId);
            return { snapshot, gpx: entry.gpx };
        });
    };

    const commitMessageFor = (backups: ReturnType<typeof Backup.buildBackup>[]): string => {
        if (backups.length === 1) return backups[0]!.message;
        return backups.every(backup => backup.isUpdate)
            ? `Refresh ${backups.length} ascents and TRs`
            : `Back up ${backups.length} ascents and TRs`;
    };

    const commitBatchOnce = async (entries: AscentBackupEntry[]) => {
        const resolved = await resolveRepo();
        const head = await readHead(resolved) || await initializeEmptyRepository(resolved);
        const state = await inspectRootTree(head.root);
        const workingFolders = state.records.map(record => record.leaf);
        const backups = entries.map(({ snapshot, gpx }) => {
            const backup = Backup.buildBackup(snapshot, { gpx, existingFolders: workingFolders });
            const ascentId = snapshot.ascent!.id;
            const suffix = `-a${ascentId}`;
            for (let i = workingFolders.length - 1; i >= 0; i -= 1) {
                if (workingFolders[i]!.endsWith(suffix)) workingFolders.splice(i, 1);
            }
            workingFolders.push(backup.folder);
            return backup;
        });
        const newPaths = new Set(backups.flatMap(backup => backup.files.map(file => file.path)));

        // Files under the old folder that the new payload will not overwrite
        // get a null sha in the tree, which deletes them relative to the base
        // tree — the rename move and stale-file prune in one atomic tree.
        const removals: string[] = [];
        for (const { snapshot } of entries) {
            const oldRecords = matchingRecords(state.records, snapshot.ascent!.id);
            for (const record of oldRecords) removals.push(...await oldFolderOwnedPaths(record));
        }

        const treeEntries: GitTreeWriteEntry[] = [];
        for (const file of backups.flatMap(backup => backup.files)) {
            if (contentBytes(file.content) <= inlineFileLimitBytes) {
                treeEntries.push({ path: file.path, mode: BLOB_MODE, type: 'blob', content: file.content });
            } else {
                const blob = await writeBlob(file.content);
                treeEntries.push({ path: file.path, mode: BLOB_MODE, type: 'blob', sha: blob.sha });
            }
        }
        if (!state.marker) {
            treeEntries.push({
                path: REPOSITORY_MARKER_PATH,
                mode: BLOB_MODE,
                type: 'blob',
                content: REPOSITORY_MARKER_CONTENT,
            });
        }
        for (const path of new Set(removals.filter(candidate => !newPaths.has(candidate)))) {
            treeEntries.push({ path, mode: BLOB_MODE, type: 'blob', sha: null });
        }

        const tree = await request<{ sha: string }>('POST', '/git/trees', {
            body: { base_tree: head.baseTreeSha, tree: treeEntries },
            phase: 'write',
        });
        const commit = await request<GitCommitResponse>('POST', '/git/commits', {
            body: { message: commitMessageFor(backups), tree: tree.sha, parents: [head.baseCommitSha] },
            phase: 'write',
        });
        await request('PATCH', `/git/refs/heads/${encodeURIComponent(resolved.targetBranch)}`, {
            body: { sha: commit.sha, force: false },
            phase: 'ref',
        });

        const commitUrl = commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`;
        return {
            sha: commit.sha,
            commitUrl,
            count: backups.length,
            message: commitMessageFor(backups),
            items: backups.map(backup => ({
                isUpdate: backup.isUpdate,
                folder: backup.folder,
                message: backup.message,
            })),
        };
    };

    // Re-read and rebuild after a bounded backoff when GitHub reports a
    // transient repository/ref conflict. Every branch-mutating operation
    // shares this schedule so root-file and ascent commits have identical
    // compare-and-swap behavior.
    const withConflictRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                const delayMs = CONFLICT_RETRY_DELAYS[attempt];
                if (!(error instanceof GithubError)
                        || error.code !== ERROR_CODES.CONFLICT
                        || delayMs === undefined) throw error;
                await sleep(delayMs);
            }
        }
    };

    const pushAscentBackups = async (entries: AscentBackupEntry[]) => {
        const normalized = normalizeBatch(entries);
        return withConflictRetry(() => commitBatchOnce(normalized));
    };

    const pushAscentBackup = async (snapshot: AscentBackupSnapshot, { gpx }: { gpx?: unknown } = {}) => {
        const batch = await pushAscentBackups([{ snapshot, gpx }]);
        const item = batch.items[0]!;
        return {
            sha: batch.sha,
            commitUrl: batch.commitUrl,
            message: item.message,
            isUpdate: item.isUpdate,
            folder: item.folder,
        };
    };

    const emptyAscentDeletion = (folders: string[]) => ({
        sha: null,
        commitUrl: null,
        message: null,
        removedFileCount: 0,
        folders,
        noOp: true,
    });

    const deleteAscentBackupOnce = async (ascentId: number) => {
        const resolved = await resolveRepo();
        const head = await readHead(resolved);
        if (!head) return emptyAscentDeletion([]);

        // Deletion inherits the same ownership gate as every other ascent
        // operation. In particular, never adopt a markerless lookalike
        // folder merely because its terminal ascent id happens to match.
        const state = await inspectRootTree(head.root);
        const records = matchingRecords(state.records, ascentId);
        const folders = records.map(record => record.leaf);
        if (!records.length) return emptyAscentDeletion(folders);

        const removals: string[] = [];
        for (const record of records) removals.push(...await oldFolderOwnedPaths(record));
        const paths = [...new Set(removals)];
        if (!paths.length) return emptyAscentDeletion(folders);

        const message = `Delete ascent and TR backup: ${ascentId}`;
        const tree = await request<{ sha: string }>('POST', '/git/trees', {
            body: {
                base_tree: head.baseTreeSha,
                tree: paths.map(path => ({
                    path,
                    mode: BLOB_MODE,
                    type: 'blob',
                    sha: null,
                })),
            },
            phase: 'write',
        });
        const commit = await request<GitCommitResponse>('POST', '/git/commits', {
            body: { message, tree: tree.sha, parents: [head.baseCommitSha] },
            phase: 'write',
        });
        await request('PATCH', `/git/refs/heads/${encodeURIComponent(resolved.targetBranch)}`, {
            body: { sha: commit.sha, force: false },
            phase: 'ref',
        });

        return {
            sha: commit.sha,
            commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
            message,
            removedFileCount: paths.length,
            folders,
            noOp: false,
        };
    };

    const deleteAscentBackup = (ascentId: number) => {
        if (!Number.isSafeInteger(ascentId) || ascentId <= 0) {
            throw new TypeError('github client requires a positive integer ascent id');
        }
        return withConflictRetry(() => deleteAscentBackupOnce(ascentId));
    };

    // Read-only profile preflight: the repository tree is the resumability
    // checkpoint, so the list-page runner needs only the ascent folder leaves.
    const getAscentFolders = async (): Promise<string[]> => {
        const resolved = await resolveRepo();
        const head = await readHead(resolved);
        if (!head) return [];
        const state = await inspectRootTree(head.root);
        return state.records.map(record => record.leaf);
    };

    // Read-only comparison for the individual ascent affordance. Validate
    // the repository marker and stable folder identity first, then fetch
    // only the two or three extension-owned blobs in that ascent folder.
    // User-added files in the folder are deliberately ignored.
    const isAscentBackupCurrent = async (snapshot: AscentBackupSnapshot, { gpx }: { gpx?: unknown } = {}): Promise<boolean> => {
        const ascentId = snapshot && snapshot.ascent ? Number(snapshot.ascent.id) : NaN;
        if (!Number.isFinite(ascentId) || ascentId <= 0) {
            throw new TypeError('github client requires a positive ascent id');
        }
        const resolved = await resolveRepo();
        const head = await readHead(resolved);
        if (!head) return false;
        const state = await inspectRootTree(head.root);
        const records = matchingRecords(state.records, ascentId);
        if (records.length !== 1 || records[0]!.leaf !== Backup.folderName(snapshot)) return false;
        const folder = await readTree(records[0]!.treeSha);
        const ownedEntries = (folder.tree || []).filter(entry => OWNED_FOLDER_FILES.has(entry.path));
        if (ownedEntries.some(entry => entry.type !== 'blob' || !entry.sha)) return false;
        const contents: Record<string, string> = {};
        await Promise.all(ownedEntries.map(async entry => {
            if (entry.sha) contents[entry.path] = await readBlobText(entry.sha);
        }));
        return Backup.matchesBackupFiles(snapshot, { gpx, contents });
    };

    const readRootFile = async (path: string, { maxBytes = null }: { maxBytes?: number | null } = {}): Promise<string | null> => {
        const filePath = rootFilePath(path);
        if (maxBytes != null) {
            const resolved = await resolveRepo();
            const head = await readHead(resolved);
            if (!head) return null;
            const entry = (head.root.tree || []).find(node => node.path === filePath);
            if (!entry) return null;
            if (entry.type !== 'blob' || !entry.sha) {
                throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                    `The repository already uses ${filePath} for something other than a file.`);
            }
            return readBoundedRawBlobText(entry.sha, {
                maxBytes,
                expectedSize: entry.size ?? null,
            });
        }
        const resolved = await resolveRepo();
        const file = await request<ContentsFileResponse>('GET',
            `/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(resolved.targetBranch)}`,
            { phase: 'read', allowNotFound: true });
        if (file == null) return null;
        if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
            throw new GithubError(ERROR_CODES.INVALID,
                `GitHub did not return ${filePath} as a base64 file.`);
        }
        return decodeBase64Utf8(file.content);
    };

    // Root files are independent last-write-wins paths, so several of them
    // belong in one tree for the same reason a profile batch of ascents
    // does. A repeated path is rejected rather than silently resolved: the
    // tree would be ambiguous and only the caller knows which write it meant.
    const normalizeRootFiles = (files: RootFileInput[]): RootFileInput[] => {
        if (!Array.isArray(files) || files.length === 0) {
            throw new TypeError('github client requires at least one root file');
        }
        const seen = new Set<string>();
        return files.map(file => {
            const path = rootFilePath(file && file.path);
            if (seen.has(path)) throw new TypeError('github client requires unique root file paths');
            seen.add(path);
            if (typeof file.content !== 'string') {
                throw new TypeError('github client requires string content and a commit message');
            }
            return { path, content: file.content, ...(typeof file.verify === 'function' ? { verify: file.verify } : {}) };
        });
    };

    const commitRootEntries = async ({
        entries,
        message,
        resolved,
        head,
        state,
        beforeCommit = null,
    }: {
        entries: { path: string; content: string }[];
        message: string;
        resolved: ResolvedRepo;
        head: HeadState;
        state: RootTreeInspection;
        beforeCommit?: (() => unknown | Promise<unknown>) | null;
    }) => {
        const treeEntries: GitTreeWriteEntry[] = entries.map(entry => {
            const existing = (head.root.tree || []).find(node => node.path === entry.path);
            if (existing && existing.type !== 'blob') {
                throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                    `The repository already uses ${entry.path} for something other than a file.`);
            }
            return { path: entry.path, mode: BLOB_MODE, type: 'blob', content: entry.content };
        });
        if (!state.marker) {
            treeEntries.push({
                path: REPOSITORY_MARKER_PATH,
                mode: BLOB_MODE,
                type: 'blob',
                content: REPOSITORY_MARKER_CONTENT,
            });
        }
        const tree = await request<{ sha: string }>('POST', '/git/trees', {
            body: { base_tree: head.baseTreeSha, tree: treeEntries },
            phase: 'write',
        });
        const commit = await request<GitCommitResponse>('POST', '/git/commits', {
            body: { message, tree: tree.sha, parents: [head.baseCommitSha] },
            phase: 'write',
        });
        if (beforeCommit) await beforeCommit();
        await request('PATCH', `/git/refs/heads/${encodeURIComponent(resolved.targetBranch)}`, {
            body: { sha: commit.sha, force: false },
            phase: 'ref',
        });
        return {
            sha: commit.sha,
            commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
            message,
            paths: entries.map(entry => entry.path),
        };
    };

    const putRootFilesOnce = async (files: RootFileInput[], commitMessage: string) => {
        const entries = normalizeRootFiles(files);
        const message = typeof commitMessage === 'string' ? commitMessage.trim() : '';
        if (!message) {
            throw new TypeError('github client requires string content and a commit message');
        }
        const resolved = await resolveRepo();
        const head = await readHead(resolved) || await initializeEmptyRepository(resolved);
        const state = await inspectRootTree(head.root);
        for (const entry of entries) {
            if (!entry.verify) continue;
            const existing = (head.root.tree || []).find(node => node.path === entry.path);
            if (existing && existing.type !== 'blob') throw new GithubError(ERROR_CODES.REPO_CONFLICT, 'The backup path is not a file.');
            const current = existing ? await readBoundedRawBlobText(existing.sha as string, {
                maxBytes: 2 * 1024 * 1024, expectedSize: existing.size ?? null,
            }) : null;
            await entry.verify(current);
        }
        // Ref-conflict retries rerun every verifier against the new head.
        return commitRootEntries({ entries, message, resolved, head, state,
            beforeCommit: async () => { for (const entry of entries) await entry.verify?.(undefined); } });
    };

    const putRootFiles = (files: RootFileInput[], commitMessage: string) =>
        withConflictRetry(() => putRootFilesOnce(files, commitMessage));

    const putRootFile = async (path: string, content: string, commitMessage: string) => {
        const result = await putRootFiles([{ path, content }], commitMessage);
        return {
            sha: result.sha,
            commitUrl: result.commitUrl,
            message: result.message,
            path: result.paths[0] ?? path,
        };
    };

    // Unlike a blind root-file replacement, a semantic update reruns its
    // reader/merge callback after every non-fast-forward. Photo-library
    // backup uses this to merge another device's records instead of
    // retrying stale content over a newly advanced branch.
    const updateRootFileOnce = async (
        path: string,
        update: (current: string | null, context: RootFileUpdateContext) => string | Promise<string>,
        commitMessage: string,
        { maxBytes = null, beforeCommit = null }: UpdateRootFileOptions = {},
    ) => {
        const filePath = rootFilePath(path);
        if (typeof update !== 'function') {
            throw new TypeError('github client requires a root file update function');
        }
        const message = typeof commitMessage === 'string' ? commitMessage.trim() : '';
        if (!message) throw new TypeError('github client requires a commit message');
        const resolved = await resolveRepo();
        const head = await readHead(resolved) || await initializeEmptyRepository(resolved);
        const state = await inspectRootTree(head.root);
        const existing = (head.root.tree || []).find(node => node.path === filePath);
        if (existing && existing.type !== 'blob') {
            throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                `The repository already uses ${filePath} for something other than a file.`);
        }
        const current = existing
            ? maxBytes == null
                ? await readBlobText(existing.sha as string)
                : await readBoundedRawBlobText(existing.sha as string, {
                    maxBytes,
                    expectedSize: existing.size ?? null,
                })
            : null;
        const content = await update(current, { head: head.baseCommitSha, fileSha: existing?.sha || null, branch: resolved.targetBranch });
        if (typeof content !== 'string') {
            throw new TypeError('github client root file update must return string content');
        }
        if (content === current) {
            return {
                sha: head.baseCommitSha,
                commitUrl: null,
                message,
                path: filePath,
                unchanged: true,
                branch: resolved.targetBranch,
            };
        }
        const result = await commitRootEntries({
            entries: [{ path: filePath, content }],
            message,
            resolved,
            head,
            state,
            beforeCommit,
        });
        return {
            sha: result.sha,
            commitUrl: result.commitUrl,
            message: result.message,
            path: filePath,
            unchanged: false,
            branch: resolved.targetBranch,
        };
    };

    const updateRootFile = (
        path: string,
        update: (current: string | null, context: RootFileUpdateContext) => string | Promise<string>,
        commitMessage: string,
        options?: UpdateRootFileOptions,
    ) => withConflictRetry(() => updateRootFileOnce(path, update, commitMessage, options));

    return {
        pushAscentBackup,
        pushAscentBackups,
        deleteAscentBackup,
        getAscentFolders,
        isAscentBackupCurrent,
        inspectRepository,
        readRootFile,
        putRootFile,
        putRootFiles,
        updateRootFile,
    };
};

const API = {
    createGithubClient,
    REPOSITORY_MARKER_PATH,
};

export const githubClient = API;
