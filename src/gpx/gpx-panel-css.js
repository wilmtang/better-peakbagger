// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the GPX Analyzer panel's theme, as stylesheet text.
//
// The panel used to be themed by a JS PALETTES table applied as inline styles
// by applyPanelTheme(), while the floating 3D toggle sitting on the same map
// was themed by `data-theme` + src/terrain/terrain-map.css. Two theming systems
// on one surface. This is the one system: light values and their dark
// counterparts declared together as `--bpb-gpx-*` tokens, reassigned under the
// same `data-theme="dark"` attribute the toggle already uses.
//
// Stylesheet-as-a-JS-string rather than a manifest `css` entry, following
// src/theme/site-dark-css.js and src/ascent/ascent-filter.js: the analyzer's
// manifest entry runs in the MAIN world, and this keeps the panel's theme
// arriving with the code that builds the panel.
//
// The Chart.js colors are deliberately *not* here. Chart.js takes color values
// as JS options, not CSS, so a small palette survives in gpx-analyzer.js for
// exactly that — a genuine need for JS values, not a second copy of this one.

export const gpxPanelCss = `
#bpb-gpx-analysis {
    --bpb-gpx-panel-bg: #fafafa;
    --bpb-gpx-panel-border: #cccccc;
    --bpb-gpx-input-bg: #ffffff;
    --bpb-gpx-input-border: #cccccc;
    --bpb-gpx-text: #000000;
    --bpb-gpx-sub: #444444;
    --bpb-gpx-muted: #777777;
    --bpb-gpx-faint: #888888;
}
#bpb-gpx-analysis[data-theme="dark"] {
    --bpb-gpx-panel-bg: #23262a;
    --bpb-gpx-panel-border: #3a3f45;
    --bpb-gpx-input-bg: #2b2f34;
    --bpb-gpx-input-border: #4a5058;
    --bpb-gpx-text: #e6e1d8;
    --bpb-gpx-sub: #b6b0a6;
    --bpb-gpx-muted: #9a948a;
    --bpb-gpx-faint: #8b857c;
}

#bpb-gpx-analysis {
    color: var(--bpb-gpx-text);
    background: var(--bpb-gpx-panel-bg);
    border-color: var(--bpb-gpx-panel-border);
}
#bpb-gpx-analysis .bpb-gpx-stats { color: var(--bpb-gpx-text); }
#bpb-gpx-analysis .bpb-gpx-substats { color: var(--bpb-gpx-sub); }
#bpb-gpx-analysis .bpb-gpx-hint { color: var(--bpb-gpx-faint); }
#bpb-gpx-analysis .bpb-gpx-control-label { color: var(--bpb-gpx-sub); }
#bpb-gpx-analysis #bpb-gpx-units {
    color: var(--bpb-gpx-text);
    background: var(--bpb-gpx-input-bg);
    border-color: var(--bpb-gpx-input-border);
}
#bpb-gpx-analysis input[type="color"] {
    background: var(--bpb-gpx-input-bg);
    border-color: var(--bpb-gpx-input-border);
}
`;
