// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — custom favorite toggle on public climber pages.

import { settings as S } from '../settings/settings.js';
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { favoriteClimbers as F } from './favorite-climbers.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';
import { numericParam, ownerClimberId } from '../profile/profile-backup-core.js';
import { observeClimberMembership } from './climber-membership.js';

const BUDDY_MUTATION_SESSION_KEY = 'bpbPendingBuddyMutation';
const BUDDY_MUTATION_MAX_AGE_MS = 5 * 60 * 1000;
const BUDDY_CONTROL_SELECTOR = F.BUDDY_CONTROL_SELECTOR;

(() => {
    'use strict';

    const pageCid = numericParam(location.href, 'cid', document.baseURI);
    const ownCid = ownerClimberId(document);
    const heading = document.querySelector('#TitleLabel h1');
    const host = heading?.parentElement;
    const name = F.climberNameFromDocument(document);
    if (pageCid == null || pageCid === ownCid || !heading || !host || !name) return;

    const store = chrome.storage.local;
    let mode = Schema.DEFAULTS.favoritesSource;
    let favorites = F.cleanFavorites(null);
    let button = null;
    let busy = false;
    let errorMessage = '';
    let activeBuddyMutation = null;
    let membership = null;
    const buddyTitles = new WeakMap();
    const ignoreSaving = () => document.getElementById('bpb-climber-ignore')?.getAttribute('aria-busy') === 'true';
    const additionBlocked = () => ignoreSaving() || !membership?.ignored || !!membership.error || membership.blockedIds.has(pageCid);
    const blockedReason = () => ignoreSaving() ? 'Saving ignored climbers…' : membership?.error || (!membership?.ignored ? 'Loading climber lists…'
        : membership.ignored.entries.some(entry => entry.cid === pageCid)
            ? `Unignore ${name} before adding to favorites or your Buddy List.`
            : 'Finish the pending ignored-climber sync before adding to favorites or your Buddy List.');
    const setAttribute = (element, attribute, value) => {
        if (element.getAttribute(attribute) === value) return;
        if (value === null) element.removeAttribute(attribute); else element.setAttribute(attribute, value);
    };

    const mutateFavorites = async mutation => {
        const response = await chrome.runtime.sendMessage({
            type: F.MUTATION_MESSAGE_TYPE,
            mutation,
        });
        if (!response?.ok) throw new Error(response?.error?.message || 'Favorite climbers are unavailable.');
        favorites = F.cleanFavorites(response.favorites);
        return favorites;
    };

    const takePendingBuddyMutation = () => {
        let raw = null;
        try {
            raw = sessionStorage.getItem(BUDDY_MUTATION_SESSION_KEY);
            sessionStorage.removeItem(BUDDY_MUTATION_SESSION_KEY);
        } catch { return null; }
        if (!raw) return null;
        let value = null;
        try { value = JSON.parse(raw); }
        catch { return null; }
        const age = Date.now() - Number(value?.at);
        return value?.version === 1
            && value.cid === pageCid
            && (value.action === 'add' || value.action === 'remove')
            && Number.isFinite(age) && age >= 0 && age <= BUDDY_MUTATION_MAX_AGE_MS
            ? { action: value.action, cid: pageCid }
            : null;
    };

    const buddyActionForControl = F.buddyControlAction;

    const buddyControls = root => {
        const controls = [];
        if (root?.matches?.(BUDDY_CONTROL_SELECTOR)) controls.push(root);
        if (root?.querySelectorAll) controls.push(...root.querySelectorAll(BUDDY_CONTROL_SELECTOR));
        return controls;
    };

    const decorateBuddyControls = root => {
        for (const control of buddyControls(root)) {
            const action = buddyActionForControl(control);
            if (!action) continue;
            control.classList.add('bpb-native-buddy-action');
            if (action === 'add' && additionBlocked()) {
                if (!buddyTitles.has(control)) buddyTitles.set(control, {
                    title: control.getAttribute('title'), disabled: control.getAttribute('aria-disabled'),
                    description: control.getAttribute('aria-describedby'),
                });
                control.dataset.bpbBuddyBlocked = 'true';
                setAttribute(control, 'aria-disabled', 'true');
                setAttribute(control, 'title', blockedReason());
                setAttribute(control, 'aria-describedby', [buddyTitles.get(control).description,
                    'bpb-climber-membership-note'].filter(Boolean).join(' '));
            } else if (buddyTitles.has(control)) {
                const original = buddyTitles.get(control);
                delete control.dataset.bpbBuddyBlocked;
                setAttribute(control, 'title', original.title);
                setAttribute(control, 'aria-disabled', original.disabled);
                setAttribute(control, 'aria-describedby', original.description);
                buddyTitles.delete(control);
            }
        }
    };

    const injectBuddyStyle = () => {
        if (document.getElementById('bpb-native-buddy-action-style')) return;
        const style = document.createElement('style');
        style.id = 'bpb-native-buddy-action-style';
        style.textContent = `
.bpb-native-buddy-action { transition: filter 120ms ease; }
.bpb-native-buddy-action[data-bpb-buddy-blocked] { opacity:.5; cursor:not-allowed; }
.bpb-native-buddy-action:hover:not(:disabled) { filter: brightness(.92); }
.bpb-native-buddy-action:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
html[data-bpb-theme="dark"] .bpb-native-buddy-action:hover:not(:disabled) { filter: brightness(1.18); }
html[data-bpb-theme="dark"] .bpb-native-buddy-action:focus-visible { outline-color: #8fc99c; }
@media (prefers-reduced-motion: reduce) { .bpb-native-buddy-action { transition: none; } }
`;
        document.head.appendChild(style);
    };

    const clearRememberedBuddyMutation = mutation => {
        try {
            const raw = sessionStorage.getItem(BUDDY_MUTATION_SESSION_KEY);
            const remembered = raw ? JSON.parse(raw) : null;
            if (remembered?.version === 1
                && remembered.cid === mutation.cid
                && remembered.action === mutation.action) {
                sessionStorage.removeItem(BUDDY_MUTATION_SESSION_KEY);
            }
        } catch { /* a blocked or malformed page store needs no cleanup */ }
    };

    const rememberBuddyMutation = control => {
        if (!control || control.disabled) return;
        const action = buddyActionForControl(control);
        if (!action) return;
        if (action === 'add') control.dataset.bpbBuddyPending = 'true';
        activeBuddyMutation = { action, cid: pageCid };
        try {
            sessionStorage.setItem(BUDDY_MUTATION_SESSION_KEY, JSON.stringify({
                version: 1,
                action,
                cid: pageCid,
                at: Date.now(),
            }));
        } catch { /* a blocked page store only disables automatic refresh */ }
    };

    const installBuddyMutationListener = () => {
        if (ownCid == null) return;
        injectBuddyStyle();
        decorateBuddyControls(document);
        const observer = new MutationObserver(records => {
            for (const record of records) {
                if (record.type === 'attributes') decorateBuddyControls(record.target);
                if (record.target?.id === 'bpb-climber-ignore' && record.attributeName === 'aria-busy') {
                    decorateBuddyControls(document); mount();
                }
                for (const node of record.addedNodes || []) decorateBuddyControls(node);
            }
            if (!activeBuddyMutation) return;
            const expectedAction = activeBuddyMutation.action === 'add' ? 'remove' : 'add';
            if (!buddyControls(document).some(control => buddyActionForControl(control) === expectedAction)) return;
            const mutation = activeBuddyMutation;
            activeBuddyMutation = null;
            for (const control of buddyControls(document)) delete control.dataset.bpbBuddyPending;
            clearRememberedBuddyMutation(mutation);
            void refreshAfterBuddyMutation(mutation);
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['aria-label', 'aria-busy', 'disabled', 'title', 'value'],
            childList: true,
            subtree: true,
        });
        document.addEventListener('click', event => {
            const control = event.target?.closest?.(BUDDY_CONTROL_SELECTOR);
            if (buddyActionForControl(control) === 'add' && additionBlocked()) {
                event.preventDefault(); event.stopImmediatePropagation(); return;
            }
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            rememberBuddyMutation(control);
        }, true);
        document.addEventListener('submit', event => {
            const fallback = event.target?.querySelector?.('button[type="submit"], input[type="submit"], input[type="image"]');
            const control = event.submitter || fallback;
            if (buddyActionForControl(control) === 'add' && additionBlocked()) {
                event.preventDefault(); event.stopImmediatePropagation(); return;
            }
            rememberBuddyMutation(control);
        }, true);
    };

    const refreshAfterBuddyMutation = async mutation => {
        if (!mutation || ownCid == null) return;
        try {
            const [settings, result] = await Promise.all([
                S.get(),
                fetchPeakbaggerDocument(F.signedInBuddyListUrl(location.origin), { kind: 'buddies' }),
            ]);
            if (result.kind !== 'ok') return;
            const responseOwner = ownerClimberId(result.document);
            if (responseOwner !== ownCid) return;
            const entries = F.parseBuddyDocument(result.document);
            const target = entries.find(entry => entry.cid === pageCid);
            const confirmed = mutation.action === 'add' ? !!target : !target;
            await store.set({
                [F.BUDDY_CACHE_KEY]: { ownerCid: ownCid, entries, fetchedAt: Date.now() },
            });
            if (confirmed && settings.favoritesSource === 'custom') {
                if (mutation.action === 'add') {
                    await mutateFavorites({
                        kind: 'add',
                        entry: {
                            ...(target || { cid: pageCid, name }),
                            addedAt: Date.now(),
                            source: 'buddy',
                        },
                    });
                } else if (settings.removeFavoriteWhenBuddyRemoved) {
                    await mutateFavorites({ kind: 'remove', cid: pageCid });
                }
            }
        } catch { /* preserve the last valid cache and custom list on any failure */ }
    };

    const pendingBuddyMutation = takePendingBuddyMutation();
    installBuddyMutationListener();
    void refreshAfterBuddyMutation(pendingBuddyMutation);

    const injectStyle = () => {
        if (document.getElementById('bpb-climber-favorite-style')) return;
        const style = document.createElement('style');
        style.id = 'bpb-climber-favorite-style';
        style.textContent = `
#TitleLabel.bpb-climber-favorite-host { display: inline-flex; align-items: center; justify-content: center;
    flex-wrap: wrap; gap: 8px; max-width: 100%; vertical-align: middle; }
#TitleLabel.bpb-climber-favorite-host > h1 { flex: 0 1 auto; min-width: 0; }
#bpb-climber-favorite { appearance: none; display: inline-flex; flex: 0 0 auto; align-items: center;
    justify-content: center; width: 30px; height: 30px; margin: 0; padding: 0 0 2px;
    border: 1px solid #8fab96; border-radius: 50%; background: #f3f8f4; color: #2f6b3f;
    font: 700 20px/1 Arial, Helvetica, sans-serif; cursor: pointer; }
#bpb-climber-favorite:hover { border-color: #2f6b3f; background: #e7f1e9; transform: translateY(-1px); }
#bpb-climber-favorite:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
#bpb-climber-favorite[aria-pressed="true"] { border-color: #2f6b3f; background: #2f6b3f; color: #fff; }
#bpb-climber-favorite:disabled { cursor: not-allowed; opacity: .58; }
#bpb-climber-favorite[aria-busy="true"] { cursor: wait; }
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
        const actionLabel = !active && additionBlocked() ? blockedReason() : active
            ? `Remove ${name} from your Better Peakbagger favorite`
            : `Add ${name} to your Better Peakbagger favorites`;
        button.textContent = active ? '★' : '☆';
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', actionLabel);
        setAttribute(button, 'aria-busy', String(busy));
        button.disabled = busy || (!active && (additionBlocked() || favorites.entries.length >= F.LIMIT));
        button.title = errorMessage || (!active && favorites.entries.length >= F.LIMIT
            ? `Favorites can hold up to ${F.LIMIT.toLocaleString('en-US')} climbers.`
            : actionLabel);
    };

    const unmount = () => {
        if (button) button.remove();
        button = null;
        host.classList.remove('bpb-climber-favorite-host');
    };

    const toggle = async () => {
        if (busy || button?.disabled) return;
        busy = true;
        errorMessage = '';
        paint();
        try {
            if (included()) {
                await mutateFavorites({ kind: 'remove', cid: pageCid });
            } else {
                await mutateFavorites({
                    kind: 'add',
                    entry: { cid: pageCid, name, addedAt: Date.now(), source: 'manual' },
                });
            }
        } catch (error) {
            errorMessage = error.message || 'Favorite climbers are unavailable. Try again.';
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
        mode = Schema.favoritesSource(settings.favoritesSource);
        mount();
    });
    observeClimberMembership(chrome, state => {
        membership = state;
        if (state.favorites) favorites = state.favorites;
        decorateBuddyControls(document);
        mount();
    });

    void S.get().then(settings => {
        mode = Schema.favoritesSource(settings.favoritesSource);
        favorites = membership?.favorites || favorites;
        mount();
    }).catch(() => { unmount(); });
})();
