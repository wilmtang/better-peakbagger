import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateRelease } from "./release-check.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function die(msg) {
  console.error(msg);
  process.exitCode = 1;
  return;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, obj) {
  await writeFile(filePath, JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const version = process.argv[2];
  if (!version || !SEMVER.test(version)) {
    return die("Usage: node scripts/release-bump.mjs <MAJOR.MINOR.PATCH>");
  }

  const tag = `v${version}`;
  const today = new Date().toISOString().slice(0, 10);

  // Read all files.
  const [manifest, packageJson, packageLock, changelog] = await Promise.all([
    readJson("manifest.json"),
    readJson("package.json"),
    readJson("package-lock.json"),
    readFile("CHANGELOG.md", "utf8"),
  ]);

  // Stamp the Unreleased heading.
  const unreleasedRe = /^## Unreleased$/m;
  if (!unreleasedRe.test(changelog)) {
    return die("CHANGELOG.md has no '## Unreleased' heading to stamp.");
  }
  const newChangelog = changelog.replace(
    unreleasedRe,
    `## ${version} \u2014 ${today}`,
  );

  // Bump versions.
  manifest.version = version;
  packageJson.version = version;
  packageLock.version = version;
  if (packageLock.packages?.[""])
    packageLock.packages[""].version = version;

  // Validate before writing — catches anything we missed.
  validateRelease({
    tag,
    manifest,
    packageJson,
    packageLock,
    changelog: newChangelog,
  });

  // Write.
  await Promise.all([
    writeJson("manifest.json", manifest),
    writeJson("package.json", packageJson),
    writeJson("package-lock.json", packageLock),
    writeFile("CHANGELOG.md", newChangelog),
  ]);

  // Re-sync the lockfile so the serialization is npm's, not ours.
  execSync("npm install --package-lock-only --ignore-scripts", {
    stdio: "inherit",
  });

  // Commit and tag.
  execSync(
    `git add manifest.json package.json package-lock.json CHANGELOG.md && git commit -m "chore: release ${version}" && git tag ${tag}`,
    { stdio: "inherit" },
  );

  console.log(`\nRelease ${tag} committed and tagged locally.`);
  console.log(`Push with: git push origin main --tags`);
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
