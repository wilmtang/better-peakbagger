import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import {
    assertReleasedSectionsUnchanged,
    releasedVersions,
} from './release-changelog.mjs';

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8' });
}

async function main() {
    const changelog = await readFile('CHANGELOG.md', 'utf8');
    const knownTags = new Set(
        git(['tag', '--list', 'v*']).trim().split('\n').filter(Boolean),
    );
    const taggedChangelogs = {};

    for (const version of releasedVersions(changelog)) {
        const tag = `v${version}`;
        if (!knownTags.has(tag)) continue;
        taggedChangelogs[version] = git(['show', `${tag}:CHANGELOG.md`]);
    }

    if (Object.keys(taggedChangelogs).length === 0) {
        throw new Error('No released changelog sections have locally available tags.');
    }
    assertReleasedSectionsUnchanged(changelog, taggedChangelogs);
    console.log(`Verified ${Object.keys(taggedChangelogs).length} immutable changelog sections.`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
