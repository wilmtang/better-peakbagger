// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.js';
import * as I from './ignored-climbers.js';
import { observeIgnored, mutateIgnored } from './ignored-client.js';
import { ownerClimberId } from '../profile/profile-backup-core.js';
import { observeClimberMembership } from './climber-membership.js';
import { climberProfileFeedback } from './climber-profile-feedback.js';
import { createStableText } from '../ui/stable-text.js';
import { climberCardState } from './climber-card-state.js';

const mount = () => {
    const cid = I.profileId(location.href);
    const heading = document.querySelector('#TitleLabel h1');
    const name = F.climberNameFromDocument(document);
    if (!cid || cid === ownerClimberId(document) || !heading || !name
        || document.getElementById('bpb-climber-ignore')) return;
    const host = heading.parentElement;
    const feedback = climberProfileFeedback();
    host.classList.add('bpb-climber-ignore-host');
    const style = document.createElement('style');
    style.textContent = `
#TitleLabel.bpb-climber-ignore-host { display:inline-flex; flex-wrap:wrap; align-items:baseline; justify-content:center; gap:8px; max-width:min(100%,calc(100vw - 32px)); }
#TitleLabel.bpb-climber-ignore-host h1 { min-width:0; overflow-wrap:anywhere; }
.bpb-ignore-actions { display:inline-flex; align-items:baseline; font:13px Arial,sans-serif; color:#424b44; }
.bpb-ignore-actions button { min-height:32px; padding:5px 10px; border:1px solid #9ba79e; border-radius:6px; background:#f6f8f6; color:#354239; font:inherit; cursor:pointer; }
#bpb-climber-ignore { min-width:83px; }
.bpb-ignore-actions button:focus-visible { outline:2px solid #2f6b3f; outline-offset:2px; }
.bpb-ignore-actions button:is(:disabled,[aria-disabled="true"]) { opacity:.5; cursor:not-allowed; }
.bpb-ignore-actions button[aria-busy="true"] { cursor:wait; }
html[data-bpb-theme="dark"] .bpb-ignore-actions { color:#ced5d0; }
html[data-bpb-theme="dark"] .bpb-ignore-actions button { color:#d5e0d8; background:#29322b; border-color:#71927a; }
html[data-bpb-theme="dark"] .bpb-ignore-actions button:focus-visible { outline-color:#8fc99c; }
@media(max-width:600px) { #TitleLabel.bpb-climber-ignore-host { display:flex; width:calc(100vw - 32px); margin:0; } }
`;
    document.head.append(style);
    const group = document.createElement('span');
    group.className = 'bpb-ignore-actions';
    const button = document.createElement('button');
    button.id = 'bpb-climber-ignore'; button.type = 'button';
    const label = createStableText(button); label.reserve(['Ignore', 'Unignore']);
    button.title = "Hide this climber's reports on peak and ascent pages.";
    button.setAttribute('aria-describedby', 'bpb-climber-membership-note');
    group.append(button); host.append(group);
    let list = null, busy = false, error = '', notice = '', retryWrite = false;
    let membership = null;
    const hasNativeBuddy = () => [...document.querySelectorAll(F.BUDDY_CONTROL_SELECTOR)]
        .some(control => F.buddyControlAction(control) === 'remove');
    let nativeBuddy = hasNativeBuddy();
    const paint = () => {
        const active = !!list?.entries.some(entry => entry.cid === cid);
        const favorite = membership?.favorites?.entries.some(entry => entry.cid === cid);
        const buddy = nativeBuddy || membership?.buddies?.entries.some(entry => entry.cid === cid);
        const lists = [favorite && 'favorites', buddy && 'your Buddy List'].filter(Boolean).join(' and ');
        const favoriteSaving = document.getElementById('bpb-climber-favorite')?.getAttribute('aria-busy') === 'true';
        const buddyPending = !!document.querySelector('[data-bpb-buddy-pending="true"]');
        const view = climberCardState({ cid, ownerCid: ownerClimberId(document), membership,
            nativeBuddy, buddyPending: buddyPending || favoriteSaving, busy });
        const buddyIntent = view.buddyIntent;
        const reason = !active && lists ? `Remove from ${lists} to ignore.` : '';
        label.set(active ? 'Unignore' : 'Ignore');
        const unavailable = busy || !list || (!active && view.ignoreDisabled);
        button.disabled = unavailable && !busy;
        button.setAttribute('aria-disabled', String(unavailable));
        button.title = reason || (!active && buddyIntent ? view.buddyCheckBlocked ? 'Check from the original account.'
            : view.buddyInFlight ? 'Buddy change in progress.' : 'Check buddy status before ignoring.'
            : active ? "Show this climber's reports again." : "Hide this climber's reports on peak and ascent pages.");
        button.setAttribute('aria-pressed', String(active));
        if (button.getAttribute('aria-busy') !== String(busy)) button.setAttribute('aria-busy', String(busy));
        const failure = error || membership?.error;
        const canCheck = buddyIntent && !view.buddyInFlight && buddyIntent.ownerCid === ownerClimberId(document) && !buddyPending
            && feedback.canCheckBuddy && !!document.querySelector('#AddBuddy, #RemoveBuddy');
        feedback.set('ignore', { text: busy ? 'Saving ignored climbers…' : failure ? error ? 'Ignore not saved.' : 'Lists unavailable.'
            : favoriteSaving ? 'Saving favorites…' : buddyPending ? 'Buddy List change pending.'
                : !active && buddyIntent ? view.buddyInFlight ? 'Buddy change in progress.'
                    : buddyIntent.ownerCid === ownerClimberId(document) ? 'Check buddy status.' : 'Check from the original account.'
                    : active ? 'Unignore to add to lists.' : membership?.pendingIds?.has(cid) ? 'Sync pending · Finish list sync.' : '',
        error: failure, busy, disabled: retryWrite && button.disabled && !busy, priority: busy ? 100 : failure ? 80 : 30,
        retryLabel: !failure && canCheck ? 'Check status' : 'Retry',
        retryName: !failure && canCheck ? 'Check buddy status' : 'Retry',
        retry: !failure && canCheck ? event => feedback.checkBuddy(event) : failure || busy && retryWrite ? () => {
            if (retryWrite) void toggle(); else { void observer.refresh(); void membershipObserver.refresh(); }
        } : null });
        if (failure || notice) feedback.announce(failure || notice);
    };
    const toggle = async () => {
        if (button.disabled || busy || !list) return;
        const active = list.entries.some(entry => entry.cid === cid);
        if (!active && (membership?.buddyIntents?.some(entry => entry.cid === cid) || hasNativeBuddy() || document.getElementById('bpb-climber-favorite')?.getAttribute('aria-busy') === 'true'
            || document.querySelector('[data-bpb-buddy-pending="true"]'))) { nativeBuddy = hasNativeBuddy(); paint(); return; }
        busy = true; error = ''; notice = ''; paint();
        try {
            const response = await mutateIgnored(chrome, active ? { kind: 'remove', cid }
                : { kind: 'add', entry: { cid, name, addedAt: Date.now() } });
            if (!list || response.list.revision >= list.revision) list = response.list;
            retryWrite = false;
            notice = active ? `${name}'s reports are visible again.` : `${name}'s reports are now hidden.`;
        } catch (failure) { error = failure.message; retryWrite = true; }
        finally { busy = false; paint(); }
    };
    button.addEventListener('click', () => { void toggle(); });
    const observer = observeIgnored(chrome, state => { list = state.list; error = state.error; paint(); });
    const membershipObserver = observeClimberMembership(chrome, state => { membership = state; paint(); });
    const buddyObserver = new MutationObserver(() => {
        const next = hasNativeBuddy();
        if (nativeBuddy !== next) { nativeBuddy = next; paint(); }
    });
    buddyObserver.observe(document.documentElement, { childList: true, subtree: true,
        attributes: true, attributeFilter: ['value', 'title', 'aria-label'] });
    const pendingObserver = new MutationObserver(records => {
        if (records.some(record => record.attributeName === 'data-bpb-buddy-pending'
            || record.target.id === 'bpb-climber-favorite')) paint();
    });
    pendingObserver.observe(document.documentElement, { attributes: true, subtree: true,
        attributeFilter: ['data-bpb-buddy-pending', 'aria-busy'] });
    paint();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
