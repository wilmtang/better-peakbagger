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
    --bpb-gpx-accent: #1769aa;
    --bpb-gpx-success: #1d6f42;
    --bpb-gpx-error: #a51d16;
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
    --bpb-gpx-accent: #79b8ff;
    --bpb-gpx-success: #8bd3a8;
    --bpb-gpx-error: #ffb4ab;
}

#bpb-gpx-analysis {
    color: var(--bpb-gpx-text);
    background: var(--bpb-gpx-panel-bg);
    border-color: var(--bpb-gpx-panel-border);
}
#bpb-route-explorer {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    gap: 10px 12px;
    inline-size: 100%;
    max-inline-size: 1500px;
    min-inline-size: 0;
    margin: 15px auto 0;
}
#bpb-route-explorer > .bpb-route-explorer__map-column {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    align-items: center;
    max-inline-size: 100%;
    min-inline-size: 0;
}
#bpb-route-explorer[data-layout="side"] > .bpb-route-explorer__map-column {
    position: sticky;
    inset-block-start: 8px;
}
#bpb-route-explorer[data-layout="stacked"] > .bpb-route-explorer__map-column {
    margin-inline: auto;
}
#bpb-route-explorer[data-layout="side"] > .bpb-route-explorer__map-column > #bpb-map-viewport {
    max-block-size: calc(100vh - 16px) !important;
}
#bpb-route-explorer .bpb-route-explorer__map-details {
    inline-size: 100%;
    min-inline-size: 0;
    margin-block-start: 0.4rem;
    text-align: center;
}
#bpb-route-explorer > #bpb-gpx-analysis {
    flex: 1 1 400px;
    box-sizing: border-box;
    container: bpb-route-analysis / inline-size;
    inline-size: auto;
    min-inline-size: min(400px, 100%);
    max-inline-size: none !important;
    margin-block-start: 0 !important;
}
@container bpb-route-analysis (max-width: 680px) {
    #bpb-route-explorer .bpb-sun-calculator__toggle {
        grid-template-columns: auto minmax(0, 1fr) auto;
        grid-template-rows: 1.6rem 2.7rem;
        block-size: 6.35rem;
    }
    #bpb-route-explorer .bpb-sun-calculator__summary {
        grid-column: 1 / -1;
        grid-row: 2;
        text-align: start;
    }
    #bpb-route-explorer .bpb-sun-calculator__chevron {
        grid-column: 3;
        grid-row: 1;
    }
    #bpb-route-explorer .bpb-sun-calculator__panel {
        block-size: calc(39.95rem + 1px);
    }
    #bpb-route-explorer .bpb-sun-calculator__layout {
        grid-template-columns: 1fr;
        grid-template-rows: 13.05rem 23.05rem;
        row-gap: 1.25rem;
        block-size: 37.35rem;
    }
    #bpb-route-explorer .bpb-sun-calculator__reading {
        grid-template-columns: minmax(8rem, 0.85fr) minmax(8.5rem, 1.15fr);
    }
}
@container bpb-route-analysis (max-width: 440px) {
    #bpb-route-explorer .bpb-sun-calculator__panel {
        block-size: calc(45.65rem + 1px);
        padding: 1rem 0.8rem 1.1rem;
    }
    #bpb-route-explorer .bpb-sun-calculator__layout {
        grid-template-rows: 13.05rem 29.25rem;
        block-size: 43.55rem;
    }
    #bpb-route-explorer .bpb-sun-calculator__reading {
        grid-template-columns: 1fr;
        grid-template-rows: 10rem 10.95rem 2.7rem 3.35rem;
        block-size: 29.25rem;
    }
    #bpb-route-explorer .bpb-sun-calculator__facts {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-template-rows: 3.4rem 6.4rem;
        block-size: 10.95rem;
        inline-size: 100%;
    }
    #bpb-route-explorer .bpb-sun-calculator__moon { grid-column: 1 / -1; }
    #bpb-route-explorer .bpb-sun-calculator__compass { inline-size: min(10rem, 70%); }
}
#bpb-gpx-analysis .bpb-gpx-stats { color: var(--bpb-gpx-text); }
#bpb-gpx-analysis .bpb-gpx-stats[data-state="error"] { color: var(--bpb-gpx-error); }
#bpb-gpx-analysis .bpb-gpx-substats { color: var(--bpb-gpx-sub); }
#bpb-gpx-analysis .bpb-gpx-hint { color: var(--bpb-gpx-faint); }
#bpb-gpx-analysis .bpb-gpx-hint[data-state="success"] {
    color: var(--bpb-gpx-success);
    font-weight: 700;
}
#bpb-gpx-analysis .bpb-gpx-hint[data-state="error"] {
    color: var(--bpb-gpx-error);
    font-weight: 700;
}
#bpb-gpx-analysis .bpb-gpx-control-label { color: var(--bpb-gpx-sub); }
#bpb-gpx-analysis .bpb-gpx-controls[hidden],
#bpb-gpx-analysis .bpb-gpx-coordinate-controls[hidden] { display: none !important; }
#bpb-gpx-analysis #bpb-gpx-units {
    color: var(--bpb-gpx-text);
    background: var(--bpb-gpx-input-bg);
    border-color: var(--bpb-gpx-input-border);
}
#bpb-gpx-analysis input[type="color"] {
    background: var(--bpb-gpx-input-bg);
    border-color: var(--bpb-gpx-input-border);
}
#bpb-gpx-analysis .bpb-gpx-coordinate-controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-start;
    align-items: center;
    gap: 5px 8px;
    margin: 0 0 8px;
}
#bpb-gpx-analysis .bpb-gpx-copy-coordinates {
    appearance: none;
    color: var(--bpb-gpx-text);
    background: var(--bpb-gpx-input-bg);
    border: 1px solid var(--bpb-gpx-input-border);
    border-radius: 5px;
    padding: 3px 7px;
    font: inherit;
    font-size: 0.8em;
    cursor: pointer;
}
#bpb-gpx-analysis .bpb-gpx-retry {
    appearance: none;
    margin-top: 8px;
    color: var(--bpb-gpx-text);
    background: var(--bpb-gpx-input-bg);
    border: 1px solid var(--bpb-gpx-input-border);
    border-radius: 5px;
    padding: 4px 9px;
    font: inherit;
    font-family: sans-serif;
    cursor: pointer;
}
#bpb-gpx-analysis .bpb-gpx-retry:hover { border-color: var(--bpb-gpx-accent); }
#bpb-gpx-analysis .bpb-gpx-retry:focus-visible {
    outline: 3px solid var(--bpb-gpx-accent);
    outline-offset: 2px;
}
#bpb-gpx-analysis .bpb-gpx-copy-coordinates:hover:not(:disabled) {
    border-color: var(--bpb-gpx-accent);
}
#bpb-gpx-analysis .bpb-gpx-copy-coordinates:disabled {
    cursor: default;
    opacity: 0.55;
}
#bpb-gpx-analysis .bpb-gpx-copy-coordinates:focus-visible,
#bpb-gpx-analysis .bpb-gpx-chart-legend button:focus-visible,
#bpb-gpx-analysis canvas:focus-visible,
#bpb-gpx-analysis .bpb-gpx-coordinate-fallback:focus-visible {
    outline: 3px solid var(--bpb-gpx-accent);
    outline-offset: 2px;
}
#bpb-gpx-analysis .bpb-gpx-chart-legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
    margin: 0 0 5px;
    font-family: sans-serif;
}
#bpb-gpx-analysis .bpb-gpx-chart-legend[hidden] { display: none; }
#bpb-gpx-analysis .bpb-gpx-chart-legend button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    appearance: none;
    color: var(--bpb-gpx-text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 4px 8px;
    font: inherit;
    font-size: 0.8em;
    cursor: pointer;
}
#bpb-gpx-analysis .bpb-gpx-chart-legend button:hover {
    border-color: var(--bpb-gpx-input-border);
}
#bpb-gpx-analysis .bpb-gpx-chart-legend button[aria-pressed="false"] {
    color: var(--bpb-gpx-muted);
    text-decoration: line-through;
    opacity: 0.72;
}
#bpb-gpx-analysis .bpb-gpx-legend-swatch {
    width: 9px;
    height: 9px;
    border: 1px solid var(--bpb-gpx-panel-bg);
    border-radius: 50%;
    box-shadow: 0 0 0 1px currentColor;
}
#bpb-gpx-analysis .bpb-gpx-coordinate-controls .bpb-gpx-hint {
    flex: 1 1 300px;
    text-align: left;
}
#bpb-gpx-analysis .bpb-gpx-coordinate-fallback {
    box-sizing: border-box;
    flex: 1 0 100%;
    min-width: 0;
    color: var(--bpb-gpx-text);
    background: var(--bpb-gpx-input-bg);
    border: 1px solid var(--bpb-gpx-input-border);
    border-radius: 5px;
    padding: 4px 6px;
    font: inherit;
    font-size: 0.8em;
}

@media (max-width: 600px) {
    #bpb-gpx-analysis .bpb-gpx-controls {
        justify-content: flex-start !important;
    }
    #bpb-gpx-analysis .bpb-gpx-chart-legend {
        justify-content: flex-start;
    }
}
`;
