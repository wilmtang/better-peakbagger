import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { distDir, root } from "./build-config.mjs";
import { RELOAD_SIGNAL, watchAll } from "./build.mjs";
import {
  createFirefoxSource,
  syncFirefoxSource,
} from "./run-firefox.mjs";

export function webExtArguments(browser, sourceDir, passthrough = []) {
  if (browser !== "chromium" && browser !== "firefox") {
    throw new Error("Usage: node scripts/run-development.mjs <chromium|firefox> [web-ext options]");
  }
  return [
    "run",
    "--source-dir",
    sourceDir,
    ...(browser === "chromium" ? ["--target", "chromium"] : []),
    "--watch-file",
    path.join(sourceDir, RELOAD_SIGNAL),
    ...passthrough,
  ];
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function runDevelopment(browser, passthrough = []) {
  let firefoxSource = null;
  let watcher = null;
  let child = null;
  let forwardedSignal = null;

  try {
    if (browser === "firefox") {
      firefoxSource = await createFirefoxSource();
    } else if (browser !== "chromium") {
      webExtArguments(browser, distDir);
    }

    watcher = await watchAll({
      afterBuild: firefoxSource
        ? ({ sequence }) => syncFirefoxSource({
            distDir,
            sourceDir: firefoxSource.sourceDir,
            reloadToken: sequence,
          })
        : undefined,
    });

    const sourceDir = firefoxSource?.sourceDir ?? distDir;
    const executable = process.platform === "win32" ? "web-ext.cmd" : "web-ext";
    child = spawn(executable, webExtArguments(browser, sourceDir, passthrough), {
      cwd: root,
      stdio: "inherit",
    });

    const forwardSignal = signal => {
      forwardedSignal = signal;
      if (!child.killed) child.kill(signal);
    };
    const forwardInterrupt = () => forwardSignal("SIGINT");
    const forwardTerminate = () => forwardSignal("SIGTERM");
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);

    try {
      const result = await waitForChild(child);
      if (forwardedSignal) return 0;
      if (result.signal) return 1;
      return result.code ?? 1;
    } finally {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    }
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
    await watcher?.close();
    await firefoxSource?.cleanup();
  }
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  runDevelopment(process.argv[2], process.argv.slice(3))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
