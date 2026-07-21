// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — Favorite climbers settings manager.

import { favoriteClimbers as F } from '../src/favorite-climbers.js';
import { classifyResponse, numericParam, ownerClimberId } from '../src/profile-backup-core.js';

const UNDO_MS = 6000;
const PEAKBAGGER_ORIGIN = 'https://www.peakbagger.com';

export const initFavorites = ({ extensionApi, flash, save } = {}) => {
    const store = extensionApi?.storage?.local;
    const sourceEls = Array.from(document.querySelectorAll('input[name="favorites-source"]'));
    const buddyPanelEl = document.getElementById('favorites-buddy-panel');
    const customPanelEl = document.getElementById('favorites-custom-panel');
    const buddyStatusEl = document.getElementById('favorites-buddy-status');
    const refreshBuddiesEl = document.getElementById('favorites-refresh-buddies');
    const addFormEl = document.getElementById('favorites-add-form');
    const addInputEl = document.getElementById('favorites-add-input');
    const addButtonEl = document.getElementById('favorites-add-button');
    const sortEl = document.getElementById('favorites-sort');
    const mergeEl = document.getElementById('favorites-merge-buddies');
    const mirrorEl = document.getElementById('favorites-mirror-buddies');
    const emptyEl = document.getElementById('favorites-empty');
    const listEl = document.getElementById('favorites-list');
    const undoAllEl = document.getElementById('favorites-undo-all');
    const undoMessageEl = document.getElementById('favorites-undo-message');
    const undoAllButtonEl = document.getElementById('favorites-undo-all-button');

    if (!store || !sourceEls.length || !buddyPanelEl || !customPanelEl || !buddyStatusEl
        || !refreshBuddiesEl || !addFormEl || !addInputEl || !addButtonEl || !sortEl
        || !mergeEl || !mirrorEl || !emptyEl || !listEl || !undoAllEl || !undoMessageEl
        || !undoAllButtonEl) return { populate() {} };

    let source = 'buddies';
    let favorites = F.cleanFavorites(null);
    let buddyCache = null;
    let buddyState = 'idle';
    let buddyError = '';
    let refreshPromise = null;
    let refreshRevision = 0;
    let refreshTimer = null;
    let pendingBulk = null;
    const pendingDeletes = new Map();

    const relativeAge = fetchedAt => {
        const elapsed = Math.max(0, Date.now() - fetchedAt);
        const minutes = Math.floor(elapsed / 60000);
        if (minutes < 1) return 'updated just now';
        if (minutes < 60) return `updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        return `updated ${days} day${days === 1 ? '' : 's'} ago`;
    };

    const setBusy = busy => {
        refreshBuddiesEl.disabled = busy;
        mergeEl.disabled = busy;
        mirrorEl.disabled = busy;
    };

    const appendPeakbaggerLink = (label = 'Open Peakbagger') => {
        const link = document.createElement('a');
        link.href = `${PEAKBAGGER_ORIGIN}/Default.aspx`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = label;
        buddyStatusEl.append(' ', link);
    };

    const renderBuddyStatus = () => {
        buddyStatusEl.textContent = '';
        if (buddyState === 'loading') {
            buddyStatusEl.textContent = 'Refreshing…';
            return;
        }
        if (buddyCache) {
            const count = buddyCache.entries.length;
            buddyStatusEl.textContent = `${count} ${count === 1 ? 'buddy' : 'buddies'} · ${relativeAge(buddyCache.fetchedAt)}`;
            if (buddyError === 'signed-out') {
                buddyStatusEl.append(' · Sign in to update.');
                appendPeakbaggerLink('Sign in to Peakbagger');
            } else if (buddyError) {
                buddyStatusEl.append(' · Refresh failed.');
                appendPeakbaggerLink();
            }
            return;
        }
        if (buddyError === 'signed-out') {
            buddyStatusEl.textContent = 'Sign in to Peakbagger to load your Buddy List.';
            appendPeakbaggerLink('Sign in to Peakbagger');
        } else if (buddyError) {
            buddyStatusEl.textContent = "Your Buddy List couldn't be loaded.";
            appendPeakbaggerLink();
        } else {
            buddyStatusEl.textContent = 'Never loaded';
        }
    };

    const sourceLabel = value => value === 'buddy' ? 'Buddy' : 'Manual';
    const addedLabel = addedAt => new Date(addedAt).toLocaleDateString([], {
        year: 'numeric', month: 'short', day: 'numeric'
    });

    const actionButton = (className, text, ariaLabel) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = text;
        button.setAttribute('aria-label', ariaLabel);
        return button;
    };

    const renderFavoriteRow = entry => {
        const item = document.createElement('li');
        item.className = 'favorite-item';
        item.dataset.cid = String(entry.cid);
        const body = document.createElement('div');
        body.className = 'favorite-body';
        const name = document.createElement('a');
        name.className = 'favorite-name';
        name.href = F.climberPageUrl(entry.cid);
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
        name.textContent = entry.name;
        const meta = document.createElement('p');
        meta.className = 'favorite-meta';
        const tag = document.createElement('span');
        tag.className = 'favorite-source-tag';
        tag.textContent = sourceLabel(entry.source);
        meta.append(`#${entry.cid}`, ' · ', `Added ${addedLabel(entry.addedAt)}`, tag);
        body.append(name, meta);
        const remove = actionButton('favorite-remove', 'Delete', `Remove ${entry.name} from favorites`);
        remove.dataset.action = 'delete';
        remove.addEventListener('click', () => { void beginDelete(entry); });
        item.append(body, remove);
        return item;
    };

    const renderDeletedRow = entry => {
        const item = document.createElement('li');
        item.className = 'favorite-item favorite-item-deleted';
        item.dataset.cid = String(entry.cid);
        const message = document.createElement('span');
        message.textContent = 'Favorite removed';
        const undo = actionButton('favorite-undo', 'Undo', `Restore ${entry.name} to favorites`);
        undo.dataset.action = 'undo';
        undo.addEventListener('click', () => { void undoDelete(entry.cid); });
        item.append(message, undo);
        return item;
    };

    const renderList = () => {
        const compare = sortEl.value === 'name' ? F.byName : F.byAddedAtDesc;
        const rows = favorites.entries
            .filter(entry => !pendingDeletes.has(entry.cid))
            .map(entry => ({ entry, item: renderFavoriteRow(entry) }));
        for (const pending of pendingDeletes.values()) {
            rows.push({ entry: pending.entry, item: renderDeletedRow(pending.entry) });
        }
        rows.sort((left, right) => compare(left.entry, right.entry));
        listEl.textContent = '';
        listEl.append(...rows.map(row => row.item));
        listEl.hidden = rows.length === 0;
        emptyEl.hidden = rows.length > 0;
        undoAllEl.hidden = !pendingBulk;
    };

    const renderPanels = () => {
        for (const radio of sourceEls) radio.checked = radio.value === source;
        buddyPanelEl.hidden = source !== 'buddies';
        customPanelEl.hidden = source !== 'custom';
        renderBuddyStatus();
        renderList();
    };

    const writeFavorites = async value => {
        const previous = favorites;
        favorites = F.cleanFavorites(value);
        renderList();
        try {
            await store.set({ [F.FAVORITES_KEY]: favorites });
            return favorites;
        } catch (error) {
            favorites = previous;
            renderList();
            throw error;
        }
    };

    const refresh = async () => {
        const revision = ++refreshRevision;
        try {
            const values = await store.get([F.FAVORITES_KEY, F.BUDDY_CACHE_KEY]);
            if (revision !== refreshRevision) return;
            favorites = F.cleanFavorites(values[F.FAVORITES_KEY]);
            buddyCache = F.cleanBuddyCache(values[F.BUDDY_CACHE_KEY]);
            renderPanels();
        } catch (error) {
            if (revision !== refreshRevision) return;
            flash('Favorite climbers are unavailable');
        }
    };

    const readResponse = async url => {
        const response = await fetch(url, { credentials: 'include' });
        const text = await response.text();
        return { response, text };
    };

    const loadSignedInOwner = async () => {
        const { response, text } = await readResponse(`${PEAKBAGGER_ORIGIN}/Default.aspx`);
        const classification = classifyResponse(response.status, response.headers, text, { kind: 'climber' });
        if (classification === 'challenged' || classification === 'transient'
            || response.status < 200 || response.status >= 300) throw Object.assign(new Error('unreachable'), { code: 'unreachable' });
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const cid = ownerClimberId(doc);
        if (cid == null) throw Object.assign(new Error('signed out'), { code: 'signed-out' });
        return cid;
    };

    const refreshBuddies = (force = false) => {
        if (refreshPromise) return refreshPromise;
        buddyState = 'loading';
        buddyError = '';
        setBusy(true);
        renderBuddyStatus();
        refreshPromise = (async () => {
            const ownerCid = await loadSignedInOwner();
            if (!force && buddyCache && buddyCache.ownerCid === ownerCid && F.isFresh(buddyCache)) return buddyCache;
            const url = F.buddyListUrl(ownerCid, PEAKBAGGER_ORIGIN);
            const { response, text } = await readResponse(url);
            if (classifyResponse(response.status, response.headers, text, { kind: 'buddies' }) !== 'ok') {
                throw Object.assign(new Error('unreachable'), { code: 'unreachable' });
            }
            const doc = new DOMParser().parseFromString(text, 'text/html');
            const next = { ownerCid, entries: F.parseBuddyDocument(doc), fetchedAt: Date.now() };
            buddyCache = next;
            await store.set({ [F.BUDDY_CACHE_KEY]: next });
            return next;
        })().catch(error => {
            buddyError = error && error.code === 'signed-out' ? 'signed-out' : 'unreachable';
            return null;
        }).finally(() => {
            buddyState = 'idle';
            refreshPromise = null;
            setBusy(false);
            renderBuddyStatus();
        });
        return refreshPromise;
    };

    const beginDelete = async entry => {
        if (pendingDeletes.has(entry.cid)) return;
        const pending = { entry, timer: null };
        pending.timer = globalThis.setTimeout(() => {
            pendingDeletes.delete(entry.cid);
            renderList();
        }, UNDO_MS);
        pendingDeletes.set(entry.cid, pending);
        try {
            await writeFavorites({
                schemaVersion: F.SCHEMA_VERSION,
                entries: favorites.entries.filter(candidate => candidate.cid !== entry.cid),
            });
        } catch (error) {
            globalThis.clearTimeout(pending.timer);
            pendingDeletes.delete(entry.cid);
            renderList();
            flash("Couldn't remove the favorite");
        }
    };

    const undoDelete = async cid => {
        const pending = pendingDeletes.get(cid);
        if (!pending) return;
        try {
            await writeFavorites({
                schemaVersion: F.SCHEMA_VERSION,
                entries: [pending.entry, ...favorites.entries.filter(entry => entry.cid !== cid)],
            });
            globalThis.clearTimeout(pending.timer);
            pendingDeletes.delete(cid);
            renderList();
            flash('Favorite restored');
        } catch (error) {
            flash("Couldn't restore the favorite");
        }
    };

    const beginReplacement = async (next, message) => {
        if (pendingBulk) globalThis.clearTimeout(pendingBulk.timer);
        const pending = { snapshot: favorites, message, timer: null };
        try {
            await writeFavorites(next);
        } catch (error) {
            flash("Couldn't update favorites");
            return false;
        }
        pending.timer = globalThis.setTimeout(() => {
            if (pendingBulk === pending) pendingBulk = null;
            renderList();
        }, UNDO_MS);
        pendingBulk = pending;
        undoMessageEl.textContent = message;
        renderList();
        return true;
    };

    const undoReplacement = async () => {
        if (!pendingBulk) return;
        const pending = pendingBulk;
        try {
            await writeFavorites(pending.snapshot);
            globalThis.clearTimeout(pending.timer);
            pendingBulk = null;
            renderList();
            flash('Custom favorites restored');
        } catch (error) {
            flash("Couldn't restore favorites");
        }
    };

    const addClimber = async () => {
        const cid = F.parseClimberInput(addInputEl.value);
        if (cid == null) {
            flash('Enter a climber id or Peakbagger climber-page link');
            return;
        }
        if (favorites.entries.some(entry => entry.cid === cid)) {
            flash('That climber is already in your favorites');
            return;
        }
        addButtonEl.disabled = true;
        try {
            const { response, text } = await readResponse(F.climberPageUrl(cid));
            if (classifyResponse(response.status, response.headers, text, { kind: 'climber' }) !== 'ok') {
                if (response.status === 404) throw Object.assign(new Error('not found'), { code: 'not-found' });
                throw Object.assign(new Error('unreachable'), { code: 'unreachable' });
            }
            const doc = new DOMParser().parseFromString(text, 'text/html');
            const identityLink = doc.querySelector('a[href*="ClimbListC.aspx?cid="], a[href*="climblistc.aspx?cid="]');
            const pageCid = identityLink ? numericParam(identityLink.href, 'cid', doc.baseURI) : null;
            const name = F.climberNameFromDocument(doc);
            if (pageCid !== cid || !name) throw Object.assign(new Error('not found'), { code: 'not-found' });
            if (favorites.entries.length >= F.LIMIT) {
                flash(`Favorites can hold up to ${F.LIMIT} climbers`);
                return;
            }
            await writeFavorites({
                schemaVersion: F.SCHEMA_VERSION,
                entries: [{ cid, name, addedAt: Date.now(), source: 'manual' }, ...favorites.entries],
            });
            addInputEl.value = '';
            flash(`${name} added to favorites`);
        } catch (error) {
            flash(error && error.code === 'not-found'
                ? `No climber page found for ID ${cid}.`
                : "Couldn't reach Peakbagger. Try again.");
        } finally {
            addButtonEl.disabled = false;
        }
    };

    refreshBuddiesEl.addEventListener('click', () => {
        void refreshBuddies(true).then(cache => { if (cache) flash('Buddy List refreshed'); });
    });
    addFormEl.addEventListener('submit', event => { event.preventDefault(); void addClimber(); });
    sortEl.addEventListener('change', renderList);
    mergeEl.addEventListener('click', () => {
        void refreshBuddies(false).then(async cache => {
            if (!cache) {
                flash(buddyError === 'signed-out'
                    ? 'Sign in to Peakbagger, then try again'
                    : "Couldn't reach Peakbagger. Try again.");
                return;
            }
            const before = favorites.entries.length;
            const next = F.mergeBuddies(favorites, cache.entries);
            const added = next.entries.length - before;
            if (!added) {
                flash('Your favorites already include all buddies');
                return;
            }
            try {
                await writeFavorites(next);
                flash(`Added ${added} ${added === 1 ? 'buddy' : 'buddies'}`);
            } catch (error) {
                flash("Couldn't merge buddies");
            }
        });
    });
    mirrorEl.addEventListener('click', () => {
        void refreshBuddies(false).then(async cache => {
            if (!cache) {
                flash(buddyError === 'signed-out'
                    ? 'Sign in to Peakbagger, then try again'
                    : "Couldn't reach Peakbagger. Try again.");
                return;
            }
            const changed = await beginReplacement(F.mirrorBuddies(cache.entries), 'Custom list replaced with your Buddy List');
            if (changed) flash('Buddy List mirrored');
        });
    });
    undoAllButtonEl.addEventListener('click', () => { void undoReplacement(); });

    for (const radio of sourceEls) {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            source = radio.value === 'custom' ? 'custom' : 'buddies';
            renderPanels();
            void save({ favoritesSource: source });
        });
    }

    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || (!changes[F.FAVORITES_KEY] && !changes[F.BUDDY_CACHE_KEY])) return;
            globalThis.clearTimeout(refreshTimer);
            refreshTimer = globalThis.setTimeout(() => { void refresh(); }, 20);
        });
    }

    void refresh();

    return {
        populate(settings) {
            source = settings && settings.favoritesSource === 'custom' ? 'custom' : 'buddies';
            renderPanels();
        },
    };
};
