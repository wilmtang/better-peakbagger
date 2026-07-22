// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GitHub Git Data client for the ascent backup (pure).
//
// Pushes one or more ascents as one atomic commit through GitHub's Git Data API:
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

import { githubBackup as Backup } from './github-backup.js';
import { githubApi as GithubApi } from './github-api.js';
import { githubErrors as GithubErrors } from './github-errors.js';

    const { ERROR_CODES, GithubError } = GithubErrors;
    const BLOB_MODE = '100644';
    const CONFLICT_RETRY_DELAYS = [500, 2000, 5000];
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
    } = {}) => {
        const api = GithubApi.createGithubApi({ fetch, token });
        if (!owner || !repo) throw new TypeError('github client requires owner and repo');
        if (!Number.isFinite(inlineFileLimitBytes) || inlineFileLimitBytes < 0) {
            throw new TypeError('github client requires a non-negative inline file limit');
        }

        const repoBase = `${GithubApi.API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

        const request = (method, path, options = {}) => api.request(
            method,
            path.startsWith('http') ? path : `${repoBase}${path}`,
            options,
        );

        // A tree read, one level unless recursive. Missing trees surface as
        // read-phase errors (no-access) rather than throwing raw.
        const readTree = (sha, { recursive = false } = {}) =>
            request('GET', `/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, { phase: 'read' });

        // Root-level mountain folders plus the validated marker are the only
        // repository layout. Keeping one representation avoids ambiguous
        // ownership and makes repository inspection fail closed.
        const inspectRootTree = async root => {
            const entries = (root && root.tree) || [];
            const markerEntry = entries.find(node => node.path === REPOSITORY_MARKER_PATH);
            if (markerEntry && markerEntry.type !== 'blob') {
                throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                    `The repository already uses ${REPOSITORY_MARKER_PATH} for something else.`);
            }
            if (markerEntry) {
                const markerBlob = await request('GET', `/git/blobs/${markerEntry.sha}`, { phase: 'read' });
                const content = markerBlob && typeof markerBlob.content === 'string'
                    ? markerBlob.content.replace(/\s/g, '')
                    : '';
                if (!markerBlob || markerBlob.encoding !== 'base64' || content !== REPOSITORY_MARKER_BASE64) {
                    throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                        `The repository's ${REPOSITORY_MARKER_PATH} file is not a Better Peakbagger marker.`);
                }
            }

            const rootFolders = entries
                .filter(node => node.type === 'tree' && Backup.isBackupFolderName(node.path))
                .map(node => ({ leaf: node.path, path: node.path, treeSha: node.sha }));

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

        const matchingRecords = (records, ascentId) => {
            if (ascentId == null) return [];
            const suffix = `-a${ascentId}`;
            return records.filter(record => Backup.isBackupFolderName(record.leaf) && record.leaf.endsWith(suffix));
        };

        // Only files Better Peakbagger itself owns are pruned. User-added notes
        // or other content survive an in-place refresh or folder rename.
        const oldFolderOwnedPaths = async record => {
            if (!record) return [];
            const sub = await readTree(record.treeSha, { recursive: true });
            return (sub.tree || [])
                .filter(node => node.type === 'blob' && OWNED_FOLDER_FILES.has(node.path))
                .map(node => `${record.path}/${node.path}`);
        };

        // Resolve the target branch and fail closed on read-only / no-push repos
        // before writing anything, so those cases get a clean pre-flight error
        // instead of a confusing mid-push rejection.
        const resolveRepo = async () => {
            const info = await request('GET', '', { phase: 'read' });
            if (info.archived) {
                throw new GithubError(ERROR_CODES.ARCHIVED, 'The backup repository is archived and read-only.', { status: 403 });
            }
            if (info.permissions && info.permissions.push === false) {
                throw new GithubError(ERROR_CODES.NO_ACCESS, 'This token cannot write to the backup repository.', { status: 403 });
            }
            return { info, targetBranch: branch || info.default_branch || 'main' };
        };

        const readHead = async ({ info, targetBranch }) => {
            let ref;
            try {
                ref = await request('GET', `/git/ref/heads/${encodeURIComponent(targetBranch)}`, {
                    phase: 'ref', allowNotFound: true,
                });
            } catch (error) {
                // GitHub's refs endpoint returns 409 (not 404) for a repository
                // with no commits. Treat only that exact response as an absent
                // head; other conflicts must keep failing closed.
                if (error && error.status === 409 && /git repository is empty/i.test(error.message || '')) ref = null;
                else throw error;
            }
            if (!ref) {
                if (Number(info.size) === 0) return null;
                throw new GithubError(ERROR_CODES.BRANCH_MISSING,
                    'The backup repository has no branch to commit to yet.', { status: 404 });
            }
            const baseCommitSha = ref.object && ref.object.sha;
            const baseCommit = await request('GET', `/git/commits/${baseCommitSha}`, { phase: 'read' });
            const baseTreeSha = baseCommit.tree && baseCommit.tree.sha;
            const root = await readTree(baseTreeSha);
            return { baseCommitSha, baseTreeSha, root };
        };

        // GitHub's Git References API explicitly refuses to create the first
        // branch in an empty repository. Seed only our ownership marker through
        // the Contents API, then keep every ascent on the atomic Git Data path.
        const initializeEmptyRepository = async ({ targetBranch }) => {
            const initialized = await request('PUT', `/contents/${encodeURIComponent(REPOSITORY_MARKER_PATH)}`, {
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
                    kind: 'empty', branch: resolved.targetBranch, hasBranch: false,
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

        const writeBlob = async content => request('POST', '/git/blobs', {
            body: { content, encoding: 'utf-8' },
            phase: 'write',
        });

        const contentBytes = content => new TextEncoder().encode(content).byteLength;

        const rootFilePath = path => {
            if (typeof path !== 'string' || !path || path === '.' || path === '..'
                || path.includes('/') || path.includes('\\') || path === REPOSITORY_MARKER_PATH) {
                throw new TypeError('github client requires a non-reserved root file path');
            }
            return path;
        };

        const decodeBase64Utf8 = value => {
            try {
                const binary = atob(value.replace(/\s/g, ''));
                const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
                return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch (cause) {
                throw new GithubError(ERROR_CODES.INVALID,
                    'GitHub returned invalid base64 file content.', { cause });
            }
        };

        const readBlobText = async sha => {
            const blob = await request('GET', `/git/blobs/${sha}`, { phase: 'read' });
            if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
                throw new GithubError(ERROR_CODES.INVALID,
                    'GitHub returned an invalid backup file.');
            }
            return decodeBase64Utf8(blob.content);
        };

        const normalizeBatch = entries => {
            if (!Array.isArray(entries) || entries.length === 0) {
                throw new TypeError('github client requires at least one ascent backup');
            }
            const seen = new Set();
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

        const commitMessageFor = backups => {
            if (backups.length === 1) return backups[0].message;
            return backups.every(backup => backup.isUpdate)
                ? `Refresh ${backups.length} ascents`
                : `Back up ${backups.length} ascents`;
        };

        const commitBatchOnce = async entries => {
            const resolved = await resolveRepo();
            const head = await readHead(resolved) || await initializeEmptyRepository(resolved);
            const state = await inspectRootTree(head.root);
            const workingFolders = state.records.map(record => record.leaf);
            const backups = entries.map(({ snapshot, gpx }) => {
                const backup = Backup.buildBackup(snapshot, { gpx, existingFolders: workingFolders });
                const ascentId = snapshot.ascent.id;
                const suffix = `-a${ascentId}`;
                for (let i = workingFolders.length - 1; i >= 0; i -= 1) {
                    if (workingFolders[i].endsWith(suffix)) workingFolders.splice(i, 1);
                }
                workingFolders.push(backup.folder);
                return backup;
            });
            const newPaths = new Set(backups.flatMap(backup => backup.files.map(file => file.path)));

            // Files under the old folder that the new payload will not overwrite
            // get a null sha in the tree, which deletes them relative to the base
            // tree — the rename move and stale-file prune in one atomic tree.
            const removals = [];
            for (const { snapshot } of entries) {
                const oldRecords = matchingRecords(state.records, snapshot.ascent.id);
                for (const record of oldRecords) removals.push(...await oldFolderOwnedPaths(record));
            }

            const treeEntries = [];
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
            for (const path of new Set(removals.filter(path => !newPaths.has(path)))) {
                treeEntries.push({ path, mode: BLOB_MODE, type: 'blob', sha: null });
            }

            const tree = await request('POST', '/git/trees', {
                body: { base_tree: head.baseTreeSha, tree: treeEntries },
                phase: 'write',
            });
            const commit = await request('POST', '/git/commits', {
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
        const withConflictRetry = async operation => {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    return await operation();
                } catch (error) {
                    if (!(error instanceof GithubError)
                        || error.code !== ERROR_CODES.CONFLICT
                        || attempt >= CONFLICT_RETRY_DELAYS.length) throw error;
                    await sleep(CONFLICT_RETRY_DELAYS[attempt]);
                }
            }
        };

        const pushAscentBackups = async entries => {
            const normalized = normalizeBatch(entries);
            return withConflictRetry(() => commitBatchOnce(normalized));
        };

        const pushAscentBackup = async (snapshot, { gpx } = {}) => {
            const batch = await pushAscentBackups([{ snapshot, gpx }]);
            return {
                sha: batch.sha,
                commitUrl: batch.commitUrl,
                message: batch.message,
                ...batch.items[0],
            };
        };

        // Read-only profile preflight: the repository tree is the resumability
        // checkpoint, so the list-page runner needs only the ascent folder leaves.
        const getAscentFolders = async () => {
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
        const isAscentBackupCurrent = async (snapshot, { gpx } = {}) => {
            const ascentId = snapshot && snapshot.ascent ? Number(snapshot.ascent.id) : NaN;
            if (!Number.isFinite(ascentId) || ascentId <= 0) {
                throw new TypeError('github client requires a positive ascent id');
            }
            const resolved = await resolveRepo();
            const head = await readHead(resolved);
            if (!head) return false;
            const state = await inspectRootTree(head.root);
            const records = matchingRecords(state.records, ascentId);
            if (records.length !== 1 || records[0].leaf !== Backup.folderName(snapshot)) return false;
            const folder = await readTree(records[0].treeSha);
            const ownedEntries = (folder.tree || []).filter(entry => OWNED_FOLDER_FILES.has(entry.path));
            if (ownedEntries.some(entry => entry.type !== 'blob' || !entry.sha)) return false;
            const contents = {};
            await Promise.all(ownedEntries.map(async entry => {
                contents[entry.path] = await readBlobText(entry.sha);
            }));
            return Backup.matchesBackupFiles(snapshot, { gpx, contents });
        };

        const readRootFile = async path => {
            const filePath = rootFilePath(path);
            const resolved = await resolveRepo();
            const file = await request('GET',
                `/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(resolved.targetBranch)}`,
                { phase: 'read', allowNotFound: true });
            if (file == null) return null;
            if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
                throw new GithubError(ERROR_CODES.INVALID,
                    `GitHub did not return ${filePath} as a base64 file.`);
            }
            return decodeBase64Utf8(file.content);
        };

        const putRootFileOnce = async (path, content, commitMessage) => {
            const filePath = rootFilePath(path);
            if (typeof content !== 'string' || typeof commitMessage !== 'string' || !commitMessage.trim()) {
                throw new TypeError('github client requires string content and a commit message');
            }
            const resolved = await resolveRepo();
            const head = await readHead(resolved) || await initializeEmptyRepository(resolved);
            const state = await inspectRootTree(head.root);
            const existing = (head.root.tree || []).find(entry => entry.path === filePath);
            if (existing && existing.type !== 'blob') {
                throw new GithubError(ERROR_CODES.REPO_CONFLICT,
                    `The repository already uses ${filePath} for something other than a file.`);
            }
            const treeEntries = [{
                path: filePath,
                mode: BLOB_MODE,
                type: 'blob',
                content,
            }];
            if (!state.marker) {
                treeEntries.push({
                    path: REPOSITORY_MARKER_PATH,
                    mode: BLOB_MODE,
                    type: 'blob',
                    content: REPOSITORY_MARKER_CONTENT,
                });
            }
            const tree = await request('POST', '/git/trees', {
                body: { base_tree: head.baseTreeSha, tree: treeEntries },
                phase: 'write',
            });
            const commit = await request('POST', '/git/commits', {
                body: { message: commitMessage.trim(), tree: tree.sha, parents: [head.baseCommitSha] },
                phase: 'write',
            });
            await request('PATCH', `/git/refs/heads/${encodeURIComponent(resolved.targetBranch)}`, {
                body: { sha: commit.sha, force: false },
                phase: 'ref',
            });
            return {
                sha: commit.sha,
                commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
                message: commitMessage.trim(),
                path: filePath,
            };
        };

        const putRootFile = (path, content, commitMessage) =>
            withConflictRetry(() => putRootFileOnce(path, content, commitMessage));

        return {
            pushAscentBackup,
            pushAscentBackups,
            getAscentFolders,
            isAscentBackupCurrent,
            inspectRepository,
            readRootFile,
            putRootFile,
        };
    };

    const API = {
        createGithubClient,
        DEFAULT_INLINE_FILE_LIMIT_BYTES,
        REPOSITORY_MARKER_PATH,
    };

    export const githubClient = API;
