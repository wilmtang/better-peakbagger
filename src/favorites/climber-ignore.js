// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.js';
import * as I from './ignored-climbers.js';
import { observeIgnored, mutateIgnored } from './ignored-client.js';
import { ownerClimberId } from '../profile/profile-backup-core.js';
import { observeClimberMembership } from './climber-membership.js';

const mount = () => {
    const cid = I.profileId(location.href);
    const heading = document.querySelector('#TitleLabel h1');
    const name = F.climberNameFromDocument(document);
    if (!cid || cid === ownerClimberId(document) || !heading || !name
        || document.getElementById('bpb-climber-ignore')) return;
    const host = heading.parentElement;
    host.classList.add('bpb-climber-ignore-host');
    const style = document.createElement('style');
    style.textContent = `
#TitleLabel.bpb-climber-ignore-host { display:inline-flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:8px; max-width:min(100%,calc(100vw - 32px)); }
#TitleLabel.bpb-climber-ignore-host h1 { min-width:0; overflow-wrap:anywhere; }
.bpb-ignore-actions { display:inline-flex; align-items:center; flex-wrap:wrap; gap:8px; font:13px Arial,sans-serif; color:#424b44; }
.bpb-ignore-actions button { min-height:32px; padding:5px 10px; border:1px solid #9ba79e; border-radius:6px; background:#f6f8f6; color:#354239; font:inherit; cursor:pointer; }
#bpb-climber-ignore { min-width:83px; }
.bpb-ignore-actions button:focus-visible { outline:2px solid #2f6b3f; outline-offset:2px; }
.bpb-ignore-actions button:disabled { opacity:.5; cursor:not-allowed; }
.bpb-ignore-actions button[aria-busy="true"] { cursor:wait; }
.bpb-ignore-actions .bpb-membership-note { max-width:34ch; font-size:12px; line-height:1.4; }
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
    button.title = "Hide this climber's reports on peak and ascent pages.";
    const status = document.createElement('span');
    status.id = 'bpb-climber-membership-note'; status.className = 'bpb-membership-note';
    button.setAttribute('aria-describedby', status.id);
    const announcement = document.createElement('span');
    announcement.setAttribute('role', 'status');
    announcement.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
    group.append(button, status, retry, announcement); host.append(group);
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
        const reason = !active && lists ? `Remove from ${lists} to ignore.` : '';
        button.textContent = active ? 'Unignore' : 'Ignore';
        button.disabled = busy || !list || (!active && (!membership?.ignored || !!membership.error || !!lists || favoriteSaving || buddyPending));
        button.title = reason || (active ? "Show this climber's reports again." : "Hide this climber's reports on peak and ascent pages.");
        button.setAttribute('aria-pressed', String(active));
        if (button.getAttribute('aria-busy') !== String(busy)) button.setAttribute('aria-busy', String(busy));
        status.textContent = error || membership?.error || reason
            || (favoriteSaving ? 'Saving favorites…' : buddyPending ? 'Buddy List change pending · Refresh this page before ignoring.' : '')
            || (active ? 'Ignored · Unignore to add to favorites or your Buddy List.'
                : membership?.pendingIds?.has(cid) ? 'Sync pending · Finish sync before adding to favorites or your Buddy List.' : '');
        announcement.textContent = error || membership?.error || notice;
        retry.hidden = !error && !membership?.error;
    };
    const toggle = async () => {
        if (button.disabled || busy || !list) return;
        const active = list.entries.some(entry => entry.cid === cid);
        if (!active && (hasNativeBuddy() || document.getElementById('bpb-climber-favorite')?.getAttribute('aria-busy') === 'true'
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
    retry.addEventListener('click', () => {
        if (retryWrite) void toggle(); else { void observer.refresh(); void membershipObserver.refresh(); }
    });
    paint();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
