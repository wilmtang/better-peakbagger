// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from '../src/favorites/ignored-climbers.js';
import { observeIgnored, mutateIgnored } from '../src/favorites/ignored-client.js';
import { favoriteClimbers as F } from '../src/favorites/favorite-climbers.js';
import { fetchPeakbaggerDocument } from '../src/peakbagger/peakbagger-request.js';
import { isPeakbaggerUrl } from '../src/peakbagger/peakbagger-origin.js';

export const initIgnored = api => {
    void api.runtime.sendMessage({ type: 'GITHUB_IGNORED_LIST', action: 'check' }).catch(() => {});
    const el = id => document.getElementById(id);
    const listEl = el('ignored-list');
    if (!listEl) return;
    let list = null, error = '', busy = false, undo = null;
    const message = el('ignored-status');
    const search = el('ignored-search'), sort = el('ignored-sort');
    const undoButton = el('ignored-undo-button');
    const announce = value => { message.textContent = value; };
    const render = () => {
        const focused = document.activeElement;
        const focusedRow = listEl.contains(focused) ? focused.closest('[data-cid]') : null;
        const focusedIndex = [...listEl.children].indexOf(focusedRow);
        const entries = list?.entries || [];
        el('ignored-tab').textContent = `Ignored · ${entries.length}`;
        el('ignored-count').textContent = `${entries.length} ignored climber${entries.length === 1 ? '' : 's'}`;
        el('ignored-add-button').disabled = busy || !list;
        listEl.setAttribute('aria-busy', String(busy));
        undoButton.setAttribute('aria-disabled', String(busy));
        const matches = entries.map(entry => ({ entry, score: F.fuzzyScore(entry, search.value) }))
            .filter(item => item.score != null).sort((a, b) => (search.value.trim() ? a.score - b.score : 0)
                || (sort.value === 'name' ? F.byName(a.entry, b.entry) : F.byAddedAtDesc(a.entry, b.entry)));
        listEl.replaceChildren();
        for (const { entry } of matches) {
            const row = document.createElement('li'); row.className = 'favorite-item'; row.dataset.cid = String(entry.cid);
            const info = document.createElement('span'); info.className = 'favorite-body';
            const name = document.createElement('a'); name.className = 'favorite-name'; name.href = F.climberPageUrl(entry.cid);
            name.target = '_blank'; name.rel = 'noopener noreferrer'; name.textContent = entry.name;
            const meta = document.createElement('span'); meta.className = 'favorite-meta';
            meta.textContent = `#${entry.cid} · Added ${new Date(entry.addedAt).toLocaleDateString()}`;
            info.append(name, meta);
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'favorite-remove';
            remove.textContent = 'Unignore'; remove.setAttribute('aria-label', `Unignore ${entry.name}`);
            // Keep the focused control available while saving. Native disabled
            // buttons cannot regain focus after this list is rendered again.
            remove.setAttribute('aria-disabled', String(busy));
            remove.addEventListener('click', async () => {
                if (busy) return;
                busy = true; render();
                try {
                    const result = await mutateIgnored(api, { kind: 'remove', cid: entry.cid,
                        expectedEntry: I.entrySignature(entry) });
                    accept(result.list); undo = entry; el('ignored-undo').hidden = false;
                    announce(`${entry.name} unignored.`);
                } catch (failure) { announce(failure.message); }
                finally { busy = false; render(); }
            });
            row.append(info, remove); listEl.append(row);
        }
        el('ignored-empty').hidden = matches.length > 0;
        el('ignored-empty').textContent = error || (!list ? 'Loading ignored climbers…'
            : entries.length ? 'No matching ignored climbers.' : 'No ignored climbers yet.');
        el('ignored-retry').hidden = !error;
        if (focusedRow) {
            const row = listEl.querySelector(`[data-cid="${focusedRow.dataset.cid}"]`)
                || listEl.children[Math.min(focusedIndex, listEl.children.length - 1)];
            (row?.querySelector(focused.matches('a') ? 'a' : 'button')
                || el('ignored-add-input')).focus({ preventScroll: true });
        }
    };
    const accept = next => { if (!list || next.revision >= list.revision) list = next; };
    const observer = observeIgnored(api, state => { if (state.list) accept(state.list); error = state.error; render(); });
    search.addEventListener('input', render); sort.addEventListener('change', render);
    el('ignored-retry').addEventListener('click', () => { void observer.refresh(); });
    el('ignored-add-form').addEventListener('submit', async event => {
        event.preventDefault(); if (busy || !list) return;
        const raw = el('ignored-add-input').value.trim();
        const cid = /^\d+$/.test(raw) ? Number(raw) : I.profileId(raw);
        if (!I.validCid(cid)) return announce('Enter a climber id or Peakbagger climber-page link.');
        const existing = list.entries.find(entry => entry.cid === cid);
        if (existing) {
            search.value = ''; render(); listEl.querySelector(`[data-cid="${cid}"] button`)?.focus();
            return announce('Already ignored.');
        }
        busy = true; render(); announce('Loading climber…');
        try {
            const result = await fetchPeakbaggerDocument(F.climberPageUrl(cid), { kind: 'climber' });
            if (result.kind !== 'ok') throw new Error("Couldn't load this climber. Try again.");
            const doc = result.document;
            const ids = new Set([...doc.querySelectorAll('a[href]')].filter(a => {
                try { const url = new URL(a.href, doc.baseURI); return isPeakbaggerUrl(url.href)
                    && /^\/climber\/climblistc\.aspx$/i.test(url.pathname)
                    && !/^My Ascents$/i.test(a.textContent.trim()); } catch { return false; }
            }).map(a => Number(new URL(a.href, doc.baseURI).searchParams.get('cid'))));
            const name = F.climberNameFromDocument(doc);
            if (ids.size !== 1 || !ids.has(cid) || !name) throw new Error("Couldn't confirm this climber's identity.");
            if ([...doc.querySelectorAll(F.BUDDY_CONTROL_SELECTOR)].some(control => F.buddyControlAction(control) === 'remove')) {
                throw new Error(`${name}: Remove from your Buddy List before ignoring.`);
            }
            const response = await mutateIgnored(api, { kind: 'add', entry: { cid, name, addedAt: Date.now() } });
            accept(response.list); el('ignored-add-input').value = '';
            announce(response.alreadyPresent ? 'Already ignored.' : `${name} added to ignored climbers.`);
        } catch (failure) { announce(failure.message); }
        finally { busy = false; render(); }
    });
    undoButton.addEventListener('click', async () => {
        if (!undo || busy) return;
        const entry = undo;
        let restoreFocus = false;
        busy = true; render();
        try {
            const response = await mutateIgnored(api, { kind: 'add', entry, expectedEntry: 'absent' });
            restoreFocus = document.activeElement === undoButton;
            accept(response.list); undo = null; el('ignored-undo').hidden = true; announce('Ignore restored.');
        } catch (failure) { announce(failure.message); }
        finally {
            busy = false; render();
            if (restoreFocus) (listEl.querySelector(`[data-cid="${entry.cid}"] button`)
                || el('ignored-add-input')).focus({ preventScroll: true });
        }
    });
    const tabs = [el('favorites-tab'), el('ignored-tab')];
    const activate = index => {
        tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
        el('favorites-workspace').hidden = index !== 0; el('ignored-workspace').hidden = index !== 1;
    };
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => { location.hash = index ? 'ignored' : 'favorites'; activate(index); });
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
            activate(next); tabs[next].focus();
        });
    });
    window.addEventListener('hashchange', () => activate(location.hash === '#ignored' ? 1 : 0));
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[F.FAVORITES_KEY]) {
            tabs[0].textContent = `Favorites · ${F.cleanFavorites(changes[F.FAVORITES_KEY].newValue).entries.length}`;
        }
    });
    void api.storage.local.get(F.FAVORITES_KEY).then(value => {
        tabs[0].textContent = `Favorites · ${F.cleanFavorites(value[F.FAVORITES_KEY]).entries.length}`;
    }).catch(() => {});
    activate(location.hash === '#ignored' ? 1 : 0); render();
};
