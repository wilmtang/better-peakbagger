// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// One feedback owner outside the centered title/action row. Reserve a compact
// status row (two lines on narrow screens); full failures expand on disclosure.
const surfaces = new WeakMap();
export const climberProfileFeedback = (doc = document) => {
    if (surfaces.has(doc)) return surfaces.get(doc);
    const host = doc.getElementById('TitleLabel');
    host.classList.add('bpb-climber-profile-host');
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
#TitleLabel.bpb-climber-profile-host { padding-block:2px; }
#TitleLabel.bpb-climber-profile-host > h1 { margin:0; }
#bpb-climber-profile-feedback { box-sizing:border-box; width:min(100%,calc(100vw - 32px)); margin:0 auto 4px; color:#424b44; font:13px/1.4 Arial,sans-serif; text-align:center; }
#bpb-climber-membership-note { min-width:0; overflow-wrap:anywhere; }
.bpb-profile-feedback-actions { display:flex; align-items:flex-start; justify-content:center; gap:12px; min-height:2em; }
@media(max-width:600px) { .bpb-profile-feedback-actions { min-height:2.8em; } }
#bpb-climber-profile-feedback button, #bpb-climber-profile-feedback summary { box-sizing:border-box; min-height:2em; border:0; background:none; color:#23593e; margin:0; padding:0; font:inherit; cursor:pointer; }
#bpb-climber-profile-feedback button:is(:disabled,[aria-disabled="true"]) { opacity:.5; cursor:not-allowed; }
#bpb-climber-profile-feedback button[aria-busy="true"] { cursor:wait; }
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
    const channels = new Map(); let current = null, buddyCheck = null, sequence = 0, lastError = '';
    const surface = {
        registerBuddyCheck(handler) { buddyCheck = handler; },
        get canCheckBuddy() { return !!buddyCheck; },
        checkBuddy(event) { buddyCheck?.(event); },
        set(key, state) {
            if (state?.text) {
                const signature = JSON.stringify([state.text, state.error, state.busy, !!state.retry, state.retryLabel, state.priority]);
                const previous = channels.get(key);
                channels.set(key, { ...state, signature, sequence: previous?.signature === signature ? previous.sequence : ++sequence });
            } else channels.delete(key);
            current = [...channels.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0) || b.sequence - a.sequence)[0] || null;
            note.textContent = current?.text || ''; note.hidden = !current;
            // Preserve an existing recovery target while that same action is busy.
            const unavailable = !!current?.busy || (typeof current?.disabled === 'function' ? current.disabled() : !!current?.disabled);
            retry.hidden = !current?.retry;
            retry.disabled = unavailable && !(current?.busy && doc.activeElement === retry);
            retry.setAttribute('aria-disabled', String(unavailable));
            retry.setAttribute('aria-busy', String(!!current?.busy));
            retry.textContent = current?.retryLabel || 'Retry';
            retry.setAttribute('aria-label', current?.retryName || retry.textContent);
            if (current?.error) { lastError = current.error; full.textContent = lastError; }
            else if (details.open && lastError) full.textContent = `Previous message: ${lastError}`;
            details.hidden = !current?.error && !details.open;
        },
        announce(message) { if (announcement.textContent !== message) announcement.textContent = message; },
    };
    retry.addEventListener('click', event => { if (!retry.disabled && retry.getAttribute('aria-disabled') !== 'true') current?.retry?.(event); });
    surfaces.set(doc, surface);
    return surface;
};
