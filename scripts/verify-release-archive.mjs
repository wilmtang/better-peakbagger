import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";

import {
  COPY_DIRS,
  COPY_FILES,
  ENTRIES,
  VENDOR_COPY,
  VENDOR_TZ,
} from "./build-config.mjs";

// Release archives are built from dist/, so derive their required runtime files
// from the same config that assembles dist rather than pinning the old src/
// layout here. COPY_DIRS is recursive; pin one icon below so an empty copied
// directory cannot satisfy verification.
const REQUIRED_FILES = [...new Set([
  ...ENTRIES.map(({ out }) => out),
  ...COPY_FILES.map(([, to]) => to),
  ...VENDOR_COPY.map(([, to]) => to),
  VENDOR_TZ.out,
  "icons/icon-128.png",
])];

const ALLOWED_TOP_LEVEL = new Set([
  ...REQUIRED_FILES.map(file => file.split("/", 1)[0]),
  ...COPY_DIRS.map(([, to]) => to.split("/", 1)[0]),
]);

const OPTIONS_PRESENTATION = {
  firefox: false,
  chrome: true,
};

export async function verifyReleaseArchive(archiveBytes, expectedVersion, browser) {
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

  if (browser !== undefined) {
    if (!Object.hasOwn(OPTIONS_PRESENTATION, browser)) {
      throw new Error(`Unknown release browser: ${browser}`);
    }
    const expectedOpenInTab = OPTIONS_PRESENTATION[browser];
    if (archivedManifest.options_ui?.open_in_tab !== expectedOpenInTab) {
      const presentation = expectedOpenInTab ? "a full tab" : "the add-on manager";
      throw new Error(
        `${browser} release options must open in ${presentation}`,
      );
    }
  }

  return entries;
}

export function requireArchiveArguments(args) {
  if (
    args.length !== 2
    || !Object.hasOwn(OPTIONS_PRESENTATION, args[1])
  ) {
    throw new Error(
      "Usage: node scripts/verify-release-archive.mjs ARCHIVE_PATH firefox|chrome",
    );
  }
  return { archivePath: args[0], browser: args[1] };
}

async function main() {
  const { archivePath, browser } = requireArchiveArguments(process.argv.slice(2));

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const entries = await verifyReleaseArchive(
    await readFile(archivePath),
    packageJson.version,
    browser,
  );
  console.log(`Verified ${browser} package ${archivePath} (${entries.length} archive entries).`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
