// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GitHub Git Data client for the ascent backup (pure).
//
// Pushes one ascent as a single atomic commit through GitHub's Git Data API:
// resolve the branch, read its tip, build blobs for the folder's files, POST a
// tree based on the latest commit (adding the new files and removing any stale
// or renamed-away ones in the same tree), POST the commit, and fast-forward the
// ref. A non-fast-forward race re-reads the ref and retries exactly once. The
// Contents API alternative is simpler but produces one commit per file and
// cannot move a renamed folder atomically, so it is not used.
//
// This module performs network I/O, but only through an *injected* fetch and an
// injected token: it holds no globals, no chrome APIs, and no ambient
// credentials, so the background worker owns the token and messaging while the
// commit mechanics stay unit-testable against a scripted fetch stub. Every
// failure surfaces as a GithubBackupError with a stable `code` from ERROR_CODES
// so callers map one actionable sentence per case (see the error taxonomy in
// docs/github-ascent-backup.md). Idempotent to inject more than once.

import { githubBackup as Backup } from './github-backup.js';

    const API_ROOT = 'https://api.github.com';
    const BLOB_MODE = '100644';

    const ERROR_CODES = Object.freeze({
        AUTH: 'auth',                 // token invalid or authorization revoked (401)
        NO_ACCESS: 'no-access',       // app uninstalled or repo access withdrawn (403/404)
        ARCHIVED: 'archived',         // repository is archived / read-only
        BRANCH_PROTECTED: 'branch-protected',
        BRANCH_MISSING: 'branch-missing',
        RATE_LIMIT: 'rate-limit',
        CONFLICT: 'conflict',         // non-fast-forward; retried once before surfacing
        NETWORK: 'network',
        INVALID: 'invalid',           // malformed request GitHub rejected (422, not the above)
        UNKNOWN: 'unknown',
    });

    class GithubBackupError extends Error {
        constructor(code, message, { status = null, cause = null } = {}) {
            super(message || code);
            this.name = 'GithubBackupError';
            this.code = code;
            this.status = status;
            if (cause) this.cause = cause;
        }
    }

    const isProtectionMessage = message =>
        /protected branch|branch protection|required status|required review|not authorized to push/i.test(message || '');

    const isFastForwardMessage = message =>
        /fast forward|not a fast-forward|update is not a fast/i.test(message || '');

    // Map an HTTP failure to a stable, actionable code. `phase` distinguishes a
    // ref update (where a 422 is usually a race or branch protection) from the
    // read/build phases (where a 422 is a malformed request).
    const classify = (status, message, headers, phase) => {
        const remaining = headers && typeof headers.get === 'function'
            ? headers.get('x-ratelimit-remaining')
            : null;
        if (status === 401) return ERROR_CODES.AUTH;
        if (status === 429) return ERROR_CODES.RATE_LIMIT;
        if (status === 403) {
            if (remaining === '0' || /rate limit|secondary rate|abuse/i.test(message)) return ERROR_CODES.RATE_LIMIT;
            if (/archiv/i.test(message)) return ERROR_CODES.ARCHIVED;
            if (isProtectionMessage(message)) return ERROR_CODES.BRANCH_PROTECTED;
            return ERROR_CODES.NO_ACCESS;
        }
        if (status === 404) return phase === 'ref' ? ERROR_CODES.BRANCH_MISSING : ERROR_CODES.NO_ACCESS;
        if (status === 409) return ERROR_CODES.CONFLICT;
        if (status === 422) {
            if (phase === 'ref' && isFastForwardMessage(message)) return ERROR_CODES.CONFLICT;
            if (isProtectionMessage(message)) return ERROR_CODES.BRANCH_PROTECTED;
            return ERROR_CODES.INVALID;
        }
        return ERROR_CODES.UNKNOWN;
    };

    const createGithubClient = ({ fetch, token, owner, repo, branch = null } = {}) => {
        if (typeof fetch !== 'function') throw new TypeError('github client requires an injected fetch');
        if (!token) throw new TypeError('github client requires a token');
        if (!owner || !repo) throw new TypeError('github client requires owner and repo');

        const repoBase = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

        const request = async (method, path, { body = undefined, phase = '' } = {}) => {
            const url = path.startsWith('http') ? path : `${repoBase}${path}`;
            let res;
            try {
                res = await fetch(url, {
                    method,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
            } catch (cause) {
                throw new GithubBackupError(ERROR_CODES.NETWORK, 'Network request to GitHub failed.', { cause });
            }
            let text = '';
            try { text = await res.text(); } catch { text = ''; }
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { json = null; }
            if (!res.ok) {
                const message = (json && json.message) || text || `GitHub responded ${res.status}`;
                throw new GithubBackupError(classify(res.status, message, res.headers, phase), message, { status: res.status });
            }
            return json;
        };

        // A tree read, one level unless recursive. Missing trees surface as
        // read-phase errors (no-access) rather than throwing raw.
        const readTree = (sha, { recursive = false } = {}) =>
            request('GET', `/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, { phase: 'read' });

        // The ascent folder leaf names already committed under ascents/, read
        // one directory level at a time so a huge archive never trips the
        // recursive-tree truncation limit and misses a rename target.
        const listAscentFolders = async baseTreeSha => {
            const root = await readTree(baseTreeSha);
            const entry = (root.tree || []).find(node => node.path === Backup.ASCENTS_DIR && node.type === 'tree');
            if (!entry) return { folders: [], ascentsTree: null };
            const ascentsTree = await readTree(entry.sha);
            const folders = (ascentsTree.tree || [])
                .filter(node => node.type === 'tree')
                .map(node => node.path);
            return { folders, ascentsTree };
        };

        // Every blob path under an existing folder, so a re-sync can null out
        // files the new payload no longer writes (a removed GPX) and a rename
        // can drop the whole old folder — all in the one tree POST.
        const oldFolderBlobPaths = async (ascentsTree, oldLeaf) => {
            const entry = (ascentsTree.tree || []).find(node => node.path === oldLeaf && node.type === 'tree');
            if (!entry) return [];
            const sub = await readTree(entry.sha, { recursive: true });
            return (sub.tree || [])
                .filter(node => node.type === 'blob')
                .map(node => `${Backup.ASCENTS_DIR}/${oldLeaf}/${node.path}`);
        };

        // Resolve the target branch and fail closed on read-only / no-push repos
        // before writing anything, so those cases get a clean pre-flight error
        // instead of a confusing mid-push rejection.
        const resolveRepo = async () => {
            const info = await request('GET', '', { phase: 'read' });
            if (info.archived) {
                throw new GithubBackupError(ERROR_CODES.ARCHIVED, 'The backup repository is archived and read-only.', { status: 403 });
            }
            if (info.permissions && info.permissions.push === false) {
                throw new GithubBackupError(ERROR_CODES.NO_ACCESS, 'This token cannot write to the backup repository.', { status: 403 });
            }
            return branch || info.default_branch || 'main';
        };

        const commitOnce = async (snapshot, { gpx } = {}) => {
            const targetBranch = await resolveRepo();
            const ref = await request('GET', `/git/ref/heads/${encodeURIComponent(targetBranch)}`, { phase: 'ref' });
            const baseCommitSha = ref.object && ref.object.sha;
            const baseCommit = await request('GET', `/git/commits/${baseCommitSha}`, { phase: 'read' });
            const baseTreeSha = baseCommit.tree && baseCommit.tree.sha;

            const { folders, ascentsTree } = await listAscentFolders(baseTreeSha);
            const ascentId = snapshot && snapshot.ascent && snapshot.ascent.id;
            const oldLeaf = Backup.matchExistingFolder(folders, ascentId);

            const backup = Backup.buildBackup(snapshot, { gpx, existingFolders: folders });
            const newPaths = new Set(backup.files.map(file => file.path));

            // Files under the old folder that the new payload will not overwrite
            // get a null sha in the tree, which deletes them relative to the base
            // tree — the rename move and stale-file prune in one atomic tree.
            const removals = oldLeaf
                ? (await oldFolderBlobPaths(ascentsTree, oldLeaf)).filter(path => !newPaths.has(path))
                : [];

            const treeEntries = [];
            for (const file of backup.files) {
                const blob = await request('POST', '/git/blobs', {
                    body: { content: file.content, encoding: 'utf-8' },
                    phase: 'write',
                });
                treeEntries.push({ path: file.path, mode: BLOB_MODE, type: 'blob', sha: blob.sha });
            }
            for (const path of removals) {
                treeEntries.push({ path, mode: BLOB_MODE, type: 'blob', sha: null });
            }

            const tree = await request('POST', '/git/trees', {
                body: { base_tree: baseTreeSha, tree: treeEntries },
                phase: 'write',
            });
            const commit = await request('POST', '/git/commits', {
                body: { message: backup.message, tree: tree.sha, parents: [baseCommitSha] },
                phase: 'write',
            });
            await request('PATCH', `/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
                body: { sha: commit.sha, force: false },
                phase: 'ref',
            });

            return {
                sha: commit.sha,
                commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
                isUpdate: backup.isUpdate,
                folder: backup.folder,
                message: backup.message,
            };
        };

        // One atomic backup commit, with a single non-fast-forward retry: if
        // another push landed between our read and our ref update, re-read and
        // rebuild once. A second conflict surfaces rather than looping.
        const pushAscentBackup = async (snapshot, options = {}) => {
            try {
                return await commitOnce(snapshot, options);
            } catch (error) {
                if (error instanceof GithubBackupError && error.code === ERROR_CODES.CONFLICT) {
                    return commitOnce(snapshot, options);
                }
                throw error;
            }
        };

        // Read-only profile preflight: the repository tree is the resumability
        // checkpoint, so the list-page runner needs only the ascent folder leaves.
        const getAscentFolders = async () => {
            const targetBranch = await resolveRepo();
            const ref = await request('GET', `/git/ref/heads/${encodeURIComponent(targetBranch)}`, { phase: 'ref' });
            const commitSha = ref.object && ref.object.sha;
            const commit = await request('GET', `/git/commits/${commitSha}`, { phase: 'read' });
            const { folders } = await listAscentFolders(commit.tree && commit.tree.sha);
            return folders;
        };

        return { pushAscentBackup, getAscentFolders };
    };

    const API = { createGithubClient, GithubBackupError, ERROR_CODES };

    export const githubClient = API;
