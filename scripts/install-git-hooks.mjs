// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Point this clone's Git hooks at .githooks, so the staged privacy scan in
// scripts/privacy-guard.mjs actually runs before a commit.
//
// The hook used to depend on a maintainer having typed `git config
// core.hooksPath .githooks` by hand, which nothing in the repository did and no
// document mentioned. That is the worst shape for a guard: it worked silently in
// the one clone that had been configured and was silently absent in a fresh
// clone, on a second machine, and for every contributor. The scan blocks the
// account holder's identifiers from being staged into *any* file, so its absence
// is not visible until something has already been committed.
//
// npm runs this from `prepare`. It must never fail an install: a tarball
// install, a checkout with no `.git`, or a machine without Git are all normal,
// and none of them are a reason to stop `npm ci`. An existing hooksPath the user
// chose is also respected rather than overwritten.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS_PATH = '.githooks';

// Pure decision, so the policy is testable without touching a real repository.
//
// `configuredPath` must come from the *local* config. `git config --get`
// falls back to the global one, and a machine-wide core.hooksPath is a default
// rather than a decision about this repository: reading it would make a fresh
// clone on such a machine skip the install and get no privacy scan at all,
// which is precisely the hole this script exists to close. Only a local value
// pointing somewhere else is a choice worth leaving alone.
//
// The comparison resolves both sides because Git accepts either a
// repository-relative or an absolute hooksPath, and an absolute one that
// already points at .githooks is installed, not foreign.
export const decideHookInstall = ({ insideWorkTree, configuredPath, root = '.' }) => {
    if (!insideWorkTree) return { action: 'skip', reason: 'not-a-work-tree' };
    if (!configuredPath) return { action: 'install' };
    return path.resolve(root, configuredPath) === path.resolve(root, HOOKS_PATH)
        ? { action: 'skip', reason: 'already-installed' }
        : { action: 'skip', reason: 'foreign-hooks-path' };
};

const git = (args, cwd) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim();
};

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const insideWorkTree = git(['rev-parse', '--is-inside-work-tree'], root) === 'true';
    const configuredPath = insideWorkTree
        ? git(['config', '--local', '--get', 'core.hooksPath'], root)
        : null;
    const decision = decideHookInstall({
        insideWorkTree, configuredPath: configuredPath || null, root,
    });

    if (decision.action === 'install') {
        if (git(['config', 'core.hooksPath', HOOKS_PATH], root) === null) {
            console.warn(`Better Peakbagger: could not set core.hooksPath; run "git config core.hooksPath ${HOOKS_PATH}" to enable the staged privacy scan.`);
        }
    } else if (decision.reason === 'foreign-hooks-path') {
        console.warn(`Better Peakbagger: core.hooksPath is "${configuredPath}", so ${HOOKS_PATH}/pre-commit (the staged privacy scan) will not run. Leaving your setting alone.`);
    }
}
