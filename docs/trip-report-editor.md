# Trip-report editor: markup, Markdown, and safety

Peakbagger's ascent form does not accept ordinary HTML source. It accepts an
HTML-like dialect written with square brackets, such as `[b]bold[/b]`, then
turns those brackets into HTML when it displays the report. Every newline left
in the report also becomes a `<br>`.

Better Peakbagger keeps Peakbagger's `JournalText` textarea inside the original
form as the submitted source of truth. Rich text and Markdown are editing views
over that value; neither replaces the form or submits an ascent. The extension
flushes the active view synchronously before Preview, Save, an ASP.NET postback,
or page exit.

## The 30-second model

There are three editing modes, but they do not pass their private document
formats directly to one another. They exchange one value through the original
`JournalText` textarea:

```text
                         submitted to Peakbagger
                                  ▲
                                  │ bracket-markup string
                                  │
                         JournalText textarea
                         (interchange + source of truth)
                           ▲          ▲          ▲
                           │          │          │
                    bracket string    │    bracket string
                           │          │          │
                    Rich converter    │    Markdown converter
                           │          │          │
                    TipTap document   │    CodeMirror string ──► preview HTML
                                      │
                                Plain mode
                         edits JournalText directly
```

The Markdown preview is not a fourth mode and never becomes source data. It is
a read-only rendering derived from the current CodeMirror string. The
allowlisted report AST is also not stored or passed between modes; it is a
short-lived intermediate value created during each conversion.

On every mode switch, the editor first flushes a dirty outgoing mode into
`JournalText`, then builds the incoming view from `JournalText`. The one
exception is an exact Markdown-source sidecar described below.

## Representations and ownership

| Representation | Owner | Data format | Role |
| --- | --- | --- | --- |
| Saved/form value | Peakbagger's `JournalText` textarea | String containing Peakbagger square-bracket markup and newlines | The only value submitted to Peakbagger and the interchange between modes |
| Rich document | [TipTap](https://tiptap.dev)/ProseMirror | Schema-constrained ProseMirror document; `getHTML()` exposes a clean HTML serialization | Editable Rich-mode state only |
| Markdown source | [CodeMirror 6](https://codemirror.net) | GFM Markdown string plus allowlisted Peakbagger bracket extensions | Editable Markdown-mode state only |
| Markdown source sidecar | `state.mdSource`, and `source` in a Markdown draft | Exact Markdown string | Preserves the user's Markdown spelling when a round trip through bracket markup would rewrite it |
| Preview | A preview `<div>` | Generated safe HTML string | Read-only view of the current Markdown source; never parsed back |
| Report AST | `src/report-markup.js` | Plain JavaScript block/inline objects | Temporary common semantic form used only inside a conversion |
| Plain editor | The original `JournalText` textarea | The same bracket-markup string that will be submitted | Verbatim editing with no converter |

One report can therefore have several equivalent spellings:

```text
Markdown source    We climbed **Baker** under [span style="color:steelblue"]blue[/span] skies.
Rich getHTML()     <p>We climbed <strong>Baker</strong> under <span style="color: steelblue;">blue</span> skies.</p>
Report AST         paragraph(text, bold(text), text, color("steelblue", text), text)
Saved JournalText  We climbed [b]Baker[/b] under [span style="color:steelblue"]blue[/span] skies.
Preview HTML       <p>We climbed <b>Baker</b> under <span style="color:steelblue">blue</span> skies.</p>
```

These values are semantically related, not byte-for-byte mirrors. Only
`JournalText` has submission authority.

Module ownership follows the same boundary: `src/report-editor.js` orchestrates
mode switches, dirty state, drafts, and `JournalText`; `src/report-rich-editor.js`
owns the TipTap schema and commands; `src/report-md-editor.js` owns only the
CodeMirror surface; and `src/report-markup.js` owns every format conversion,
sanitizer, and canonical serializer.

## Exact conversion paths

The orchestrator calls these converter entry points:

| Operation | Converter entry point |
| --- | --- |
| Enter Rich | `bracketToEditorHtml(JournalText.value)` |
| Flush a Rich edit | parse `richEditor.getHTML()` into a detached DOM, then `domToBracket(body)` |
| Enter Markdown without an exact sidecar | `bracketToMarkdown(JournalText.value)` |
| Flush a Markdown edit | `markdownToBracket(codeMirrorText)` |
| Refresh Markdown preview | `markdownToPreviewHtml(codeMirrorText)` |
| Enter or edit Plain | None; Plain is `JournalText` |

### Loading Rich mode

```text
JournalText bracket string
  → validate balanced bracket tags and attributes
  → safe HTML in a detached DOM
  → allowlisted report AST
  → generated editor HTML
  → TipTap parses HTML into its ProseMirror document
```

TipTap is rebuilt on every entry to Rich mode, so its undo history cannot cross
a mode switch. Loading may already produce a normalized or reduced Rich view,
but the original `JournalText` remains unchanged until the user actually edits
Rich mode.

### Editing and flushing Rich mode

```text
TipTap ProseMirror document
  → TipTap getHTML()
  → detached DOM
  → allowlisted report AST
  → canonical Peakbagger bracket string
  → JournalText
```

The schema is an early structural filter, but it is not trusted as the final
security boundary. The DOM-to-AST conversion validates the content again. A
Rich edit clears the Markdown-source sidecar because that old Markdown no
longer describes the document.

### Loading Markdown mode

Normally the path is:

```text
JournalText bracket string
  → validate balanced bracket tags and attributes
  → safe HTML in a detached DOM
  → allowlisted report AST
  → generated canonical Markdown string
  → CodeMirror
```

If `state.mdSource` holds an exact Markdown string from the current editing
session or a restored draft, CodeMirror receives that string instead. This
avoids needless rewrites such as changing a user's list markers or emphasis
spelling merely because they visited another mode without editing it.

### Editing Markdown mode

CodeMirror only edits and highlights text. It does not parse, sanitize, or
render the report. The extension sends its string through two sibling outputs:

```text
CodeMirror Markdown string
  → Marked 18.0.6 lexer tokens
  → allowlisted report AST ──→ canonical bracket string ──→ JournalText
                           └─→ generated safe HTML ───────→ preview.innerHTML
```

[Marked 18.0.6](https://github.com/markedjs/marked/tree/v18.0.6) is used only as
a GFM lexer. Its HTML renderer is never called. Raw HTML tokens become visible
text, while Peakbagger bracket extensions embedded in a Markdown text token go
through the same bracket-to-detached-DOM parser used when loading
`JournalText`.

The preview and `JournalText` are printed from the same parsed semantics, so
they agree about supported structure and rejected input. The preview does not
prove pixel-for-pixel fidelity with Peakbagger's own stylesheet.

### Plain mode

Plain mode exposes the original `JournalText` textarea. There is no AST,
detached DOM, TipTap, Marked, CodeMirror conversion, sanitization, or
normalization:

```text
user keystrokes ↔ JournalText bracket string → Peakbagger form submission
```

That makes Plain mode the verbatim escape hatch, including for markup the Rich
and Markdown converters do not support. It also means Plain mode provides none
of their safety filtering. Editing the native textarea invalidates the exact
Markdown-source sidecar, so a later switch to Markdown regenerates its source
from the current `JournalText` value.

## What sanitizes, and what only normalizes

Sanitizing decides whether content is allowed to reach `JournalText` or the
preview as active markup. Normalizing keeps allowed semantics but chooses one
canonical spelling or structure. Several components do only one of those jobs:

| Component | Sanitizes? | Normalizes? | What it actually does |
| --- | --- | --- | --- |
| TipTap schema | Partial, structural first pass | Yes | Refuses nodes and marks its schema cannot represent; turns editing operations and pasted content into a ProseMirror document |
| CodeMirror | No | No | Stores a string, highlights syntax, continues lists, and manages Markdown undo history |
| Marked lexer | No | No | Tokenizes GFM syntax; Better Peakbagger, not Marked, decides which token types enter the AST |
| Markdown-token-to-AST mapper | Yes | Yes | Accepts known token types, validates links and images, sends bracket extensions through the bracket parser, and keeps raw HTML inert as visible text |
| Bracket-source parser | Yes | Yes | Requires balanced allowlisted tags, validates attributes, neutralizes unsupported tag-like source, and builds inert safe HTML |
| DOM-to-AST parser | Yes, authoritative for DOM input | Yes | Drops dangerous DOM nodes, unwraps unsupported elements to safe visible content where appropriate, and revalidates links, image sources, dimensions, and colors |
| AST-to-bracket printer | No new validation | Yes | Serializes the already-validated AST, emitting canonical Peakbagger tags and escaping ordinary text that resembles HTML or bracket tags |
| AST-to-HTML printer | No new validation | Yes | Serializes the already-validated AST into allowlisted preview/editor elements with escaped text and attributes |
| AST-to-Markdown printer | No new validation | Yes | Serializes the already-validated AST into canonical Markdown plus bracket extensions for features with no standard Markdown form |
| Preview `<div>` | No | No | Receives only AST-generated safe HTML and is never read back into source data |
| Plain mode | No | No | Edits the submitted string verbatim |

Important normalization examples include:

- `strong` → `b`, `em` → `i`, and `strike`/`del` → `s` in saved markup;
- `font color="…"` → `span style="color:…"`;
- `p`, `div`, and `br` → Peakbagger's newline convention;
- loose legacy `- item` and `1. item` reports → real list tags after an edit;
- every table → `[table border="1"]`;
- DOM bold/italic/underline/strike styles → semantic AST marks;
- unsafe or unsupported source → escaped visible text, unwrapped visible
  children, or complete removal for dangerous elements, depending on where it
  entered.

## Mode-switch behavior

| Switch | What is flushed | What the destination receives |
| --- | --- | --- |
| Rich → Markdown | Dirty Rich document becomes canonical bracket markup; this clears `mdSource` | Canonical Markdown regenerated from `JournalText` |
| Markdown → Rich | Dirty Markdown becomes canonical bracket markup; exact Markdown remains in `mdSource` | Rich document regenerated from `JournalText` |
| Markdown → Rich → Markdown, with no Rich edit | Nothing is rewritten by Rich | The exact `mdSource` string is restored |
| Rich or Markdown → Plain | Dirty outgoing editor is flushed first | The actual `JournalText` string |
| Plain → Rich | Nothing is flushed by Plain | Rich document regenerated from the current `JournalText` string |
| Plain → Markdown | Nothing is flushed by Plain; Plain input has already cleared `mdSource` | Markdown regenerated from the current `JournalText` |

Dirty flags are deliberate. Merely opening Rich or Markdown may normalize or
omit unsupported content in that view, but does not overwrite the server value.
The first real edit serializes the entire active document, at which point those
normalizations become the new `JournalText`. Before Preview, Save, any ASP.NET
postback, or page exit, a pending dirty edit is flushed synchronously rather
than waiting for the typing debounce.

## Known issues

### Hex colors are lost outside Plain mode

The bracket parser initially accepts a color such as `#2471a3`, creates a
detached `<span>`, and later reads the parsed declaration through
`element.style.color`. CSSOM returns the equivalent `rgb(36, 113, 163)`.
`sanitizeColor` accepts hex literals and short alphabetic keywords, but not the
`rgb(…)` spelling, so the second validation drops the color wrapper and keeps
its text.

This affects both Rich and Markdown. Markdown bracket extensions pass through
the same detached-DOM parser; CodeMirror does not keep them away from it. The
toolbar therefore uses named colors such as `steelblue`, which survive the
round trip. Plain mode preserves hex markup because it invokes no converter.

Merely visiting Rich or Markdown still leaves the original `JournalText`
untouched. Making any edit in either mode serializes the whole reduced document
and makes the lost color permanent. This is a converter invariant bug, not a
loss of the semantic color by the browser.

The accepted repair is raw-token preservation, as recorded in the
[color-conversion spike](archive/trip-report-color-conversion-spike.md). It is
not implemented yet. The converter should use a private, color-specific helper
that reads the last raw inline `color` declaration, then validates that value
against the existing narrow contract. An invalid final declaration must remove
the color rather than fall back to CSSOM or an earlier declaration. Initially,
Rich and Markdown should accept only three- and six-digit hex plus the existing
short alphabetic tokens; alpha hex, functional colors, variables, and arbitrary
CSS remain out of scope until separately verified against Peakbagger.

### Lossy imports are not surfaced before the first edit

Rich and Markdown deliberately omit, unwrap, or neutralize markup outside the
allowlisted report AST. Dirty flags protect an untouched server report when the
user merely visits those modes. They do not protect it after the first real
edit: serializing the active view rewrites the entire report, so an unrelated
change can make unsupported existing markup permanently inert.

Plain mode avoids that conversion, but the editor does not currently detect a
lossy import or direct the user to Plain before editing. This is a UX guardrail
gap rather than a reason to weaken sanitization. The recommended follow-up is
for the bracket parser to return explicit diagnostics when source is dropped or
neutralized. A report with those diagnostics should start in Plain and require
an intentional action before conversion to Rich or Markdown. Do not infer loss
by comparing serialized strings: supported aliases, legacy structure, and
whitespace are intentionally normalized and would create false positives.

## Supported Markdown

Markdown mode supports the GFM structures that have a useful, verified
Peakbagger equivalent:

| Markdown | Peakbagger output |
| --- | --- |
| `**bold**`, `*italic*`, `~~strike~~` | `[b]`, `[i]`, `[s]` |
| `` `inline code` `` | `[code]` |
| `#` through `######` headings | `[h1]` through `[h6]` |
| `> quote` | `[blockquote]` |
| `-`/`*` bullets and `1.` numbering, including nesting | `[ul]`/`[ol]`/`[li]` |
| GFM pipe tables | `[table border="1"]`/`[tr]`/`[th]`/`[td]` |
| fenced or indented code blocks | `[pre]` |
| `---` horizontal rule | `[hr]` |
| `[label](https://…)` and bare web URLs | `[a href="…"]` |
| `![alt](https://…)` | `[img src="…" alt="…"]` |
| two spaces plus newline, or an ordinary newline inside a paragraph | Peakbagger line break |
| a blank line | Peakbagger paragraph spacing |

Peakbagger-supported inline features without standard Markdown syntax remain
available as bracket extensions inside Markdown:

```markdown
[u]underline[/u]
[mark]highlight[/mark]
H[sub]2[/sub]O and x[sup]2[/sup]
[small]aside[/small]
[q]inline quote[/q]
[span style="color:red"]red[/span]
```

The extension accepts only a single safe `color` declaration on `span` (or the
equivalent legacy `[font color="…"]` on import). It does not accept arbitrary
CSS.

## Supported Peakbagger markup

The following tags were verified against Peakbagger's rendered ascent-report
output and are represented in rich and Markdown modes:

- Inline: `b`, `strong`, `i`, `em`, `u`, `s`, `strike`, `del`, `small`,
  `mark`, `sub`, `sup`, `code`, `q`, `a`, `img`, and color-only `span`/`font`.
- Blocks: `h1`–`h6`, `blockquote`, `ul`, `ol`, `li`, `table`, `tr`, `th`,
  `td`, `pre`, and `hr`.
- Compatibility imports: `p`, `div`, and `br` are accepted, then normalized to
  Peakbagger's documented newline convention. Older Better Peakbagger reports
  whose lists were saved as `- item` or `1. item` lines import as real lists and
  are emitted as list tags after an edit.

Aliases normalize to one canonical spelling: `strong` becomes `b`, `em`
becomes `i`, and `strike`/`del` become `s`. Tables always receive
`border="1"`, matching the server-verified form that remains legible in
Peakbagger's report page.

The rich toolbar exposes the common actions without becoming a wall of
controls: block style (paragraph, six heading levels, quote, preformatted),
bold, italic, underline, strikethrough, link, image, table, both list types,
horizontal rule, and undo/redo, with live active states that follow the caret.
Less-frequent inline formats — inline code, highlight, sub/superscript, small,
inline quote, and a named-color text palette — sit one click away behind the
"Aa" control. While the caret is inside a table, a contextual row offers
add/delete row and column, header-row toggle, and table removal.

## Deliberate restrictions

Peakbagger was observed rendering `iframe` markup, and the site accepts a much
broader HTML-shaped surface than a trip-report editor should expose. Better
Peakbagger therefore does **not** generate or execute:

- `iframe`, `video`, `audio`, `object`, or `embed`;
- `script`, forms, controls, or event-handler attributes;
- raw HTML embedded in Markdown;
- `javascript:`, `data:`, filesystem, browser-internal, or protocol-relative
  URLs;
- arbitrary `style` attributes.

Plain mode is the explicit verbatim escape hatch for an experienced user who
needs Peakbagger markup outside the allowlist. Merely opening Rich or Markdown
and switching modes does not rewrite the server value. Once content is actually
edited in Rich or Markdown, unsupported tag-like text is entity-escaped so it
will remain visible text after Peakbagger renders it instead of becoming active
HTML.

Links allow HTTP, HTTPS, `mailto:`, root-relative Peakbagger paths, and local
fragments. Images are stricter: only HTTPS or root-relative sources are emitted,
dimensions are bounded, and the local editor preview adds lazy loading plus a
no-referrer policy. A remote image in the final saved report is still loaded by
Peakbagger and therefore makes a request to that image host when someone reads
the report.

## Local drafts and cache limits

Drafts autosave to extension-local storage every time you pause typing, and also save synchronously on page exit. They never leave your device. 
To prevent storage unbounded growth and accidental overwrites, drafts have specific lifecycle rules:
- **Identity:** Drafts are uniquely keyed by the climber ID and the ascent ID (or peak ID, for a new ascent).
- **TTL:** Drafts expire after **14 days**.
- **Limit:** The extension keeps a maximum of **30 drafts** globally. Excess drafts are pruned (oldest first).
- **Restoration:** When you return to an ascent page, the extension compares its saved draft against the text the server just rendered. If they differ, it presents a banner offering to restore the draft. The extension **never silently applies** a draft; you must explicitly click "Restore draft". 
- **Clearance:** A draft is permanently cleared when you click either Peakbagger Save button, click "Delete draft", or if you delete all text and it autosaves an empty state.

## Preview fidelity

Markdown mode renders its preview live in a split pane beside the source
(stacked below it when the form column is narrow), re-rendering as you pause
typing and following the source pane's scroll position. The preview shows the
exact semantic structure the converter will save, with the extension's compact
editor styles. Peakbagger's report page owns the final colors, heading
alignment, font sizes, and margins, so the preview intentionally does not
claim pixel-for-pixel fidelity with that legacy stylesheet. Plain mode always
shows the exact bracket source.

## Regression boundaries

- The hex-color defect above describes current behavior, not the intended
  contract, and does not yet have focused regression coverage.
- Existing tests pin unsupported-markup neutralization after an edit, but there
  is no parser diagnostic or mode-level guardrail for a lossy import. A future
  guardrail must distinguish actual dropped or neutralized source from allowed
  canonical normalization.
- `test/report-markup.test.mjs` pins Markdown tokens, bracket aliases, DOM
  import, canonical output, unsafe-input neutralization, and round trips.
- `test/report-editor.test.mjs` pins the native-textarea source of truth,
  untouched-value preservation, expanded rich DOM, toolbar active states,
  image-source validation, undo isolation across mode switches, mode
  switching (including invalidation of stale Markdown source after a Plain
  edit), local drafts, and pre-postback flushing, driving the TipTap and
  CodeMirror instances through the mount's test handle.
- `test/manifest-capture.test.mjs` pins the vendored parser before the converter
  and editor in the real content-script list.
- `npm run verify:extension` loads the unpacked extension in hidden Chrome for
  Testing and exercises real typing, Ctrl/Cmd+B, the `1. ` input rule, live
  toolbar states, the CodeMirror source pane with its live split preview,
  toolbar table insertion and growth, and draft restoration against the masked
  ascent form fixture.

## Peakbagger render test
```
=== BETTER PEAKBAGGER TAG TEST ===

--- Emphasis ---
Bold b: [b]bold[/b]
Strong: [strong]strong[/strong]
Italic i: [i]italic[/i]
Emphasis em: [em]emphasis[/em]
Underline u: [u]underline[/u]
Strike s: [s]strike[/s]
Strike strike: [strike]strike[/strike]
Strike del: [del]deleted[/del]
Small: [small]small[/small]
Mark: [mark]highlight[/mark]
Sub: H[sub]2[/sub]O
Sup: x[sup]2[/sup]
Code: [code]inline_code()[/code]

--- Headings ---
[h1]Heading 1[/h1]
[h2]Heading 2[/h2]
[h3]Heading 3[/h3]
[h4]Heading 4[/h4]
[h5]Heading 5[/h5]
[h6]Heading 6[/h6]

--- Quotes ---
[blockquote]Block quote line.[/blockquote]
Inline q: [q]quoted[/q]

--- Links ---
Link: [a href="https://www.peakbagger.com/"]Peakbagger[/a]
Link new tab: [a href="https://www.peakbagger.com/" target="_blank"]new tab[/a]

--- Images ---
Image: [img src="https://www.peakbagger.com/image/header.jpg" alt="test"]
Image sized: [img src="https://www.peakbagger.com/image/header.jpg" width="120"]

--- Video / embeds ---
Iframe: [iframe width="320" height="180" src="https://www.youtube.com/embed/aqz-KE-bpKQ"][/iframe]
Video: [video src="https://file-examples.com/storage/fee96acbae6a5a8fda1faee/2017/04/file_example_MP4_480_1_5MG.mp4" controls][/video]

--- Lists ---
[ul][li]bullet one[/li][li]bullet two[/li][/ul]
[ol][li]number one[/li][li]number two[/li][/ol]

--- Table ---
[table border="1"][tr][th]Peak[/th][th]Elev[/th][/tr][tr][td]Rainier[/td][td]14411[/td][/tr][tr][td]Baker[/td][td]10781[/td][/tr][/table]

--- Structure / misc ---
Rule below: [hr]
Preformatted: [pre]two   spaces
new line[/pre]
Div: [div]div content[/div]
Span color: [span style="color:red"]red[/span]
Font color: [font color="green"]green[/font]

--- Warned-against (test anyway) ---
Paragraph: [p]paragraph[/p]
Break here[br]after break

=== END TEST ===
```
