import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { convertChromeDescription } from "../../scripts/create-chrome-description.mjs";

test("Chrome description converts the supported store Markdown to plain text", () => {
  const markdown = [
    "**Upgrade your experience.**",
    "",
    "An overview paragraph.",
    "",
    "**Features**",
    "",
    "- **Create drafts:** Turn activities into drafts.",
    "- **Explore terrain:** View routes in 3D.",
    "",
    "**Privacy by design**",
    "",
    "**No analytics.**",
    "",
    "[Privacy policy](https://example.com/privacy).",
  ].join("\n");

  assert.equal(
    convertChromeDescription(markdown),
    [
      "Upgrade your experience.",
      "",
      "An overview paragraph.",
      "",
      "FEATURES",
      "",
      "• Create drafts — Turn activities into drafts.",
      "",
      "• Explore terrain — View routes in 3D.",
      "",
      "PRIVACY BY DESIGN",
      "",
      "No analytics.",
      "",
      "Privacy policy:",
      "https://example.com/privacy",
      "",
    ].join("\n"),
  );
});

test("Chrome description rejects Markdown it cannot render safely", () => {
  assert.throws(
    () => convertChromeDescription("Read the [privacy policy](https://example.com/privacy)."),
    /Unsupported Markdown/,
  );
  assert.throws(
    () => convertChromeDescription("- **Privacy:** Read the [policy](https://example.com)."),
    /Unsupported Markdown/,
  );
  assert.throws(
    () => convertChromeDescription(""),
    /must contain the listing description/,
  );
});

test("checked-in Chrome description matches the Markdown source", async () => {
  const [markdown, chromeDescription] = await Promise.all([
    readFile(new URL("../../store-assets/description.md", import.meta.url), "utf8"),
    readFile(new URL("../../store-assets/description-chrome.txt", import.meta.url), "utf8"),
  ]);

  assert.equal(chromeDescription, convertChromeDescription(markdown));
});
