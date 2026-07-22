# Trip-report color conversion: CSSOM canonicalization or raw tokens

Status: Spike decision
Prepared: July 18, 2026
Code reviewed: `main` commit `ea0acf283c210e04d9848758713047c3b77ac6b6`
Method: Static source inspection, existing fixture/test review, and hidden
CSSOM probes in Chromium 149, Firefox 151, and jsdom. No authenticated live
Peakbagger form was changed or submitted.

## Question

The trip-report converter currently loses hex text colors after an edit in
Rich or Markdown mode. This spike compares two repairs:

1. **CSSOM canonicalization:** continue reading `element.style.color`, accept
   the browser's canonical `rgb(…)`/`rgba(…)` result, and convert it into the
   AST's canonical color representation.
2. **Raw-token preservation:** bypass CSSOM for color, extract the raw `color`
   declaration from the inline `style` attribute, and accept only a tiny
   injection-proof token grammar.

The broader policy under evaluation is:

> Bypass CSSOM for colors, keep a tiny injection-proof color grammar, and
> retain broader sanitization only where the extension itself renders or
> transforms content.

The exact-Markdown sidecar defect documented in `trip-report-editor.md` is
orthogonal. Its fix should remain a separate implementation and commit.

## Decision summary

**Choose raw-token preservation for color.** It is smaller, preserves the
author's accepted spelling, matches TipTap's own color parser, and avoids
turning browser serialization formats into a second input language.

This decision does **not** remove the converter's HTML, URL, image, or DOM
sanitizers. Plain mode already provides the coherent no-validation path:
verbatim `JournalText`, no local conversion, and no local preview. Rich and
Markdown must retain their sanitizers because the extension itself transforms
content and inserts generated preview/editor HTML before Peakbagger sees it.

## Current failure

The intended round trip is:

```text
[span style="color:#2471a3"]blue[/span]
  → detached <span style="color:#2471a3">
  → report AST color("#2471a3")
  → Rich / Markdown / preview / JournalText
```

The implemented round trip is:

```text
raw #2471a3
  → sanitizeColor accepts it
  → detached DOM parses it
  → element.style.color returns rgb(36, 113, 163)
  → sanitizeColor rejects rgb(…)
  → color node disappears; "blue" remains as uncolored text
```

The first gate lives in `safeOpening` in `src/reports/report-markup.js`. The second
gate lives in `colorFromElement`, which reads `element.style.color`. The bug
affects more than TipTap: Markdown text tokens containing bracket extensions
go through `parseBracketInline`, which builds the same detached DOM and folds
it back into the AST.

Merely visiting Rich or Markdown does not overwrite `JournalText`, because
the editor's dirty flags preserve an untouched server value. The first actual
edit serializes the whole reduced document and makes the missing color
permanent.

## Evidence

### CSSOM does change the representation

The same hidden probe was run in Chromium 149 and Firefox 151 at a 1280×720
viewport. Both browsers returned identical values; jsdom matched them:

| Raw inline value | `element.style.color` |
| --- | --- |
| `#2471a3` | `rgb(36, 113, 163)` |
| `#abc` | `rgb(170, 187, 204)` |
| `#abcd` | `rgba(170, 187, 204, 0.867)` |
| `#2471a380` | `rgba(36, 113, 163, 0.5)` |
| `steelblue` | `steelblue` |
| `hsl(204, 64%, 39%)` | `rgb(36, 112, 163)` |
| `notacolor` | empty string |
| `var(--trip-color)` | `var(--trip-color)` |

This is expected CSS behavior. CSS Color defines CSS serialization of ordinary
sRGB values in `rgb()`/`rgba()` form while retaining declared named-color
keywords. See [CSS Color 4, serializing color values](https://drafts.csswg.org/css-color-4/#serializing-color-values)
and [CSSOM, serializing CSS values](https://drafts.csswg.org/cssom/#serializing-css-values).

The browser preserves the semantic color. The converter loses it by accepting
one spelling before DOM parsing and rejecting the equivalent spelling after
DOM parsing.

### The raw attribute survives DOM parsing

In the same probes, `element.getAttribute('style')` retained the original
declaration text (`color:#2471a3`, `color:#abc`, and so on). A detached DOM can
therefore still provide inert structure without making CSSOM serialization the
source of the AST color token.

### TipTap already makes this choice

The packaged TipTap 3.28 color extension
(`node_modules/@tiptap/extension-text-style/src/color/color.ts`) prefers a raw
inline-style property reader and falls back to `element.style.color`. Its code
comment names this exact reason: preserve formats such as `#rrggbb` instead of
the canonicalized `rgb(…)` returned by CSSOM.

Better Peakbagger currently destroys the token once before TipTap receives the
editor HTML and again when TipTap's `getHTML()` is folded back through
`domToBracket`. Reading raw color text in the converter makes both boundaries
consistent with the editor library.

## Option A: accept and canonicalize CSSOM output

### Design

Keep `element.style.color` as the DOM boundary. Split color handling into two
grammars:

- bracket/Markdown source accepts only the product's declared color forms;
- DOM input additionally accepts strict browser-produced `rgb(…)` and possibly
  `rgba(…)`, converting them into canonical hex before constructing the AST.

For example:

```text
#2471a3 → DOM → rgb(36, 113, 163) → #2471a3
```

### Advantages

- The browser rejects syntactically invalid CSS before the converter sees it.
- Pasted `rgb()` and some other sRGB forms can be reduced to a fixed color.
- The AST can use one semantic representation regardless of the input syntax.

### Costs and risks

- The converter must implement and test CSSOM's serialization language rather
  than the much smaller source contract.
- Alpha requires decimal-to-byte conversion and careful rounding. The observed
  `#abcd → rgba(…, 0.867)` round trip no longer has the original alpha byte.
- CSSOM can turn an input outside the declared grammar into an accepted one:
  for example, pasted `hsl(…)` becomes `rgb(…)`. That silently widens the DOM
  input contract.
- Modern color syntax can serialize as forms other than legacy `rgb()`.
  Supporting browser output becomes an ongoing compatibility boundary.
- Source validation and DOM validation necessarily behave differently, making
  the same semantic content path-dependent.
- The code does more work only to reconstruct information still present in the
  raw style attribute.

### Security assessment

This option can be secure if the RGB parser is strict and the AST printer
emits only canonical hex. Its problem is not security; it is unnecessary
complexity and a wider, browser-dependent contract.

## Option B: extract and validate the raw color token

### Design

Read the last raw `color` declaration from `element.getAttribute('style')`, or
the raw `color` attribute on legacy `font`. Feed only that value into the
existing color sanitizer. Do not ask CSSOM to serialize it first.

The extractor may encounter other declarations in pasted or TipTap-generated
DOM, but it returns only the value belonging to `color`. Every other style is
ignored by the color path. The returned token must then match a grammar that
cannot contain a CSS declaration separator, function, URL, quote, or bracket.

Recommended initial grammar:

```text
#[0-9a-fA-F]{3}
#[0-9a-fA-F]{6}
[A-Za-z]{3,20}
```

The sanitizer lowercases the result. Alphabetic values preserve the existing
compatibility contract: an unknown word may be an ineffective color, but it
cannot inject another declaration or escape the attribute. If strict semantic
validation of named colors is later desired, use an explicit standard-name
set rather than CSSOM.

Four- and eight-digit alpha hex should remain out of the supported Rich and
Markdown contract until a minimal Peakbagger Preview/render check verifies it.
Plain mode continues to preserve those strings verbatim. If verified, adding
exact lengths 4 and 8 is a grammar change, not a converter redesign.

### Advantages

- Preserves accepted source spelling without an RGB reverse-converter.
- Matches TipTap 3.28's deliberate behavior.
- Has the same contract in bracket import, Markdown extensions, TipTap load,
  TipTap save, DOM paste, and preview.
- Is deterministic across Chrome, Firefox, and jsdom.
- Does not accidentally accept HSL, variables, or future CSS color functions.
- Keeps the AST and serializer unchanged.
- Is the smallest safe change at the actual broken boundary.

### Costs and risks

- The extension, rather than the CSS parser, owns the tiny lexical grammar.
- The raw style extractor must define duplicate declarations. Following CSS
  order and taking the last `color` declaration is predictable and matches
  TipTap's utility.
- Naively splitting arbitrary CSS is not a general CSS parser. This is
  acceptable only because the accepted value grammar itself excludes
  semicolons, parentheses, quotes, escapes, and comments. The extractor must
  never grow into an arbitrary-style feature.
- An alphabetic but nonexistent color can pass the lexical gate and render as
  the browser default. That is inert, round-trippable input rather than active
  CSS injection.

### Security assessment

The grammar is sufficient for the emitted context because no accepted token
can terminate `color`, introduce a second declaration, call `url()`, or break
out of the quoted `style` attribute. The HTML serializer must continue escaping
attributes, and the bracket serializer must continue accepting color nodes only
from the validated AST.

## Comparison

| Criterion | Option A: CSSOM canonicalization | Option B: raw token grammar |
| --- | --- | --- |
| Source of truth | Browser-serialized CSS value | Accepted source token |
| Hex behavior | Reconstructed from `rgb()` | Preserved directly |
| Named-color behavior | Preserved by CSSOM | Preserved by grammar |
| Alpha | Requires parsing/rounding `rgba()` | Exact if lengths 4/8 are later allowed |
| Pasted HSL/RGB | May be accepted after normalization | Rejected unless explicitly added |
| Browser dependence | CSSOM output is part of the contract | Raw attribute plus local grammar |
| Implementation size | RGB(A) parser and canonicalizer | Raw property extractor plus corrected regex |
| Cross-path consistency | Source and DOM use different grammars | All paths use one value grammar |
| Match with TipTap | Works against TipTap's raw preservation | Uses the same preservation strategy |
| Security | Safe with a strict functional parser | Safe with a non-injectable token grammar |
| Future surface area | Tracks new serialization forms | Expands only through explicit grammar changes |
| Recommendation | Reject | **Choose** |

## Why broader sanitization remains

"Let the website reject evil input" is coherent only for content the extension
passes to the website without interpreting. That is Plain mode. The other
surfaces act before Peakbagger can respond:

| Boundary | Why Better Peakbagger owns it |
| --- | --- |
| Markdown preview | The extension assigns generated HTML to local `innerHTML`; Peakbagger never receives it first |
| Rich editor load/paste/drop | The extension turns DOM into an editable schema document and later serializes it |
| Raw Markdown HTML | Marked tokenizes but does not sanitize it; rendering it locally would create a new active surface |
| Links | The extension emits clickable anchors and must exclude active or browser-internal schemes |
| Images | The extension can cause an immediate third-party request in preview and must constrain sources and dimensions |
| Existing bracket reports | Peakbagger was observed accepting and rendering broader tags such as `iframe`; a server error cannot be assumed |

Removing these validators while retaining local Rich/Markdown rendering would
make the extension responsible for an unsafe transformation and then pretend
the server owned it. If the product wants zero local validation, the coherent
alternative is Plain-only editing with no local preview. That is a product
removal, not a simplification of the current converter.

## Proposed implementation

Keep the color repair as one focused unit:

1. Add a small `readStyleProperty(element, 'color')` helper in
   `src/reports/report-markup.js`. Keep it local so the converter remains independent
   of TipTap.
2. For `span`, read raw inline `color`; for `font`, continue reading the raw
   `color` attribute.
3. Tighten `sanitizeColor` to exact supported hex lengths instead of the
   current `#{3,8}` range, which accidentally admits five- and seven-digit
   strings.
4. Continue lowercasing the accepted token and storing it in the existing AST
   color node.
5. Do not add `rgb()`, `rgba()`, HSL, variables, arbitrary declarations, or a
   general CSS parser.
6. Remove the hex-color known-defect warning from `trip-report-editor.md` only
   after the regressions below pass.

The Markdown-sidecar repair should be a separate commit because it changes
editor state validity rather than markup conversion.

## Regression plan

### Pure converter tests

Add focused cases in `test/reports/report-markup.test.mjs` for:

- named color and three-/six-digit hex through bracket → AST → bracket;
- hex through bracket → Markdown and Markdown extension → bracket;
- hex through bracket → editor HTML → detached DOM → bracket;
- preview HTML containing the same safe color;
- legacy `font color` normalization to `span style="color:…"`;
- a pasted span with other declarations retaining only an allowed color;
- duplicate color declarations selecting the last raw value, with an invalid
  final token producing no color rather than falling back through declarations;
- invalid hex lengths, `rgb()`, `rgba()`, `hsl()`, `var()`, `url()`, quotes,
  semicolon injection, and unsupported properties remaining inert or unstyled;
- named palette behavior remaining unchanged.

### Editor integration tests

Add cases in `test/reports/report-editor.test.mjs` proving:

- an existing hex-colored report appears colored in Rich mode;
- an unrelated Rich edit retains the color in `JournalText`;
- entering Markdown retains the bracket extension;
- an unrelated Markdown edit retains the color in both `JournalText` and the
  live preview;
- merely visiting either mode still does not rewrite unsupported server text.

### Hidden real-browser verification

Extend `scripts/verify-extension.mjs` to exercise the real unpacked extension
in hidden Chrome for Testing at its existing 1000×760 viewport:

1. Enter hex markup in Plain.
2. Switch to Rich, make an unrelated edit, and assert that `JournalText` still
   contains the color.
3. Switch to Markdown and assert both source and preview color.
4. Confirm that no page errors occurred.

Run a small hidden Firefox CSSOM/raw-attribute probe as a cross-browser
diagnostic. This does not prove visible focus, window placement, or browser
chrome behavior; those are not affected by this change.

Required checks before committing:

- `npm test`
- `npm run lint`
- `npm run verify:extension`
- `git diff --check`

## Non-goals

- No arbitrary CSS or general `style` passthrough.
- No raw HTML rendering in Markdown preview.
- No weakening of link, image, DOM, or bracket-tag validation.
- No toolbar redesign or new color picker.
- No fix for the stale Markdown sidecar in the color commit.
- No automated click on either Peakbagger Save control.

## Revisit conditions

Reconsider this decision only if:

- Rich mode must accept functional or wide-gamut CSS colors;
- TipTap stops preserving raw color attributes;
- Peakbagger begins validating or rewriting color values server-side; or
- alpha hex is verified and should graduate into the supported contract.

Until then, raw-token preservation is the smallest safe repair and keeps the
security boundary legible: strict conversion where the extension renders,
verbatim escape through Plain mode.
