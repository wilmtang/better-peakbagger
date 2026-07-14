import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";

const ALLOWED_TOP_LEVEL = new Set([
  "LICENSE",
  "README.md",
  "icons",
  "manifest.json",
  "options",
  "popup",
  "src",
  "vendor",
]);

const REQUIRED_FILES = [
  "LICENSE",
  "README.md",
  "manifest.json",
  "icons/icon-128.png",
  "options/options.html",
  "popup/popup.html",
  "src/background.js",
  "src/capture-core.js",
  "vendor/chart.umd.min.js",
];

export async function verifyReleaseArchive(archiveBytes, expectedVersion) {
  const archive = await JSZip.loadAsync(archiveBytes);
  const entries = Object.keys(archive.files);

  for (const entry of entries) {
    const topLevel = entry.split("/", 1)[0];
    if (!ALLOWED_TOP_LEVEL.has(topLevel)) {
      throw new Error(`Release archive contains unexpected entry: ${entry}`);
    }
  }

  for (const requiredFile of REQUIRED_FILES) {
    if (!archive.file(requiredFile)) {
      throw new Error(`Release archive is missing required file: ${requiredFile}`);
    }
  }

  const archivedManifest = JSON.parse(
    await archive.file("manifest.json").async("string"),
  );
  if (archivedManifest.version !== expectedVersion) {
    throw new Error(
      `Archived manifest version ${JSON.stringify(archivedManifest.version)} does not match ${JSON.stringify(expectedVersion)}`,
    );
  }

  return entries;
}

async function main() {
  const archivePath = process.argv[2];
  if (!archivePath) {
    throw new Error("Usage: node scripts/verify-release-archive.mjs ARCHIVE_PATH");
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const entries = await verifyReleaseArchive(await readFile(archivePath), packageJson.version);
  console.log(`Verified ${archivePath} (${entries.length} archive entries).`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
