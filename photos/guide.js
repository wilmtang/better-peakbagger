// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the photo guide's symbol legend.
//
// The legend is painted from photo-renderer rather than drawn into the page, so
// the symbol a climber is taught here is the same one the export paints. The
// rest of the guide is static markup; only the glyphs come from code.

import { photoRenderer as Renderer } from '../src/photos/photo-renderer.js';

for (const slot of document.querySelectorAll('[data-symbol]')) {
    const parsed = new DOMParser().parseFromString(
        Renderer.markerSymbolSvg(slot.dataset.symbol, { size: 34 }),
        'image/svg+xml',
    );
    slot.replaceChildren(document.importNode(parsed.documentElement, true));
}

// The guide is opened from Peakbagger, from Settings, and from the editor, so
// "go back" has to mean the tab the reader actually came from.
const back = document.getElementById('guide-back');
if (back && history.length > 1) {
    back.hidden = false;
    back.addEventListener('click', () => history.back());
}
