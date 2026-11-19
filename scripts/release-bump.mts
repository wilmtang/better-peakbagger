import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stampUnreleased } from './release-changelog.mts';
import {
    validateRelease,
    type ReleaseManifest,
    type ReleasePackageJson,
    type ReleasePackageLock,
} from './release-check.mts';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type ReleasePreflightInput = {
    branch: string;
    status: string;
    headCommit: string;
    originMainCommit: string;
    localTagExists: boolean;
    remoteTagExists: boolean;
    tag: string;
};

function die(msg: string): void {
    console.error(msg);
    process.exitCode = 1;
}

export function validateReleasePreflight({
    branch,
    status,
    headCommit,
    originMainCommit,
    localTagExists,
    remoteTagExists,
    tag,
}: ReleasePreflightInput): void {
    if (branch !== 'main') {
        throw new Error(`Release metadata must be stamped on main, not ${branch || 'detached HEAD'}.`);
    }
    if (status !== '') {
        throw new Error('Release metadata requires a clean worktree and index.');
    }
    if (headCommit !== originMainCommit) {
        throw new Error('Local main must exactly match the freshly fetched origin/main.');
    }
    if (localTagExists || remoteTagExists) {
        throw new Error(`Release tag ${tag} already exists ${localTagExists ? 'locally' : 'on origin'}.`);
    }
}

export function resolveReleaseDate(explicitDate: string | undefined, now: Date = new Date()): string {
    if (explicitDate === undefined) return now.toISOString().slice(0, 10);
    const parsed = new Date(`${explicitDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)
        || Number.isNaN(parsed.valueOf())
        || parsed.toISOString().slice(0, 10) !== explicitDate) {
        throw new Error('--date must be an ISO calendar date in YYYY-MM-DD form.');
    }
    return explicitDate;
}

export function atomicReleasePushArgs(tag: string): string[] {
    return ['push', '--atomic', 'origin', 'main', `refs/tags/${tag}`];
}

function git(
    args: string[],
    options: Omit<ExecFileSyncOptionsWithStringEncoding, 'encoding'> = {},
): string {
    return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function commandSucceeded(command: string, args: string[]): boolean {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status === 0) return true;
    if (result.status === 1 || result.status === 2) return false;
    throw new Error(result.stderr.trim() || `${command} exited with status ${result.status}`);
}

function releaseDateArgument(args: string[]): string | undefined {
    const dateIndex = args.indexOf('--date');
    if (dateIndex === -1) return undefined;
    if (!args[dateIndex + 1] || args[dateIndex + 1].startsWith('--')) {
        throw new Error('--date requires a YYYY-MM-DD value.');
    }
    return args[dateIndex + 1];
}

async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function writeJson(filePath: string, obj: unknown): Promise<void> {
    await writeFile(filePath, JSON.stringify(obj, null, 2) + '\n');
}

async function main(): Promise<void> {
    const version = process.argv[2];
    const options = process.argv.slice(3);
    const dryRun = options.includes('--dry-run');
    if (!version || !SEMVER.test(version)) {
        return die(
            'Usage: node scripts/release-bump.mts <MAJOR.MINOR.PATCH> [--dry-run] [--date YYYY-MM-DD]',
        );
    }
    const recognizedOptions = new Set(['--dry-run', '--date', releaseDateArgument(options)]);
    const unknownOption = options.find((option) => !recognizedOptions.has(option));
    if (unknownOption) return die(`Unknown release option: ${unknownOption}`);

    const tag = `v${version}`;
    const today = resolveReleaseDate(releaseDateArgument(options));

    git(['fetch', '--quiet', '--no-tags', 'origin',
        '+refs/heads/main:refs/remotes/origin/main']);
    let branch = '';
    try {
        branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    } catch {
        // The preflight reports detached HEAD with the actionable release boundary.
    }
    validateReleasePreflight({
        branch,
        status: git(['status', '--porcelain=v1', '--untracked-files=normal']),
        headCommit: git(['rev-parse', 'HEAD']),
        originMainCommit: git(['rev-parse', 'refs/remotes/origin/main']),
        localTagExists: commandSucceeded('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]),
        remoteTagExists: commandSucceeded(
            'git',
            ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`],
        ),
        tag,
    });

    // Read all files.
    const [manifest, packageJson, packageLock, changelog] = await Promise.all([
        readJson<ReleaseManifest>('manifest.json'),
        readJson<ReleasePackageJson>('package.json'),
        readJson<ReleasePackageLock>('package-lock.json'),
        readFile('CHANGELOG.md', 'utf8'),
    ]);

    const newChangelog = stampUnreleased(changelog, version, today);

    // Bump versions.
    manifest.version = version;
    packageJson.version = version;
    packageLock.version = version;
    const rootPackage = packageLock.packages?.[''];
    if (rootPackage) {
        rootPackage.version = version;
    }

    // Validate before writing — catches anything we missed.
    validateRelease({
        tag,
        manifest,
        packageJson,
        packageLock,
        changelog: newChangelog,
    });

    if (dryRun) {
        console.log(`Release ${tag} metadata and changelog are ready to stamp.`);
        return;
    }

    // Write.
    await Promise.all([
        writeJson('manifest.json', manifest),
        writeJson('package.json', packageJson),
        writeJson('package-lock.json', packageLock),
        writeFile('CHANGELOG.md', newChangelog),
    ]);

    // Re-sync the lockfile so the serialization is npm's, not ours.
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
        stdio: 'inherit',
    });

    console.log(`\nStamped release ${tag} metadata with the ${today} UTC release date.`);
    console.log('No commit or tag was created. Review the diff and run every release gate first.');
    console.log('Commit and push main, wait for CI and a fresh three-pass rehearsal, then run:');
    console.log(`  npm run release:preflight -- ${tag} --ci-run CI_RUN_ID --rehearsal-run REHEARSAL_RUN_ID`);
    console.log(`After tagging the exact commit from that receipt, push with:\n  git ${
        atomicReleasePushArgs(tag).join(' ')}`);
}

const isCli =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
