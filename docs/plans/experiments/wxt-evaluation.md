# WXT and Vite build evaluation

Evaluated November 18, 2026 against `fd12835a` on macOS arm64, with Node
24.22.3, WXT 0.21.5 and Vite 8.3.8. Keep esbuild as the production publisher.
The candidate reduced the archive sizes by about 1.9%, while the median
release build took 3.7 times as long. Adopting it would still require our
ordered entry inventory, vendor patches, manifest and packaging logic,
transactional watcher, and browser launchers.

## Fixed and verified

- The [candidate builder](wxt-candidate.mts) emits all 67 bundles from the
  production entry inventory. WXT evaluates inert metadata during discovery.
  The Vite build hook then receives the ordered, static source imports.
  Both module frames kept their local MapLibre imports. The other 65 bundles
  parsed as classic scripts, with no dynamic import in the synchronous head
  and early-theme bundles. Targets were Chrome 128 and Firefox 152.
- Both 145-file archives matched the existing inventory and their respective
  parsed manifests, including content-script order, execution worlds, CSP,
  permissions and update identity. Copied assets and third-party notices
  matched byte-for-byte. The shared JSZip patch applied once to the worker,
  and the shared MapLibre patch remained in the copied vendor module. Web-ext
  lint had zero errors, zero notices and the same ten owned warnings.
- The first minified candidate failed Chromium registration. The browser's
  CDP load probe identified `content/profile-editor.js` as invalid UTF-8.
  Its underlying Unicode issue also affected `content/ascent-editor.js`.
  Both contained raw U+FFFF from CodeMirror. Rolldown's ASCII output option
  preserved the escaped sentinel. The candidate now checks for malformed
  UTF-8 and Unicode noncharacters, since valid text such as the minus sign
  in a raw template can remain unescaped. [Chromium character validation](https://github.com/chromium/chromium/blob/main/base/strings/utf_string_conversion_utils.h#L32-L40)
- The corrected exact archives passed the repository's packaged verifier in
  hidden Chromium 158.0.8127.18 and Firefox 160.0.1 at a default 1000 × 760
  viewport. The verifiers also exercised their responsive fixture widths.
  Both reported a BFCache restore and clean teardown.
- The rollback probe published two candidate generations and validated both
  browser trees and reload tokens. An injected syntax error and a failed
  Chromium directory swap each preserved the prior trees byte-for-byte.

| Release measurement | esbuild | WXT and Vite |
| --- | ---: | ---: |
| Median of three one-off builds, including assets and notices | 0.50 s | 1.85 s |
| Chrome archive | 3,703,699 bytes | 3,633,196 bytes |
| Firefox archive | 3,703,641 bytes | 3,633,316 bytes |

WXT timing starts after loading the toolchain, while the esbuild wall time
includes Node startup. These are local build timings. Browser startup time
was outside the measurement.

## Intentionally not changed

- Production package, release and development commands keep their esbuild
  entry points. The experiment installs its build dependencies outside the
  repository. The repository audit passed with zero vulnerabilities.

## Changed but not fully proven

- The rollback probe tests the filesystem publication protocol. Live browser
  reload, a failure during Firefox mirroring after the Chromium swap, and
  native focus behavior remain outside its evidence.
- Fresh installations cover current desktop engines. Browser-floor, hardware
  terrain, Android, and signed store upgrade checks remain outstanding for
  the candidate. The comparison did not publish packages or run a hosted
  Actions workflow.

## Reproduce the candidate

Install the experimental tools in a disposable directory. The separate
lockfile captures the resolved dependencies for reuse with `npm ci`.

```bash
wxt_tools="$(mktemp -d)"
npm install --prefix "$wxt_tools" --ignore-scripts --save-exact wxt@0.21.5 vite@8.3.8
node docs/plans/experiments/wxt-candidate.mts "$wxt_tools" release
node docs/plans/experiments/wxt-candidate.mts "$wxt_tools" rollback
```

The `release` command prints a candidate directory and its owning workspace.
Use the candidate as `web-ext build --source-dir`, direct its archives to a
separate directory with `--artifacts-dir`, and derive the Firefox archive
with the [existing package command](../../../scripts/build-firefox-package.mts).
Then run `npm run verify -- packages CHROME.zip FIREFOX.zip` with the two
archive paths. The `development` selection emits an unminified candidate
with source maps. Remove the printed workspace and the disposable toolchain
and archive directories after verification.
