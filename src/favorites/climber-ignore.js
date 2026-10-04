// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { favoriteClimbers as F } from './favorite-climbers.js';
import * as I from './ignored-climbers.js';
import { observeIgnored, mutateIgnored } from './ignored-client.js';
import { ownerClimberId } from '../profile/profile-backup-core.js';

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
.bpb-ignore-actions button:disabled { cursor:wait; }
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
    const announcement = document.createElement('span');
    announcement.setAttribute('role', 'status');
    announcement.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
    group.append(button, status, retry, announcement); host.append(group);
    let list = null, busy = false, error = '', notice = '', retryWrite = false;
    const paint = () => {
        const active = !!list?.entries.some(entry => entry.cid === cid);
        button.textContent = active ? 'Unignore' : 'Ignore';
        button.disabled = busy || !list;
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-busy', String(busy));
        status.textContent = error || (active ? 'Ignored' : '');
        announcement.textContent = error || notice;
        retry.hidden = !error;
    };
    const toggle = async () => {
        if (busy || !list) return;
        const active = list.entries.some(entry => entry.cid === cid);
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
    retry.addEventListener('click', () => { if (retryWrite) void toggle(); else void observer.refresh(); });
    paint();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
