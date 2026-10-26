# Instagram embeds and trip-report script protection

Date: October 25, 2026. Source baseline: `bb675408`.

Status: implementation in progress. Default response protection and safe report
rebuilding are implemented; the post-link authoring model and isolated Instagram
player are next. The findings below describe the original `bb675408` baseline.

## Implementation progress

- Reader protection uses static Chrome CSP rules and a synchronous Firefox
  response-header listener, with one shared policy and a narrowly identified
  Cloudflare challenge exception. Native MasterMap frames remain available;
  native Quick Search has a fixed packaged implementation.
- The hostile-report verifier fails on observed script execution when protection
  is removed from a disposable copy. It passes in hidden Chrome 156 and Firefox
  158 with zero attack/provider requests, safe prose, native map execution,
  route variants and the challenge exception. Five focused security/inventory
  checks and 72 origin/Cloudflare/package/development checks passed. The full
  Chrome extension check also passed; broader Firefox/full-suite gates continue.
- Baseline limitations remain explicit: this does not protect non-BPB readers,
  undo previously executed code, or constrain a pre-existing hostile site service
  worker that synthesizes documents outside the browser's network stack.


## Findings and recommendation

1. **P1 — BPB currently does not prevent scripts in a native saved report from
   running.** Its authoring sanitizer protects the Rich/Markdown representations
   it generates; it is not a security boundary around Peakbagger's rendered
   reports. A local HTTPS fixture with the real extension reproduced inline
   script, event-handler and same-origin `srcdoc` execution, including reading a
   synthetic non-HttpOnly cookie. No live account cookies were inspected.
2. **Pasting a post URL is the right authoring flow.** Users should not need to
   copy Instagram HTML. Current Meta-owned source supports URL-driven tokenless
   oEmbed. Treat its returned HTML as untrusted input, not executable content.
3. **Use a placeholder by default, with “Load Instagram post” and an ordinary
   “Open on Instagram” link.** Add one preference, **Load Instagram posts
   automatically**, default off. Clicking loads that post for the current visit;
   it must not enable arbitrary report code or change the global preference.
4. **Establish reader protection before shipping richer embeds.** Replacing or
   hiding report DOM after rendering cannot undo code that already ran. Test a
   browser-enforced response policy and a sanitized rendering boundary first.
   Keep native-map and form compatibility as explicit release gates.

## What the current code actually protects

| Boundary | Current behavior | Consequence |
| --- | --- | --- |
| Rich/Markdown authoring | [report-markup.js](../../src/reports/report-markup.js), especially `safeOpening`, `markedInlines`, and the AST serializers, rebuild allowlisted markup; unknown HTML becomes inert text | Existing authoring protections should remain the foundation |
| Embedded media | `sanitizeYouTubeEmbedSrc` permits only a canonical YouTube player; [report-rich-editor.js](../../src/reports/report-rich-editor.js) has a matching media node | Instagram is currently unsupported; widening the general iframe allowlist would be the wrong change |
| Plain authoring | [report-editor.js](../../src/reports/report-editor.js) preserves the native textarea and conversion guard; [the guide](../trip-report-editor.md#deliberate-restrictions) documents verbatim unsupported markup | Opening an editor does not sanitize or rewrite the server value; Plain can still submit unsupported active markup |
| Reading a saved report | [ascent-report-visibility.js](../../src/ascent/ascent-report-visibility.js) hides ignored reports and suspends their players | Visibility and media suspension do not constitute a script firewall |
| Report identification | [report-adapters.js](../../src/favorites/report-adapters.js), `ascentReport`, validates the native author/report boundary | Useful for presentation, but intentionally returns no match for some unexpected forms/controls; security cannot silently allow an unrecognized report |
| Browser enforcement | [manifest.json](../../manifest.json) has no declarative network permission or installed report CSP rules | The extension currently adds no response-level script barrier to saved reports |

The isolated content-script world protects extension variables from page scripts;
it does not stop the page's own JavaScript. Chrome documents this distinction in
[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

The cookie concern needs one distinction: JavaScript can read accessible cookies;
`HttpOnly` prevents direct reading of that cookie. Such cookies still accompany
eligible script-initiated requests, so preventing cookie reads alone does not
prevent authenticated actions by injected code. See
[MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#httponly).
The extension's lack of cookie-reading permission is not a defense against
Peakbagger-origin page code. Actual live Peakbagger cookie flags were not audited.

## Reproduced security behavior

Run after building `dist/`:

```sh
npm run build
node docs/plans/experiments/instagram-report/security-probe.mjs
```

On macOS under Codex, use the approved path outside the Seatbelt sandbox, as
required by the repository's Chrome launch guard. The
[probe](experiments/instagram-report/security-probe.mjs) loads the real extension
in hidden Chrome for Testing, routes an HTTPS Peakbagger hostname to a local
masked fixture, installs only synthetic cookies, and blocks other network
traffic. Payloads record local booleans; they do not exfiltrate anything.

Observed in Chrome 156.0.8078.4 at 1000×760:

| Fixture condition | Inline script | Image error handler | Same-origin `srcdoc` script |
| --- | --- | --- | --- |
| Current BPB, no added policy | Ran; synthetic accessible cookie read, HttpOnly cookie unreadable | Ran | Ran and accessed parent DOM |
| Early script-removal observer | This inline script was removed and did not run | Ran | Ran |
| Response CSP: `script-src 'none'; object-src 'none'; base-uri 'none'` | Blocked | Blocked | Blocked |

The observer result matters: this experiment **did** prevent its particular
parser-created script. It does not support a blanket claim that observers always
run too late, or that stripping `<script>` is sufficient. The other execution
paths remained active. A complete security design needs a defined enforcement
boundary and an adversarial corpus, not a successful removal of one tag.

This is a controlled client-side finding. It is not a new proof that the current
live server accepts a particular attack payload, and the CSP experiment is a
server-response fixture policy, not an implemented DNR rule. It also does not
prove compatibility with native maps, live forms, Firefox, or every script vector.

## Instagram: URL versus copied embed code

Meta's current [official plugin README](https://github.com/facebook/meta-embeds-for-wordpress/blob/main/README.md)
documents URL insertion and tokenless oEmbed. Its
[provider registration](https://github.com/facebook/meta-embeds-for-wordpress/blob/main/includes/class-meta-embeds.php)
uses `https://graph.facebook.com/v25.0/instagram_oembed` for Instagram and
`https://www.instagram.com/embed.js` for rendering. This is current primary-source
evidence; older instructions requiring users to create an app/token must not be
assumed current. It does not establish browser CORS behavior or BPB compatibility.

| Input approach | Assessment |
| --- | --- |
| Paste an HTTPS `/p/<shortcode>/` or `/reel/<shortcode>/` permalink on its own line | Recommended primary flow; BPB derives the embed identity |
| Paste Instagram's full embed HTML | Optional convenience importer: extract one validated permalink as text/data, discard scripts and all supplied markup |
| Execute the copied HTML or returned oEmbed HTML in the report document | Reject; gives untrusted content a much larger execution surface |
| Save an ordinary permalink and let BPB enhance it on reading | Recommended storage format; useful without BPB and avoids publishing script tags |
| Construct `/embed/` URLs directly | Candidate experiment only; no verified public contract or successful live rendering established here |

Recommended input contract:

- Accept HTTPS on exact Instagram hosts deliberately supported by the parser,
  initially `instagram.com` and `www.instagram.com`, without credentials or
  nondefault ports. Canonicalize to `www.instagram.com`; keep only a validated
  post/reel path and bounded shortcode, removing tracking query parameters.
- Reject deceptive suffix hosts, encoded separators, arbitrary paths, `srcdoc`,
  user-provided script URLs, redirects to other hosts, and ambiguous embed snippets
  with conflicting post identities. Do not follow Instagram share/redirect URLs
  automatically; retain an ordinary link when no canonical identity is available.
- Transform only a standalone pasted URL into a post block. An Instagram link
  inside prose remains a link. Offer an ordinary-link fallback and reversible
  conversion. In Markdown, a standalone permalink is sufficient; do not require
  HTML. Retain Plain's current verbatim behavior until its security policy is
  deliberately changed and communicated.
- Extend the existing AST, serializers, Rich node and conversion diagnostics
  together. Persist a canonical ordinary bracket link, so readers without BPB
  still get a useful report. Recognize only that narrow standalone-link shape
  when enhancing a saved report; do not add arbitrary iframe support.

A copied snippet can be parsed without executing or attaching it to a live DOM.
Use a bounded inert/token parser and extract just the permalink. Avoid a naive
regex-only HTML sanitizer or a detached-document parsing assumption that ignores
resource loads. Reconstruct output from the validated URL through the same path
as URL paste.

### Rendering boundary and permission design

Do not load `embed.js` into Peakbagger's top-level document. A third-party script
there runs as page code, even when its download host is Instagram. The candidate
rendering boundary is a sandboxed, unprivileged frame containing the provider's
blockquote/script, or a verified cross-origin provider player. The report must
never be able to supply the wrapper source, sandbox flags or script URLs.

Start the wrapper with scripts permitted but no same-origin privilege, top-level
navigation, forms or popups. Test whether the provider works under those limits;
if it fails, retain the permalink rather than silently loosening the boundary.
Any cross-origin alternative needs a documented URL contract and tested sandbox
configuration. In particular, do not combine same-origin `srcdoc` with both
`allow-scripts` and `allow-same-origin`; see
[MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox).

A packaged extension renderer also needs an explicit MV3/store-policy review.
Remote JavaScript must not enter the service worker, content-script bundle or a
privileged extension page. Chrome documents a constrained sandboxed-frame option
in [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security#embed-remotely-hosted-code-in-a-sandboxed-iframe).
This is a design constraint, not a claim that the proposed integration has passed
store review.

If oEmbed lookup is necessary, first test an on-demand browser request with
credentials omitted. If CORS prevents it, a worker request would need narrowly
scoped optional access to `graph.facebook.com`, requested only for the embed
feature. The current manifest grants neither that host nor Instagram. Embedding
a remote frame and making a privileged cross-origin API fetch are separate
permission questions. Do not introduce a proxy/backend, app secret or scraping
fallback without a concrete need.

Direct Meta documentation and help requests returned rate-limit/access errors;
the sample oEmbed and `/embed/` page could not be retrieved by the research tool.
No successful live post rendering, tokenless API response, sandbox compatibility,
private-post behavior or browser CORS result is claimed. Source verification is
not provider end-to-end verification.

## Blocking and loading on demand

Add **Load Instagram posts automatically** under report/media settings, default
**off**, through the shared settings schema. Apply it to Rich previews, Markdown
previews and saved-report readers. It is independent of the always-on rule that
report-supplied executable code is forbidden.

When off, show a restrained post placeholder with a real **Load Instagram post**
button and an **Open on Instagram** link. Do not fetch oEmbed metadata, thumbnails,
`embed.js`, frames, preconnects or previews before activation. Even a blurred
remote thumbnail would violate this no-contact state. Loading discloses contact
with Instagram and may involve its cookies subject to browser restrictions;
no-referrer does not mean no tracking.

Activation grants one recognized post instance for this visit. Keep the trigger
anchored through pending/error/retry, prevent duplicate loads, preserve keyboard
focus, and allow cancellation/unloading. A necessary expansion into the player
is deliberate; repeated height bouncing is a defect. Bound any accepted resize
message and validate frame source plus provider origin, not just a message type.
Unknown sizes and narrow unsupported layouts retain the link fallback. On BFCache
resume or a preference change, reconcile the same node without duplicate loads;
turning automatic loading off unloads existing players.

For reports authored elsewhere that already contain Instagram scripts/iframes,
DOM replacement alone cannot promise zero prior network contact. Network blocking
must apply before navigation. A default deny rule for known Instagram subresources
on Peakbagger, with a narrow session-scoped exception bound to the clicked child
frame, is a candidate. Do not unlock the whole tab or all Instagram scripts when
one post is clicked. Frame identity/initiator attribution, redirects, retries and
rule teardown need a dedicated browser spike before promising this guarantee.

## Default protection against malicious reports

The desired default is correct: deny report-supplied active code regardless of
whether Instagram is enabled. It must cover scripts, inline handlers, executable
URLs, `srcdoc`, SVG/MathML execution paths, forms, objects, embeds, meta/base tags,
unsafe CSS/URLs and DOM-clobbering attributes. Preserve safe prose/media through
an allowlist; do not try to recognize which JavaScript looks malicious.

There are two feasible directions to prototype:

| Direction | Strength | Main cost / unproven boundary |
| --- | --- | --- |
| Install response CSP for saved-report pages, then rebuild allowlisted report DOM | Browser blocks execution before parsing; native URL can remain | CSP covers the whole document, not only the report; native map scripts and handlers need compatibility work |
| Redirect to an extension-owned safe reader before native HTML is parsed; fetch authenticated HTML as inert data and render an allowlist | Clear separation of untrusted report from site origin and privileged extension code | Larger reading/navigation change; native surrounding features need adapters or links back |

Prefer the response-policy spike first, restricted to saved-ascent/report-reading
routes and case/host variants. Chrome's
[declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
can modify response headers before document processing; it requires a new API
permission such as `declarativeNetRequestWithHostAccess` using the existing
Peakbagger host access. Add a policy without relaxing an existing site policy.
Install rules durably, before the first protected navigation; an async settings
read after navigation is too late. Investigate cached, BFCache, redirect and
service-worker-generated responses explicitly.

A strict starting policy can block all page scripts, frames and plugin content,
then selectively restore only independently trusted functionality. The test's
`script-src 'none'` is evidence of prevention, **not a shipping policy**. Native
maps and the MAIN-world GPX/map integration must be tested under the real policy.
Do not add `'unsafe-inline'` to make the site work: that re-enables report script
execution. A broad script-host allowlist also cannot distinguish trusted script
tags from report-supplied tags on that host. See
[MDN script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)
and [script-src-attr](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src-attr).

If preserving native behavior requires allowing unaudited report execution,
choose the isolated reader instead. A document-start observer may complement
those boundaries, but must not be advertised as equivalent enforcement. Firefox
also has [response-body filtering](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData)
with additional permissions; a Firefox-only rewrite is not a Chrome solution.

Server-side sanitization and separation of user content remain the strongest
site-wide fix, especially for readers without BPB. This investigation did not
contact Peakbagger's operator or submit an attack report. A browser extension
should not claim to repair the website for everyone.

## Proposed implementation order and acceptance gates

1. **Reader-protection spike.** Exercise response CSP versus isolated reader in
   Chrome and Firefox against realistic native maps/forms and malformed reports.
   Select a design only when script prevention and normal reading can coexist.
2. **Canonical post-link model.** Add the narrow parser/AST/round-trip contract and
   optional copied-snippet importer; keep saved output useful without BPB.
3. **Placeholder and isolated player.** Implement the shared preference, no-contact
   default, click grant, bounded loading and lifecycle cleanup. Ship a player only
   after real public-post/reel rendering succeeds with the intended sandbox.
4. **Adversarial and interaction gates.** Test parser-created and dynamically
   inserted scripts, external/module scripts, all handler/URL vectors, same-origin
   frames, encoded malformed markup, SVG/MathML, DOM clobbering and CSP escape
   attempts. Check ordinary reading, maps, links, native form Preview/Save and
   no automatic Save. Do not submit attack payloads to live Peakbagger.
5. **Privacy and layout gates.** Assert zero provider requests while blocked,
   including native pre-existing embeds; one click cannot enable another post.
   Exercise pending/success/error/retry, keyboard activation, rapid clicks,
   preference changes, navigation and BFCache. Compare placeholder/action,
   surrounding headings, following content and scroll at desktop/narrow sizes,
   both themes and enlarged text. Update PRIVACY and permission documentation.

## Closure ledger and evidence

### Fixed and verified

- `e70f94de`: filter settings above Climber lists; Newest ascents first directly
  below Has beta. Fifty options tests passed. Hidden Chrome 156 rendering checked
  1000×900 and 480×900, light/dark, plus 200% CSS zoom and stable checkbox geometry.
- `67776b56`: startup pruning precedes observing draft ownership; expired-current
  cleanup is awaited. The new test failed on the exact false warning before the
  fix; 61 draft tests and the real-extension single/two-editor Chrome probe passed.
  Recovery rendering inspected at 1000×760 light and 375×760 dark.
- `bb675408`: passive GitHub comparison is neutral status text. The new browser
  assertion detected the old button presentation. Twenty-six ascent-backup tests
  and eight Chrome 156/Firefox 157 cases passed at 390/1280×900, light/dark and
  normal/doubled text, including check/write/slow/error/retry/completion geometry.
- The full packaged Chrome verifier passed after the draft fix (before the small
  GitHub presentation change), including real manifest startup, settings, reports,
  bridges, BFCache and its teardown check. Targeted changed-JavaScript ESLint and
  diff checks passed for the fixes.
- `9b5c670f`: repaired the additional real-extension backup lifecycle fixture to
  seed current device-local consent and wait for the status span. It passed in
  hidden Chrome 156 at 1000×760 and 390×760, restoring the same BFCache document
  with one control and zero GitHub writes.
- The retained security probe passed with the table above. Sixty-two focused
  markup/editor-mode tests and all three documentation/link checks passed.

### Intentionally not changed

- No Instagram runtime, new settings/permissions, CSP rules or reader rewrite was
  added in this investigation. Existing YouTube behavior and Plain's documented
  verbatim boundary remain. The report proposes deliberate changes to those
  boundaries where needed; it does not treat them as already secured.
- Native Save remains manual. No live report was changed, no attack was submitted,
  and no message was sent to another person or service operator.

### Changed but not fully proven

- The investigation adds a repeatable local security experiment and this design
  report. Their results establish the client-side gap and a narrow CSP proof;
  they do not establish production security coverage.
- Instagram live rendering, API/CORS, sandbox behavior, precise optional host
  requirements, permission/store review and provider eligibility failures remain
  open. No verified current live-server exploit or cookie-flag audit is claimed.
- The broader `npm test` run executed 3,603 tests: 3,602 passed and one failed.
  `test/project/verifier-assets.test.mjs` found the unrelated, concurrently added
  `scripts/settings-fragment-verification.mjs` missing from the script inventory.
  Those settings-navigation changes were preserved; no full-suite pass is claimed.
- All browser checks were hidden. They do not prove onscreen window placement,
  native browser chrome/permission prompts or user-window focus. Static surfaces
  did not use WebGL; no GPU-renderer result is claimed.
