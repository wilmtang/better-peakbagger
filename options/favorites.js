// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — Favorite climbers settings manager.

import { favoriteClimbers as F } from '../src/favorite-climbers.js';
import { githubError as GithubError } from '../src/github-error.js';
import { peakbaggerError as PeakbaggerError } from '../src/peakbagger-error.js';
import { fetchPeakbaggerDocument } from '../src/peakbagger-request.js';
import { numericParam, ownerClimberId } from '../src/profile-backup-core.js';
import { hasGithubPermission } from './github.js';

const UNDO_MS = 6000;
const SITE_TAB_REFRESH_MS = 8000;
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
    const limitEl = document.getElementById('favorites-limit');
    const sortEl = document.getElementById('favorites-sort');
    const mergeEl = document.getElementById('favorites-merge-buddies');
    const mirrorEl = document.getElementById('favorites-mirror-buddies');
    const importStatusEl = document.getElementById('favorites-import-status');
    const mirrorConfirmationEl = document.getElementById('favorites-mirror-confirmation');
    const mirrorConfirmationImpactEl = document.getElementById('favorites-mirror-confirmation-impact');
    const mirrorConfirmationSummaryEl = document.getElementById('favorites-mirror-confirmation-summary');
    const mirrorCancelEl = document.getElementById('favorites-mirror-cancel');
    const mirrorConfirmEl = document.getElementById('favorites-mirror-confirm');
    const emptyEl = document.getElementById('favorites-empty');
    const listEl = document.getElementById('favorites-list');
    const undoAllEl = document.getElementById('favorites-undo-all');
    const undoMessageEl = document.getElementById('favorites-undo-message');
    const undoAllButtonEl = document.getElementById('favorites-undo-all-button');
    const githubStatusEl = document.getElementById('favorites-github-status');
    const githubActionsEl = document.getElementById('favorites-github-actions');
    const backupEl = document.getElementById('favorites-backup');
    const restoreEl = document.getElementById('favorites-restore');

    if (!store || !sourceEls.length || !buddyPanelEl || !customPanelEl || !buddyStatusEl
        || !refreshBuddiesEl || !addFormEl || !addInputEl || !addButtonEl || !limitEl || !sortEl
        || !mergeEl || !mirrorEl || !importStatusEl || !mirrorConfirmationEl
        || !mirrorConfirmationImpactEl || !mirrorConfirmationSummaryEl
        || !mirrorCancelEl || !mirrorConfirmEl
        || !emptyEl || !listEl || !undoAllEl || !undoMessageEl
        || !undoAllButtonEl || !githubStatusEl || !githubActionsEl || !backupEl
        || !restoreEl) return { populate() {} };

    limitEl.textContent = F.LIMIT.toLocaleString('en-US');

    let source = 'buddies';
    let favorites = F.cleanFavorites(null);
    let buddyCache = null;
    let buddyState = 'idle';
    let buddyError = null;
    let refreshPromise = null;
    let refreshRevision = 0;
    let refreshTimer = null;
    let pendingBulk = null;
    let pendingMirror = null;
    let githubStatus = null;
    let githubBusy = false;
    let githubRevision = 0;
    let githubBackupResult = null;
    const pendingDeletes = new Map();

    const send = message => new Promise(resolve => {
        try {
            extensionApi.runtime.sendMessage(message, response => {
                void extensionApi.runtime.lastError;
                resolve(response || null);
            });
        } catch { resolve(null); }
    });

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

    const appendPeakbaggerLink = (target, {
        label = 'Open Buddy List',
        href = F.signedInBuddyListUrl(PEAKBAGGER_ORIGIN),
    } = {}) => {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = label;
        target.append(' ', link);
    };

    const appendBuddyRecovery = (error, target = buddyStatusEl) => {
        const recovery = PeakbaggerError.recovery(error, {
            url: F.signedInBuddyListUrl(PEAKBAGGER_ORIGIN),
            label: 'Open Buddy List',
        });
        if (recovery) appendPeakbaggerLink(target, recovery);
    };

    const renderImportStatus = (message = '', error = null) => {
        importStatusEl.textContent = message;
        importStatusEl.hidden = !message;
        if (message && error) appendBuddyRecovery(error, importStatusEl);
    };

    const favoritesSignature = () => JSON.stringify(favorites.entries);

    const membershipChanges = (currentEntries, nextEntries) => {
        const currentIds = new Set(currentEntries.map(entry => entry.cid));
        const nextIds = new Set(nextEntries.map(entry => entry.cid));
        return {
            added: nextEntries.filter(entry => !currentIds.has(entry.cid)).length,
            removed: currentEntries.filter(entry => !nextIds.has(entry.cid)).length,
        };
    };

    const completionCopy = (operation, { added, removed, total, skipped = 0 }) => {
        const climbers = total === 1 ? 'climber' : 'climbers';
        const skippedCopy = skipped > 0
            ? ` ${skipped} ${skipped === 1 ? 'buddy was' : 'buddies were'} not added because custom favorites can hold up to ${F.LIMIT.toLocaleString('en-US')} climbers.`
            : '';
        return `${operation} complete: ${added} added, ${removed} removed. Custom list now has ${total} ${climbers}.${skippedCopy}`;
    };

    const dismissMirrorConfirmation = ({ restoreFocus = false } = {}) => {
        pendingMirror = null;
        mirrorConfirmationEl.hidden = true;
        if (restoreFocus && !mirrorEl.disabled) mirrorEl.focus();
    };

    const showMirrorConfirmation = (buddyEntries, { focus = true } = {}) => {
        const { added, removed } = membershipChanges(favorites.entries, buddyEntries);
        const buddyCount = buddyEntries.length;
        mirrorConfirmationImpactEl.textContent = `${added} ${added === 1 ? 'buddy' : 'buddies'} will be added. ${removed} custom ${removed === 1 ? 'favorite' : 'favorites'} will be removed.`;
        mirrorConfirmationSummaryEl.textContent = ` The custom list will then exactly match your ${buddyCount} current ${buddyCount === 1 ? 'buddy' : 'buddies'}. You can undo for 6 seconds after replacement.`;
        mirrorConfirmEl.textContent = 'Replace custom list';
        pendingMirror = {
            buddyEntries: buddyEntries.map(entry => ({ ...entry })),
            favoritesSignature: favoritesSignature(),
            added,
            removed,
        };
        mirrorConfirmationEl.hidden = false;
        if (focus) mirrorCancelEl.focus();
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
            if (buddyError) {
                buddyStatusEl.append(` · ${PeakbaggerError.message(buddyError)}`);
                appendBuddyRecovery(buddyError);
            }
            return;
        }
        if (buddyError) {
            buddyStatusEl.textContent = PeakbaggerError.message(buddyError);
            appendBuddyRecovery(buddyError);
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

    const githubRepoName = () => githubStatus?.repo?.fullName
        || (githubStatus?.repo?.owner && githubStatus?.repo?.name
            ? `${githubStatus.repo.owner}/${githubStatus.repo.name}`
            : 'the connected repository');

    const renderGithub = () => {
        const connected = !!(githubStatus?.permissionGranted && githubStatus?.connected);
        const showBackupResult = connected
            && githubBackupResult?.repo === githubRepoName()
            && githubBackupResult?.signature === favoritesSignature();
        githubActionsEl.hidden = !connected;
        backupEl.disabled = githubBusy;
        restoreEl.disabled = githubBusy;
        githubStatusEl.classList.remove('favorites-github-success');
        githubStatusEl.textContent = '';
        if (githubBusy) {
            githubStatusEl.textContent = 'Working with GitHub…';
        } else if (showBackupResult) {
            githubStatusEl.classList.add('favorites-github-success');
            githubStatusEl.textContent = 'Favorites backed up ✓';
            if (githubBackupResult.commitUrl) {
                githubStatusEl.append(' ', Object.assign(document.createElement('a'), {
                    href: githubBackupResult.commitUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    textContent: 'View commit',
                }));
            }
        } else if (connected) {
            githubStatusEl.textContent = `Save or restore this custom list in ${githubRepoName()}.`;
        } else {
            githubStatusEl.append(Object.assign(document.createElement('a'), {
                href: '#github-connection', textContent: 'Connect GitHub',
            }), ' to move this custom list between browsers.');
        }
    };

    const refreshGithubStatus = async () => {
        const revision = ++githubRevision;
        const [status, permissionGranted] = await Promise.all([
            send({ type: 'GITHUB_AUTH_STATUS' }),
            hasGithubPermission(extensionApi),
        ]);
        if (revision !== githubRevision) return;
        githubStatus = { ...(status || {}), permissionGranted };
        renderGithub();
    };

    const writeFavorites = async value => {
        const previous = favorites;
        favorites = F.cleanFavorites(value);
        renderList();
        renderGithub();
        try {
            await store.set({ [F.FAVORITES_KEY]: favorites });
            return favorites;
        } catch (error) {
            favorites = previous;
            renderList();
            renderGithub();
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
            renderGithub();
            if (pendingMirror) showMirrorConfirmation(pendingMirror.buddyEntries, { focus: false });
        } catch (error) {
            if (revision !== refreshRevision) return;
            flash('Favorite climbers are unavailable');
        }
    };

    const loadSignedInBuddies = async () => {
        const url = F.signedInBuddyListUrl(PEAKBAGGER_ORIGIN);
        const result = await fetchPeakbaggerDocument(url, { kind: 'buddies' });
        if (result.kind !== 'ok') {
            if (result.error?.code === 'signed-out') {
                const pageCache = await loadBuddiesInSiteTab();
                if (pageCache) return pageCache;
            }
            throw result.error;
        }
        const ownerCid = ownerClimberId(result.document);
        if (ownerCid == null) throw PeakbaggerError.failure('signed-out', { resource: 'buddies' });
        return { ownerCid, entries: F.parseBuddyDocument(result.document) };
    };

    const loadBuddiesInSiteTab = async () => {
        const tabs = extensionApi.tabs;
        const changes = extensionApi.storage.onChanged;
        const helperUrl = extensionApi.runtime.getURL?.('options/buddy-refresh.html');
        if (!helperUrl || !tabs?.create || !tabs?.update || !tabs?.remove
            || !changes?.addListener || !changes?.removeListener) return null;

        const promiseTabs = typeof globalThis.browser !== 'undefined'
            && extensionApi === globalThis.browser;
        const createTab = details => promiseTabs
            ? tabs.create(details)
            : new Promise((resolve, reject) => {
                tabs.create(details, created => {
                    const error = extensionApi.runtime.lastError;
                    if (error) reject(new Error(error.message || 'Could not open the Buddy List.'));
                    else resolve(created);
                });
            });
        const removeTab = tabId => {
            if (promiseTabs) {
                void tabs.remove(tabId).catch(() => {});
                return;
            }
            tabs.remove(tabId, () => { void extensionApi.runtime.lastError; });
        };
        const navigateTab = (tabId, url) => {
            if (promiseTabs) {
                void tabs.update(tabId, { url, active: false }).catch(() => {});
                return;
            }
            tabs.update(tabId, { url, active: false }, () => {
                void extensionApi.runtime.lastError;
            });
        };

        const startedAt = Date.now();
        let listener = null;
        let timer = null;
        let tab = null;
        const cachePromise = new Promise(resolve => {
            const finish = value => {
                if (timer != null) globalThis.clearTimeout(timer);
                if (listener) changes.removeListener(listener);
                listener = null;
                timer = null;
                resolve(value);
            };
            listener = (updates, area) => {
                if (area !== 'local' || !updates[F.BUDDY_CACHE_KEY]) return;
                const cache = F.cleanBuddyCache(updates[F.BUDDY_CACHE_KEY].newValue);
                if (cache && cache.fetchedAt >= startedAt) finish(cache);
            };
            changes.addListener(listener);
            timer = globalThis.setTimeout(() => finish(null), SITE_TAB_REFRESH_MS);
        });

        try {
            // Chrome can leave an inactive tab at about:blank when create()
            // receives a URL whose load does not settle. Create a literal
            // blank tab first, then start the extension-helper navigation
            // without making its callback part of the import lifecycle.
            tab = await createTab({ url: 'about:blank', active: false });
            if (!Number.isInteger(tab?.id)) return null;
            navigateTab(tab.id, helperUrl);
            return await cachePromise;
        } catch {
            return null;
        } finally {
            if (timer != null) globalThis.clearTimeout(timer);
            if (listener) changes.removeListener(listener);
            if (Number.isInteger(tab?.id)) {
                try { removeTab(tab.id); }
                catch { /* the user or browser already closed it */ }
            }
        }
    };

    const refreshBuddies = () => {
        if (refreshPromise) return refreshPromise;
        buddyState = 'loading';
        buddyError = null;
        setBusy(true);
        renderBuddyStatus();
        refreshPromise = (async () => {
            const { ownerCid, entries } = await loadSignedInBuddies();
            const next = { ownerCid, entries, fetchedAt: Date.now() };
            buddyCache = next;
            try {
                await store.set({ [F.BUDDY_CACHE_KEY]: next });
            } catch {
                buddyError = PeakbaggerError.failure('storage', { resource: 'buddies' });
            }
            return next;
        })().catch(error => {
            buddyError = error && error.code
                ? error
                : PeakbaggerError.failure('network', { resource: 'buddies' });
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

    const withGithubBusy = async operation => {
        if (githubBusy) return;
        githubBusy = true;
        renderGithub();
        try { await operation(); }
        finally { githubBusy = false; renderGithub(); }
    };

    const backupFavorites = () => withGithubBusy(async () => {
        const exported = {
            schemaVersion: F.SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            entries: F.cleanFavorites(favorites).entries,
        };
        const response = await send({
            type: 'GITHUB_FAVORITES_BACKUP',
            content: `${JSON.stringify(exported, null, 2)}\n`,
        });
        if (!response?.ok) {
            flash(GithubError.message(response?.error));
            return;
        }
        githubBackupResult = {
            ...(response.result || {}),
            repo: githubRepoName(),
            signature: favoritesSignature(),
        };
        flash(`Favorites backed up to ${githubRepoName()}`);
    });

    const restoreFavorites = () => withGithubBusy(async () => {
        const response = await send({ type: 'GITHUB_FAVORITES_RESTORE' });
        if (!response?.ok) {
            flash(GithubError.message(response?.error));
            return;
        }
        if (response.content == null) {
            flash(`No favorites backup found in ${githubRepoName()}.`);
            return;
        }
        let parsed;
        try { parsed = JSON.parse(response.content); }
        catch { parsed = null; }
        if (!parsed || parsed.schemaVersion !== F.SCHEMA_VERSION || !Array.isArray(parsed.entries)
            || parsed.entries.length > F.LIMIT
            || F.cleanFavorites(parsed).entries.length !== parsed.entries.length) {
            flash('This favorites backup is not valid or uses a newer format.');
            return;
        }
        const changed = await beginReplacement(F.cleanFavorites(parsed), 'Favorites restored from GitHub');
        if (changed) flash(`Favorites restored from ${githubRepoName()}`);
    });

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
        let name = '';
        try {
            const result = await fetchPeakbaggerDocument(F.climberPageUrl(cid), { kind: 'climber' });
            if (result.kind !== 'ok') throw result.error;
            const doc = result.document;
            const identityLink = doc.querySelector('a[href*="ClimbListC.aspx?cid="], a[href*="climblistc.aspx?cid="]');
            const pageCid = identityLink ? numericParam(identityLink.href, 'cid', doc.baseURI) : null;
            name = F.climberNameFromDocument(doc);
            if (pageCid !== cid || !name) throw PeakbaggerError.failure('not-found', { resource: 'climber' });
        } catch (error) {
            flash(PeakbaggerError.message(error, { resource: `climber page for ID ${cid}` }));
            addButtonEl.disabled = false;
            return;
        }
        if (favorites.entries.length >= F.LIMIT) {
            flash(`Favorites can hold up to ${F.LIMIT.toLocaleString('en-US')} climbers`);
            addButtonEl.disabled = false;
            return;
        }
        try {
            await writeFavorites({
                schemaVersion: F.SCHEMA_VERSION,
                entries: [{ cid, name, addedAt: Date.now(), source: 'manual' }, ...favorites.entries],
            });
            addInputEl.value = '';
            flash(`${name} added to favorites`);
        } catch {
            flash("The climber page loaded, but the favorite couldn't be saved on this device.");
        } finally {
            addButtonEl.disabled = false;
        }
    };

    refreshBuddiesEl.addEventListener('click', () => {
        void refreshBuddies().then(cache => {
            if (cache && !buddyError) flash('Buddy List refreshed');
            else if (buddyError) flash(PeakbaggerError.message(buddyError));
        });
    });
    addFormEl.addEventListener('submit', event => { event.preventDefault(); void addClimber(); });
    sortEl.addEventListener('change', renderList);
    mergeEl.addEventListener('click', () => {
        dismissMirrorConfirmation();
        renderImportStatus('Loading your Buddy List…');
        void refreshBuddies().then(async cache => {
            if (!cache) {
                const message = PeakbaggerError.message(buddyError);
                renderImportStatus(message, buddyError);
                flash(message);
                return;
            }
            const before = favorites.entries.length;
            const next = F.mergeBuddies(favorites, cache.entries);
            const added = next.entries.length - before;
            const missing = membershipChanges(favorites.entries, cache.entries).added;
            const skipped = missing - added;
            const summary = completionCopy('Merge', {
                added, removed: 0, total: next.entries.length, skipped,
            });
            if (!added) {
                renderImportStatus(summary);
                flash(skipped > 0 ? 'Custom favorites are full' : 'No changes to custom favorites');
                return;
            }
            try {
                await writeFavorites(next);
                renderImportStatus(summary);
                flash(`Merge complete: ${added} added, 0 removed`);
            } catch (error) {
                renderImportStatus("The Buddy List loaded, but the custom favorites couldn't be saved.");
                flash("Couldn't merge buddies");
            }
        });
    });
    mirrorEl.addEventListener('click', () => {
        dismissMirrorConfirmation();
        renderImportStatus('Loading your Buddy List…');
        void refreshBuddies().then(async cache => {
            if (!cache) {
                const message = PeakbaggerError.message(buddyError);
                renderImportStatus(message, buddyError);
                flash(message);
                return;
            }
            renderImportStatus();
            showMirrorConfirmation(cache.entries);
        });
    });
    mirrorCancelEl.addEventListener('click', () => { dismissMirrorConfirmation({ restoreFocus: true }); });
    mirrorConfirmEl.addEventListener('click', () => {
        if (!pendingMirror) return;
        if (pendingMirror.favoritesSignature !== favoritesSignature()) {
            showMirrorConfirmation(pendingMirror.buddyEntries);
            return;
        }
        const { buddyEntries, added, removed } = pendingMirror;
        setBusy(true);
        mirrorCancelEl.disabled = true;
        mirrorConfirmEl.disabled = true;
        renderImportStatus('Replacing custom favorites…');
        void beginReplacement(F.mirrorBuddies(buddyEntries), 'Custom list replaced with your Buddy List')
            .then(changed => {
                dismissMirrorConfirmation();
                if (changed) {
                    renderImportStatus(completionCopy('Mirror', {
                        added, removed, total: buddyEntries.length,
                    }));
                    flash(`Mirror complete: ${added} added, ${removed} removed`);
                } else {
                    renderImportStatus("The Buddy List loaded, but the custom favorites couldn't be saved.");
                }
            }).finally(() => {
                setBusy(false);
                mirrorCancelEl.disabled = false;
                mirrorConfirmEl.disabled = false;
            });
    });
    mirrorConfirmationEl.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        dismissMirrorConfirmation({ restoreFocus: true });
    });
    undoAllButtonEl.addEventListener('click', () => { void undoReplacement(); });
    backupEl.addEventListener('click', () => { void backupFavorites(); });
    restoreEl.addEventListener('click', () => { void restoreFavorites(); });

    for (const radio of sourceEls) {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            source = radio.value === 'custom' ? 'custom' : 'buddies';
            if (source !== 'custom') dismissMirrorConfirmation();
            renderPanels();
            void save({ favoritesSource: source });
        });
    }

    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && (changes[F.FAVORITES_KEY] || changes[F.BUDDY_CACHE_KEY])) {
                globalThis.clearTimeout(refreshTimer);
                refreshTimer = globalThis.setTimeout(() => { void refresh(); }, 20);
            }
            if (area === 'local' && changes.bpbGithubAuth) void refreshGithubStatus();
            if (area === 'sync' && changes.bpbSettings) void refreshGithubStatus();
        });
    }

    void refresh();
    void refreshGithubStatus();

    return {
        populate(settings) {
            source = settings && settings.favoritesSource === 'custom' ? 'custom' : 'buddies';
            if (source !== 'custom') dismissMirrorConfirmation();
            renderPanels();
            void refreshGithubStatus();
        },
    };
};
