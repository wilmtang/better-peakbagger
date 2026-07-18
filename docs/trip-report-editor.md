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

## One converter, two editing surfaces

The converter is the heart of the feature, and it is deliberately
editor-agnostic. The extension installs through npm and packages
[Marked 18.0.6](https://github.com/markedjs/marked/tree/v18.0.6), a small
MIT-licensed GFM parser. Better Peakbagger consumes Marked's token tree and maps
only known token types into its own allowlisted AST. It **never uses Marked's
HTML renderer** and never inserts arbitrary Markdown HTML. This keeps the rich
view, Markdown preview, bracket import, pasted DOM, and saved value on one
conversion path:

```text
Markdown ── Marked tokens ──┐
                            ├── allowlisted report AST ──┬── safe preview/editor HTML
bracket markup ── safe DOM ─┘                            ├── Peakbagger bracket markup
rich editor DOM ─────────────────────────────────────────┘── Markdown
```

The *input surfaces* on top of that path are established open-source editors,
adopted after the first release:

- **Rich mode is a [TipTap](https://tiptap.dev) (ProseMirror) editor**
  (`src/report-rich-editor.js`). Its schema is locked to exactly the
  allowlisted node and mark set — including small custom marks for
  Peakbagger's `[small]` and `[q]` — so nothing typed, pasted, or dropped can
  enter the document unless the converter has a bracket equivalent for it.
  The model provides what `document.execCommand` never could: reliable undo
  and IME handling, markdown-style input rules (`**bold**`, `# `, `1. ` as
  you type), toolbar active states, and real table editing.
- **Markdown mode is a [CodeMirror 6](https://codemirror.net) source pane**
  (`src/report-md-editor.js`) beside a live preview. CodeMirror contributes
  GFM syntax highlighting, list continuation on Enter, and history; it renders
  nothing. The preview is produced by this extension's own converter, so what
  it shows is exactly what will be saved.

An earlier revision of this document rejected editor frameworks because they
"would not remove the hard part": the Peakbagger-specific, security-aware
serializer. That was true, and it is why the serializer was built first,
standalone. With the converter in place the calculus reversed — the frameworks
now slot in as input surfaces only, the schema enforcement *adds* a safety
layer on top of serialization-time sanitizing, and the added bundle weight
(the editor bundle is ~1 MB minified, loaded only on the ascent add/edit
form) was judged acceptable for the editing quality. Neither library ever
parses or renders the saved report: TipTap documents are serialized through
`domToBracket`, CodeMirror text through the Marked pipeline, and every href,
image source, color, and dimension is still validated by the converter on the
way out.

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

- `test/report-markup.test.mjs` pins Markdown tokens, bracket aliases, DOM
  import, canonical output, unsafe-input neutralization, and round trips.
- `test/report-editor.test.mjs` pins the native-textarea source of truth,
  untouched-value preservation, expanded rich DOM, toolbar active states,
  image-source validation, undo isolation across mode switches, mode
  switching, local drafts, and pre-postback flushing, driving the TipTap and
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
