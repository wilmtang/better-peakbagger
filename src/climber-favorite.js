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
    const name = F.climberNameFromDocument(document);
    if (pageCid == null || pageCid === ownCid || !heading || !name) return;

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
#bpb-climber-favorite { appearance: none; display: inline-flex; align-items: center; margin: 4px 0 8px;
    padding: 4px 10px; border: 1px solid #aeb8ae; border-radius: 999px; background: #fff; color: #2f6b3f;
    font: 600 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; }
#bpb-climber-favorite:hover { border-color: #2f6b3f; background: #f3f8f4; }
#bpb-climber-favorite:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
#bpb-climber-favorite:disabled { cursor: wait; opacity: .58; }
html[data-bpb-theme="dark"] #bpb-climber-favorite { border-color: #667066; background: #23262a; color: #8fc99c; }
html[data-bpb-theme="dark"] #bpb-climber-favorite:hover { border-color: #8fc99c; background: #29322b; }
`;
        document.head.appendChild(style);
    };

    const included = () => favorites.entries.some(entry => entry.cid === pageCid);
    const paint = () => {
        if (!button) return;
        const active = included();
        button.textContent = active ? '★ In your favorites — remove' : '☆ Add to favorites';
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', active
            ? `Remove ${name} from your favorites`
            : `Add ${name} to your favorites`);
        button.disabled = busy || (!active && favorites.entries.length >= F.LIMIT);
        button.title = !active && favorites.entries.length >= F.LIMIT
            ? `Favorites can hold up to ${F.LIMIT} climbers.`
            : errorMessage;
    };

    const unmount = () => {
        if (button) button.remove();
        button = null;
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
