// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// One feedback owner outside the centered title/action row. Normal feedback has
// two short lines of room; full failures expand only by explicit disclosure.
const surfaces = new WeakMap();
export const climberProfileFeedback = (doc = document) => {
    if (surfaces.has(doc)) return surfaces.get(doc);
    const host = doc.getElementById('TitleLabel');
    const region = doc.createElement('div'); region.id = 'bpb-climber-profile-feedback';
    const note = doc.createElement('span'); note.id = 'bpb-climber-membership-note';
    note.hidden = true;
    const actions = doc.createElement('div'); actions.className = 'bpb-profile-feedback-actions';
    const retry = doc.createElement('button'); retry.id = 'bpb-climber-profile-retry';
    retry.setAttribute('data-bpb-climber-ui', '');
    retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
    const details = doc.createElement('details'); details.hidden = true;
    const summary = doc.createElement('summary'); summary.textContent = 'Details';
    const full = doc.createElement('p'); details.append(summary, full);
    const announcement = doc.createElement('span'); announcement.id = 'bpb-climber-profile-announcement';
    announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
    actions.append(note, retry, details); region.append(actions, announcement); host.after(region);
    const style = doc.createElement('style');
    style.textContent = `
#bpb-climber-profile-feedback { box-sizing:border-box; width:min(100%,calc(100vw - 32px)); margin:4px auto 8px; color:#424b44; font:13px/1.4 Arial,sans-serif; text-align:center; }
#bpb-climber-membership-note { min-width:0; overflow-wrap:anywhere; }
.bpb-profile-feedback-actions { display:flex; align-items:flex-start; justify-content:center; gap:12px; min-height:2.8em; }
#bpb-climber-profile-feedback button, #bpb-climber-profile-feedback summary { box-sizing:border-box; min-height:2em; border:0; background:none; color:#23593e; margin:0; padding:0; font:inherit; cursor:pointer; }
#bpb-climber-profile-feedback button:disabled { opacity:.5; cursor:wait; }
#bpb-climber-profile-feedback :is(button,summary):focus-visible { outline:2px solid #2f6b3f; outline-offset:2px; }
#bpb-climber-profile-feedback details[open] { max-width:100%; }
.bpb-profile-feedback-actions:has(details[open]) { flex-wrap:wrap; }
#bpb-climber-profile-feedback details[open] { flex-basis:100%; }
#bpb-climber-profile-feedback details p { margin:8px 0; text-align:left; overflow-wrap:anywhere; }
#bpb-climber-profile-feedback [hidden] { display:none !important; }
#bpb-climber-profile-announcement { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
html[data-bpb-theme="dark"] #bpb-climber-profile-feedback { color:#ced5d0; }
html[data-bpb-theme="dark"] #bpb-climber-profile-feedback :is(button,summary) { color:#7ac78d; }
`;
    doc.head.append(style);
    const channels = new Map(); let current = null;
    const surface = {
        set(key, state) {
            if (state?.text) channels.set(key, state); else channels.delete(key);
            current = [...channels.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0))[0] || null;
            note.textContent = current?.text || ''; note.hidden = !current;
            // Preserve an existing recovery target while that same action is busy.
            retry.hidden = !current?.retry; retry.disabled = !!current?.busy;
            retry.textContent = current?.retryLabel || 'Retry';
            if (current?.error) full.textContent = current.error;
            details.hidden = !current?.error && !details.open;
        },
        announce(message) { if (announcement.textContent !== message) announcement.textContent = message; },
    };
    retry.addEventListener('click', event => { if (!retry.disabled) current?.retry?.(event); });
    surfaces.set(doc, surface);
    return surface;
};
