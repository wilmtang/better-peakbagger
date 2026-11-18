// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from '../src/favorites/ignored-climbers.ts';
import type { IgnoredClimberEntry, IgnoredClimbersList } from '../src/favorites/ignored-climbers.ts';
import {
    observeIgnored,
    mutateIgnored,
    type IgnoredRuntimeApi,
    type IgnoredStorageApi,
} from '../src/favorites/ignored-client.ts';
import { favoriteClimbers as F } from '../src/favorites/favorite-climbers.ts';
import { fetchPeakbaggerDocument } from '../src/peakbagger/peakbagger-request.ts';
import { isPeakbaggerUrl } from '../src/peakbagger/peakbagger-origin.ts';
import { peakbaggerError } from '../src/peakbagger/peakbagger-error.ts';

export type IgnoredExtensionApi = (IgnoredStorageApi & IgnoredRuntimeApi) | typeof chrome;

const errorMessage = (failure: unknown): string => {
    if (failure instanceof Error) return failure.message;
    if (failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string') {
        return failure.message;
    }
    return String(failure);
};

export const initIgnored = (api: IgnoredExtensionApi): void => {
    const runtimeApi = api as unknown as IgnoredRuntimeApi;
    const storageApi = api as unknown as IgnoredStorageApi;
    void runtimeApi.runtime.sendMessage({ type: 'GITHUB_IGNORED_LIST', action: 'check' }).catch(() => {});
    const listEl = document.getElementById('ignored-list');
    if (!listEl) return;
    const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
    let list: IgnoredClimbersList | null = null, error = '', busy = false, undo: IgnoredClimberEntry | null = null;
    const message = el('ignored-status');
    const search = el<HTMLInputElement>('ignored-search'), sort = el<HTMLSelectElement>('ignored-sort');
    const undoButton = el<HTMLButtonElement>('ignored-undo-button');
    const announce = (value: string): void => { message.textContent = value; };
    const accept = (next: unknown): void => {
        const valid = I.readList(next);
        if (valid && (!list || valid.revision >= list.revision)) list = valid;
    };
    const render = (): void => {
        const focused = document.activeElement;
        const focusedRow = focused && listEl.contains(focused) ? focused.closest<HTMLElement>('[data-cid]') : null;
        const focusedIndex = focusedRow ? [...listEl.children].indexOf(focusedRow) : -1;
        const entries = list?.entries || [];
        el('ignored-tab').textContent = `Ignored · ${entries.length}`;
        el('ignored-count').textContent = `${entries.length} ignored climber${entries.length === 1 ? '' : 's'}`;
        el<HTMLButtonElement>('ignored-add-button').disabled = busy || !list;
        listEl.setAttribute('aria-busy', String(busy));
        undoButton.setAttribute('aria-disabled', String(busy));
        const matches = entries.map(entry => ({ entry, score: F.fuzzyScore(entry, search.value) }))
            .filter((item): item is { entry: IgnoredClimberEntry; score: number } => item.score != null)
            .sort((a, b) => (search.value.trim() ? a.score - b.score : 0)
                || (sort.value === 'name' ? F.byName(a.entry, b.entry) : F.byAddedAtDesc(a.entry, b.entry)));
        listEl.replaceChildren();
        for (const { entry } of matches) {
            const row = document.createElement('li'); row.className = 'favorite-item'; row.dataset.cid = String(entry.cid);
            const info = document.createElement('span'); info.className = 'favorite-body';
            const name = document.createElement('a'); name.className = 'favorite-name';
            const climberUrl = F.climberPageUrl(entry.cid);
            if (climberUrl) name.href = climberUrl;
            name.target = '_blank'; name.rel = 'noopener noreferrer'; name.textContent = entry.name;
            const meta = document.createElement('span'); meta.className = 'favorite-meta';
            meta.textContent = `#${entry.cid} · Added ${new Date(entry.addedAt).toLocaleDateString()}`;
            info.append(name, meta);
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'panel-button quiet favorite-remove';
            remove.textContent = 'Unignore'; remove.setAttribute('aria-label', `Unignore ${entry.name}`);
            // Keep the focused control available while saving. Native disabled
            // buttons cannot regain focus after this list is rendered again.
            remove.setAttribute('aria-disabled', String(busy));
            remove.addEventListener('click', async () => {
                if (busy) return;
                busy = true; render();
                try {
                    const result = await mutateIgnored(runtimeApi, {
                        kind: 'remove',
                        cid: entry.cid,
                        expectedEntry: I.entrySignature(entry),
                    });
                    accept(result.list); undo = entry; el('ignored-undo').hidden = false;
                    announce(`${entry.name} unignored.`);
                } catch (failure) { announce(errorMessage(failure)); }
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
            (row?.querySelector<HTMLElement>(focused?.matches('a') ? 'a' : 'button')
                || el<HTMLInputElement>('ignored-add-input')).focus({ preventScroll: true });
        }
    };
    const observer = observeIgnored(storageApi, state => { if (state.list) accept(state.list); error = state.error; render(); });
    search.addEventListener('input', render); sort.addEventListener('change', render);
    el('ignored-retry').addEventListener('click', () => { void observer.refresh(); });
    el<HTMLFormElement>('ignored-add-form').addEventListener('submit', async event => {
        event.preventDefault(); if (busy || !list) return;
        const input = el<HTMLInputElement>('ignored-add-input');
        const raw = input.value.trim();
        const cid = /^\d+$/.test(raw) ? Number(raw) : I.profileId(raw);
        if (!I.validCid(cid)) return announce('Enter a climber id or Peakbagger climber-page link.');
        const existing = list.entries.find(entry => entry.cid === cid);
        if (existing) {
            search.value = ''; render(); listEl.querySelector<HTMLElement>(`[data-cid="${cid}"] button`)?.focus();
            return announce('Already ignored.');
        }
        const climberUrl = F.climberPageUrl(cid);
        if (!climberUrl) return announce('Enter a climber id or Peakbagger climber-page link.');
        busy = true; render(); announce('Loading climber…');
        try {
            const result = await fetchPeakbaggerDocument(climberUrl, { kind: 'climber' });
            if (result.kind !== 'ok') throw peakbaggerError.exception(result.error);
            const doc = result.document;
            const ids = new Set([...doc.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a => {
                try {
                    const url = new URL(a.href, doc.baseURI);
                    return isPeakbaggerUrl(url.href)
                        && /^\/climber\/climblistc\.aspx$/i.test(url.pathname)
                        && !/^My Ascents$/i.test((a.textContent || '').trim());
                } catch { return false; }
            }).map(a => Number(new URL(a.href, doc.baseURI).searchParams.get('cid'))));
            const name = F.climberNameFromDocument(doc);
            if (ids.size !== 1 || !ids.has(cid) || !name) throw new Error("Couldn't confirm this climber's identity.");
            if ([...doc.querySelectorAll(F.BUDDY_CONTROL_SELECTOR)].some(control => F.buddyControlAction(control) === 'remove')) {
                throw new Error(`${name}: Remove from your Buddy List before ignoring.`);
            }
            const response = await mutateIgnored(runtimeApi, { kind: 'add', entry: { cid, name, addedAt: Date.now() } });
            accept(response.list); input.value = '';
            announce(response.alreadyPresent ? 'Already ignored.' : `${name} added to ignored climbers.`);
        } catch (failure) { announce(errorMessage(failure)); }
        finally { busy = false; render(); }
    });
    undoButton.addEventListener('click', async () => {
        if (!undo || busy) return;
        const entry = undo;
        let restoreFocus = false;
        busy = true; render();
        try {
            const response = await mutateIgnored(runtimeApi, { kind: 'add', entry, expectedEntry: 'absent' });
            restoreFocus = document.activeElement === undoButton;
            accept(response.list); undo = null; el('ignored-undo').hidden = true; announce('Ignore restored.');
        } catch (failure) { announce(errorMessage(failure)); }
        finally {
            busy = false; render();
            if (restoreFocus) (listEl.querySelector<HTMLElement>(`[data-cid="${entry.cid}"] button`)
                || el<HTMLInputElement>('ignored-add-input')).focus({ preventScroll: true });
        }
    });
    const tabs = [el<HTMLButtonElement>('favorites-tab'), el<HTMLButtonElement>('ignored-tab')];
    const activate = (index: number): void => {
        tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
        el('favorites-workspace').hidden = index !== 0; el('ignored-workspace').hidden = index !== 1;
    };
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => { location.hash = index ? 'ignored' : 'favorites'; activate(index); });
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
            history.replaceState(null, '', next ? '#ignored' : '#favorites');
            activate(next); tabs[next].focus();
        });
    });
    window.addEventListener('hashchange', () => activate(location.hash === '#ignored' ? 1 : 0));
    storageApi.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[F.FAVORITES_KEY]) {
            tabs[0].textContent = `Favorites · ${F.cleanFavorites(changes[F.FAVORITES_KEY].newValue).entries.length}`;
        }
    });
    void storageApi.storage.local.get(F.FAVORITES_KEY).then(value => {
        tabs[0].textContent = `Favorites · ${F.cleanFavorites(value[F.FAVORITES_KEY]).entries.length}`;
    }).catch(() => {});
    activate(location.hash === '#ignored' ? 1 : 0); render();
};
