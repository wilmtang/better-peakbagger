// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — device-local trip-report draft manager.

import { reportDrafts as Drafts } from '../src/reports/report-drafts.js';
import { reportMarkup as Markup } from '../src/reports/report-markup.js';

(() => {
    'use strict';

    const extensionApi = globalThis.browser || globalThis.chrome;
    const store = extensionApi?.storage?.local;
    const listEl = document.getElementById('drafts-list');
    const emptyEl = document.getElementById('drafts-empty');
    const deleteAllEl = document.getElementById('drafts-delete-all');
    const undoAllEl = document.getElementById('drafts-undo-all');
    const undoAllButtonEl = document.getElementById('drafts-undo-all-button');
    const statusEl = document.getElementById('status');
    if (!store || !listEl || !emptyEl || !deleteAllEl || !undoAllEl || !undoAllButtonEl || !statusEl) return;

    const DAY_MS = 24 * 60 * 60 * 1000;
    const UNDO_MS = 6000;
    const pendingDeletes = new Map();
    let pendingBulk = null;
    let currentDrafts = [];
    let refreshRevision = 0;
    let refreshTimer = null;
    let statusTimer = null;

    const showStatus = message => {
        statusEl.textContent = message;
        statusEl.classList.add('show');
        globalThis.clearTimeout(statusTimer);
        statusTimer = globalThis.setTimeout(() => statusEl.classList.remove('show'), 2200);
    };

    const draftTitle = draft => {
        const label = draft.record.label && typeof draft.record.label === 'object'
            ? draft.record.label
            : {};
        const peak = typeof label.peak === 'string' ? label.peak.trim().slice(0, 200) : '';
        const date = typeof label.date === 'string' ? label.date.trim().slice(0, 20) : '';
        const base = peak || Drafts.fallbackTitle(draft.parsed);
        return date ? `${base} · ${date}` : base;
    };

    const markdownFor = record => record.mode === 'markdown' && typeof record.source === 'string'
        ? record.source
        : Markup.bracketToMarkdown(record.text);

    const excerptFor = record => {
        let source;
        try { source = markdownFor(record); }
        catch (error) { source = record.text; }
        const oneLine = String(source).replace(/\s+/g, ' ').trim();
        return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
    };

    const savedLabel = savedAt => new Date(savedAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });

    const expiryLabel = record => {
        const remaining = Drafts.remainingMs(record, Date.now());
        return remaining <= DAY_MS ? 'Expires today' : `Expires in ${Math.ceil(remaining / DAY_MS)} days`;
    };

    const actionButton = (className, text, ariaLabel) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = text;
        button.setAttribute('aria-label', ariaLabel);
        return button;
    };

    const undoDelete = async key => {
        const pending = pendingDeletes.get(key);
        if (!pending) return;
        globalThis.clearTimeout(pending.timer);
        pendingDeletes.delete(key);
        render();
        try {
            await store.set({ [key]: pending.record });
            showStatus('Draft restored');
            await refresh();
        } catch (error) {
            showStatus('Couldn’t restore the draft');
        }
    };

    const beginDelete = async draft => {
        if (pendingDeletes.has(draft.key)) return;
        const pending = {
            record: draft.record,
            savedAt: draft.record.savedAt,
            title: draftTitle(draft),
            timer: null
        };
        pending.timer = globalThis.setTimeout(() => {
            pendingDeletes.delete(draft.key);
            render();
        }, UNDO_MS);
        pendingDeletes.set(draft.key, pending);
        render();
        try {
            await store.remove(draft.key);
            await refresh();
        } catch (error) {
            globalThis.clearTimeout(pending.timer);
            pendingDeletes.delete(draft.key);
            render();
            showStatus('Couldn’t delete the draft');
        }
    };

    const copyDraft = async (draft, control) => {
        try {
            const clipboard = globalThis.navigator?.clipboard;
            if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
            await clipboard.writeText(markdownFor(draft.record));
            control.textContent = 'Copied';
            showStatus('Copied');
            globalThis.setTimeout(() => {
                if (control.isConnected) control.textContent = 'Copy Markdown';
            }, 1400);
        } catch (error) {
            showStatus('Couldn’t copy Markdown');
        }
    };

    const renderDraftRow = draft => {
        const title = draftTitle(draft);
        const item = document.createElement('li');
        item.className = 'draft-item';
        item.dataset.draftKey = draft.key;

        const body = document.createElement('div');
        body.className = 'draft-body';
        const heading = document.createElement('h3');
        heading.className = 'draft-title';
        heading.textContent = title;

        const meta = document.createElement('p');
        meta.className = 'draft-meta';
        const mode = document.createElement('span');
        mode.className = 'draft-mode';
        mode.textContent = draft.record.mode === 'markdown' ? 'Markdown' : 'Rich';
        meta.append(`Saved ${savedLabel(draft.record.savedAt)}`, ' · ', mode, ' · ', expiryLabel(draft.record));

        const excerpt = document.createElement('p');
        excerpt.className = 'draft-excerpt';
        excerpt.textContent = excerptFor(draft.record) || 'Empty report';
        excerpt.title = excerpt.textContent;
        body.append(heading, meta, excerpt);

        const actions = document.createElement('div');
        actions.className = 'draft-actions';
        const open = document.createElement('a');
        open.className = 'secondary';
        open.href = Drafts.editUrl(draft.parsed);
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = 'Open';
        open.setAttribute('aria-label', `Open ${title}`);

        const copy = actionButton('secondary', 'Copy Markdown', `Copy ${title} as Markdown`);
        copy.dataset.action = 'copy';
        copy.addEventListener('click', () => { void copyDraft(draft, copy); });
        const remove = actionButton('secondary', 'Delete', `Delete ${title}`);
        remove.dataset.action = 'delete';
        remove.addEventListener('click', () => { void beginDelete(draft); });
        actions.append(open, copy, remove);
        item.append(body, actions);
        return item;
    };

    const renderDeletedRow = (key, pending) => {
        const item = document.createElement('li');
        item.className = 'draft-item draft-item-deleted';
        item.dataset.draftKey = key;
        const message = document.createElement('span');
        message.textContent = 'Draft deleted';
        const undo = actionButton('draft-undo', 'Undo', `Undo deletion of ${pending.title}`);
        undo.dataset.action = 'undo';
        undo.addEventListener('click', () => { void undoDelete(key); });
        item.append(message, undo);
        return { item, savedAt: pending.savedAt };
    };

    const render = () => {
        const bulkKeys = new Set(pendingBulk ? pendingBulk.records.keys() : []);
        const rows = currentDrafts
            .filter(draft => !pendingDeletes.has(draft.key) && !bulkKeys.has(draft.key))
            .map(draft => ({ savedAt: draft.record.savedAt, item: renderDraftRow(draft), fresh: true }));
        for (const [key, pending] of pendingDeletes) rows.push(renderDeletedRow(key, pending));
        rows.sort((a, b) => b.savedAt - a.savedAt);

        listEl.textContent = '';
        listEl.append(...rows.map(row => row.item));
        listEl.hidden = rows.length === 0;
        undoAllEl.hidden = !pendingBulk;
        emptyEl.hidden = rows.length > 0 || !!pendingBulk;
        deleteAllEl.hidden = !rows.some(row => row.fresh);
    };

    const refresh = async () => {
        const revision = ++refreshRevision;
        try {
            const everything = await store.get(null);
            const now = Date.now();
            const validEntries = Object.entries(everything || {})
                .filter(([key, record]) => key.startsWith(Drafts.PREFIX) && Drafts.validRecord(record));
            const expiredKeys = validEntries
                .filter(([, record]) => now - record.savedAt > Drafts.TTL_MS)
                .map(([key]) => key);
            if (expiredKeys.length) await store.remove(expiredKeys);
            if (revision !== refreshRevision) return;
            currentDrafts = validEntries
                .filter(([key]) => !expiredKeys.includes(key) && Drafts.parseKey(key))
                .map(([key, record]) => ({ key, record, parsed: Drafts.parseKey(key) }))
                .sort((a, b) => b.record.savedAt - a.record.savedAt);
            render();
        } catch (error) {
            if (revision !== refreshRevision) return;
            currentDrafts = [];
            render();
            showStatus('TR drafts are unavailable');
        }
    };

    const beginDeleteAll = async () => {
        if (pendingBulk) return;
        const records = new Map(currentDrafts
            .filter(draft => !pendingDeletes.has(draft.key))
            .map(draft => [draft.key, draft.record]));
        if (!records.size) return;
        const pending = { records, timer: null };
        pending.timer = globalThis.setTimeout(() => {
            if (pendingBulk === pending) pendingBulk = null;
            render();
        }, UNDO_MS);
        pendingBulk = pending;
        render();
        try {
            await store.remove([...records.keys()]);
            await refresh();
        } catch (error) {
            globalThis.clearTimeout(pending.timer);
            if (pendingBulk === pending) pendingBulk = null;
            render();
            showStatus('Couldn’t delete the drafts');
        }
    };

    const undoDeleteAll = async () => {
        if (!pendingBulk) return;
        const pending = pendingBulk;
        globalThis.clearTimeout(pending.timer);
        pendingBulk = null;
        render();
        try {
            await store.set(Object.fromEntries(pending.records));
            showStatus('Drafts restored');
            await refresh();
        } catch (error) {
            showStatus('Couldn’t restore the drafts');
        }
    };

    deleteAllEl.addEventListener('click', () => { void beginDeleteAll(); });
    undoAllButtonEl.addEventListener('click', () => { void undoDeleteAll(); });

    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !Object.keys(changes).some(key => key.startsWith(Drafts.PREFIX))) return;
            globalThis.clearTimeout(refreshTimer);
            refreshTimer = globalThis.setTimeout(() => { void refresh(); }, 20);
        });
    }

    void refresh();
})();
