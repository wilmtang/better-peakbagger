// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the derived Firefox extension in a disposable headless profile. This
// deliberately starts as a narrow vertical slice: prove Firefox interprets its
// manifest, starts background.js, and runs both execution worlds before the
// broader browser fixtures are shared with the Chrome verifier.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, Key, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

import {
  createBrowserFixtureServer,
  createSyntheticCaptureJob,
  fixtureHost,
  storeUrls,
  surfaceSelectors,
  verificationViewport,
  waitForCondition,
} from "./browser-verification-fixtures.mjs";
import { prepareFirefoxSource } from "./run-firefox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function waitForScript(
  driver,
  script,
  description,
  timeout = 15_000,
  isReady = Boolean,
) {
  try {
    return await driver.wait(async () => {
      const value = await driver.executeScript(script);
      return isReady(value) ? value : false;
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

async function evaluatePageRealm(driver, expression) {
  const bidi = await driver.getBidi();
  const context = await driver.getWindowHandle();
  const response = await bidi.send({
    method: "script.evaluate",
    params: {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    },
  });
  if (response.type === "error") {
    throw new Error(`${response.error}: ${response.message}`);
  }
  if (response.result?.type === "exception") {
    throw new Error(response.result.exceptionDetails?.text || "page-realm script failed");
  }
  return response.result;
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
    const suppliedSource = process.env.BPB_VERIFY_EXTENSION_SOURCE
      ? path.resolve(process.env.BPB_VERIFY_EXTENSION_SOURCE)
      : null;
    if (!suppliedSource) prepared = await prepareFirefoxSource({ temporaryRoot });
    const extensionSource = suppliedSource || prepared.sourceDir;
    fixture = await createBrowserFixtureServer({ temporaryRoot });
    const buddyListFixture = await readFile(
      path.join(root, "test", "fixtures", "pages", "report-buddy-list.html"),
      "utf8",
    );

    const options = new firefox.Options()
      .addArguments("-headless")
      .enableBidi()
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

    const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
    driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .setFirefoxService(service)
      .build();
    await driver.manage().setTimeouts({ pageLoad: 20_000, script: 15_000 });

    addonId = await driver.installAddon(extensionSource, true);
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
          optionsOpenInTab: api.runtime.getManifest().options_ui?.open_in_tab,
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
        === `Version ${extensionState.version}` && extensionState.optionsOpenInTab === false,
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
      const entries = Array.from({ length: 1500 }, (_, index) => ({
        cid: 100000 + index,
        name: index === 1498
          ? "Navigation Alpine Climber 1499"
          : `Navigation Scale Climber ${String(index + 1).padStart(4, "0")}`,
        addedAt: index,
        source: index % 2 ? "buddy" : "manual",
      }));
      api.storage.sync.get("bpbSettings").then(({ bpbSettings = {} }) => Promise.all([
        api.storage.sync.set({
          bpbSettings: {
            ...bpbSettings,
            theme: "dark",
            enable3dMap: true,
            addReportCredit: true,
            enableGithubBackup: true,
            favoritesSource: "custom",
          },
        }),
        api.storage.local.set({
          bpbGithubAuth: {
            token: "browser-verification-only",
            repo: { owner: "fixture", name: "backup", branch: "main", fullName: "fixture/backup" },
          },
          bpbFavoriteClimbers: { schemaVersion: 1, entries },
        }),
      ])).then(() => done(true), error => done(String(error)));
    });
    await driver.navigate().refresh();
    await waitForScript(
      driver,
      "return document.getElementById('theme')?.value === 'dark' && document.documentElement.dataset.bpbTheme === 'dark';",
      "the persisted Firefox option",
    );
    await waitForScript(
      driver,
      "return document.querySelectorAll('.favorite-item').length === 1500;",
      "the full Firefox favorite-climber scale list",
    );
    const fullFavoriteCount = await driver.findElement(By.id("favorites-count")).getText();
    await driver.findElement(By.id("favorites-search")).sendKeys("alpin clmber 1499");
    const fuzzyFavoriteSearch = await waitForScript(driver, `
      const rows = [...document.querySelectorAll(".favorite-item")];
      const count = document.getElementById("favorites-count")?.textContent || "";
      return rows.length === 1 && count === "1 of 1,500 favorites" ? {
        name: rows[0].querySelector(".favorite-name")?.textContent || "",
        count,
      } : false;
    `, "the Firefox favorite-climber fuzzy search");
    assertState(
      fullFavoriteCount === "1,500 favorites"
        && fuzzyFavoriteSearch.name === "Navigation Alpine Climber 1499",
      "Firefox did not report or fuzzy-filter the full favorite-climber list",
      { fullFavoriteCount, fuzzyFavoriteSearch },
    );
    await driver.executeScript(`
      const search = document.getElementById("favorites-search");
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await waitForScript(
      driver,
      "return document.querySelectorAll('.favorite-item').length === 1500;",
      "the restored Firefox favorite-climber scale list",
    );

    const signedInBuddyUrl = "https://www.peakbagger.com/report/report.aspx?r=b";
    await evaluatePageRealm(driver, `(() => {
      const url = ${JSON.stringify(signedInBuddyUrl)};
      const html = ${JSON.stringify(buddyListFixture)};
      const api = globalThis.browser || globalThis.chrome;
      const dialog = document.getElementById("favorites-mirror-confirmation");
      globalThis.__bpbNativeFetch = globalThis.fetch;
      dialog.dataset.verifyBuddyRequests = "0";
      globalThis.fetch = async (input, init) => {
        if (String(input) !== url) return globalThis.__bpbNativeFetch(input, init);
        dialog.dataset.verifyBuddyRequests = String(
          Number(dialog.dataset.verifyBuddyRequests) + 1,
        );
        return { status: 200, headers: {}, text: async () => html };
      };
      globalThis.__bpbNativeRuntimeSendMessage = api.runtime.sendMessage.bind(api.runtime);
      globalThis.__bpbHeldReplacement = null;
      dialog.dataset.verifyHeld = "false";
      dialog.dataset.verifyDismissals = "0";
      let wasHidden = dialog.hidden;
      globalThis.__bpbReplacementObserver = new MutationObserver(() => {
        if (dialog.hidden && !wasHidden) {
          dialog.dataset.verifyDismissals = String(
            Number(dialog.dataset.verifyDismissals) + 1,
          );
        }
        wasHidden = dialog.hidden;
      });
      globalThis.__bpbReplacementObserver.observe(dialog, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
      api.runtime.sendMessage = message => {
        if (message?.type !== "FAVORITES_MUTATE" || message.mutation?.kind !== "replace") {
          return globalThis.__bpbNativeRuntimeSendMessage(message);
        }
        return new Promise(resolve => {
          dialog.dataset.verifyHeld = "true";
          globalThis.__bpbHeldReplacement = resolve;
        });
      };
    })()`);
    await driver.findElement(By.id("favorites-mirror-buddies")).click();
    const mirrorPreview = await waitForScript(driver, `
      const dialog = document.getElementById("favorites-mirror-confirmation");
      const status = document.getElementById("favorites-import-status")?.textContent || "";
      return !dialog.hidden
        ? { visible: true, requests: Number(dialog.dataset.verifyBuddyRequests) }
        : status && !/Loading your Buddy List/.test(status)
          ? { visible: false, status, requests: Number(dialog.dataset.verifyBuddyRequests) }
          : false;
    `, "the Firefox Buddy replacement preview");
    assertState(
      mirrorPreview.visible && mirrorPreview.requests === 1,
      "Firefox did not load one Buddy report into the replacement confirmation",
      mirrorPreview,
    );
    const reviewedReplacement = await driver.executeScript(
      "return document.getElementById('favorites-mirror-confirmation-detail').textContent;",
    );
    await driver.findElement(By.id("favorites-mirror-confirm")).click();
    const replacementBusy = await waitForScript(driver, `
      const dialog = document.getElementById("favorites-mirror-confirmation");
      const confirm = document.getElementById("favorites-mirror-confirm");
      const cancel = document.getElementById("favorites-mirror-cancel");
      return dialog?.getAttribute("aria-busy") === "true"
        && document.activeElement === dialog
        && confirm?.disabled
        && cancel?.disabled
        && dialog.dataset.verifyHeld === "true"
        ? {
            focused: document.activeElement.id,
            busy: dialog.getAttribute("aria-busy"),
            confirmDisabled: confirm.disabled,
            cancelDisabled: cancel.disabled,
          }
        : false;
    `, "the Firefox Buddy replacement busy state");
    assertState(
      replacementBusy.focused === "favorites-mirror-confirmation"
        && replacementBusy.busy === "true"
        && replacementBusy.confirmDisabled
        && replacementBusy.cancelDisabled,
      "Firefox did not keep deliberate focus inside the busy replacement dialog",
      replacementBusy,
    );
    const busyStayedOpen = await driver.executeScript(`
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.getElementById("favorites-mirror-cancel")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const dialog = document.getElementById("favorites-mirror-confirmation");
      return !dialog.hidden && dialog.getAttribute("aria-busy") === "true";
    `);
    assertState(busyStayedOpen, "Firefox dismissed an in-progress Buddy replacement");
    await evaluatePageRealm(driver, `
      globalThis.__bpbHeldReplacement({
        ok: false,
        error: { code: "unavailable", message: "browser verification failure" },
      });
      globalThis.__bpbHeldReplacement = null;
      document.getElementById("favorites-mirror-confirmation").dataset.verifyHeld = "false";
    `);
    const retryableReplacement = await waitForScript(driver, `
      const dialog = document.getElementById("favorites-mirror-confirmation");
      const confirm = document.getElementById("favorites-mirror-confirm");
      const cancel = document.getElementById("favorites-mirror-cancel");
      return dialog.dataset.verifyHeld === "false" && !dialog.hasAttribute("aria-busy")
        ? {
            hidden: dialog.hidden,
            focused: document.activeElement?.id || "",
            confirmDisabled: confirm.disabled,
            cancelDisabled: cancel.disabled,
            impactMatches:
              document.getElementById("favorites-mirror-confirmation-detail")?.textContent
                === ${JSON.stringify(reviewedReplacement)},
            dismissals: Number(dialog.dataset.verifyDismissals),
          }
        : false;
    `, "the retryable Firefox Buddy replacement");
    assertState(
      !retryableReplacement.hidden
        && retryableReplacement.focused === "favorites-mirror-confirm"
        && !retryableReplacement.confirmDisabled
        && !retryableReplacement.cancelDisabled
        && retryableReplacement.impactMatches
        && retryableReplacement.dismissals === 0,
      "Firefox did not retain the reviewed Buddy replacement after failure",
      retryableReplacement,
    );
    await evaluatePageRealm(driver, `
      const api = globalThis.browser || globalThis.chrome;
      api.runtime.sendMessage = globalThis.__bpbNativeRuntimeSendMessage;
    `);
    const buddyRequestsBeforeRetry = await driver.executeScript(
      "return Number(document.getElementById('favorites-mirror-confirmation').dataset.verifyBuddyRequests);",
    );
    await driver.findElement(By.id("favorites-mirror-confirm")).click();
    const mirrorApplied = await waitForScript(driver, `
      const api = globalThis.browser || globalThis.chrome;
      return api.storage.local.get("bpbFavoriteClimbers").then(({ bpbFavoriteClimbers }) => {
        const status = document.getElementById("favorites-import-status")?.textContent || "";
        return bpbFavoriteClimbers?.entries?.length === 6
          && document.getElementById("favorites-mirror-confirmation")?.hidden
          && /Mirror complete: 6 added, 1500 removed/.test(status)
          ? {
              dismissals: Number(
                document.getElementById("favorites-mirror-confirmation").dataset.verifyDismissals
              ),
              buddyRequests: Number(
                document.getElementById("favorites-mirror-confirmation").dataset.verifyBuddyRequests
              ),
            }
          : false;
      });
    `, "the retried Firefox Buddy replacement");
    assertState(
      mirrorApplied.dismissals === 1
        && mirrorApplied.buddyRequests === buddyRequestsBeforeRetry,
      "Firefox reloaded or repeatedly dismissed the retried Buddy replacement",
      { buddyRequestsBeforeRetry, mirrorApplied },
    );
    await evaluatePageRealm(driver, `
      globalThis.__bpbReplacementObserver.disconnect();
      globalThis.fetch = globalThis.__bpbNativeFetch;
    `);
    await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      const entries = Array.from({ length: 1500 }, (_, index) => ({
        cid: 100000 + index,
        name: index === 1498
          ? "Navigation Alpine Climber 1499"
          : `Navigation Scale Climber ${String(index + 1).padStart(4, "0")}`,
        addedAt: index,
        source: index % 2 ? "buddy" : "manual",
      }));
      api.storage.local.set({
        bpbFavoriteClimbers: { schemaVersion: 1, entries },
      }).then(() => done(true), error => done(String(error)));
    });
    await waitForScript(
      driver,
      "return document.querySelectorAll('.favorite-item').length === 1500;",
      "the restored post-replacement Firefox favorite list",
    );

    const longDistanceBefore = await driver.executeScript(`
      const content = document.querySelector(".content");
      const target = document.getElementById("drafts");
      const previousBehavior = content.style.scrollBehavior;
      content.style.scrollBehavior = "auto";
      content.scrollTop = 0;
      void content.scrollTop;
      if (previousBehavior) content.style.scrollBehavior = previousBehavior;
      else content.style.removeProperty("scroll-behavior");

      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      const distance = () => target.getBoundingClientRect().top
        - content.getBoundingClientRect().top - margin;
      return {
        distance: distance(),
        viewportHeight: content.clientHeight,
      };
    `);
    await driver.findElement(By.css('.side-nav a[href="#drafts"]')).click();
    const longDistanceAfter = await waitForScript(driver, `
      const content = document.querySelector(".content");
      const target = document.getElementById("drafts");
      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      const state = {
        distance: target.getBoundingClientRect().top
          - content.getBoundingClientRect().top - margin,
        scrollTop: content.scrollTop,
        hash: location.hash,
      };
      return {
        ...state,
        ready: Math.abs(state.distance) <= 2
          && state.scrollTop > 0
          && state.hash === "#drafts",
      };
    `, "the instant Firefox long-distance settings navigation", 15_000,
    state => state?.ready);
    const longDistanceNavigation = {
      before: longDistanceBefore.distance,
      after: longDistanceAfter.distance,
      viewportHeight: longDistanceBefore.viewportHeight,
      scrollTop: longDistanceAfter.scrollTop,
      hash: longDistanceAfter.hash,
    };
    assertState(
      longDistanceNavigation.before > Math.min(longDistanceNavigation.viewportHeight * 2, 1200)
        && Math.abs(longDistanceNavigation.after) <= 2
        && longDistanceNavigation.scrollTop > 0
        && longDistanceNavigation.hash === "#drafts",
      "the 1,500-row Firefox options list did not make long-distance sidebar navigation instant",
      longDistanceNavigation,
    );

    await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      api.storage.sync.get("bpbSettings").then(({ bpbSettings = {} }) => Promise.all([
        api.storage.sync.set({
          bpbSettings: {
            ...bpbSettings,
            favoritesSource: "custom",
            removeFavoriteWhenBuddyRemoved: false,
          },
        }),
        api.storage.local.set({
          bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
        }),
      ])).then(() => done(true), error => done(String(error)));
    });
    const buddyMutationBaseline = { ...fixture.requests };
    const otherClimberUrl = `https://${fixtureHost}:${fixture.port}/climber/climber.aspx?cid=900002`;
    await driver.get(otherClimberUrl);
    await driver.wait(until.elementLocated(By.id("BuddyButton")), 10_000);
    await driver.wait(until.elementLocated(By.id("bpb-climber-favorite")), 10_000);
    await driver.findElement(By.id("BuddyButton")).click();
    const buddyAdded = await waitForScript(driver, `
      const nativeButton = document.getElementById("BuddyButton");
      const favorite = document.getElementById("bpb-climber-favorite");
      return /^Remove\\b/.test(nativeButton?.value || "") && favorite?.textContent === "★" ? {
        native: nativeButton.value,
        favorite: favorite.textContent,
      } : false;
    `, "the confirmed Firefox Buddy addition");
    await driver.findElement(By.id("BuddyButton")).click();
    const removalPreserved = await waitForScript(driver, `
      const nativeButton = document.getElementById("BuddyButton");
      const favorite = document.getElementById("bpb-climber-favorite");
      return /^Add\\b/.test(nativeButton?.value || "") && favorite?.textContent === "★";
    `, "the default Firefox Buddy removal policy");
    assertState(
      buddyAdded.favorite === "★" && removalPreserved,
      "Firefox did not add a confirmed Buddy or preserve the favorite on default removal",
      { buddyAdded, removalPreserved },
    );

    await driver.get(optionsUrl);
    const removeWithBuddy = await driver.findElement(By.id("favorites-remove-with-buddy"));
    assertState(!(await removeWithBuddy.isSelected()),
      "Firefox rendered destructive Buddy removal sync on by default");
    await removeWithBuddy.click();
    const removalPreferenceSaved = await driver.wait(() => driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      api.storage.sync.get("bpbSettings")
        .then(({ bpbSettings }) => done(bpbSettings?.removeFavoriteWhenBuddyRemoved === true));
    }), 5_000);
    assertState(removalPreferenceSaved, "Firefox did not persist the Buddy removal preference");
    await driver.get(otherClimberUrl);
    await driver.wait(until.elementLocated(By.id("BuddyButton")), 10_000);
    await driver.findElement(By.id("BuddyButton")).click();
    await waitForScript(driver, `
      return /^Remove\\b/.test(document.getElementById("BuddyButton")?.value || "")
        && document.getElementById("bpb-climber-favorite")?.textContent === "★";
    `, "the second confirmed Firefox Buddy addition");
    await driver.findElement(By.id("BuddyButton")).click();
    const removalSynced = await waitForScript(driver, `
      return /^Add\\b/.test(document.getElementById("BuddyButton")?.value || "")
        && document.getElementById("bpb-climber-favorite")?.textContent === "☆";
    `, "the opted-in Firefox Buddy removal policy");
    assertState(
      removalSynced
        && fixture.requests.buddyMutations - buddyMutationBaseline.buddyMutations === 4
        && fixture.requests.buddyReports - buddyMutationBaseline.buddyReports === 4,
      "Firefox Buddy mutation sync did not issue one confirmed refresh per native action",
      { before: buddyMutationBaseline, after: fixture.requests, removalSynced },
    );

    await driver.get(optionsUrl);
    await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      api.storage.sync.get("bpbSettings").then(({ bpbSettings = {} }) => Promise.all([
        api.storage.sync.set({
          bpbSettings: {
            ...bpbSettings,
            favoritesSource: "buddies",
            removeFavoriteWhenBuddyRemoved: false,
          },
        }),
        api.storage.local.set({
          bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
        }),
      ])).then(() => done(true), error => done(String(error)));
    });

    await driver.get(
      `https://${fixtureHost}:${fixture.port}/climber/ascent.aspx?aid=1`,
    );
    const surfaceState = await waitForScript(driver, `
      const state = {
        origin: location.origin,
        theme: document.documentElement.getAttribute("data-bpb-theme"),
        analyzer: Boolean(document.getElementById("bpb-gpx-analysis")),
        stats: document.querySelector("#bpb-gpx-analysis div")?.textContent || "",
      };
      return {
        ...state,
        ready: state.analyzer && /Interactive Stats/.test(state.stats),
      };
    `, "the Firefox MAIN-world analyzer stats", 15_000, state => state?.ready);
    if (surfaceState.theme === null) {
      throw new Error("Firefox isolated-world theme bundle did not initialize");
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
      `https://${fixtureHost}:${fixture.port}/map/BigMap.aspx?cy=48.83115&cx=-121.60214&z=14&t=P&d=2829&c=0&hj=300&cyn=0`,
    );
    const peakBigMapState = await waitForScript(driver, `
      const button = document.querySelector(${JSON.stringify(surfaceSelectors.terrainToggle)});
      const iframe = document.getElementById("if");
      return button && !button.disabled && document.getElementById("bpb-map-viewport") ? {
        title: button.title,
        markerReady: Boolean(iframe?.contentWindow?.mapsPlaceholder),
      } : false;
    `, "the Firefox Full Screen peak map surface");
    assertState(
      peakBigMapState.title === "View this peak on 3D terrain" && peakBigMapState.markerReady,
      "Firefox Full Screen peak map did not expose the 3D toggle",
      peakBigMapState,
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

    await driver.get(
      `https://${fixtureHost}:${fixture.port}/report/report.aspx?r=b&cid=900001`,
    );
    await driver.wait(until.elementLocated(By.css("#RGridView .pbaf-table-sort")), 10_000);
    const buddyStateBefore = await driver.executeScript(`return {
      labels: [...document.querySelectorAll("#RGridView .pbaf-table-sort")]
        .map(control => control.firstChild.textContent.trim()),
      betaBar: Boolean(document.getElementById("pbaf-bar")),
      firstPeak: document.querySelector("#RGridView tr:nth-child(2) td:nth-child(4)")?.textContent.trim(),
    };`);
    const buddyControls = await driver.findElements(By.css("#RGridView .pbaf-table-sort"));
    await buddyControls[3].click();
    const buddyStateAfter = await driver.executeScript(`return {
      firstPeak: document.querySelector("#RGridView tr:nth-child(2) td:nth-child(4)")?.textContent.trim(),
      sort: document.querySelector("#RGridView th:nth-child(4)")?.getAttribute("aria-sort"),
    };`);
    assertState(
      buddyStateBefore.labels.length === 6
        && buddyStateBefore.betaBar === false
        && buddyStateAfter.sort === "ascending"
        && buddyStateAfter.firstPeak !== buddyStateBefore.firstPeak,
      "Firefox Buddy List did not expose six sorter-only controls",
      { before: buddyStateBefore, after: buddyStateAfter },
    );

    await driver.get(
      `https://${fixtureHost}:${fixture.port}/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999`,
    );
    await driver.wait(until.elementLocated(By.css(surfaceSelectors.profileBackup)), 10_000);
    const profileBackupState = await driver.executeScript(`
      const panel = document.querySelector(${JSON.stringify(surfaceSelectors.profileBackup)});
      return {
        copy: panel?.textContent || "",
        primary: panel?.querySelector(".bpb-profile-primary")?.textContent || "",
      };
    `);
    assertState(
      profileBackupState.primary === "Back up all ascents"
        && /fixture\/backup/.test(profileBackupState.copy),
      "Firefox full-profile backup surface did not mount for its verified owner",
      profileBackupState,
    );

    const editorUrl = `https://${fixtureHost}:${fixture.port}/climber/ascentedit.aspx?cid=900001`;
    await driver.get(editorUrl);
    await driver.wait(until.elementLocated(By.css(surfaceSelectors.editor)), 10_000);
    const editorHandle = await driver.getWindowHandle();
    const handlesBeforeDraftManager = new Set(await driver.getAllWindowHandles());
    const draftsManagerButton = await driver.findElement(By.css(".bpb-re-manage"));
    await driver.executeScript(
      "arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' });",
      draftsManagerButton,
    );
    await draftsManagerButton.click();
    const draftsManagerHandle = await driver.wait(async () => {
      const handles = await driver.getAllWindowHandles();
      return handles.find(handle => !handlesBeforeDraftManager.has(handle)) || false;
    }, 5_000);
    await driver.switchTo().window(draftsManagerHandle);
    const draftsManagerUrl = await driver.getCurrentUrl();
    assertState(
      draftsManagerUrl === `${baseUrl}options/options.html#drafts`,
      "Firefox report editor did not open its drafts manager",
      draftsManagerUrl,
    );
    await driver.close();
    await driver.switchTo().window(editorHandle);
    await driver.navigate().refresh();
    await driver.wait(until.elementLocated(By.css(surfaceSelectors.editor)), 10_000);

    await driver.findElement(By.id("GPXUpload")).sendKeys(fixture.gpxPath);
    const uploadState = await waitForScript(driver, `
      const process = document.querySelector(".bpb-process-button");
      const date = document.getElementById("DateText")?.value || "";
      const now = new Date();
      const pad = value => String(value).padStart(2, "0");
      const today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
      return process ? {
        date,
        today,
        label: process.textContent,
        ariaLabel: process.getAttribute("aria-label"),
        nativePreviewHidden: document.getElementById("GPXPreview")
          ?.classList.contains("bpb-native-preview-hidden") || false,
      } : false;
    `, "the Firefox GPX Process affordance");
    assertState(
      uploadState.date === uploadState.today
        && /Process/.test(uploadState.label || "")
        && uploadState.ariaLabel === "Process the chosen GPX and fill this form"
        && uploadState.nativePreviewHidden,
      "Firefox did not autofill the ascent date and swap trusted GPX selection to Process",
      uploadState,
    );
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

    const controlHandle = await driver.getWindowHandle();
    const sourceTabId = await driver.executeAsyncScript(done => {
      const api = globalThis.browser || globalThis.chrome;
      api.tabs.query({ active: true, currentWindow: true })
        .then(([tab]) => done(tab?.id ?? null), error => done({ error: String(error) }));
    });
    assertState(Number.isInteger(sourceTabId), "Firefox draft source tab identity was unavailable", sourceTabId);
    const seededJob = createSyntheticCaptureJob(sourceTabId);
    const opened = await driver.executeAsyncScript((job, done) => {
      const api = globalThis.browser || globalThis.chrome;
      api.storage.session.set({
        bpbCaptureJobs: { [job.sourceTabId]: job },
        bpbDraftTabs: {},
      }).then(() => api.runtime.sendMessage({
        type: "CAPTURE_OPEN_DRAFTS",
        tabId: job.sourceTabId,
        selectedIds: [2829],
      })).then(async reply => {
        const tab = reply?.tabIds?.length ? await api.tabs.get(reply.tabIds[0]) : null;
        done({ reply, tab });
      }).catch(error => done({ error: String(error) }));
    }, seededJob);
    const draftTabId = opened.reply?.tabIds?.[0];
    assertState(
      Number.isInteger(draftTabId),
      "Firefox worker did not create a draft tab",
      opened,
    );
    assertState(
      opened.reply?.groupWarning || Number(opened.tab?.groupId) >= 0,
      "Firefox draft tab was neither grouped nor reported honestly",
      opened,
    );

    const draftHandle = await driver.wait(async () => {
      const handles = await driver.getAllWindowHandles();
      return handles.find(handle => handle !== controlHandle) || false;
    }, 10_000);
    await driver.switchTo().window(draftHandle);
    const workerDraftUrl = await driver.wait(async () => {
      const current = await driver.getCurrentUrl();
      return /peakbagger\.com\/climber\/ascentedit\.aspx\?pid=2829&cid=900001/i.test(current)
        ? current
        : false;
    }, 10_000);
    assertState(
      /peakbagger\.com\/climber\/ascentedit\.aspx\?pid=2829&cid=900001/i.test(workerDraftUrl),
      "Firefox worker did not navigate the draft tab to its bound peak and climber",
      workerDraftUrl,
    );
    await driver.switchTo().window(controlHandle);

    const wrongDraftUrl = `https://${fixtureHost}:${fixture.port}/climber/ascentedit.aspx?pid=999&cid=900001`;
    await driver.executeAsyncScript((tabId, url, done) => {
      const api = globalThis.browser || globalThis.chrome;
      api.tabs.update(tabId, { url }).then(() => done(true), error => done({ error: String(error) }));
    }, draftTabId, wrongDraftUrl);
    await driver.switchTo().window(draftHandle);
    await driver.wait(async () => (await driver.getCurrentUrl()) === wrongDraftUrl, 10_000);
    const mismatch = await driver.wait(until.elementLocated(By.id("bpb-draft-banner")), 10_000).then(
      element => element.getText(),
    );
    assertState(
      /does not match its prepared ascent draft/.test(mismatch)
        && fixture.requests.previewPosts === 0,
      "Firefox worker accepted the wrong peak identity",
      { mismatch, requests: fixture.requests },
    );

    const correctDraftUrl = `https://${fixtureHost}:${fixture.port}/climber/ascentedit.aspx?pid=2829&cid=900001`;
    await driver.get(correctDraftUrl);
    try {
      await waitForCondition(() => fixture.requests.previewPosts === 1, {
        description: "the Firefox draft GPS Preview POST",
        timeoutMs: 15_000,
      });
    } catch (error) {
      const pageState = await driver.executeScript(`return {
        url: location.href,
        banner: document.getElementById("bpb-draft-banner")?.textContent || null,
        date: document.getElementById("DateText")?.value || null,
        files: document.getElementById("GPXUpload")?.files?.length ?? null,
      };`).catch(readError => ({ error: String(readError) }));
      throw new Error(`Firefox draft Preview did not submit: ${JSON.stringify({
        requests: fixture.requests,
        pageState,
      })}`, { cause: error });
    }
    await waitForScript(
      driver,
      "return /Preview is ready/.test(document.getElementById('bpb-draft-banner')?.textContent || '');",
      "the completed Firefox draft banner",
    );
    assertState(
      fixture.requests.previewPosts === 1
        && fixture.requests.savePosts === 0
        && fixture.requests.lastPreview?.attachedGpx
        && fixture.requests.lastPreview?.dateFilled
        && fixture.requests.lastPreview?.suffixBlank,
      "Firefox draft handoff did not attach/fill/Preview exactly once",
      fixture.requests,
    );

    await driver.switchTo().window(controlHandle);
    const privateState = await driver.executeAsyncScript((sourceId, draftId, done) => {
      const api = globalThis.browser || globalThis.chrome;
      api.storage.session.get(["bpbCaptureJobs", "bpbDraftTabs"]).then(values => done({
        job: values.bpbCaptureJobs?.[sourceId] || null,
        draft: values.bpbDraftTabs?.[draftId] || null,
      }), error => done({ error: String(error) }));
    }, sourceTabId, draftTabId);
    assertState(
      privateState.job?.phase === "previewed"
        && privateState.job?.uploadGpx === null
        && privateState.draft?.complete === true
        && privateState.draft?.previewStarted === true,
      "Firefox worker did not complete the exactly-once handoff",
      privateState,
    );
    await driver.switchTo().window(draftHandle);
    await driver.close();
    await driver.switchTo().window(controlHandle);

    const capabilities = await driver.getCapabilities();
    console.log("Firefox extension startup verification passed:");
    console.log(`  - ${capabilities.getBrowserName()} ${capabilities.getBrowserVersion()}`);
    console.log(`  - hidden/headless at ${verificationViewport.width}x${verificationViewport.height}`);
    console.log("  - real sync/local/session storage and storage.onChanged round-tripped");
    console.log("  - the real 1,500-row favorite list reported its total, fuzzy-searched, and kept long navigation instant");
    console.log("  - a held Buddy replacement stayed busy and focused, then failed retryably without another fetch");
    console.log("  - four native Buddy actions refreshed/synced custom favorites under both removal policies");
    console.log("  - options, popup, ascent, editor, Peak, BigMap, PeakAscents, Buddy List, and profile-backup surfaces initialized");
    console.log("  - a fresh ascent form autofilled its local date and trusted GPX selection swapped Preview for Process");
    console.log("  - the report editor opened the real report-drafts manager tab");
    console.log("  - AMO report credit, real editor input/draft recovery, filter/sort, and 3D frame passed");
    console.log("  - a real draft tab rejected wrong identity, attached GPX, filled fields, Previewed once, and never Saved");
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
