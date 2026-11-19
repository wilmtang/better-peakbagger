import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type ReleaseManifest = {
    version?: unknown;
    description?: unknown;
    browser_specific_settings?: {
        gecko?: {
            id?: unknown;
        };
    };
};

export type ReleasePackageJson = {
    version?: unknown;
    description?: unknown;
};

export type ReleasePackageLock = {
    version?: unknown;
    packages?: Record<string, { version?: unknown } | undefined>;
};

export type ReleaseValidationInput = {
    tag?: string;
    manifest: ReleaseManifest;
    packageJson: ReleasePackageJson;
    packageLock: ReleasePackageLock;
    changelog: string;
};

export type TagCommitCheckInput = {
    tag: string;
    tagCommit: string;
    headCommit: string;
};

export type ProtectedMainAncestryInput = {
    tag: string;
    isAncestor: boolean;
};

function requireEqual(label: string, actual: unknown, expected: unknown): void {
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
}: ReleaseValidationInput): string {
    if (typeof tag !== 'string' || !SEMVER_TAG.test(tag)) {
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

export function validateTagAtHead({ tag, tagCommit, headCommit }: TagCommitCheckInput): void {
    requireEqual(`release tag ${tag} commit`, tagCommit, headCommit);
}

export function validateProtectedMainAncestry({ tag, isAncestor }: ProtectedMainAncestryInput): void {
    if (!isAncestor) {
        throw new Error(`Release tag ${tag} is not integrated into protected origin/main.`);
    }
}

async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function main(): Promise<void> {
    const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
    const [manifest, packageJson, packageLock, changelog] = await Promise.all([
        readJson<ReleaseManifest>('manifest.json'),
        readJson<ReleasePackageJson>('package.json'),
        readJson<ReleasePackageLock>('package-lock.json'),
        readFile('CHANGELOG.md', 'utf8'),
    ]);

    const version = validateRelease({
        tag,
        manifest,
        packageJson,
        packageLock,
        changelog,
    });
    if (!tag) {
        throw new Error(`Release tag ${JSON.stringify(tag)} must be an exact vMAJOR.MINOR.PATCH tag`);
    }
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
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
