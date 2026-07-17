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

## Why a Markdown parser, not a new editor framework

The first editor used a hand-written inline Markdown parser and represented
only paragraphs, bold, italic, underline, links, and visual list-like lines.
That model was the limiting factor. Peakbagger itself renders semantic
headings, quotes, lists, tables, code, images, and more.

Replacing `contenteditable` with ProseMirror, TipTap, Quill, or another editor
framework would not remove the hard part: every document would still need a
Peakbagger-specific, security-aware serializer. It would also add a second
document model and a much larger runtime to a build-free extension.

The extension instead vendors
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
bold, italic, underline, strikethrough, link, both list types, and horizontal
rule. Existing tables and images are preserved in rich mode and can be removed;
Markdown is the clearer insertion surface for those less frequent structures.

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

## Preview fidelity

Preview shows the exact semantic structure the converter will save, with the
extension's compact editor styles. Peakbagger's report page owns the final
colors, heading alignment, font sizes, and margins, so the preview intentionally
does not claim pixel-for-pixel fidelity with that legacy stylesheet. Plain mode
always shows the exact bracket source.

## Regression boundaries

- `test/report-markup.test.mjs` pins Markdown tokens, bracket aliases, DOM
  import, canonical output, unsafe-input neutralization, and round trips.
- `test/report-editor.test.mjs` pins the native-textarea source of truth,
  untouched-value preservation, expanded rich DOM, mode switching, local
  drafts, and pre-postback flushing.
- `test/manifest-capture.test.mjs` pins the vendored parser before the converter
  and editor in the real content-script list.
- `npm run verify:extension` loads the unpacked extension in hidden Chrome for
  Testing and exercises real typing, formatting, Markdown conversion/preview,
  expanded semantic blocks, and draft restoration against the masked ascent
  form fixture.
