import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createFirefoxManifest } from "./build-firefox-package.mjs";
import { RELOAD_SIGNAL } from "./build.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");
const defaultDistDir = path.join(defaultProjectRoot, "dist");

export async function createFirefoxSource({ temporaryRoot = tmpdir() } = {}) {
  const sourceDir = await mkdtemp(
    path.join(temporaryRoot, "better-peakbagger-firefox-"),
  );
  return {
    sourceDir,
    cleanup: () => rm(sourceDir, { recursive: true, force: true }),
  };
}

async function mirrorDirectory(sourceDir, destinationDir, { preserve = new Set() } = {}) {
  await mkdir(destinationDir, { recursive: true });
  const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  const sourceNames = new Set(sourceEntries.map(entry => entry.name));
  for (const destinationEntry of await readdir(destinationDir, { withFileTypes: true })) {
    if (!sourceNames.has(destinationEntry.name) && !preserve.has(destinationEntry.name)) {
      await rm(path.join(destinationDir, destinationEntry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  for (const entry of sourceEntries) {
    if (preserve.has(entry.name)) continue;
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await mirrorDirectory(source, destination);
    } else {
      await copyFile(source, destination);
    }
  }
}

// Synchronize a complete dist build before changing the watched reload signal.
// Firefox needs this copy because its development manifest intentionally opens
// Preferences inline instead of using Chromium's full-tab behavior.
export async function syncFirefoxSource({
  distDir = defaultDistDir,
  sourceDir,
  reloadToken,
}) {
  await mirrorDirectory(distDir, sourceDir, {
    preserve: new Set([RELOAD_SIGNAL]),
  });
  const manifest = createFirefoxManifest(
    JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8")),
  );
  await writeFile(
    path.join(sourceDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (reloadToken !== undefined) {
    await writeFile(path.join(sourceDir, RELOAD_SIGNAL), `${reloadToken}\n`);
  }
}

// The Firefox dev source is the built extension (dist/) with only its manifest
// overridden with Firefox-specific fields. Run `npm run build` first.
export async function prepareFirefoxSource({
  distDir = defaultDistDir,
  temporaryRoot = tmpdir(),
} = {}) {
  const prepared = await createFirefoxSource({ temporaryRoot });

  try {
    await syncFirefoxSource({ distDir, sourceDir: prepared.sourceDir });
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }

  return prepared;
}

async function main() {
  const { sourceDir, cleanup } = await prepareFirefoxSource();
  const executable = process.platform === "win32" ? "web-ext.cmd" : "web-ext";
  const child = spawn(
    executable,
    ["run", "--source-dir", sourceDir, ...process.argv.slice(2)],
    { cwd: defaultProjectRoot, stdio: "inherit" },
  );

  const forwardSignal = signal => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) {
      process.exitCode = 1;
    } else {
      process.exitCode = result.code ?? 1;
    }
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
    await cleanup();
  }
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
