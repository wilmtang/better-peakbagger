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
| Markdown source | [CodeMirror 6](https://codemirror.net) | GFM Markdown string plus allowlisted inline HTML | Editable Markdown-mode state only |
| Markdown source sidecar | `state.mdSource`, and `source` in a Markdown draft | Exact Markdown string | Preserves the user's Markdown spelling when a round trip through bracket markup would rewrite it |
| Preview | A preview `<div>` | Generated safe HTML string | Read-only view of the current Markdown source; never parsed back |
| Report AST | `src/reports/report-markup.js` | Plain JavaScript block/inline objects | Temporary common semantic form used only inside a conversion |
| Plain editor | The original `JournalText` textarea | The same bracket-markup string that will be submitted | Verbatim editing with no converter |

One report can therefore have several equivalent spellings:

```text
Markdown source    We climbed **Baker** under <span style="color:#2471a3">blue</span> skies.
Rich getHTML()     <p>We climbed <strong>Baker</strong> under <span style="color: rgb(36, 113, 163);" data-bpb-report-color="#2471a3">blue</span> skies.</p>
Report AST         paragraph(text, bold(text), text, color("#2471a3", text), text)
Saved JournalText  We climbed [b]Baker[/b] under [span style="color:#2471a3"]blue[/span] skies.
Preview HTML       <p>We climbed <b>Baker</b> under <span style="color:#2471a3">blue</span> skies.</p>
```

These values are semantically related, not byte-for-byte mirrors. Only
`JournalText` has submission authority.

Module ownership follows the same boundary: `src/reports/report-editor.js` orchestrates
mode switches, dirty state, drafts, and `JournalText`; `src/reports/report-rich-editor.js`
owns the TipTap schema and commands; `src/reports/report-md-editor.js` owns only the
CodeMirror surface; and `src/reports/report-markup.js` owns every format conversion,
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
longer describes the document. TipTap may serialize a hex `style` value through
CSSOM as `rgb(…)`, so the Rich schema also carries its originally parsed color
token in `data-bpb-report-color`. The DOM converter revalidates that token; the
internal attribute never reaches `JournalText` or preview HTML.

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
text, while allowlisted HTML embedded in Markdown goes through the same
tag-to-detached-DOM parser used when loading
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
| TipTap schema | Partial, structural first pass | Yes | Refuses nodes and marks its schema cannot represent; turns editing operations and pasted content into a ProseMirror document, carrying the parsed color token across CSSOM serialization |
| CodeMirror | No | No | Stores a string, highlights syntax, continues lists, and manages Markdown undo history |
| Marked lexer | No | No | Tokenizes GFM syntax; Better Peakbagger, not Marked, decides which token types enter the AST |
| Markdown-token-to-AST mapper | Yes | Yes | Accepts known token types, validates links and images, parses only the documented inline HTML allowlist, and keeps other HTML inert as visible text |
| Bracket-source parser | Yes | Yes | Requires balanced allowlisted tags, validates attributes, neutralizes unsupported tag-like source, and builds inert safe HTML |
| DOM-to-AST parser | Yes, authoritative for DOM input | Yes | Drops dangerous DOM nodes, unwraps unsupported elements to safe visible content where appropriate, and revalidates links, image sources, dimensions, raw inline colors, and TipTap-preserved color tokens |
| AST-to-bracket printer | No new validation | Yes | Serializes the already-validated AST, emitting canonical Peakbagger tags and escaping ordinary text that resembles HTML or bracket tags |
| AST-to-HTML printer | No new validation | Yes | Serializes the already-validated AST into allowlisted preview/editor elements with escaped text and attributes |
| AST-to-Markdown printer | No new validation | Yes | Serializes the already-validated AST into canonical Markdown plus safe HTML for features with no standard Markdown form |
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

## Color conversion boundary

Color conversion follows the raw-token decision recorded in the archived
[color-conversion spike](archive/trip-report-color-conversion-spike.md). For
ordinary DOM input, the converter reads the last raw inline `color` declaration
instead of `element.style.color`, then validates the token. For Rich output,
TipTap's internal `data-bpb-report-color` attribute preserves the parsed token
across its CSSOM-backed DOM serialization; the converter applies the same
validation again before constructing a color AST node.

Rich and Markdown accept three- and six-digit hex plus alphabetic tokens from
three through twenty characters. Accepted values are lowercased. An invalid
final declaration removes the color rather than falling back to CSSOM or an
earlier declaration. Four- and eight-digit alpha hex, five- and seven-digit
malformed hex, `rgb()`/`rgba()`, HSL, variables, URLs, quotes, and arbitrary CSS
remain inert or unstyled. Plain mode continues to preserve every spelling
verbatim because it performs no conversion.

## Known issue

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
| `![alt\|300](https://…)`, `![alt\|300x200](https://…)` | `[img … width="300"]`, optionally with `height="200"` |
| `![](https://…/clip.mp4)` (also `.webm`, `.ogv`, `.ogg`, or `.m3u8`) | `[video src="…" controls …][/video]` |
| `![Video\|640](https://…)`, `![Video\|640x360](https://…)` | `[video … width="640"]`, optionally with `height="360"` |
| `![YouTube\|640x360](https://youtu.be/aqz-KE-bpKQ)` | A canonical, lazy YouTube player iframe that sends only Peakbagger's origin |
| two spaces plus newline, or an ordinary newline inside a paragraph | Peakbagger line break |
| a blank line | Peakbagger paragraph spacing |

The image-size suffix follows Obsidian's pixel convention. It changes the
image's dimensions, not its alt text, and each dimension must remain between 1
and 1,600 pixels. The source is still subject to Better Peakbagger's image URL
rules: HTTPS and root-relative Peakbagger paths work; an Obsidian vault-local
attachment path does not grant the extension access to that file.

Direct video uses the image form because Markdown has no standard video syntax.
An empty alt text and a recognizable media-file suffix creates a video; use
`![Video](https://…)` for a signed or extensionless direct media URL. The
Markdown preview and Rich editor show a native, non-autoplaying video control.
The saved report uses Peakbagger's `[video src="…" controls …][/video]` form,
including fixed native controls, metadata preload, inline playback, and a
no-referrer policy. Video pages
and iframe embeds are deliberately not supported, with one narrow exception:
a recognized YouTube watch, share, Shorts, Live, or embed URL is converted to a
canonical YouTube player iframe. Other video pages and all non-YouTube embeds
remain unsupported. The same `|width` or `|widthxheight` suffix used for images
sizes a direct video or YouTube player; Rich media controls resize with an
aspect-locked corner handle or the left/right arrow keys.
Height-only legacy media markup is represented canonically as `|x360`, so a
Rich/Plain → Markdown → Rich round trip does not discard that dimension.

Peakbagger-supported inline features without standard Markdown syntax use
allowlisted HTML inside Markdown, so Markdown mode remains portable text rather
than exposing Peakbagger's private bracket dialect:

```markdown
<u>underline</u>
<mark>highlight</mark>
H<sub>2</sub>O and x<sup>2</sup>
<small>aside</small>
<q>inline quote</q>
<span style="color:red">red</span>
```

The extension accepts only a single safe `color` declaration on `span` (or the
equivalent legacy `[font color="…"]` on import): three- or six-digit hex, or a
short alphabetic token. It does not accept arbitrary CSS.

## Supported Peakbagger markup

The following tags were verified against Peakbagger's rendered ascent-report
output and are represented in rich and Markdown modes:

- Inline: `b`, `strong`, `i`, `em`, `u`, `s`, `strike`, `del`, `small`,
  `mark`, `sub`, `sup`, `code`, `q`, `a`, `img`, `video`, the restricted
  YouTube `iframe`, and color-only `span`/`font`.
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
bold, italic, underline, strikethrough, link, image, direct video or YouTube, table, both list types,
horizontal rule, and undo/redo, with live active states that follow the caret.
Selecting an image or direct video reveals one lower-corner handle. A YouTube
player keeps the same editor-owned corner handle visible so its own clicks
remain available for playback; dragging it
resizes the media without distorting its aspect ratio, and the left/right arrow
keys on the focused handle provide precise adjustment. The resulting pixel
dimensions are stored in Peakbagger's existing `width`/`height` media
attributes and remain bounded to 1,600 pixels per axis.
Less-frequent inline formats — inline code, highlight, sub/superscript, small,
inline quote, and a named-color text palette — sit one click away behind the
"Aa" control. While the caret is inside a table, a contextual row offers
add/delete row and column, header-row toggle, and table removal.

## Deliberate restrictions

Peakbagger was observed rendering `iframe` markup, and the site accepts a much
broader HTML-shaped surface than a trip-report editor should expose. Better
Peakbagger therefore does **not** generate or execute:

- iframes other than a canonical YouTube player, plus `audio`, `object`, or
  `embed`;
- `script`, forms, controls, or event-handler attributes;
- HTML outside the documented inline allowlist;
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
fragments. Images and direct videos are stricter: only HTTPS or root-relative
sources are emitted; image dimensions are bounded; the local preview uses a
no-referrer policy, and video never autoplays. A recognized YouTube URL is
instead emitted as a canonical iframe with `strict-origin-when-cross-origin`,
because YouTube rejects unidentified player requests with error 153.
Cross-origin player requests therefore identify only
`https://www.peakbagger.com/`, never the ascent path or query string. A remote
image, video, or YouTube player can make a request to its host when it is
visible in the Rich editor or Markdown preview. Media in the final saved report
is also loaded by Peakbagger and therefore makes a request to that host when
someone reads the report. Direct videos retain no-referrer in saved markup;
remote images use Peakbagger's page policy. These policies do not hide the
requesting browser's IP address or ordinary request metadata.

## Device-local trip report draft lifecycle

Trip report drafts are recovery snapshots for the trip-report field. They are separate
from the 30-minute prepared ascent drafts created by activity capture and from
the optional GitHub save-time snapshot. A TR draft uses extension
`storage.local`, not Peakbagger storage, `storage.sync`, or `storage.session`,
and never leaves the browser profile. It is not synced to another browser or
device and is not sent to Peakbagger, GitHub, or the extension developer.

`src/reports/report-editor.js` owns persistence and recovery. The pure
`src/reports/report-drafts.js` module is the shared identity, expiry, and limit contract
used by the editor and the manager in `options/drafts.js`.

### Identity: one key per climber and form target

The key, rather than the stored object, carries the draft's editing target:

```text
bpbReportDraft:<cid>:a<aid>   existing ascent
bpbReportDraft:<cid>:p<pid>   new ascent opened for a known peak
bpbReportDraft:<cid>:new      new ascent with no ascent or peak id
```

`aid` takes precedence over `pid`, and a missing `cid` becomes the literal
owner segment `0`. Keys read by the manager must match the all-digit grammar;
an unrelated `storage.local` entry or malformed `bpbReportDraft:` key is never
treated as a TR draft. Opening a parsed key reconstructs the corresponding
`ascentedit.aspx` URL. The unknown owner `0` is omitted from that URL instead of
being sent as a real climber id.

Identity is form-scoped, not tab-scoped or revision-scoped. Two open tabs
editing the same ascent, two new-ascent tabs for the same `pid`, or two generic
new-ascent tabs for the same `cid` share one key and can replace each other's
latest recovery snapshot. There is no merge or compare-and-swap layer. That is
an important current limitation, not an invitation to add a tab id without
designing how the manager and restore flow would resolve multiple candidates.

### Exact stored record

`storage.local` stores a structured object, not a JSON string. The current
writer produces this shape:

```ts
type ReportDraftRecord = {
  text: string;
  mode: "rich" | "markdown";
  savedAt: number;
  source?: string;
  label?: {
    peak?: string;
    date?: string;
  };
};
```

There is deliberately no schema version today. The fields have these exact
roles and authority boundaries:

| Field | New-write requirement | Meaning and constraints |
| --- | --- | --- |
| `text` | Required | The flushed `JournalText` value: Peakbagger bracket markup plus newlines. This is the recovery copy of the submitted representation. It is never TipTap HTML, a ProseMirror document, preview HTML, or Markdown. |
| `mode` | Required | The initialized authoring mode at the write: `rich` or `markdown`. Plain and uninitialized or disabled editors cannot write a record. |
| `savedAt` | Required | `Date.now()` in milliseconds at the write. It drives ordering, display, expiry, and pruning; it is not an ascent time or content revision id. |
| `source` | Markdown only | The exact CodeMirror string, including the user's Markdown spelling and whitespace. It is an authoring-fidelity sidecar; `text` remains the Peakbagger-facing value. Rich writes omit it because a Rich edit invalidates any earlier Markdown spelling. |
| `label.peak` | Optional | Display-only selected peak name, or the matching prepared-draft peak name when the native picker is not ready. It is trimmed and capped at 200 characters. The key, not this label, is identity. |
| `label.date` | Optional | Display-only raw trimmed `DateText`, capped at 20 characters. It is intentionally not normalized into the backup date identity. |

`label` is omitted when both members are empty. Label extraction is isolated in
its own `try`/`catch`: missing or changed optional form controls may make the
manager title less friendly, but cannot block saving the report. No other
ascent fields, cookies, GPX points, coordinates, page/provider URL fields,
preview HTML, report AST, or editor history are stored in a TR draft. The
report strings can of course contain links the author put in the report.

A normal Rich record has one report representation:

```js
{
  text: "Windy [b]summit[/b] day.",
  mode: "rich",
  savedAt: 1780000000000,
  label: { peak: "Example Peak", date: "7/21/2026" }
}
```

A normal Markdown record carries two representations of the same intended
report:

```js
{
  text: "Windy [b]summit[/b] day.",
  mode: "markdown",
  source: "Windy **summit** day.",
  savedAt: 1780000000000
}
```

Why keep both? `text` can be restored directly into Peakbagger's form and is
what Peakbagger would receive. `source` restores the exact Markdown editing
experience and is what **Copy Markdown** returns. Reconstructing Markdown from
`text` preserves supported meaning but can rewrite list markers, emphasis
spelling, whitespace, or safe inline HTML. Neither field contains Rich editor
state: Rich formatting survives because `text` encodes it as Peakbagger tags.

### Runtime validation and backward compatibility

The writer is stricter than the reader. New writes always provide the shape
above, but the shared `validRecord()` guard intentionally requires only a
non-array object with string `text` and finite numeric `savedAt`. This lets
older records without `mode`, `source`, or `label` remain recoverable.

Optional data is consumed defensively:

- restore uses the stored mode only when it is recognized; otherwise it keeps
  the current mode;
- the exact Markdown sidecar is used only when `mode === "markdown"` and
  `source` is a string;
- malformed or missing label members are ignored in favor of a key-derived
  fallback title;
- malformed optional fields do not invalidate otherwise recoverable `text`.

The minimal guard does not prove that `source` and `text` describe the same
semantics, nor does it authenticate a record. Page scripts cannot directly
access extension storage, but code changes and manual extension debugging can
still create inconsistent records. On such a record, `text` controls form
recovery while a qualifying `source` controls restored Markdown and the
manager's **Copy Markdown** output.

### Write path and decision order

Only Rich and Markdown modes autosave. An edit restarts an 800 ms timer; after
that pause, `saveDraftNow()` runs this sequence:

1. Cancel the pending autosave timer so the same edit does not leave a second
   scheduled write behind this attempt.
2. Return unless the editor has reached `rich` or `markdown`. This rejects
   Plain mode, a disabled editor, and page exit racing initialization; those
   states must not create `mode: null` records.
3. Synchronously flush a dirty editor into `JournalText`. Classification then
   sees the bracket representation a postback would submit, not stale private
   editor state.
4. Decide whether the flushed report contains recoverable content. Empty and
   generated-credit-only reports remove the matching key instead of writing.
5. Build `{ text, mode, savedAt }`, add exact Markdown `source` only in
   Markdown mode, and best-effort add `label`.
6. Replace the one value at the form key with `storage.local.set()` and show
   the device-local saved timestamp after that promise resolves.

A `pagehide` handler also synchronously flushes and starts a best-effort
`saveDraftNow()`. Storage failure is deliberately non-blocking because the live
form value still belongs to Peakbagger; the UI does not claim success unless
the write resolves.

Plain mode edits `JournalText` directly and deliberately does not write, update,
or remove a TR draft. It therefore has the native textarea's recovery risks,
and a draft previously written in Rich or Markdown mode can remain unchanged
while the user continues in Plain mode.

### What counts as no recoverable report

An empty editor is a deletion, not a zero-byte recovery snapshot. The writer
removes the matching key and clears its saved-status text when either condition
holds:

- `JournalText` contains only spaces, tabs, CR/LF line endings, or other source
  whitespace after the active editor flushes; or
- the canonical bracket document contains only the optional generated credit,
  with surrounding blank space or newlines.

The credit test does not duplicate the credit sentence, markup, browser store
URL, or a regular expression. At runtime the editor derives ignored canonical
documents from the same `REPORT_CREDIT` value it inserts. It records the raw
bracket form, the actual bracket → Markdown → bracket form, and, when a seeded
credit enters an editor, the real Rich or Markdown serialization. Those forms
matter because equivalent editor documents need not be byte-identical: TipTap
can split nested marks around a link, while Markdown can use safe inline HTML
for the `small` element.

Candidate bracket source is parsed into the allowlisted AST and serialized back
to canonical bracket markup. That removes insignificant outer whitespace and
editor spelling differences before comparison. A report with any user content
in addition to the credit remains recoverable and is stored normally. If
parsing unexpectedly throws, the writer fails toward data retention and saves
non-whitespace source; uncertainty must not delete the only local recovery
copy.

No credit marker or boolean is persisted. This is a write-time policy over
runtime-derived representations, not an installation migration that scans and
rewrites every historical draft.

### Recovery on form load

The editor reads only the key for the current climber and form; it does not scan
other drafts before deciding whether to offer recovery. It ignores a missing or
structurally unusable record, removes one older than 14 days, and removes a
whitespace-only stored `text`. It compares the remainder with Peakbagger's
server-rendered `JournalText` after normalizing CRLF/CR line endings to LF and
trimming both values.

- If the values match, no recovery prompt appears. For a Markdown draft, the
  exact `source` sidecar is adopted so a postback does not needlessly rewrite
  the user's Markdown spelling.
- If the values differ, the editor offers **Restore draft**, **Delete draft**,
  and **Manage drafts**. It never applies a differing draft silently.
- Restoring replaces `JournalText`, restores the recorded mode when valid, and
  reuses the exact Markdown sidecar when present. Opening a row from the manager
  returns to this same recovery gate; the manager cannot bypass it.

Restore is intentionally not an immediate storage write. The record remains
the recovery source until a later edit/autosave, explicit deletion, or
Peakbagger Save clearing. The server copy is never overwritten merely because a
draft exists or because the manager's **Open** link was used.

### Retention and management

The nominal TTL is 14 days and the nominal global target is 30 drafts, newest
first. These are lazy cleanup rules, not timers or a hard write-time quota:

- Opening an editor removes expired records and prunes fresh records after the
  newest 30, oldest first. It preserves the current form's key even when that
  key falls in the excess set, so storage can temporarily contain 31 valid
  records rather than delete the report currently being edited.
- Opening Settings → **Trip report drafts** removes expired records, but does not enforce
  the 30-record target. A newly written 31st draft can therefore remain until a
  later editor initialization performs pruning.

These are lazy cleanup rules. There is no expiry timer, write-time quota, or
background sweep, so expired or excess records can physically remain until an
editor or the manager next performs the relevant cleanup.

The manager reads all local storage but renders only parseable draft keys with
minimally valid records, newest first:

- title uses bounded `label.peak` and `label.date`, then a key-derived fallback;
- the mode badge says Markdown only for `mode === "markdown"`; historical
  records without that exact value follow the Rich-compatible fallback path;
- the excerpt uses exact Markdown `source` when qualified, otherwise converts
  bracket `text` to Markdown, collapses whitespace, and caps display at 160
  characters;
- **Copy Markdown** uses the same exact-source-or-convert rule;
- **Open** reconstructs the form URL, but the destination editor's normal
  compare-and-offer gate still owns Restore.

Deleting one or all drafts removes storage immediately and holds copies only in
the open manager page for a six-second Undo window. Live `storage.onChanged`
refreshes preserve an active Undo row. If the window closes without Undo, or
the manager itself closes, those in-memory copies are no longer recoverable
through the extension.

### Clearing at Peakbagger Save

The intended boundary is that clicking either Peakbagger **Save Ascent** button
flushes `JournalText` and clears the matching TR draft; the extension never
clicks Save itself. Removal happens before Peakbagger confirms success. If the
server rejects the save, the posted report may round-trip in Peakbagger's form,
but the local draft has already been scheduled for removal.

The current implementation does not fully guarantee that intended boundary:

- Draft clearing is attached to clicks on `SaveButton` and `SaveButton2`, not
  to every form-submit path. A submit without either click does not clear it.
- A successful Save navigation also reaches the general `pagehide` handler.
  There is no terminal "saving" state, so its asynchronous `saveDraftNow()` can
  race with, or follow, the earlier asynchronous removal and recreate the
  non-empty draft.

Treat those as current implementation risks, not desired product behavior. A
future fix needs a terminal Save state and a regression test covering the real
click → submit → pagehide sequence before this section can claim that every
successful Save reliably clears its draft.

### Reviewer questions this design must keep answering

- **Can Rich HTML enter storage?** No. A dirty Rich document must pass through
  `domToBracket()` before `text` is built; `getHTML()` and ProseMirror JSON are
  never draft fields.
- **Can Markdown be reconstructed exactly from `text`?** No. Exact spelling is
  available only from qualifying `source`; conversion promises supported
  semantics, not byte identity.
- **Can an empty or generated-credit-only page create a timestamped row?** No.
  The post-flush decision removes the key in Rich and Markdown, including after
  real content is deleted back to only credit.
- **Can a disabled, Plain, or not-yet-initialized editor write?** No. Only the
  two initialized autosave modes cross the write boundary.
- **Can display metadata retarget a draft?** No. Only the parsed key controls
  the Open URL and recovery lookup; `label` is presentation-only.
- **Can the manager silently apply a draft?** No. It can navigate, copy, and
  delete; the destination editor owns explicit Restore.
- **Does `storage.local` mean permanent or synced?** No. It is profile-local,
  subject to browser and extension storage lifecycle, and bounded only by lazy
  application cleanup.
- **Does one key mean one editing tab?** No. It means one climber/form target;
  same-target tabs are last-writer-wins.

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

- Existing tests pin unsupported-markup neutralization after an edit, but there
  is no parser diagnostic or mode-level guardrail for a lossy import. A future
  guardrail must distinguish actual dropped or neutralized source from allowed
  canonical normalization.
- `test/reports/report-markup.test.mjs` pins Markdown tokens, bracket aliases, DOM
  import, canonical output, unsafe-input neutralization, raw color validation,
  TipTap color-token revalidation, and round trips.
- `test/reports/report-editor.test.mjs` pins the native-textarea source of truth,
  untouched-value preservation, expanded rich DOM, toolbar active states,
  image-source validation, hex-color preservation after Rich and Markdown
  edits, undo isolation across mode switches, mode switching (including
  invalidation of stale Markdown source after a Plain edit), local drafts,
  whitespace-only and runtime-derived credit-only suppression, deletion back
  to credit-only in both editors, disabled-editor write rejection, and
  pre-postback flushing. It drives the TipTap and CodeMirror instances through
  the mount's test handle.
- `test/reports/report-drafts.test.mjs` pins key construction/parsing, edit URLs,
  compatibility record validation, fallback titles, and expiry arithmetic.
- `test/options/options.test.mjs` pins manager ordering, labels, exact Markdown copy
  versus bracket conversion, expiry cleanup, live refresh, and reversible
  single/bulk deletion.
- `test/project/manifest-capture.test.mjs` pins the vendored parser before the converter
  and editor in the real content-script list.
- `npm run verify:browsers` loads the unpacked extension in hidden Chrome and
  Firefox and exercises each store-specific credit, real typing, Ctrl/Cmd+B,
  the `1. ` input rule in Chrome, live
  toolbar states, the CodeMirror source pane with its live split preview,
  hex-color preservation across Rich and Markdown, toolbar table insertion and
  growth, and draft restoration against the masked ascent form fixture.

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
