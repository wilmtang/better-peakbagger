import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API_ROOT = "https://chromewebstore.googleapis.com";
const IN_PROGRESS_STATES = new Set(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);
const SUCCESS_STATES = new Set(["SUCCEEDED", "UPLOAD_SUCCEEDED"]);
const SUBMITTED_STATES = new Set([
  "PENDING_REVIEW",
  "PUBLISHED",
  "PUBLISHED_TO_TESTERS",
]);

function requireValue(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

async function apiRequest(fetchImpl, token, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const bodyText = await response.text();
  let body = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { raw: bodyText };
    }
  }

  if (!response.ok) {
    const apiMessage = body.error?.message || body.raw || response.statusText;
    const apiDetails = body.error?.details?.length
      ? ` (${JSON.stringify(body.error.details)})`
      : "";
    const detail = `${apiMessage}${apiDetails}`;
    throw new Error(`Chrome Web Store API ${response.status}: ${detail}`);
  }
  return body;
}

export async function publishChrome({
  token,
  publisherId,
  extensionId,
  packageBytes,
  expectedVersion,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = 5_000,
  maxPolls = 60,
}) {
  const normalizedToken = requireValue("CHROME_WEBSTORE_TOKEN", token);
  const normalizedPublisherId = requireValue("CHROME_PUBLISHER_ID", publisherId);
  const normalizedExtensionId = requireValue("CHROME_EXTENSION_ID", extensionId);
  const normalizedVersion = requireValue("expectedVersion", expectedVersion);
  if (!/^[a-p]{32}$/.test(normalizedExtensionId)) {
    throw new Error("CHROME_EXTENSION_ID must be a 32-character Chrome extension ID");
  }
  if (!(packageBytes instanceof Uint8Array) || packageBytes.byteLength === 0) {
    throw new Error("Chrome release package is empty");
  }

  const itemName = `publishers/${encodeURIComponent(normalizedPublisherId)}/items/${normalizedExtensionId}`;
  const uploadUrl = `${API_ROOT}/upload/v2/${itemName}:upload`;
  const itemUrl = `${API_ROOT}/v2/${itemName}`;

  const upload = await apiRequest(fetchImpl, normalizedToken, uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: packageBytes,
  });

  let uploadState = upload.uploadState;
  let uploadedVersion = upload.crxVersion;
  for (let poll = 0; IN_PROGRESS_STATES.has(uploadState) && poll < maxPolls; poll += 1) {
    await sleep(pollIntervalMs);
    const status = await apiRequest(
      fetchImpl,
      normalizedToken,
      `${itemUrl}:fetchStatus`,
    );
    uploadState = status.lastAsyncUploadState;
  }

  if (!SUCCESS_STATES.has(uploadState)) {
    throw new Error(`Chrome Web Store upload did not succeed (state: ${uploadState || "missing"})`);
  }
  if (uploadedVersion && uploadedVersion !== normalizedVersion) {
    throw new Error(
      `Chrome Web Store processed version ${uploadedVersion}; expected ${normalizedVersion}`,
    );
  }

  const publish = await apiRequest(fetchImpl, normalizedToken, `${itemUrl}:publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publishType: "DEFAULT_PUBLISH",
      blockOnWarnings: true,
    }),
  });

  if (publish.warningInfo?.warnings?.length) {
    const descriptions = publish.warningInfo.warnings
      .map((warning) => warning.description || warning.reason)
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `Chrome Web Store blocked publishing on warnings: ${descriptions || "unspecified warning"}`,
    );
  }
  if (!SUBMITTED_STATES.has(publish.state)) {
    throw new Error(
      `Chrome Web Store returned an unexpected publish state: ${publish.state || "missing"}`,
    );
  }

  return {
    uploadState,
    uploadedVersion: uploadedVersion || normalizedVersion,
    publishState: publish.state,
  };
}

async function main() {
  const packagePaths = process.argv.slice(2);
  if (packagePaths.length !== 1) {
    throw new Error("Usage: node scripts/publish-chrome.mjs RELEASE_PACKAGE.zip");
  }

  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  const result = await publishChrome({
    token: process.env.CHROME_WEBSTORE_TOKEN,
    publisherId: process.env.CHROME_PUBLISHER_ID,
    extensionId: process.env.CHROME_EXTENSION_ID,
    packageBytes: await readFile(packagePaths[0]),
    expectedVersion: manifest.version,
  });
  console.log(`Submitted Chrome Web Store version ${result.uploadedVersion} for review.`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
