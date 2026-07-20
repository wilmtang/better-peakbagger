// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the derived Firefox extension in a disposable headless profile. This
// deliberately starts as a narrow vertical slice: prove Firefox interprets its
// manifest, starts background.js, and runs both execution worlds before the
// broader browser fixtures are shared with the Chrome verifier.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

import {
  createBrowserFixtureServer,
  fixtureHost,
  surfaceSelectors,
  verificationViewport,
} from "./browser-verification-fixtures.mjs";
import { prepareFirefoxSource } from "./run-firefox.mjs";

async function extensionBaseUrl(driver, addonId) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript(`
      const policy = WebExtensionPolicy.getByID(arguments[0]);
      return policy ? policy.getURL("") : null;
    `, addonId);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "better-peakbagger-firefox-verify-"));
  const profileTemplate = path.join(temporaryRoot, "profile");
  await mkdir(profileTemplate);

  let fixture;
  let prepared;
  let driver;
  let addonId;
  try {
    prepared = await prepareFirefoxSource({ temporaryRoot });
    fixture = await createBrowserFixtureServer({ temporaryRoot });

    const options = new firefox.Options()
      .addArguments("-headless", "-remote-allow-system-access")
      .setProfile(profileTemplate)
      .setPreference("network.dns.localDomains", fixtureHost)
      .windowSize(verificationViewport);
    options.setAcceptInsecureCerts(true);
    if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);

    driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .build();
    await driver.manage().setTimeouts({ pageLoad: 20_000, script: 15_000 });

    addonId = await driver.installAddon(prepared.sourceDir, true);
    const baseUrl = await extensionBaseUrl(driver, addonId);
    if (!baseUrl?.startsWith("moz-extension://")) {
      throw new Error(`Firefox reported an invalid extension origin: ${JSON.stringify(baseUrl)}`);
    }

    await driver.get(new URL("options/options.html", baseUrl).href);
    const runtimeProbe = await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      api.runtime.sendMessage({ type: "CAPTURE_STATUS", tabId: -1 })
        .then(value => done({ ok: true, value: value ?? null }))
        .catch(error => done({ ok: false, error: String(error) }));
    });
    if (!runtimeProbe?.ok) {
      throw new Error(`Firefox background did not answer CAPTURE_STATUS: ${runtimeProbe?.error || "no reply"}`);
    }

    await driver.get(
      `https://${fixtureHost}:${fixture.port}/climber/ascent.aspx?aid=1`,
    );
    await driver.wait(until.elementLocated(By.css(surfaceSelectors.analyzer)), 15_000);
    const surfaceState = await driver.executeScript(`return {
      origin: location.origin,
      theme: document.documentElement.getAttribute("data-bpb-theme"),
      analyzer: Boolean(document.getElementById("bpb-gpx-analysis")),
      stats: document.querySelector("#bpb-gpx-analysis div")?.textContent || "",
    };`);
    if (surfaceState.theme === null) {
      throw new Error("Firefox isolated-world theme bundle did not initialize");
    }
    if (!surfaceState.analyzer || !/Interactive Stats/.test(surfaceState.stats)) {
      throw new Error(`Firefox MAIN-world analyzer did not initialize: ${JSON.stringify(surfaceState)}`);
    }

    const capabilities = await driver.getCapabilities();
    console.log("Firefox extension startup verification passed:");
    console.log(`  - ${capabilities.getBrowserName()} ${capabilities.getBrowserVersion()}`);
    console.log(`  - hidden/headless at ${verificationViewport.width}x${verificationViewport.height}`);
    console.log("  - moz-extension origin, background message, isolated theme, and MAIN-world analyzer initialized");
    console.log("  - native toolbar activeTab grant, popup chrome, prompts, and window placement were not tested");
  } finally {
    if (driver && addonId) {
      await driver.uninstallAddon(addonId).catch(() => {});
    }
    if (driver) await driver.quit().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
    if (prepared) await prepared.cleanup().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Firefox extension startup verification failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
