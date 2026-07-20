// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packagePaths(args) {
  if (args.length !== 2) {
    throw new Error(
      "Usage: node scripts/verify-packaged-extensions.mjs CHROME.zip FIREFOX.zip",
    );
  }
  return args.map(value => path.resolve(value));
}

async function extractArchive(archivePath, destination) {
  const archive = await JSZip.loadAsync(await readFile(archivePath));
  for (const entry of Object.values(archive.files)) {
    const normalized = path.posix.normalize(entry.name);
    if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`Package contains an unsafe path: ${entry.name}`);
    }
    const outputPath = path.join(destination, ...normalized.split("/"));
    if (entry.dir) {
      await mkdir(outputPath, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, await entry.async("nodebuffer"));
  }
}

async function runVerifier(script, extensionSource) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "scripts", script)], {
      cwd: projectRoot,
      env: { ...process.env, BPB_VERIFY_EXTENSION_SOURCE: extensionSource },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${script} failed (${signal || `exit ${code}`})`));
    });
  });
}

async function main() {
  const [chromeArchive, firefoxArchive] = packagePaths(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "better-peakbagger-packages-"));
  const chromeSource = path.join(temporaryRoot, "chrome");
  try {
    await mkdir(chromeSource);
    await extractArchive(chromeArchive, chromeSource);
    await runVerifier("verify-extension.mjs", chromeSource);
    // Firefox's temporary-install endpoint accepts the generated ZIP bytes
    // directly, so this runs the exact archive that will be submitted to AMO.
    await runVerifier("verify-firefox-extension.mjs", firefoxArchive);
    console.log("Packaged browser extension verification passed:");
    console.log(`  - Chrome archive: ${chromeArchive}`);
    console.log(`  - Firefox archive: ${firefoxArchive}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
