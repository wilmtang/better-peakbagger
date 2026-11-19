# WXT and Vite build evaluation

Evaluated November 18, 2026 against `fd12835a` on macOS arm64, with Node
24.22.3, WXT 0.21.5 and Vite 8.3.8. Keep esbuild as the production publisher.
The original candidate reduced the archive sizes by about 1.9%. After the
optimization, its median release build still took 2.7–3.0 times as long as
esbuild in two matched comparisons. Adopting it would still
require our ordered entry inventory, vendor patches, manifest and packaging
logic, transactional watcher, and browser launchers.

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

| Original release archives | esbuild | WXT and Vite |
| --- | ---: | ---: |
| Chrome archive | 3,703,699 bytes | 3,633,196 bytes |
| Firefox archive | 3,703,641 bytes | 3,633,316 bytes |

### Build performance follow-up

WXT 0.21.5 built each of the candidate's 67 unlisted entry wrappers in a
separate Vite build. The serial group loop dominated the candidate profile.
The adapter now uses up to six concurrent jobs for the separate outputs, with
WXT consuming their results in its usual order. A failed build stops the queue
and waits for active jobs before the disposable tree can be cleaned up. [WXT build internals](https://wxt.dev/guide/resources/how-wxt-works#building)

Bundle verification reads the emitted files. The follow-up reads the module
summary from Vite's Rolldown parser, keeping the V8 classic-script and UTF-8
checks. This avoids loading TypeScript and materializing or traversing a
JavaScript AST to check early-script and frame imports.

Both comparisons interleaved five runs per variant on macOS arm64 with Node
24.22.3. Each wall measurement spans subprocess launch through exit, including
Node and toolchain startup, asset copying and notices. Archive compression
and browser startup were outside the timed commands. The original 3.7× figure
divided WXT's in-process build time by esbuild's full CLI wall time.

| Release build | First CLI median | Replicate CLI median | Replicate CLI samples (ms) |
| --- | ---: | ---: | --- |
| Production esbuild (`node scripts/build.mts --minify`) | 463 ms | 499 ms | 454, 457, 499, 514, 527 |
| Serial WXT | 2,242 ms | 2,264 ms | 2,264, 2,121, 2,194, 2,345, 2,518 |
| Six WXT jobs with TypeScript format checks | 1,550 ms | 1,566 ms | 1,699, 1,457, 1,526, 1,566, 1,951 |
| Six WXT jobs with Rolldown format checks | 1,383 ms | 1,345 ms | 1,586, 1,273, 1,272, 1,345, 1,642 |

The first comparison used `BPB_WXT_JOBS=1` at `eaa22553` for the serial row.
The replicate ran the original serial adapter at `df8ba40c`. Both used
`eaa22553` for six jobs with TypeScript checks and `01f54b06` for six jobs
with Rolldown checks. The optimized candidate took 38–41% less wall time
than the serial candidate. Both concurrent adapters matched the original
serial candidate's file paths and SHA-256 digests across all 145 release
files and 212 development files. The queue and rollback checks also passed.

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
with source maps. Set `BPB_WXT_JOBS=1` for WXT's serial build loop. Values
from two through six set the concurrent job count explicitly. Remove the
printed workspace and the disposable toolchain and archive directories
after verification.
