// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the shared DOM builder.
//
// Adoption policy, recorded here so a reader does not have to open each file to
// find out whether it uses this:
//
// Use element() in any surface that builds more than a couple of nodes. It is
// not options-page-only — three of its four original adopters are content
// scripts. The reason the injected surfaces (the GPX Analyzer panel, the ascent
// upload card, the beta-filter bar) hand-rolled createElement instead is that
// they style inline, because they cannot assume a stylesheet reached the page,
// and this builder had no way to express that. The `style` prop closes that
// gap: there is no longer a category of surface it cannot serve.
//
// The remaining hand-rolled surfaces are inherited, not a decision. Adopt
// element() when touching them for other reasons rather than converting them
// wholesale, which would be a large diff with no behavioural benefit. What must
// not happen is a *new* surface growing its own builder beside this one.

const element = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class' && value != null) node.className = value;
        else if (key === 'text' && value !== undefined) node.textContent = value;
        else if (key === 'checked') node.checked = !!value;
        else if (key === 'style' && value && typeof value === 'object') Object.assign(node.style, value);
        else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2), value);
        } else if (value != null) {
            node.setAttribute(key, value);
        }
    }
    for (const child of [].concat(children)) if (child) node.appendChild(child);
    return node;
};

export const dom = { element };
