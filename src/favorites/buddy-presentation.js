// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createStableText } from '../ui/stable-text.js';

// Keep the real input, form association, value and accessible name. Only its
// visible caption is overlaid so alternatives can reserve room AND wrap.
const controls = new WeakMap();
export const reserveBuddyPresentation = control => {
    if (!control || control.tagName !== 'INPUT' || !['submit', 'button'].includes(control.type)) return;
    if (controls.has(control)) { controls.get(control).set(control.value); return; }
    const doc = control.ownerDocument;
    if (!doc.getElementById('bpb-buddy-presentation-style')) {
        const style = doc.createElement('style'); style.id = 'bpb-buddy-presentation-style';
        style.textContent = `
.bpb-buddy-shell { position:relative; vertical-align:middle; max-width:100%; min-width:0; color:#111; }
.bpb-buddy-shell > span { box-sizing:border-box; padding:2px 6px; overflow-wrap:anywhere; pointer-events:none; position:relative; z-index:1; }
.bpb-buddy-shell > input.bpb-native-buddy-action { position:absolute; inset:0; box-sizing:border-box; min-width:0; width:100%; height:100%; margin:0; color:transparent !important; text-shadow:none !important; }
.bpb-buddy-shell:has(:disabled), .bpb-buddy-shell:has([data-bpb-buddy-blocked]), .bpb-buddy-shell:has([data-bpb-buddy-pending="true"]) { opacity:.5; }
.bpb-buddy-shell > input:disabled { cursor:wait; }
.bpb-buddy-shell > input[data-bpb-buddy-blocked] { opacity:1; }
.bpb-buddy-relationship { vertical-align:middle; max-width:100%; min-width:0; }
.bpb-buddy-relationship > span { overflow-wrap:anywhere; }
html[data-bpb-theme="dark"] .bpb-buddy-shell { color:#e6e1d8; }
html[data-bpb-theme="dark"] .bpb-buddy-shell > input.bpb-native-buddy-action { color:transparent !important; }
`;
        doc.head.append(style);
    }
    const wrapper = doc.createElement('span'); wrapper.className = 'bpb-buddy-shell';
    wrapper.style.font = doc.defaultView.getComputedStyle(control).font;
    const text = createStableText(wrapper);
    wrapper.style.display = 'inline-grid';
    text.reserve(['Add to your Buddy List', 'Remove from your Buddy List', 'Add to My Buddy List', 'Remove from My Buddy List']);
    text.set(control.value); wrapper.firstElementChild.setAttribute('aria-hidden', 'true');
    control.before(wrapper); wrapper.append(control); controls.set(control, text);
    const label = doc.getElementById('BuddyLabel');
    if (label && !label.parentElement.classList.contains('bpb-buddy-relationship')) {
        const relationship = doc.createElement('span'); relationship.className = 'bpb-buddy-relationship';
        relationship.style.font = doc.defaultView.getComputedStyle(label).font;
        const sizing = createStableText(relationship);
        relationship.style.display = 'inline-grid';
        sizing.reserve(['Add this Climber as a Buddy', 'This Climber is one of your buddies.']);
        label.before(relationship); relationship.prepend(label);
    }
};
