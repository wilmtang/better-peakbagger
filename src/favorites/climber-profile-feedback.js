// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// One dismissible feedback owner outside document flow: idle profiles need no
// empty status row, and async feedback must not move the title or native form.
const surfaces = new WeakMap();
export const climberProfileFeedback = (doc = document) => {
    if (surfaces.has(doc)) return surfaces.get(doc);
    const host = doc.getElementById('TitleLabel');
    host.classList.add('bpb-climber-profile-host');
    const region = doc.createElement('div'); region.id = 'bpb-climber-profile-feedback'; region.hidden = true;
    const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.className = 'bpb-profile-feedback-dismiss';
    dismiss.setAttribute('data-bpb-climber-ui', '');
    dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Dismiss message');
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
    actions.append(note, retry, details); region.append(actions, dismiss); host.after(region, announcement);
    const style = doc.createElement('style');
    style.textContent = `
#TitleLabel.bpb-climber-profile-host { padding-block:2px; }
#TitleLabel.bpb-climber-profile-host > h1 { margin:0; }
#bpb-climber-profile-feedback { position:fixed; z-index:2147483646; inset:auto auto 16px 50%; transform:translateX(-50%); box-sizing:border-box; width:min(440px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow:auto; overscroll-behavior:contain; margin:0; padding:12px 40px 12px 16px; border:1px solid #bdc8bf; border-radius:10px; background:#f6f8f6; box-shadow:0 4px 20px #0002; color:#424b44; font:13px/1.4 Arial,sans-serif; text-align:left; }
#bpb-climber-profile-feedback[hidden] { display:none !important; }
#bpb-climber-membership-note { flex-basis:100%; min-width:0; overflow-wrap:anywhere; }
.bpb-profile-feedback-actions { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; }
#bpb-climber-profile-feedback button, #bpb-climber-profile-feedback summary { box-sizing:border-box; min-height:2em; border:0; background:none; color:#23593e; margin:0; padding:0; font:inherit; cursor:pointer; }
#bpb-climber-profile-feedback button:is(:disabled,[aria-disabled="true"]) { opacity:.5; cursor:not-allowed; }
#bpb-climber-profile-feedback button[aria-busy="true"] { cursor:wait; }
#bpb-climber-profile-feedback .bpb-profile-feedback-dismiss { position:absolute; top:8px; right:8px; display:grid; place-items:center; width:24px; height:24px; min-height:24px; font-size:20px; line-height:1; color:inherit; }
#bpb-climber-profile-feedback :is(button,summary):focus-visible { outline:2px solid #2f6b3f; outline-offset:2px; }
#bpb-climber-profile-feedback details[open] { max-width:100%; flex-basis:100%; }
#bpb-climber-profile-feedback details p { margin:8px 0; font:inherit; text-align:left; overflow-wrap:anywhere; max-height:50dvh; overflow:auto; overscroll-behavior:contain; }
#bpb-climber-profile-feedback [hidden] { display:none !important; }
#bpb-climber-profile-announcement { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
html[data-bpb-theme="dark"] #bpb-climber-profile-feedback { color:#ced5d0; background:#252c27; border-color:#59675e; box-shadow:0 4px 20px #0005; }
html[data-bpb-theme="dark"] #bpb-climber-profile-feedback :is(button,summary) { color:#7ac78d; }
`;
    doc.head.append(style);
    const channels = new Map(); let current = null, buddyCheck = null, sequence = 0, lastError = '', dismissed = null, returnFocus = null;
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
            const hidden = (!current && !details.open) || current?.sequence === dismissed;
            if (!hidden && !region.contains(doc.activeElement) && doc.activeElement !== doc.body) returnFocus = doc.activeElement;
            region.hidden = hidden;
        },
        announce(message) { if (announcement.textContent !== message) announcement.textContent = message; },
    };
    retry.addEventListener('click', event => { if (!retry.disabled && retry.getAttribute('aria-disabled') !== 'true') current?.retry?.(event); });
    details.addEventListener('toggle', () => { if (!details.open && !current) region.hidden = true; });
    dismiss.addEventListener('click', () => {
        dismissed = current?.sequence; details.open = false;
        if (region.contains(doc.activeElement) && returnFocus?.isConnected) returnFocus.focus();
        region.hidden = true;
    });
    surfaces.set(doc, surface);
    return surface;
};
