import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RELOAD_SIGNAL } from "../scripts/build.mjs";
import { webExtArguments } from "../scripts/run-development.mjs";
import {
  createFirefoxSource,
  syncFirefoxSource,
} from "../scripts/run-firefox.mjs";

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
