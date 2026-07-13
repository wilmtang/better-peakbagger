// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — site-wide dark theme, as stylesheet *text*.
// This is deliberately a JS string rather than a .css file: src/theme.js
// injects it as a <style> synchronously at document_start (the way Dark Reader
// does), which a manifest `css` entry cannot guarantee before first paint. See
// docs/dark-mode-flash.md. Loaded as an isolated-world content script ahead of
// theme.js; idempotent.
//
// Every rule is scoped under html[data-bpb-theme="dark"], which src/theme.js
// toggles from the extension settings, so the injected sheet is inert until
// that attribute is "dark". Peakbagger's native palette (pb.css): white/wallpaper
// body, navy links, purple visited, maroon h1, navy h2, light-gray table.gray
// borders, Tahoma. Images and the map iframe are left untouched.

(() => {
    if (window.BPBDarkCSS) return;
    window.BPBDarkCSS = `
html[data-bpb-theme="dark"] {
    color-scheme: dark;
    background: #181a1b !important;
}

html[data-bpb-theme="dark"] body {
    background: #181a1b !important;      /* overrides the mewallp.gif wallpaper */
    background-image: none !important;
    color: #c7c1b8 !important;
}

/* Links (navy / purple -> readable on dark) */
html[data-bpb-theme="dark"] a,
html[data-bpb-theme="dark"] a:link { color: #7ab6ff !important; }
html[data-bpb-theme="dark"] a:visited { color: #c39bf0 !important; }
html[data-bpb-theme="dark"] a:hover { color: #9ecbff !important; }

/* Peakbagger uses inline navy for help and hint copy on form pages. Preserve
   that hierarchy with a muted steel blue: distinct from warm body text, but
   less link-like than the saturated blue above. Match at a property boundary
   so a navy background does not get mistaken for navy text. */
html[data-bpb-theme="dark"] [style^="color:navy" i],
html[data-bpb-theme="dark"] [style^="color: navy" i],
html[data-bpb-theme="dark"] [style*=";color:navy" i],
html[data-bpb-theme="dark"] [style*=";color: navy" i],
html[data-bpb-theme="dark"] [style*="; color:navy" i],
html[data-bpb-theme="dark"] [style*="; color: navy" i] { color: #94adc5 !important; }

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

/* Small section and metric labels on climber pages carry maroon inline. Map
   the same legacy semantic color to the dark-theme h1 red. As with navy above,
   property boundaries avoid treating a maroon background as maroon text. */
html[data-bpb-theme="dark"] [style^="color:maroon" i],
html[data-bpb-theme="dark"] [style^="color: maroon" i],
html[data-bpb-theme="dark"] [style*=";color:maroon" i],
html[data-bpb-theme="dark"] [style*=";color: maroon" i],
html[data-bpb-theme="dark"] [style*="; color:maroon" i],
html[data-bpb-theme="dark"] [style*="; color: maroon" i] { color: #e79a9a !important; }

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

/* Form controls */
html[data-bpb-theme="dark"] input,
html[data-bpb-theme="dark"] select,
html[data-bpb-theme="dark"] textarea,
html[data-bpb-theme="dark"] button {
    background: #2b2f34 !important;
    color: #e6e1d8 !important;
    border: 1px solid #4a5058 !important;
}
html[data-bpb-theme="dark"] input::placeholder,
html[data-bpb-theme="dark"] textarea::placeholder { color: #9c968c !important; }

/* --- Ascent Beta Filter bar (higher specificity than its own #pbaf-bar rules) --- */
html[data-bpb-theme="dark"] #pbaf-bar {
    background: #23262a !important;
    border-color: #3a3f45 !important;
    color: #c7c1b8 !important;
    box-shadow: none !important;
}
html[data-bpb-theme="dark"] .pbaf-label { color: #9c968c !important; }
html[data-bpb-theme="dark"] .pbaf-divider { background: #3a3f45 !important; }
html[data-bpb-theme="dark"] .pbaf-chip {
    background: #2b2f34 !important;
    border-color: #4a5058 !important;
    color: #d7d2c9 !important;
}
html[data-bpb-theme="dark"] .pbaf-chip:hover { border-color: #69b58a !important; color: #8fdcae !important; }
html[data-bpb-theme="dark"] .pbaf-chip[aria-pressed="true"] {
    background: #2f6b3f !important;
    border-color: #3f8a54 !important;
    color: #ffffff !important;
}
html[data-bpb-theme="dark"] .pbaf-chip .pbaf-count { color: #a29c92 !important; }
html[data-bpb-theme="dark"] .pbaf-chip[aria-pressed="true"] .pbaf-count { color: #c9e8d4 !important; }
html[data-bpb-theme="dark"] .pbaf-words { color: #b6b0a6 !important; }
html[data-bpb-theme="dark"] .pbaf-words input {
    background: #2b2f34 !important;
    color: #e6e1d8 !important;
    border-color: #4a5058 !important;
}
html[data-bpb-theme="dark"] .pbaf-status { color: #b6b0a6 !important; }
html[data-bpb-theme="dark"] .pbaf-status b { color: #f0ece4 !important; }
html[data-bpb-theme="dark"] .pbaf-reset { color: #a29c92 !important; }
html[data-bpb-theme="dark"] .pbaf-reset:hover { color: #8fdcae !important; }
html[data-bpb-theme="dark"] .pbaf-note { color: #b6b0a6 !important; }
html[data-bpb-theme="dark"] .pbaf-note a { color: #8fdcae !important; }
`;
})();
