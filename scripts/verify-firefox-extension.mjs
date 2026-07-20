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

import { Builder, By, Key, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

import {
  createBrowserFixtureServer,
  fixtureHost,
  storeUrls,
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

function assertState(condition, message, state) {
  if (!condition) {
    throw new Error(state === undefined ? message : `${message}: ${JSON.stringify(state)}`);
  }
}

async function waitForScript(driver, script, description, timeout = 15_000) {
  try {
    return await driver.wait(async () => {
      const value = await driver.executeScript(script);
      return value || false;
    }, timeout);
  } catch (error) {
    let current;
    try {
      current = await driver.executeScript(script);
    } catch (readError) {
      current = `unavailable: ${readError.message}`;
    }
    throw new Error(`Timed out waiting for ${description}; current value: ${JSON.stringify(current)}`, {
      cause: error,
    });
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
      .setPreference("network.dns.localDomains", [
        fixtureHost,
        "peakbagger.com",
        "tiles.mapterhorn.com",
        "tiles.openfreemap.org",
        "caltopo.s3.amazonaws.com",
        "ctusfs.s3.amazonaws.com",
        "tileserver.trimbleoutdoors.com",
        "a.tile.opentopomap.org",
        "tile.openstreetmap.org",
        "services.arcgisonline.com",
      ].join(","))
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

    const optionsUrl = new URL("options/options.html", baseUrl).href;
    await driver.get(optionsUrl);
    const runtimeProbe = await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      api.runtime.sendMessage({ type: "CAPTURE_STATUS", tabId: -1 })
        .then(value => done({ ok: true, value: value ?? null }))
        .catch(error => done({ ok: false, error: String(error) }));
    });
    if (!runtimeProbe?.ok) {
      throw new Error(`Firefox background did not answer CAPTURE_STATUS: ${runtimeProbe?.error || "no reply"}`);
    }

    const extensionState = await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      const keys = {
        sync: "bpbBrowserVerifySync",
        local: "bpbBrowserVerifyLocal",
        session: "bpbBrowserVerifySession",
      };
      const changed = new Promise(resolve => {
        const listener = (changes, area) => {
          if (area === "local" && changes[keys.local]?.newValue === "local") {
            api.storage.onChanged.removeListener(listener);
            resolve(true);
          }
        };
        api.storage.onChanged.addListener(listener);
      });
      Promise.all([
        api.storage.sync.set({ [keys.sync]: "sync" }),
        api.storage.local.set({ [keys.local]: "local" }),
        api.storage.session.set({ [keys.session]: "session" }),
      ]).then(async () => {
        const [sync, local, session, onChanged] = await Promise.all([
          api.storage.sync.get(keys.sync),
          api.storage.local.get(keys.local),
          api.storage.session.get(keys.session),
          changed,
        ]);
        await Promise.all([
          api.storage.sync.remove(keys.sync),
          api.storage.local.remove(keys.local),
          api.storage.session.remove(keys.session),
        ]);
        done({
          origin: globalThis.location.origin,
          version: api.runtime.getManifest().version,
          values: [sync[keys.sync], local[keys.local], session[keys.session]],
          onChanged,
        });
      }).catch(error => done({ error: String(error) }));
    });
    assertState(
      extensionState.origin.startsWith("moz-extension://"),
      "Firefox options did not use a moz-extension origin",
      extensionState,
    );
    assertState(
      extensionState.version && await driver.findElement(By.id("about-version")).getText()
        === `Version ${extensionState.version}`,
      "Firefox options did not render the manifest version",
      extensionState,
    );
    assertState(
      extensionState.onChanged && extensionState.values.join(",") === "sync,local,session",
      "Firefox storage areas or storage.onChanged did not round-trip",
      extensionState,
    );

    await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      api.storage.sync.get("bpbSettings").then(({ bpbSettings = {} }) =>
        api.storage.sync.set({
          bpbSettings: {
            ...bpbSettings,
            theme: "dark",
            enable3dMap: true,
            addReportCredit: true,
          },
        })).then(() => done(true), error => done(String(error)));
    });
    await driver.navigate().refresh();
    await waitForScript(
      driver,
      "return document.getElementById('theme')?.value === 'dark' && document.documentElement.dataset.bpbTheme === 'dark';",
      "the persisted Firefox option",
    );

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

    const terrainToggle = await driver.findElement(By.css(surfaceSelectors.terrainToggle));
    await terrainToggle.click();
    await driver.wait(until.elementLocated(By.id("bpb-terrain-frame")), 10_000);
    const ascentFrameOrigin = await driver.executeScript(
      "return document.getElementById('bpb-terrain-frame')?.src || '';",
    );
    assertState(
      ascentFrameOrigin.startsWith("moz-extension://"),
      "Firefox ascent 3D did not create an extension-owned frame",
      ascentFrameOrigin,
    );

    await driver.get(`https://${fixtureHost}:${fixture.port}/Peak.aspx?pid=2829`);
    await driver.wait(until.elementLocated(By.id("bpb-peak-links")), 10_000);
    await driver.wait(until.elementLocated(By.css(surfaceSelectors.terrainToggle)), 10_000);
    const peakState = await waitForScript(driver, `
      const button = document.querySelector(${JSON.stringify(surfaceSelectors.terrainToggle)});
      const mount = document.getElementById("bpb-map-viewport");
      return button && mount && !button.disabled ? {
        links: document.querySelectorAll("#bpb-peak-links a").length,
        theme: document.documentElement.getAttribute("data-bpb-theme"),
        framePreserved: document.getElementById("Gmap")?.parentElement === mount,
      } : false;
    `, "the Firefox Peak surface");
    assertState(
      peakState.links >= 4 && peakState.theme !== null && peakState.framePreserved,
      "Firefox Peak links, theme, or 3D mount did not initialize",
      peakState,
    );

    await driver.get(`https://${fixtureHost}:${fixture.port}/map/BigMap.aspx?t=A&d=2296`);
    const bigMapState = await waitForScript(driver, `
      const button = document.querySelector(${JSON.stringify(surfaceSelectors.terrainToggle)});
      return button && !button.disabled && document.getElementById("bpb-map-viewport") ? {
        theme: document.documentElement.getAttribute("data-bpb-theme"),
        frameReady: Boolean(document.getElementById("if")?.contentWindow?.mapsPlaceholder),
      } : false;
    `, "the Firefox BigMap surface");
    assertState(
      bigMapState.theme !== null && bigMapState.frameReady,
      "Firefox BigMap bridge or native frame did not initialize",
      bigMapState,
    );

    await driver.get(
      `https://${fixtureHost}:${fixture.port}/climber/PeakAscents.aspx?pid=1039`,
    );
    await driver.wait(until.elementLocated(By.id("pbaf-bar")), 10_000);
    const filterStateBefore = await driver.executeScript(`return {
      visible: [...document.querySelectorAll("table.gray tr")]
        .filter(row => row.cells.length > 1 && row.cells[0].tagName === "TD" && getComputedStyle(row).display !== "none").length,
      first: document.querySelector("table.gray tr td")?.textContent.trim(),
      controls: document.querySelectorAll(".pbaf-table-sort").length,
    };`);
    const showAll = await driver.findElement(By.css(".pbaf-reset"));
    await showAll.click();
    const climberSort = await driver.findElements(By.css(".pbaf-table-sort"));
    await climberSort[0].click();
    const filterStateAfter = await driver.executeScript(`return {
      visible: [...document.querySelectorAll("table.gray tr")]
        .filter(row => row.cells.length > 1 && row.cells[0].tagName === "TD" && getComputedStyle(row).display !== "none").length,
      first: document.querySelector("table.gray tr td")?.textContent.trim(),
    };`);
    assertState(
      filterStateBefore.controls > 1
        && filterStateAfter.visible > filterStateBefore.visible
        && filterStateAfter.first !== filterStateBefore.first,
      "Firefox ascent filter did not mount, reveal rows, and sort in place",
      { before: filterStateBefore, after: filterStateAfter },
    );

    const editorUrl = `https://${fixtureHost}:${fixture.port}/climber/ascentedit.aspx?cid=900001`;
    await driver.get(editorUrl);
    await driver.wait(until.elementLocated(By.css(surfaceSelectors.editor)), 10_000);
    const creditState = await waitForScript(driver, `
      const link = document.querySelector("#bpb-report-editor a[href*='better-peakbagger']");
      const textarea = document.getElementById("JournalText");
      return link && textarea?.value.includes(link.href) ? {
        href: link.href,
        serialized: textarea.value,
        nativeForm: textarea.form?.id || null,
      } : false;
    `, "the Firefox report credit");
    assertState(
      creditState.href === storeUrls.firefox && creditState.nativeForm,
      "Firefox report credit or native form ownership was wrong",
      creditState,
    );
    const editorSurface = await driver.findElement(By.css(".bpb-re-surface"));
    await editorSurface.click();
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    await editorSurface.sendKeys("Cross-browser ");
    await driver.actions({ async: true })
      .keyDown(modifier).sendKeys("b").keyUp(modifier)
      .sendKeys("bold")
      .keyDown(modifier).sendKeys("b").keyUp(modifier)
      .sendKeys(".")
      .perform();
    const editorTypedState = await waitForScript(
      driver,
      "const value = document.getElementById('JournalText')?.value || ''; return value.includes('Cross-browser') ? { value } : false;",
      "Firefox editor serialization",
    );
    assertState(
      /Cross-browser \[b\]bold\[\/b\]\./.test(editorTypedState.value),
      "Firefox real bold input did not serialize synchronously",
      editorTypedState,
    );
    await waitForScript(
      driver,
      "return /Draft saved on this device/.test(document.querySelector('.bpb-re-status')?.textContent || '');",
      "the Firefox local report draft",
    );
    await driver.navigate().refresh();
    await driver.wait(until.elementLocated(By.css(".bpb-re-draft")), 10_000);

    await driver.get(new URL("popup/popup.html", baseUrl).href);
    const popupState = await waitForScript(driver, `
      const text = document.getElementById("state")?.textContent || "";
      return /Open an activity to begin/.test(text) ? text : false;
    `, "the Firefox popup worker status");
    assertState(
      /Garmin Connect or Strava/.test(popupState),
      "Firefox popup did not query its real active tab and render the worker response",
      popupState,
    );

    const capabilities = await driver.getCapabilities();
    console.log("Firefox extension startup verification passed:");
    console.log(`  - ${capabilities.getBrowserName()} ${capabilities.getBrowserVersion()}`);
    console.log(`  - hidden/headless at ${verificationViewport.width}x${verificationViewport.height}`);
    console.log("  - real sync/local/session storage and storage.onChanged round-tripped");
    console.log("  - options, popup, ascent, editor, Peak, BigMap, and PeakAscents surfaces initialized");
    console.log("  - AMO report credit, real editor input/draft recovery, filter/sort, and 3D frame passed");
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
