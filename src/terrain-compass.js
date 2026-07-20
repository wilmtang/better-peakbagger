// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — page-world 3D-map compass overlay.
//
// A Google-Maps-style compass that floats just above the host page's floating
// 2D/3D toggle (NOT inside the extension frame — the in-frame control stack is
// deliberately compass-free so its height matches the 2D zoom stack, which the
// toggle alignment depends on). Clicking it snaps the 3D view back to north-up,
// looking straight down. The bearing/pitch it displays are streamed from the
// frame through the bridge; the reset command travels back the same way.
//
// This module owns only the button and its rotation; the coordinators
// (big-map.js, peak-map.js) own visibility, positioning cadence, and theme.

// north half red, south half neutral — rotated as a whole by update(). The red
// is a compass red, deliberately not the shared route color.
const NEEDLE_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">'
    + '<polygon points="12,3 8.5,12 15.5,12" fill="#ea4335"></polygon>'
    + '<polygon points="12,21 8.5,12 15.5,12" fill="#8a8a82"></polygon>'
    + '</svg>';

const create = ({ container, toggle, onReset }) => {
    const button = document.createElement('button');
    button.id = 'bpb-terrain-compass';
    button.className = 'bpb-map-compass';
    button.type = 'button';
    button.hidden = true;
    button.setAttribute('aria-label', 'Reset the view to north, looking straight down');
    button.title = 'Reset to north';

    const disc = document.createElement('span');
    disc.className = 'bpb-map-compass-disc';
    disc.setAttribute('aria-hidden', 'true');
    disc.innerHTML = NEEDLE_SVG;
    button.append(disc);

    // A reset only eases the extension's own 3D camera back to north-up — no
    // feature gate, no data — so unlike the consent dialog it needs no
    // trusted-event guard.
    if (typeof onReset === 'function') button.addEventListener('click', () => onReset());
    (container || document.body).append(button);

    const setVisible = visible => { button.hidden = !visible; };

    // The transform encodes live camera state, so it is always applied; only the
    // CSS transition between states honors prefers-reduced-motion (in the sheet).
    const update = (bearing, pitch) => {
        disc.style.transform = `rotateX(${pitch}deg) rotateZ(${-bearing}deg)`;
    };

    // Sit one gap above the toggle, sharing its right inset (from CSS). Reads the
    // toggle's resolved bottom so it tracks both the measured-navTop position and
    // the CSS fallback.
    const position = () => {
        if (!toggle) return;
        const toggleBottom = parseFloat(getComputedStyle(toggle).bottom) || 0;
        button.style.bottom = `${Math.round(toggleBottom + toggle.offsetHeight + 8)}px`;
    };

    return { setVisible, update, position, element: button };
};

export const terrainCompass = { create };
