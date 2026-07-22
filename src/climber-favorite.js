// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — custom favorite toggle on public climber pages.

import { settings as S } from './settings.js';
import { favoriteClimbers as F } from './favorite-climbers.js';
import { numericParam, ownerClimberId } from './profile-backup-core.js';

(() => {
    'use strict';

    const pageCid = numericParam(location.href, 'cid', document.baseURI);
    const ownCid = ownerClimberId(document);
    const heading = document.querySelector('#TitleLabel h1');
    const host = heading?.parentElement;
    const name = F.climberNameFromDocument(document);
    if (pageCid == null || pageCid === ownCid || !heading || !host || !name) return;

    const store = chrome.storage.local;
    let mode = 'buddies';
    let favorites = F.cleanFavorites(null);
    let button = null;
    let busy = false;
    let errorMessage = '';

    const injectStyle = () => {
        if (document.getElementById('bpb-climber-favorite-style')) return;
        const style = document.createElement('style');
        style.id = 'bpb-climber-favorite-style';
        style.textContent = `
#TitleLabel.bpb-climber-favorite-host { display: inline-flex; align-items: center; justify-content: center;
    flex-wrap: nowrap; gap: 8px; max-width: 100%; vertical-align: middle; }
#TitleLabel.bpb-climber-favorite-host > h1 { flex: 0 1 auto; min-width: 0; }
#bpb-climber-favorite { appearance: none; display: inline-flex; flex: 0 0 auto; align-items: center;
    justify-content: center; width: 30px; height: 30px; margin: 0; padding: 0 0 2px;
    border: 1px solid #8fab96; border-radius: 50%; background: #f3f8f4; color: #2f6b3f;
    font: 700 20px/1 Arial, Helvetica, sans-serif; cursor: pointer; }
#bpb-climber-favorite:hover { border-color: #2f6b3f; background: #e7f1e9; transform: translateY(-1px); }
#bpb-climber-favorite:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
#bpb-climber-favorite[aria-pressed="true"] { border-color: #2f6b3f; background: #2f6b3f; color: #fff; }
#bpb-climber-favorite:disabled { cursor: wait; opacity: .58; }
html[data-bpb-theme="dark"] #bpb-climber-favorite { border-color: #71927a; background: #29322b; color: #b5e0bf; }
html[data-bpb-theme="dark"] #bpb-climber-favorite:hover { border-color: #9ad5a7; background: #334238; }
html[data-bpb-theme="dark"] #bpb-climber-favorite[aria-pressed="true"] { border-color: #8fc99c; background: #3f8a54; color: #fff; }
`;
        document.head.appendChild(style);
    };

    const included = () => favorites.entries.some(entry => entry.cid === pageCid);
    const paint = () => {
        if (!button) return;
        const active = included();
        const actionLabel = active
            ? `Remove ${name} from your favorites`
            : `Add ${name} to your favorites`;
        button.textContent = active ? '★' : '☆';
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', actionLabel);
        button.disabled = busy || (!active && favorites.entries.length >= F.LIMIT);
        button.title = errorMessage || (!active && favorites.entries.length >= F.LIMIT
            ? `Favorites can hold up to ${F.LIMIT} climbers.`
            : actionLabel);
    };

    const unmount = () => {
        if (button) button.remove();
        button = null;
        host.classList.remove('bpb-climber-favorite-host');
    };

    const toggle = async () => {
        if (busy) return;
        busy = true;
        errorMessage = '';
        paint();
        try {
            const stored = await store.get(F.FAVORITES_KEY);
            const current = F.cleanFavorites(stored[F.FAVORITES_KEY]);
            const exists = current.entries.some(entry => entry.cid === pageCid);
            const entries = exists
                ? current.entries.filter(entry => entry.cid !== pageCid)
                : [{ cid: pageCid, name, addedAt: Date.now(), source: 'manual' }, ...current.entries];
            favorites = F.cleanFavorites({ schemaVersion: F.SCHEMA_VERSION, entries });
            await store.set({ [F.FAVORITES_KEY]: favorites });
        } catch (error) {
            errorMessage = 'Favorite climbers are unavailable. Try again.';
        } finally {
            busy = false;
            paint();
        }
    };

    const mount = () => {
        if (mode !== 'custom') return unmount();
        if (!button) {
            injectStyle();
            button = document.createElement('button');
            button.id = 'bpb-climber-favorite';
            button.type = 'button';
            button.addEventListener('click', () => { void toggle(); });
            host.classList.add('bpb-climber-favorite-host');
            heading.insertAdjacentElement('afterend', button);
        }
        paint();
    };

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[F.FAVORITES_KEY]) return;
        favorites = F.cleanFavorites(changes[F.FAVORITES_KEY].newValue);
        mount();
    });
    S.subscribe(settings => {
        mode = settings.favoritesSource === 'custom' ? 'custom' : 'buddies';
        mount();
    });

    void Promise.all([S.get(), store.get(F.FAVORITES_KEY)]).then(([settings, stored]) => {
        mode = settings.favoritesSource === 'custom' ? 'custom' : 'buddies';
        favorites = F.cleanFavorites(stored[F.FAVORITES_KEY]);
        mount();
    }).catch(() => { unmount(); });
})();
