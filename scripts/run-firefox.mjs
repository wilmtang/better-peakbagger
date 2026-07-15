import { spawn } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createFirefoxManifest } from "./build-firefox-package.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");
const RUNTIME_DIRECTORIES = ["icons", "options", "popup", "src", "vendor"];

export async function prepareFirefoxSource({
  projectRoot = defaultProjectRoot,
  temporaryRoot = tmpdir(),
} = {}) {
  const sourceDir = await mkdtemp(
    path.join(temporaryRoot, "better-peakbagger-firefox-"),
  );

  try {
    const manifest = createFirefoxManifest(
      JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8")),
    );
    await writeFile(
      path.join(sourceDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await Promise.all(RUNTIME_DIRECTORIES.map(directory => cp(
      path.join(projectRoot, directory),
      path.join(sourceDir, directory),
      { recursive: true },
    )));
  } catch (error) {
    await rm(sourceDir, { recursive: true, force: true });
    throw error;
  }

  return {
    sourceDir,
    cleanup: () => rm(sourceDir, { recursive: true, force: true }),
  };
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
