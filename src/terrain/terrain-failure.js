// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared user-facing 3D terrain failure semantics.

const MESSAGES = Object.freeze({
    frame: '3D terrain could not start in this browser. The 2D map is unchanged.',
    // `unavailable` includes valid routes the renderer deliberately cannot
    // represent (for example an antimeridian-spanning route), so do not blame
    // the browser here.
    unavailable: '3D terrain is unavailable for this map. The 2D map is unchanged.',
    // The elevation provider covers different regions to different depths, and
    // some ground not at all. Neither the browser nor the user can act on that,
    // so say what is true and leave it there.
    coverage: 'No 3D elevation data is available for this area. The 2D map is unchanged.',
    // Reaching the provider failed. Unlike `coverage` this may well work later,
    // and unlike `maplibre` it is not the browser's doing.
    elevation: '3D elevation data could not be loaded. The 2D map is unchanged.',
    maplibre: 'Your browser could not render 3D terrain. The 2D map is unchanged.',
    renderer: 'Your browser could not render 3D terrain. The 2D map is unchanged.',
    timeout: '3D terrain took too long to load. The 2D map is unchanged.'
});

// The reasons a surface may be told about, derived from the messages rather
// than listed again. The isolated bridge relays a reason across a trust
// boundary and must reject anything it does not recognise — but a second,
// hand-maintained copy of this set is exactly how `coverage` reached the user
// as "Your browser could not render 3D terrain": the frame reported the right
// thing and the relay overwrote it, silently, in a build where every test was
// green. One list, one place.
const REASONS = new Set(Object.keys(MESSAGES));

const message = reason => MESSAGES[reason]
    || '3D terrain could not load. The 2D map is unchanged.';

// BigMap and Peak pages have no analyzer panel for errors. Mount one compact,
// auto-hiding live region beside their floating toggle so a failed attempt is
// visible without permanently covering the native map.
const createNotice = ({ container, toggle }) => {
    const element = document.createElement('p');
    element.id = 'bpb-terrain-failure';
    element.className = 'bpb-terrain-failure';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.hidden = true;
    container.append(element);

    let hideTimer = null;
    const clear = () => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        element.hidden = true;
        element.textContent = '';
    };
    const position = () => {
        element.style.bottom = toggle?.style.bottom || '';
    };
    const setTheme = theme => { element.dataset.theme = theme === 'dark' ? 'dark' : 'light'; };
    const show = reason => {
        clear();
        element.textContent = message(reason);
        element.hidden = false;
        position();
        hideTimer = setTimeout(clear, 10000);
    };

    return { clear, element, position, setTheme, show };
};

export const terrainFailure = { REASONS, createNotice, message };
