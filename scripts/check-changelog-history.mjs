import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    assertReleasedSectionsUnchanged,
} from './release-changelog.mjs';

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8' });
}

const SEMVER_RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function exactReleaseTags(tagList) {
    return tagList
        .split('\n')
        .map((tag) => tag.trim())
        .filter((tag) => SEMVER_RELEASE_TAG.test(tag));
}

export function requireCompleteHistory(isShallow) {
    if (isShallow.trim() !== 'false') {
        throw new Error(
            'Release changelog history cannot be verified in a shallow repository. Fetch full history and tags.',
        );
    }
}

async function main() {
    requireCompleteHistory(git(['rev-parse', '--is-shallow-repository']));
    const changelog = await readFile('CHANGELOG.md', 'utf8');
    const releaseTags = exactReleaseTags(git(['tag', '--list']));
    const taggedChangelogs = {};

    for (const tag of releaseTags) {
        const version = tag.slice(1);
        try {
            taggedChangelogs[version] = git(['show', `${tag}:CHANGELOG.md`]);
        } catch {
            throw new Error(`${tag} does not contain CHANGELOG.md.`);
        }
    }

    if (releaseTags.length === 0) {
        throw new Error('No exact semver release tags are locally available.');
    }
    assertReleasedSectionsUnchanged(changelog, taggedChangelogs);
    console.log(`Verified ${releaseTags.length} immutable changelog sections.`);
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
