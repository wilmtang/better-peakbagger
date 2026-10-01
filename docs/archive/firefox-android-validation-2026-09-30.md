# Firefox Android 3.8 validation — 2026-09-30

## Environment and method

- Android 15 ARM64 AOSP emulator, Android Emulator 37.1.11, 1080×1920 at
  420 dpi; hidden window. Host rendering identified Apple M3 Pro through
  Android Emulator OpenGL ES Translator and Metal. No 3D terrain check was run.
- Official Mozilla Firefox for Android 157.0 APK, package `org.mozilla.firefox`.
- Installed the exact minified Firefox release archive through geckodriver and
  Selenium's Android support as a temporary add-on. The archive has 86 entries,
  including the inert draft staging page.
- Latest retest: 2026-10-01 UTC, after the worker readiness event correction.
- Archive SHA-256: `dff8a56fa1b7e36b945639e829913697adecfeefe96a4cab3c232b34c9c22317`.
- The retest uses Mozilla's documented `automationtest` Android intent extra
  to bypass the onboarding flow in the disposable WebDriver session. See the
  [geckodriver startup workaround](https://github.com/mozilla-firefox/firefox/blob/main/testing/geckodriver/CHANGES.md#0371-2026-07-20-300705c65d1b).
- Reused the repository's HTTPS `www.peakbagger.com` fixture server through
  an emulator-only ADB reverse connection and isolated Firefox DNS settings.
  The temporary browser session accepted only the test context's TLS errors.
  No live provider or Peakbagger Save was exercised.

## Fixed and verified

- The candidate installed as `better-peakbagger@wilmtang.github.io` without an
  unsupported-manifest error. The actual browser identified itself as Firefox
  157 on Android 15.
- Settings rendered its controls at a 414×599 CSS-pixel viewport. The heading,
  horizontally scrolling section navigation, Theme selector, and 3D setting
  were visually inspected in the captured page screenshot.
- The background worker answered `CAPTURE_STATUS` from the extension page.
- The ascent analyzer initialized its chart and interactive statistics using
  the masked GPX fixture. The rendered chart and controls were inspected.
- The final archive was retested after the draft staging and worker readiness
  event corrections. The readiness poll waited for populated Interactive Stats
  and the removal of the analyzing message before recording the chart.

## Intentionally not changed

- The captured Peakbagger ascent fixture retains its desktop-width layout:
  Firefox uses a 980×1418 CSS-pixel layout viewport, scaled into the phone view.
  Analyzer startup works, but this is not a responsive redesign of Peakbagger.
- Save remains a manual user action; this check made no save requests.

## Changed but not fully proven

- An emulator establishes Android browser execution, not physical-device
  touch ergonomics, native permission presentation, or battery behavior.
- This check does not establish live Garmin/Strava ownership or export behavior,
  the native desktop Firefox toolbar grant, or store acceptance.

Evidence retained locally under `tmp/release-3.8.0/`: `android-event-check.log`,
`android-settings.png`, `android-analyzer.png`, and `android-emulator-event.log`.
The temporary verifier uses `createBrowserFixtureServer`, Firefox mobile
WebDriver options, `installAddon`, a worker request, and a chart readiness poll.
