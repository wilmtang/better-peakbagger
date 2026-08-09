import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stampUnreleased } from './release-changelog.mjs';
import { validateRelease } from './release-check.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function die(msg) {
    console.error(msg);
    process.exitCode = 1;
    return;
}

export function validateReleasePreflight({
    branch,
    status,
    headCommit,
    originMainCommit,
    localTagExists,
    remoteTagExists,
    tag,
}) {
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

export function resolveReleaseDate(explicitDate, now = new Date()) {
    if (explicitDate === undefined) return now.toISOString().slice(0, 10);
    const parsed = new Date(`${explicitDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)
        || Number.isNaN(parsed.valueOf())
        || parsed.toISOString().slice(0, 10) !== explicitDate) {
        throw new Error('--date must be an ISO calendar date in YYYY-MM-DD form.');
    }
    return explicitDate;
}

export function atomicReleasePushArgs(tag) {
    return ['push', '--atomic', 'origin', 'main', `refs/tags/${tag}`];
}

function git(args, options = {}) {
    return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function commandSucceeded(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status === 0) return true;
    if (result.status === 1 || result.status === 2) return false;
    throw new Error(result.stderr.trim() || `${command} exited with status ${result.status}`);
}

function releaseDateArgument(args) {
    const dateIndex = args.indexOf('--date');
    if (dateIndex === -1) return undefined;
    if (!args[dateIndex + 1] || args[dateIndex + 1].startsWith('--')) {
        throw new Error('--date requires a YYYY-MM-DD value.');
    }
    return args[dateIndex + 1];
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, obj) {
    await writeFile(filePath, JSON.stringify(obj, null, 2) + '\n');
}

async function main() {
    const version = process.argv[2];
    const options = process.argv.slice(3);
    const dryRun = options.includes('--dry-run');
    if (!version || !SEMVER.test(version)) {
        return die(
            'Usage: node scripts/release-bump.mjs <MAJOR.MINOR.PATCH> [--dry-run] [--date YYYY-MM-DD]',
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
        readJson('manifest.json'),
        readJson('package.json'),
        readJson('package-lock.json'),
        readFile('CHANGELOG.md', 'utf8'),
    ]);

    const newChangelog = stampUnreleased(changelog, version, today);

    // Bump versions.
    manifest.version = version;
    packageJson.version = version;
    packageLock.version = version;
    if (packageLock.packages?.[''])
        packageLock.packages[''].version = version;

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
    console.log(`After committing and tagging only the verified commit, push with:\n  git ${
        atomicReleasePushArgs(tag).join(' ')}`);
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
