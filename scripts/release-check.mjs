import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requireEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(
            `${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
        );
    }
}

export function validateRelease({
    tag,
    manifest,
    packageJson,
    packageLock,
    changelog,
}) {
    const match = SEMVER_TAG.exec(tag ?? '');
    if (!match) {
        throw new Error(
            `Release tag ${JSON.stringify(tag)} must be an exact vMAJOR.MINOR.PATCH tag`,
        );
    }

    const version = tag.slice(1);
    requireEqual('manifest.json version', manifest.version, version);
    requireEqual('package.json version', packageJson.version, version);
    requireEqual('package-lock.json version', packageLock.version, version);
    requireEqual(
        'package-lock.json root package version',
        packageLock.packages?.['']?.version,
        version,
    );
    requireEqual('package.json description', packageJson.description, manifest.description);

    const geckoId = manifest.browser_specific_settings?.gecko?.id;
    if (typeof geckoId !== 'string' || geckoId.trim() === '') {
        throw new Error(
            'manifest.json must keep a stable browser_specific_settings.gecko.id for AMO updates',
        );
    }

    const escapedVersion = version.replaceAll('.', '\\.');
    if (!new RegExp(`^## ${escapedVersion}(?:\\s|$)`, 'm').test(changelog)) {
        throw new Error(`CHANGELOG.md has no release heading for ${version}`);
    }

    return version;
}

export function validateTagAtHead({ tag, tagCommit, headCommit }) {
    requireEqual(`release tag ${tag} commit`, tagCommit, headCommit);
}

export function validateProtectedMainAncestry({ tag, isAncestor }) {
    if (!isAncestor) {
        throw new Error(`Release tag ${tag} is not integrated into protected origin/main.`);
    }
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function main() {
    const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
    const [manifest, packageJson, packageLock, changelog] = await Promise.all([
        readJson('manifest.json'),
        readJson('package.json'),
        readJson('package-lock.json'),
        readFile('CHANGELOG.md', 'utf8'),
    ]);

    const version = validateRelease({
        tag,
        manifest,
        packageJson,
        packageLock,
        changelog,
    });
    if (process.argv.includes('--metadata-only')) {
        console.log(`Release metadata is consistent for ${version}.`);
        return;
    }
    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
    }).trim();
    const tagCommit = execFileSync(
        'git',
        ['rev-list', '-n', '1', tag],
        { encoding: 'utf8' },
    ).trim();
    validateTagAtHead({ tag, tagCommit, headCommit });
    if (process.argv.includes('--require-protected-main')) {
        const ancestry = spawnSync(
            'git',
            ['merge-base', '--is-ancestor', tagCommit, 'refs/remotes/origin/main'],
            { encoding: 'utf8' },
        );
        if (ancestry.status !== 0 && ancestry.status !== 1) {
            throw new Error(
                ancestry.stderr.trim()
                || 'Could not compare the release tag with protected origin/main.',
            );
        }
        validateProtectedMainAncestry({ tag, isAncestor: ancestry.status === 0 });
    }
    console.log(`Release metadata is consistent for ${version}.`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
