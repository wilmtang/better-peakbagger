// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — site-wide dark theme, as stylesheet *text*.
// This is deliberately a JS string rather than a .css file: src/theme/theme.js
// injects it as a <style> synchronously at document_start (the way Dark Reader
// does), which a manifest `css` entry cannot guarantee before first paint. See
// docs/dark-mode-flash.md. Imported by theme.js into the isolated-world theme
// bundle.
//
// Every rule is scoped under html[data-bpb-theme="dark"], which src/theme/theme.js
// toggles from the extension settings, so the injected sheet is inert until
// that attribute is "dark". Peakbagger's native palette (pb.css): white/wallpaper
// body, navy links, purple visited, maroon h1, navy h2, light-gray table.gray
// borders, Tahoma. Images and the map iframe are left untouched.

export const darkCss = `
html[data-bpb-theme="dark"] {
    color-scheme: dark;
    background: #181a1b !important;
}

html[data-bpb-theme="dark"] body {
    position: relative;
    z-index: 0;
    background-color: #181a1b !important;
    background-image: none !important;
    color: #c7c1b8 !important;
}

/* Keep Peakbagger's mountain wallpaper as a quiet part of the site's identity.
   The source GIF is an opaque white tile, so render a filtered copy behind all
   page content: white becomes black (invisible with screen blending) while its
   pale contour lines become a restrained highlight over the unchanged dark
   base. The low opacity keeps the motif subordinate to text. */
html[data-bpb-theme="dark"] body::before {
    content: "";
    position: absolute;
    z-index: -1;
    inset: 0;
    background-image: url("/image/mewallp.gif");
    background-repeat: repeat;
    filter: invert(1) brightness(4);
    mix-blend-mode: screen;
    opacity: 0.1;
    pointer-events: none;
}

/* Links (navy / purple -> readable on dark) */
html[data-bpb-theme="dark"] a,
html[data-bpb-theme="dark"] a:link { color: #7ab6ff !important; }
html[data-bpb-theme="dark"] a:visited { color: #c39bf0 !important; }
html[data-bpb-theme="dark"] a:hover { color: #9ecbff !important; }

/* The header banner sits on the untouched header.jpg photo (a light image).
   Its title + nav links are inline color:black in the native markup; keep them
   dark so they stay legible on the photo, instead of the light-on-dark link
   colors used everywhere else — those wash out over the light banner. The
   :link/:visited/:hover selectors outrank the generic link rules above. */
html[data-bpb-theme="dark"] .mainbanner a:link,
html[data-bpb-theme="dark"] .mainbanner a:visited,
html[data-bpb-theme="dark"] .mainbanner a:hover,
html[data-bpb-theme="dark"] .mainmenu a:link,
html[data-bpb-theme="dark"] .mainmenu a:visited,
html[data-bpb-theme="dark"] .mainmenu a:hover { color: #000 !important; }

/* Headings (maroon h1 / navy h2) */
html[data-bpb-theme="dark"] h1 { color: #e79a9a !important; }
html[data-bpb-theme="dark"] h2 { color: #8fb8ff !important; }
html[data-bpb-theme="dark"] h3,
html[data-bpb-theme="dark"] h4 { color: #e6e1d8 !important; }

/* Data tables */
html[data-bpb-theme="dark"] table.gray {
    border-color: #3a3f45 !important;
    background: #202224 !important;
}
html[data-bpb-theme="dark"] table.gray td,
html[data-bpb-theme="dark"] table.gray th {
    border-color: #3a3f45 !important;
}
html[data-bpb-theme="dark"] th { color: #e6e1d8 !important; }
html[data-bpb-theme="dark"] hr { border-color: #3a3f45 !important; }

/* Light backgrounds set via legacy bgcolor / inline styles */
html[data-bpb-theme="dark"] [bgcolor="#FFFFFF"],
html[data-bpb-theme="dark"] [bgcolor="#ffffff"],
html[data-bpb-theme="dark"] [bgcolor="white"],
html[data-bpb-theme="dark"] [bgcolor="#FFFFCC"],
html[data-bpb-theme="dark"] [bgcolor="#ffffcc"],
html[data-bpb-theme="dark"] [bgcolor="#EEEEEE"],
html[data-bpb-theme="dark"] [bgcolor="#eeeeee"],
html[data-bpb-theme="dark"] [bgcolor="#F0F0F0"],
html[data-bpb-theme="dark"] [bgcolor="#f0f0f0"] {
    background-color: #202224 !important;
    color: #c7c1b8 !important;
}

/* Form controls. This is a blanket repaint of Peakbagger's own markup, so
   extension-owned controls that carry their own theme opt out: report-editor
   color swatches are semantic samples whose backgrounds and borders must stay
   intact, and .pbaf-control marks the Ascent Beta Filter's controls, whose
   complete light+dark theme lives in src/ascent/ascent-filter.js. */
html[data-bpb-theme="dark"] input:not(.pbaf-control),
html[data-bpb-theme="dark"] select,
html[data-bpb-theme="dark"] textarea,
html[data-bpb-theme="dark"] button:not(.bpb-re-swatch):not(.pbaf-control) {
    background: #2b2f34 !important;
    color: #e6e1d8 !important;
    border: 1px solid #4a5058 !important;
}
html[data-bpb-theme="dark"] input::placeholder,
html[data-bpb-theme="dark"] textarea::placeholder { color: #9c968c !important; }

/* Dynamic inline colors. theme.js parses Peakbagger's literal color and
   background declarations, maps them into the dark palette, and writes only
   these extension-owned variables/markers. The source inline style remains
   untouched, so light mode and later site mutations keep their original
   values. Header-photo and extension-owned surfaces are deliberately skipped
   by that applier. */
html[data-bpb-theme="dark"] [data-bpb-dark-inline-color] {
    color: var(--bpb-dark-inline-color) !important;
}
html[data-bpb-theme="dark"] [data-bpb-dark-inline-bg] {
    background-color: var(--bpb-dark-inline-bg) !important;
}

/* The Ascent Beta Filter bar is deliberately absent here. Its theme — light
   values and their dark counterparts — is owned entirely by the STYLE block in
   src/ascent/ascent-filter.js, so a new control cannot ship with a light value
   and no dark one. Do not reintroduce .pbaf-* rules in this file. */
`;
