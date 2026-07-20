// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GitHub Git Data client for the ascent backup (pure).
//
// Pushes one ascent as a single atomic commit through GitHub's Git Data API:
// resolve the branch, read its tip, build blobs for the folder's files, POST a
// tree based on the latest commit (adding the new files and removing any stale
// or renamed-away ones in the same tree), POST the commit, and fast-forward the
// ref. A non-fast-forward race re-reads the ref and retries exactly once. GitHub
// does not permit creating a ref in an empty repository, so that one case is
// bootstrapped with a marker-only Contents API commit before the ordinary
// atomic ascent commit. The Contents API is not used for ascent files because
// it would produce one commit per file and cannot move a renamed folder
// atomically.
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
    const CONFLICT_RETRY_DELAYS = [500, 2000, 5000];
    const REPOSITORY_MARKER_PATH = '.better-peakbagger.json';
    const REPOSITORY_MARKER_CONTENT = `${JSON.stringify({
        schemaVersion: 1,
        type: 'better-peakbagger-backup',
        layout: 'repository-root',
    }, null, 2)}\n`;
    const REPOSITORY_MARKER_BASE64 = 'ewogICJzY2hlbWFWZXJzaW9uIjogMSwKICAidHlwZSI6ICJiZXR0ZXItcGVha2JhZ2dlci1iYWNrdXAiLAogICJsYXlvdXQiOiAicmVwb3NpdG9yeS1yb290Igp9Cg==';
    const OWNED_FOLDER_FILES = new Set(['report.md', 'ascent.json', 'track.gpx']);

    const ERROR_CODES = Object.freeze({
        AUTH: 'auth',                 // token invalid or authorization revoked (401)
        NO_ACCESS: 'no-access',       // app uninstalled or repo access withdrawn (403/404)
        ARCHIVED: 'archived',         // repository is archived / read-only
        REPO_CONFLICT: 'repo-conflict',
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
        /fast forward|not a fast-forward|update is not a fast|reference already exists/i.test(message || '');

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

    const createGithubClient = ({
        fetch,
        token,
        owner,
        repo,
        branch = null,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    } = {}) => {
        if (typeof fetch !== 'function') throw new TypeError('github client requires an injected fetch');
        if (!token) throw new TypeError('github client requires a token');
        if (!owner || !repo) throw new TypeError('github client requires owner and repo');

        const repoBase = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

        const request = async (method, path, { body = undefined, phase = '', allowNotFound = false } = {}) => {
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
                if (allowNotFound && res.status === 404) return null;
                const message = (json && json.message) || text || `GitHub responded ${res.status}`;
                throw new GithubBackupError(classify(res.status, message, res.headers, phase), message, { status: res.status });
            }
            return json;
        };

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
                throw new GithubBackupError(ERROR_CODES.REPO_CONFLICT,
                    `The repository already uses ${REPOSITORY_MARKER_PATH} for something else.`);
            }
            if (markerEntry) {
                const markerBlob = await request('GET', `/git/blobs/${markerEntry.sha}`, { phase: 'read' });
                const content = markerBlob && typeof markerBlob.content === 'string'
                    ? markerBlob.content.replace(/\s/g, '')
                    : '';
                if (!markerBlob || markerBlob.encoding !== 'base64' || content !== REPOSITORY_MARKER_BASE64) {
                    throw new GithubBackupError(ERROR_CODES.REPO_CONFLICT,
                        `The repository's ${REPOSITORY_MARKER_PATH} file is not a Better Peakbagger marker.`);
                }
            }

            const rootFolders = entries
                .filter(node => node.type === 'tree' && Backup.isBackupFolderName(node.path))
                .map(node => ({ leaf: node.path, path: node.path, treeSha: node.sha }));

            // Without our marker, root folders that look exactly like the paths
            // we own are ambiguous. Refuse to adopt and potentially prune them.
            if (!markerEntry && rootFolders.length) {
                throw new GithubBackupError(ERROR_CODES.REPO_CONFLICT,
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
                throw new GithubBackupError(ERROR_CODES.ARCHIVED, 'The backup repository is archived and read-only.', { status: 403 });
            }
            if (info.permissions && info.permissions.push === false) {
                throw new GithubBackupError(ERROR_CODES.NO_ACCESS, 'This token cannot write to the backup repository.', { status: 403 });
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
                throw new GithubBackupError(ERROR_CODES.BRANCH_MISSING,
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
                throw new GithubBackupError(ERROR_CODES.INVALID,
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

        const commitOnce = async (snapshot, { gpx } = {}) => {
            const resolved = await resolveRepo();
            const head = await readHead(resolved) || await initializeEmptyRepository(resolved);
            const state = await inspectRootTree(head.root);
            const folders = state.records.map(record => record.leaf);
            const ascentId = snapshot && snapshot.ascent && snapshot.ascent.id;
            const oldRecords = matchingRecords(state.records, ascentId);

            const backup = Backup.buildBackup(snapshot, { gpx, existingFolders: folders });
            const newPaths = new Set(backup.files.map(file => file.path));

            // Files under the old folder that the new payload will not overwrite
            // get a null sha in the tree, which deletes them relative to the base
            // tree — the rename move and stale-file prune in one atomic tree.
            const removals = Array.from(new Set((await Promise.all(oldRecords.map(oldFolderOwnedPaths)))
                .flat()
                .filter(path => !newPaths.has(path))));

            const treeEntries = [];
            for (const file of backup.files) {
                const blob = await writeBlob(file.content);
                treeEntries.push({ path: file.path, mode: BLOB_MODE, type: 'blob', sha: blob.sha });
            }
            if (!state.marker) {
                const marker = await writeBlob(REPOSITORY_MARKER_CONTENT);
                treeEntries.push({ path: REPOSITORY_MARKER_PATH, mode: BLOB_MODE, type: 'blob', sha: marker.sha });
            }
            for (const path of removals) {
                treeEntries.push({ path, mode: BLOB_MODE, type: 'blob', sha: null });
            }

            const tree = await request('POST', '/git/trees', {
                body: { base_tree: head.baseTreeSha, tree: treeEntries },
                phase: 'write',
            });
            const commit = await request('POST', '/git/commits', {
                body: { message: backup.message, tree: tree.sha, parents: [head.baseCommitSha] },
                phase: 'write',
            });
            await request('PATCH', `/git/refs/heads/${encodeURIComponent(resolved.targetBranch)}`, {
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

        // Re-read and rebuild after a bounded backoff when GitHub reports a
        // transient repository/ref conflict. Immediate retries can hit the same
        // propagation window; the bounded schedule absorbs brief 409s without
        // hiding a persistent conflict or looping forever.
        const pushAscentBackup = async (snapshot, options = {}) => {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    return await commitOnce(snapshot, options);
                } catch (error) {
                    if (!(error instanceof GithubBackupError)
                        || error.code !== ERROR_CODES.CONFLICT
                        || attempt >= CONFLICT_RETRY_DELAYS.length) throw error;
                    await sleep(CONFLICT_RETRY_DELAYS[attempt]);
                }
            }
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

        return { pushAscentBackup, getAscentFolders, inspectRepository };
    };

    const API = {
        createGithubClient,
        GithubBackupError,
        ERROR_CODES,
        REPOSITORY_MARKER_PATH,
    };

    export const githubClient = API;
