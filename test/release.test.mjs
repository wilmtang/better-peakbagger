import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";

import { buildAmoMetadata } from "../scripts/create-amo-metadata.mjs";
import { publishChrome } from "../scripts/publish-chrome.mjs";
import { validateRelease } from "../scripts/release-check.mjs";
import {
  requireSingleArchivePath,
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
  const metadata = buildAmoMetadata("GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3");
  assert.deepEqual(metadata.categories, ["other"]);
  assert.deepEqual(metadata.version.compatibility, ["firefox"]);
  assert.match(metadata.version.custom_license.name["en-US"], /or later/);
  assert.match(metadata.version.custom_license.text["en-US"], /at your option/);
  assert.match(metadata.version.custom_license.text["en-US"], /GNU AFFERO/);
  assert.match(metadata.version.approval_notes, /Chart\.js 4\.5\.1/);
  assert.match(metadata.description["en-US"], /coordinate corridor boxes/);
  assert.match(metadata.description["en-US"], /coordinate-only GPX/);
});

async function makeReleaseZip(extraFiles = {}) {
  const zip = new JSZip();
  const files = {
    LICENSE: "license",
    "README.md": "readme",
    "manifest.json": JSON.stringify({ version: "1.4.0" }),
    "icons/icon-128.png": "icon",
    "options/options.html": "options",
    "popup/popup.html": "popup",
    "src/background.js": "background",
    "src/capture-core.js": "core",
    "vendor/chart.umd.min.js": "chart",
    ...extraFiles,
  };
  for (const [name, contents] of Object.entries(files)) {
    zip.file(name, contents);
  }
  return zip.generateAsync({ type: "uint8array" });
}

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

test("release archive verification rejects ambiguous archive paths", () => {
  assert.equal(requireSingleArchivePath(["release.zip"]), "release.zip");
  assert.throws(() => requireSingleArchivePath([]), /Usage:/);
  assert.throws(
    () => requireSingleArchivePath(["old.zip", "release.zip"]),
    /Usage:/,
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
