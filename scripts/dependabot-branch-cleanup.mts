// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Retry GitHub's missed automatic deletions. Never download branch content or
// infer merge completion from a successful auto-merge queueing job.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'wilmtang/better-peakbagger';
const REMOTE = `https://github.com/${REPOSITORY}.git`;
type Run = (command: string, args: string[]) => string;
type Pull = {
    merged_at: string | null;
    user: { login: string };
    base: { ref: string };
    head: { ref: string; sha: string; repo: { full_name: string } | null };
};
type Branch = { name: string; protected: boolean; commit: { sha: string } };
const execute: Run = (command, args) => execFileSync(command, args, {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});

export function cleanupMergedBranches(run: Run = execute): string[] {
    // Project inside gh: Dependabot release-note bodies already exceed Node's
    // default subprocess buffer. Keep only the metadata needed for deletion.
    const pages = <T,>(endpoint: string, projection: string): T[] => run('gh', [
        'api', '--paginate', '--jq', `.[] | ${projection} | tojson`, `repos/${REPOSITORY}/${endpoint}`,
    ]).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as T);
    const branches = pages<Branch>('branches?per_page=100', '{name, protected, commit: {sha: .commit.sha}}');
    const pullFields = '{merged_at, user: {login: .user.login}, base: {ref: .base.ref}, head: {ref: .head.ref, sha: .head.sha, repo: (if .head.repo then {full_name: .head.repo.full_name} else null end)}}';
    const closed = pages<Pull>('pulls?state=closed&base=main&per_page=100', pullFields);
    const open = pages<Pull>('pulls?state=open&per_page=100', pullFields);
    // Pin the ancestry proof to main's observed commit, rather than a mutable ref.
    const main = branches.find(branch => branch.name === 'main');
    if (!main || !/^[a-f0-9]{40}$/.test(main.commit.sha)) throw new Error('Cannot establish main head.');
    const deleted: string[] = [];
    for (const branch of branches) {
        if (branch.protected || !branch.name.startsWith('dependabot/')
            || !/^[a-f0-9]{40}$/.test(branch.commit.sha)) continue;
        const merged = closed.some(pull => pull.merged_at && pull.base.ref === 'main'
            && pull.user.login === 'dependabot[bot]' && pull.head.repo?.full_name === REPOSITORY
            && pull.head.ref === branch.name && pull.head.sha === branch.commit.sha);
        if (!merged || open.some(pull => pull.base.ref === branch.name
            || (pull.head.repo?.full_name === REPOSITORY && pull.head.ref === branch.name))) continue;
        const comparison = JSON.parse(run('gh', [
            'api', '--jq', '{status}', `repos/${REPOSITORY}/compare/${branch.commit.sha}...${main.commit.sha}`,
        ])) as { status: string };
        // With the branch as base and main as head, only ahead/identical proves
        // the entire branch tip is in main. Squashed/diverged heads stay manual.
        if (!['ahead', 'identical'].includes(comparison.status)) continue;
        const ref = `refs/heads/${branch.name}`;
        run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
            'push', `--force-with-lease=${ref}:${branch.commit.sha}`, REMOTE, `:${ref}`]);
        deleted.push(branch.name);
    }
    return deleted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const deleted = cleanupMergedBranches();
    console.log(deleted.length ? `Deleted merged branches:\n${deleted.join('\n')}` : 'No merged Dependabot branches to delete.');
}
