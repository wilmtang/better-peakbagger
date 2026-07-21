import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";

import {
  COPY_FILES,
  ENTRIES,
  VENDOR_COPY,
  VENDOR_TZ,
} from "../scripts/build-config.mjs";
import {
  buildFirefoxPackage,
  createFirefoxManifest,
  requirePackagePaths,
} from "../scripts/build-firefox-package.mjs";
import { buildAmoMetadata } from "../scripts/create-amo-metadata.mjs";
import { publishChrome } from "../scripts/publish-chrome.mjs";
import { validateRelease } from "../scripts/release-check.mjs";
import { prepareFirefoxSource } from "../scripts/run-firefox.mjs";
import {
  requireArchiveArguments,
  verifyReleaseArchive,
} from "../scripts/verify-release-archive.mjs";

function releaseState(overrides = {}) {
  return {
    tag: "v1.4.0",
    manifest: {
      version: "1.4.0",
      browser_specific_settings: { gecko: { id: "better-peakbagger@example.test" } },
    },
    packageJson: { version: "1.4.0" },
    packageLock: { version: "1.4.0", packages: { "": { version: "1.4.0" } } },
    changelog: "# Changelog\n\n## 1.4.0 — 2026-07-13\n",
    ...overrides,
  };
}

test("release metadata requires an exact tag and synchronized versions", () => {
  assert.equal(validateRelease(releaseState()), "1.4.0");
  assert.throws(
    () => validateRelease(releaseState({ tag: "release-1.4.0" })),
    /exact vMAJOR\.MINOR\.PATCH/,
  );
  assert.throws(
    () => validateRelease(releaseState({ packageJson: { version: "1.3.0" } })),
    /package\.json version/,
  );
  assert.throws(
    () => validateRelease(releaseState({ changelog: "# Changelog\n" })),
    /no release heading/,
  );
});

test("Firefox metadata preserves the project's or-later license grant", () => {
  const metadata = buildAmoMetadata({
    licenseText: "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3",
    description: "Better Peakbagger streamlines trip planning.\n\ncoordinate corridor boxes\nWaypoint coordinates and names are included by default",
  });
  assert.deepEqual(metadata.categories, ["other"]);
  assert.deepEqual(metadata.version.compatibility, ["firefox"]);
  assert.match(metadata.version.custom_license.name["en-US"], /or later/);
  assert.match(metadata.version.custom_license.text["en-US"], /at your option/);
  assert.match(metadata.version.custom_license.text["en-US"], /GNU AFFERO/);
  assert.match(metadata.version.approval_notes, /esbuild 0\.28\.1/);
  assert.match(metadata.version.approval_notes, /Chart\.js 4\.5\.1/);
  assert.match(metadata.version.approval_notes, /Marked 18\.0\.6/);
  assert.match(metadata.version.approval_notes, /MapLibre GL JS 5\.24\.0/);
  assert.match(metadata.version.approval_notes, /tz-lookup 6\.1\.25/);
  assert.doesNotMatch(metadata.version.approval_notes, /build-free|@photostructure/);
  assert.match(metadata.version.approval_notes, /tiles\.mapterhorn\.com/);
  assert.match(metadata.description["en-US"], /coordinate corridor boxes/);
  assert.match(metadata.description["en-US"], /Waypoint coordinates and names are included by default/);
});

async function makeReleaseZip(extraFiles = {}, omittedFiles = []) {
  const zip = new JSZip();
  const omitted = new Set(omittedFiles);
  const files = {
    ...Object.fromEntries(ENTRIES.map(({ out }) => [out, `bundle:${out}`])),
    ...Object.fromEntries(COPY_FILES.map(([, out]) => [out, `copy:${out}`])),
    ...Object.fromEntries(VENDOR_COPY.map(([, out]) => [out, `vendor:${out}`])),
    [VENDOR_TZ.out]: "vendor:tz-lookup",
    "icons/icon-128.png": "icon",
    "manifest.json": JSON.stringify({
      version: "1.4.0",
      options_ui: {
        page: "options/options.html",
        open_in_tab: true,
      },
    }),
    ...extraFiles,
  };
  for (const [name, contents] of Object.entries(files)) {
    if (!omitted.has(name)) {
      zip.file(name, contents);
    }
  }
  return zip.generateAsync({ type: "uint8array" });
}

test("release and browser development commands use the dist build", async () => {
  const [packageJson, workflow] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson.scripts.package, /build:release.*--source-dir dist/);
  assert.equal(
    packageJson.scripts["start:firefox"],
    "node scripts/run-development.mjs firefox",
  );
  assert.equal(
    packageJson.scripts["start:chromium"],
    "node scripts/run-development.mjs chromium",
  );
  assert.match(
    workflow,
    /- name: Build store packages[\s\S]*?npm run package[\s\S]*?chrome_archive=/,
  );
  assert.match(workflow, /- name: Run GPX scale test\s+run: npm run test:scale/);
});

test("bare web-ext commands use only the dist build", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.webExt.sourceDir, "dist");
  assert.equal("ignoreFiles" in packageJson.webExt, false);
});

test("CI tests, lints, and exercises both real browser extensions", async () => {
  const workflow = await readFile(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  assert.match(workflow, /node:\s*\n[\s\S]*?run: npm test[\s\S]*?run: npm run lint/);
  assert.match(workflow, /scale:\s*\n[\s\S]*?run: npm run test:scale/);
  assert.match(workflow, /chrome:\s*\n[\s\S]*?run: npm run verify:chrome/);
  assert.match(workflow, /firefox:\s*\n[\s\S]*?run: npm run verify:firefox/);
  assert.equal(workflow.match(/run: npm ci/g)?.length, 4);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  await assert.rejects(
    lstat(new URL("../.github/workflows/ci.yml", import.meta.url)),
    { code: "ENOENT" },
  );
});

test("release archive rejects development and internal files", async () => {
  await assert.doesNotReject(
    verifyReleaseArchive(await makeReleaseZip(), "1.4.0"),
  );
  await assert.rejects(
    verifyReleaseArchive(await makeReleaseZip({ "test/private-fixture.html": "no" }), "1.4.0"),
    /unexpected entry: test\//,
  );
  await assert.rejects(
    verifyReleaseArchive(await makeReleaseZip(), "1.4.1"),
    /does not match/,
  );
});

test("Firefox package embeds options without changing its canonical Chrome package", async () => {
  const sourceBytes = await makeReleaseZip();
  const firefoxBytes = await buildFirefoxPackage(sourceBytes);
  const [sourceArchive, firefoxArchive] = await Promise.all([
    JSZip.loadAsync(sourceBytes),
    JSZip.loadAsync(firefoxBytes),
  ]);
  const [sourceManifest, firefoxManifest] = await Promise.all([
    sourceArchive.file("manifest.json").async("string").then(JSON.parse),
    firefoxArchive.file("manifest.json").async("string").then(JSON.parse),
  ]);

  assert.deepEqual(Object.keys(firefoxArchive.files), Object.keys(sourceArchive.files));
  for (const [name, sourceEntry] of Object.entries(sourceArchive.files)) {
    if (name === "manifest.json" || sourceEntry.dir) continue;
    assert.deepEqual(
      await firefoxArchive.file(name).async("uint8array"),
      await sourceEntry.async("uint8array"),
      `${name} must be unchanged in the Firefox package`,
    );
  }
  assert.equal(sourceManifest.options_ui.open_in_tab, true);
  assert.equal(firefoxManifest.options_ui.open_in_tab, false);
  await assert.doesNotReject(
    verifyReleaseArchive(sourceBytes, "1.4.0", "chrome"),
  );
  await assert.doesNotReject(
    verifyReleaseArchive(firefoxBytes, "1.4.0", "firefox"),
  );
  await assert.rejects(
    verifyReleaseArchive(sourceBytes, "1.4.0", "firefox"),
    /firefox release options must open in the add-on manager/,
  );
});

test("Firefox package builder rejects a non-canonical source package", async () => {
  const sourceBytes = await makeReleaseZip({
    "manifest.json": JSON.stringify({
      version: "1.4.0",
      options_ui: {
        page: "options/options.html",
        open_in_tab: false,
      },
    }),
  });
  await assert.rejects(
    buildFirefoxPackage(sourceBytes),
    /Canonical manifest must declare a full-tab options_ui page/,
  );
});

test("Firefox development source copies runtime files while overriding only the manifest", async () => {
  const prepared = await prepareFirefoxSource();
  try {
    const manifest = JSON.parse(
      await readFile(path.join(prepared.sourceDir, "manifest.json"), "utf8"),
    );
    const canonicalManifest = JSON.parse(
      await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(manifest, createFirefoxManifest(canonicalManifest));
    for (const directory of ["content", "css", "icons", "options", "popup", "terrain", "vendor"]) {
      assert.equal(
        (await lstat(path.join(prepared.sourceDir, directory))).isDirectory(),
        true,
      );
    }
  } finally {
    await prepared.cleanup();
  }
});

test("release archive requires third-party acknowledgements", async () => {
  await assert.rejects(
    verifyReleaseArchive(
      await makeReleaseZip({}, ["ACKNOWLEDGEMENTS.md"]),
      "1.4.0",
    ),
    /missing required file: ACKNOWLEDGEMENTS\.md/,
  );
});

test("release archive verification requires an explicit browser", () => {
  assert.deepEqual(requireArchiveArguments(["release.zip", "firefox"]), {
    archivePath: "release.zip",
    browser: "firefox",
  });
  assert.throws(() => requireArchiveArguments(["release.zip"]), /Usage:/);
  assert.throws(
    () => requireArchiveArguments(["release.zip", "safari"]),
    /Usage:/,
  );
});

test("Firefox package builder requires distinct input and output paths", () => {
  assert.deepEqual(requirePackagePaths(["source.zip", "firefox.zip"]), {
    sourcePath: "source.zip",
    firefoxPath: "firefox.zip",
  });
  assert.throws(() => requirePackagePaths(["source.zip"]), /Usage:/);
  assert.throws(
    () => requirePackagePaths(["source.zip", "./source.zip"]),
    /must differ/,
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chromeArguments(overrides = {}) {
  return {
    token: "test-token",
    publisherId: "publisher-123",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    packageBytes: new Uint8Array([1, 2, 3]),
    expectedVersion: "1.4.0",
    pollIntervalMs: 0,
    ...overrides,
  };
}

test("Chrome publisher waits for upload processing before publishing", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ uploadState: "IN_PROGRESS" }),
    jsonResponse({ lastAsyncUploadState: "SUCCEEDED" }),
    jsonResponse({ state: "PENDING_REVIEW" }),
  ];
  const result = await publishChrome(chromeArguments({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleep: async () => {},
  }));

  assert.equal(result.uploadedVersion, "1.4.0");
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/upload\/v2\/publishers\/publisher-123\/items\//);
  assert.match(calls[1].url, /:fetchStatus$/);
  assert.match(calls[2].url, /:publish$/);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    publishType: "DEFAULT_PUBLISH",
    blockOnWarnings: true,
  });
});

test("Chrome publisher fails closed and never publishes a failed upload", async () => {
  const calls = [];
  await assert.rejects(
    publishChrome(chromeArguments({
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse({ uploadState: "FAILED" });
      },
    })),
    /upload did not succeed/,
  );
  assert.equal(calls.length, 1);
});

test("Chrome publisher rejects an invalid configured extension ID", async () => {
  await assert.rejects(
    publishChrome(chromeArguments({ extensionId: "not-an-extension-id" })),
    /32-character Chrome extension ID/,
  );
});

test("Chrome publisher treats store warnings as a failed release", async () => {
  const responses = [
    jsonResponse({ uploadState: "SUCCEEDED", crxVersion: "1.4.0" }),
    jsonResponse({
      state: "PENDING_REVIEW",
      warningInfo: { warnings: [{ description: "Listing needs attention" }] },
    }),
  ];
  await assert.rejects(
    publishChrome(chromeArguments({ fetchImpl: async () => responses.shift() })),
    /Listing needs attention/,
  );
});
