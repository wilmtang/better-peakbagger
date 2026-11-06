// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Keeps queued Dependabot pull requests moving. The `main` ruleset requires a
// branch to be current, and nothing else rebases one that fell behind: GitHub's
// auto-merge just waits, while the update job still reports success. Asking
// Dependabot to rebase keeps its single signed commit, which the provenance check
// in dependabot-auto-merge.yml requires; an update-branch merge commit would not.
//
// This only asks for rebases and reports. It holds no merge authority, never reads
// pull-request code, and treats everything it reads from GitHub as data.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REBASE_COMMAND = '@dependabot rebase';
// A rebase restarts about an hour of checks, so one at a time is enough.
const REBASE_RETRY_AFTER = 3 * HOUR;
const STUCK_AFTER = 3 * DAY;
export const ISSUE_TITLE = 'Dependabot auto-merge needs attention';

type Check = { name?: string; context?: string; status?: string; state?: string; conclusion?: string };
export type QueuedPullRequest = {
    number: number;
    title: string;
    url: string;
    createdAt: string;
    mergeStateStatus: string;
    mergeable: string;
    autoMergeRequest: unknown;
    author: { login: string };
    comments: { body: string; createdAt: string }[];
    statusCheckRollup: Check[];
};
type Sweep = { rebase: number | null; problems: string[] };

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR']);
const isRunning = ({ status, state }: Check) => status
    ? status !== 'COMPLETED' : state === 'PENDING' || state === 'EXPECTED';
const failedChecks = (pull: QueuedPullRequest) => pull.statusCheckRollup
    .filter(check => FAILED.has(check.conclusion ?? check.state ?? ''))
    .map(check => check.name ?? check.context ?? 'unnamed check');
const requestedRebaseRecently = (pull: QueuedPullRequest, now: number) => pull.comments.some(comment =>
    comment.body.trim() === REBASE_COMMAND
    && now - Date.parse(comment.createdAt) < REBASE_RETRY_AFTER);

export function planSweep(pulls: QueuedPullRequest[], now: number): Sweep {
    // Hand-managed updates, such as the GitHub Actions group, are not queued.
    const queued = pulls
        .filter(pull => pull.author.login === 'app/dependabot' && pull.autoMergeRequest)
        .sort((a, b) => a.number - b.number);
    const busy = queued.some(pull => pull.statusCheckRollup.some(isRunning)
        || requestedRebaseRecently(pull, now));
    const behind = queued.find(pull => pull.mergeStateStatus === 'BEHIND');

    const problems = queued
        .filter(pull => now - Date.parse(pull.createdAt) >= STUCK_AFTER)
        .map(pull => {
            const failed = failedChecks(pull);
            const reason = failed.length ? `failing: ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? `, and ${failed.length - 8} more` : ''}`
                : pull.mergeable === 'CONFLICTING' ? 'merge conflict'
                    : `merge state ${pull.mergeStateStatus}`;
            return `#${pull.number} ${pull.title} (${reason})`;
        });
    return { rebase: !busy && behind ? behind.number : null, problems };
}

export function issueBody(problems: string[]): string {
    return `The scheduled Dependabot queue sweep found:\n\n${problems.map(problem => `- ${problem}`).join('\n')}\n\nThis issue is updated by \`.github/workflows/dependabot-queue-sweep.yml\` and closes itself once the list is empty.\n`;
}

type Gh = (args: string[]) => string;
const gh: Gh = args => execFileSync('gh', args, { encoding: 'utf8' });

export function sweep(run: Gh = gh, now = Date.now()): Sweep {
    const pulls = JSON.parse(run(['pr', 'list', '--state', 'open', '--base', 'main', '--limit', '50', '--json',
        'number,title,url,createdAt,mergeStateStatus,mergeable,autoMergeRequest,author,comments,statusCheckRollup'])) as QueuedPullRequest[];
    const plan = planSweep(pulls, now);
    if (plan.rebase !== null) run(['pr', 'comment', String(plan.rebase), '--body', REBASE_COMMAND]);

    const issues = JSON.parse(run(['issue', 'list', '--state', 'open', '--limit', '100', '--author', 'app/github-actions',
        '--json', 'number,title'])) as { number: number; title: string }[];
    const issue = issues.find(candidate => candidate.title === ISSUE_TITLE);
    if (plan.problems.length) {
        const body = issueBody(plan.problems);
        if (issue) run(['issue', 'edit', String(issue.number), '--body', body]);
        else run(['issue', 'create', '--title', ISSUE_TITLE, '--body', body]);
    } else if (issue) {
        run(['issue', 'close', String(issue.number), '--comment', 'The Dependabot queue is healthy again.']);
    }
    return plan;
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    const { rebase, problems } = sweep();
    console.log(rebase === null ? 'No rebase requested.' : `Requested a rebase of #${rebase}.`);
    console.log(problems.length ? `Reported problems:\n${problems.join('\n')}` : 'No problems to report.');
}
