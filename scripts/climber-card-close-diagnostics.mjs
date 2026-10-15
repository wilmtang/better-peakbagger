// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global window, document, Element, getComputedStyle */

// Install only through scripting.executeScript in the disposable fixture tab's
// extension world. Forward the original setter unchanged; archive bytes and
// application decisions stay untouched. Page navigation removes the probe.
export function installClimberCardCloseProbe() {
    const native = Element.prototype.setAttribute;
    const events = [];
    Element.prototype.setAttribute = function (name, value) {
        if (name === 'aria-expanded' && value === 'false' && this.matches('#hover-climber + button')) {
            const anchor = document.getElementById('hover-climber');
            const card = document.getElementById('bpb-climber-card');
            events.push({ at: window.performance.now(), stack: new Error('card close call').stack,
                anchor: anchor.getBoundingClientRect().toJSON(), rects: anchor.getClientRects().length,
                ancestor: anchor.closest('[hidden], [inert], [aria-hidden="true"]')?.outerHTML.slice(0, 200),
                visibility: getComputedStyle(anchor).visibility, href: anchor.getAttribute('href'),
                viewport: { width: window.innerWidth, height: window.innerHeight,
                    visualWidth: window.visualViewport?.width, visualHeight: window.visualViewport?.height,
                    top: window.visualViewport?.offsetTop, left: window.visualViewport?.offsetLeft },
                active: document.activeElement?.id });
            if (events.length > 8) events.shift();
            native.call(card, 'data-bpb-verifier-close-trace', JSON.stringify(events));
        }
        return native.call(this, name, value);
    };
    window.addEventListener('pagehide', () => { Element.prototype.setAttribute = native; }, { once: true });
    return true;
}
