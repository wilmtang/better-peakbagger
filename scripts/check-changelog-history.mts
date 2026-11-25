import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    assertReleasedSectionsUnchanged,
} from './release-changelog.mts';

function git(args: string[]): string {
    return execFileSync('git', args, { encoding: 'utf8' });
}

const SEMVER_RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function exactReleaseTags(tagList: string): string[] {
    return tagList
        .split('\n')
        .map((tag) => tag.trim())
        .filter((tag) => SEMVER_RELEASE_TAG.test(tag));
}

export function requireCompleteHistory(isShallow: string): void {
    if (isShallow.trim() !== 'false') {
        throw new Error(
            'Release changelog history cannot be verified in a shallow repository. Fetch full history and tags.',
        );
    }
}

async function main(): Promise<void> {
    requireCompleteHistory(git(['rev-parse', '--is-shallow-repository']));
    const changelog = await readFile('CHANGELOG.md', 'utf8');
    const releaseTags = exactReleaseTags(git(['tag', '--list']));
    const taggedChangelogs: Record<string, string> = {};

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
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
