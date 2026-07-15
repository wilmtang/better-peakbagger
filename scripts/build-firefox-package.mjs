import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";

export function requirePackagePaths(packagePaths) {
  if (packagePaths.length !== 2) {
    throw new Error(
      "Usage: node scripts/build-firefox-package.mjs SOURCE_PACKAGE.zip FIREFOX_PACKAGE.zip",
    );
  }
  const [sourcePath, firefoxPath] = packagePaths;
  if (path.resolve(sourcePath) === path.resolve(firefoxPath)) {
    throw new Error("Firefox package path must differ from the source package path");
  }
  return { sourcePath, firefoxPath };
}

export function createFirefoxManifest(sourceManifest) {
  if (
    typeof sourceManifest.options_ui?.page !== "string"
    || sourceManifest.options_ui.page === ""
    || sourceManifest.options_ui.open_in_tab !== true
  ) {
    throw new Error(
      "Canonical manifest must declare a full-tab options_ui page before creating the Firefox variant",
    );
  }

  const manifest = structuredClone(sourceManifest);
  manifest.options_ui.open_in_tab = false;
  return manifest;
}

export async function buildFirefoxPackage(sourceBytes) {
  const archive = await JSZip.loadAsync(sourceBytes);
  const manifestEntry = archive.file("manifest.json");
  if (!manifestEntry) {
    throw new Error("Source package is missing manifest.json");
  }

  const manifest = createFirefoxManifest(
    JSON.parse(await manifestEntry.async("string")),
  );
  archive.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, {
    date: manifestEntry.date,
    comment: manifestEntry.comment,
    unixPermissions: manifestEntry.unixPermissions,
    dosPermissions: manifestEntry.dosPermissions,
  });

  return archive.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
}

async function main() {
  const { sourcePath, firefoxPath } = requirePackagePaths(process.argv.slice(2));
  const firefoxBytes = await buildFirefoxPackage(await readFile(sourcePath));
  await writeFile(firefoxPath, firefoxBytes);
  console.log(`Built Firefox package ${firefoxPath}.`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
