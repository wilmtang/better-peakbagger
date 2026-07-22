import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { formatReloadLog, RELOAD_SIGNAL } from "../../scripts/build.mjs";
import { webExtArguments } from "../../scripts/run-development.mjs";
import {
  createFirefoxSource,
  syncFirefoxSource,
} from "../../scripts/run-firefox.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("source and tests stay organized by owning domain", async () => {
  const sourceEntries = await readdir(path.join(projectRoot, "src"), { withFileTypes: true });
  const sourceFiles = sourceEntries
    .filter(entry => entry.isFile() && /\.(?:js|css)$/.test(entry.name))
    .map(entry => entry.name);
  assert.deepEqual(sourceFiles, [], "src/ must not contain loose runtime source files");

  const sourceDomains = sourceEntries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const testEntries = await readdir(path.join(projectRoot, "test"), { withFileTypes: true });
  const testDomains = new Set(testEntries.filter(entry => entry.isDirectory()).map(entry => entry.name));
  assert.deepEqual(
    sourceDomains.filter(domain => !testDomains.has(domain)),
    [],
    "every source domain must have a matching test directory",
  );

  const ungroupedTests = testEntries
    .filter(entry => entry.isFile() && /\.(?:test|scale)\.mjs$/.test(entry.name))
    .map(entry => entry.name);
  assert.deepEqual(ungroupedTests, [], "test files must live in a domain directory");

  const scaleEntries = await readdir(path.join(projectRoot, "test", "scale"), { withFileTypes: true });
  const ungroupedScaleTests = scaleEntries
    .filter(entry => entry.isFile() && entry.name.endsWith(".scale.mjs"))
    .map(entry => entry.name);
  assert.deepEqual(ungroupedScaleTests, [], "scale tests must live in a domain directory");
});

test("development reload logs include a local timestamp", () => {
  const localTime = new Date(2026, 6, 19, 13, 4, 5);
  assert.match(
    formatReloadLog(3, localTime),
    /^\[2026-07-19 13:04:05\] Rebuilt \d+ bundles \(development reload 3\)$/,
  );
});

test("development browsers reload only from the completed-build signal", () => {
  const chromiumSource = path.resolve("dist");
  assert.deepEqual(
    webExtArguments("chromium", chromiumSource, ["--chromium-binary", "/test/chrome"]),
    [
      "run",
      "--source-dir",
      chromiumSource,
      "--target",
      "chromium",
      "--watch-file",
      path.join(chromiumSource, RELOAD_SIGNAL),
      "--chromium-binary",
      "/test/chrome",
    ],
  );

  const firefoxSource = path.resolve("firefox-source");
  assert.deepEqual(webExtArguments("firefox", firefoxSource), [
    "run",
    "--source-dir",
    firefoxSource,
    "--watch-file",
    path.join(firefoxSource, RELOAD_SIGNAL),
  ]);
  assert.throws(() => webExtArguments("safari", chromiumSource), /chromium\|firefox/);
});

test("Firefox mirrors a completed build before exposing its reload signal", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bpb-development-test-"));
  const distDir = path.join(temporaryRoot, "dist");
  await mkdir(path.join(distDir, "content"), { recursive: true });
  await writeFile(path.join(distDir, "content", "theme.js"), "first build\n");
  await writeFile(path.join(distDir, RELOAD_SIGNAL), "do-not-copy\n");
  await writeFile(path.join(distDir, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    options_ui: {
      page: "options/options.html",
      open_in_tab: true,
    },
  }));

  const prepared = await createFirefoxSource({ temporaryRoot });
  try {
    await syncFirefoxSource({
      distDir,
      sourceDir: prepared.sourceDir,
      reloadToken: 1,
    });
    assert.equal(
      await readFile(path.join(prepared.sourceDir, "content", "theme.js"), "utf8"),
      "first build\n",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(prepared.sourceDir, "manifest.json"), "utf8"))
        .options_ui.open_in_tab,
      false,
    );
    assert.equal(
      await readFile(path.join(prepared.sourceDir, RELOAD_SIGNAL), "utf8"),
      "1\n",
    );

    await writeFile(path.join(distDir, "content", "theme.js"), "second build\n");
    await writeFile(path.join(prepared.sourceDir, "content", "stale.js"), "stale\n");
    await syncFirefoxSource({
      distDir,
      sourceDir: prepared.sourceDir,
      reloadToken: 2,
    });
    assert.equal(
      await readFile(path.join(prepared.sourceDir, "content", "theme.js"), "utf8"),
      "second build\n",
    );
    assert.equal(
      await readFile(path.join(prepared.sourceDir, RELOAD_SIGNAL), "utf8"),
      "2\n",
    );
    await assert.rejects(
      readFile(path.join(prepared.sourceDir, "content", "stale.js")),
      error => error.code === "ENOENT",
    );
  } finally {
    await prepared.cleanup();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
