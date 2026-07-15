import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";

export function requirePackagePaths(packagePaths) {
  if (packagePaths.length !== 2) {
    throw new Error(
      "Usage: node scripts/build-chrome-package.mjs SOURCE_PACKAGE.zip CHROME_PACKAGE.zip",
    );
  }
  const [sourcePath, chromePath] = packagePaths;
  if (path.resolve(sourcePath) === path.resolve(chromePath)) {
    throw new Error("Chrome package path must differ from the source package path");
  }
  return { sourcePath, chromePath };
}

export async function buildChromePackage(sourceBytes) {
  const archive = await JSZip.loadAsync(sourceBytes);
  const manifestEntry = archive.file("manifest.json");
  if (!manifestEntry) {
    throw new Error("Source package is missing manifest.json");
  }

  const manifest = JSON.parse(await manifestEntry.async("string"));
  if (
    typeof manifest.options_ui?.page !== "string"
    || manifest.options_ui.page === ""
    || manifest.options_ui.open_in_tab !== false
  ) {
    throw new Error(
      "Source package must declare an inline options_ui page before creating the Chrome variant",
    );
  }

  manifest.options_ui.open_in_tab = true;
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
  const { sourcePath, chromePath } = requirePackagePaths(process.argv.slice(2));
  const chromeBytes = await buildChromePackage(await readFile(sourcePath));
  await writeFile(chromePath, chromeBytes);
  console.log(`Built Chrome package ${chromePath}.`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
