// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — device-local trip-report draft manager.

import { reportDrafts as Drafts } from '../src/reports/report-drafts.js';
import { reportMarkup as Markup } from '../src/reports/report-markup.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

export const initDrafts = ({ extensionApi = globalThis.browser || globalThis.chrome, flash } = {}) => {
    const store = extensionApi?.storage?.local;
    const listEl = document.getElementById('drafts-list');
    const emptyEl = document.getElementById('drafts-empty');
    const deleteAllEl = document.getElementById('drafts-delete-all');
    const undoAllEl = document.getElementById('drafts-undo-all');
    const undoAllButtonEl = document.getElementById('drafts-undo-all-button');
    const confirmationEl = document.getElementById('drafts-delete-all-confirmation');
    const confirmationTitleEl = document.getElementById('drafts-delete-all-confirmation-title');
    const confirmationCancelEl = document.getElementById('drafts-delete-all-cancel');
    const confirmationConfirmEl = document.getElementById('drafts-delete-all-confirm');
    if (!store || OptionsUtils.logMissingElements('draft manager', {
        'drafts-list': listEl,
        'drafts-empty': emptyEl,
        'drafts-delete-all': deleteAllEl,
        'drafts-undo-all': undoAllEl,
        'drafts-undo-all-button': undoAllButtonEl,
        'drafts-delete-all-confirmation': confirmationEl,
        'drafts-delete-all-confirmation-title': confirmationTitleEl,
        'drafts-delete-all-cancel': confirmationCancelEl,
        'drafts-delete-all-confirm': confirmationConfirmEl,
    })) return { refresh() {} };

    const DAY_MS = 24 * 60 * 60 * 1000;
    const UNDO_MS = 6000;
    const pendingDeletes = new Map();
    let pendingBulk = null;
    let currentDrafts = [];
    let refreshRevision = 0;
    let refreshTimer = null;

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

    const undoControlFor = key => [...listEl.children]
        .find(item => item.dataset.draftKey === key)
        ?.querySelector('[data-action="undo"]');

    const undoDelete = async key => {
        const pending = pendingDeletes.get(key);
        if (!pending || pending.restoring) return;
        globalThis.clearTimeout(pending.timer);
        pending.timer = null;
        pending.restoring = true;
        render();
        try {
            await store.set({ [key]: pending.record });
            if (pendingDeletes.get(key) === pending) pendingDeletes.delete(key);
            render();
            flash('Draft restored');
            await refresh();
        } catch (error) {
            pending.restoring = false;
            render();
            flash('Couldn’t restore the draft. Try again.', { error: true });
            undoControlFor(key)?.focus();
        }
    };

    const beginDelete = async draft => {
        if (pendingDeletes.has(draft.key)) return;
        const pending = {
            record: draft.record,
            savedAt: draft.record.savedAt,
            title: draftTitle(draft),
            timer: null,
            restoring: false
        };
        pending.timer = globalThis.setTimeout(() => {
            pendingDeletes.delete(draft.key);
            render();
        }, UNDO_MS);
        pendingDeletes.set(draft.key, pending);
        render();
        // render() replaced the row, so the Delete button the user activated is
        // gone and focus would fall to <body>. Move it to this row's Undo — the
        // control they now need, and the one the bulk path already focuses —
        // because it expires in 6 seconds.
        undoControlFor(draft.key)?.focus();
        try {
            await store.remove(draft.key);
            await refresh();
        } catch (error) {
            globalThis.clearTimeout(pending.timer);
            pendingDeletes.delete(draft.key);
            render();
            flash('Couldn’t delete the draft', { error: true });
        }
    };

    const copyDraft = async (draft, control) => {
        try {
            const clipboard = globalThis.navigator?.clipboard;
            if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
            await clipboard.writeText(markdownFor(draft.record));
            control.textContent = 'Copied';
            flash('Copied');
            globalThis.setTimeout(() => {
                if (control.isConnected) control.textContent = 'Copy Markdown';
            }, 1400);
        } catch (error) {
            flash('Couldn’t copy Markdown', { error: true });
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
        message.textContent = pending.restoring ? 'Restoring draft…' : 'Draft deleted';
        const undo = actionButton(
            'draft-undo',
            pending.restoring ? 'Restoring…' : 'Undo',
            `Undo deletion of ${pending.title}`
        );
        undo.dataset.action = 'undo';
        undo.disabled = pending.restoring;
        undo.addEventListener('click', () => { void undoDelete(key); });
        item.append(message, undo);
        return { item, savedAt: pending.savedAt };
    };

    const render = () => {
        const focusedUndoKey = document.activeElement?.dataset.action === 'undo'
            ? document.activeElement.closest('.draft-item')?.dataset.draftKey
            : null;
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
        undoAllButtonEl.disabled = !!pendingBulk?.restoring;
        undoAllButtonEl.textContent = pendingBulk?.restoring ? 'Restoring…' : 'Undo';
        emptyEl.hidden = rows.length > 0 || !!pendingBulk;
        const freshCount = rows.filter(row => row.fresh).length;
        deleteAllEl.hidden = freshCount === 0;
        deleteAllEl.textContent = freshCount === 1
            ? 'Delete this draft'
            : `Delete all ${freshCount} drafts`;
        // Another tab may have emptied the list while the question was open;
        // never leave a confirmation for drafts that are no longer there.
        if (!confirmationEl.hidden && freshCount === 0) hideDeleteAllConfirmation({ restoreFocus: false });
        if (focusedUndoKey) undoControlFor(focusedUndoKey)?.focus();
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
            flash('Trip report drafts are unavailable', { error: true });
        }
    };

    const hideDeleteAllConfirmation = ({ restoreFocus = true } = {}) => {
        confirmationEl.hidden = true;
        if (restoreFocus && deleteAllEl.isConnected && !deleteAllEl.hidden) deleteAllEl.focus();
    };

    // The native confirm() cannot follow the extension's dark theme, cannot be
    // styled, and blocks the page. This is the third host for the in-page block
    // the favorites mirror and the settings import already use.
    const askDeleteAll = () => {
        const count = currentDrafts.filter(draft => !pendingDeletes.has(draft.key)).length;
        if (!count || pendingBulk) return;
        confirmationTitleEl.textContent = count === 1
            ? 'Delete this trip report draft from this device?'
            : `Delete all ${count} trip report drafts from this device?`;
        confirmationEl.hidden = false;
        confirmationConfirmEl.focus();
    };

    const beginDeleteAll = async () => {
        if (pendingBulk) return;
        const records = new Map(currentDrafts
            .filter(draft => !pendingDeletes.has(draft.key))
            .map(draft => [draft.key, draft.record]));
        if (!records.size) return;
        hideDeleteAllConfirmation({ restoreFocus: false });
        const pending = { records, timer: null, restoring: false };
        pending.timer = globalThis.setTimeout(() => {
            if (pendingBulk === pending) pendingBulk = null;
            render();
        }, UNDO_MS);
        pendingBulk = pending;
        render();
        undoAllButtonEl.focus();
        try {
            await store.remove([...records.keys()]);
            await refresh();
        } catch (error) {
            globalThis.clearTimeout(pending.timer);
            if (pendingBulk === pending) pendingBulk = null;
            render();
            flash('Couldn’t delete the drafts', { error: true });
            deleteAllEl.focus();
        }
    };

    const undoDeleteAll = async () => {
        if (!pendingBulk || pendingBulk.restoring) return;
        const pending = pendingBulk;
        globalThis.clearTimeout(pending.timer);
        pending.timer = null;
        pending.restoring = true;
        render();
        try {
            await store.set(Object.fromEntries(pending.records));
            if (pendingBulk === pending) pendingBulk = null;
            render();
            flash('Drafts restored');
            await refresh();
        } catch (error) {
            pending.restoring = false;
            render();
            flash('Couldn’t restore the drafts. Try again.', { error: true });
            undoAllButtonEl.focus();
        }
    };

    deleteAllEl.addEventListener('click', askDeleteAll);
    confirmationCancelEl.addEventListener('click', () => hideDeleteAllConfirmation());
    confirmationConfirmEl.addEventListener('click', () => { void beginDeleteAll(); });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || confirmationEl.hidden) return;
        event.preventDefault();
        hideDeleteAllConfirmation();
    });
    undoAllButtonEl.addEventListener('click', () => { void undoDeleteAll(); });

    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !Object.keys(changes).some(key => key.startsWith(Drafts.PREFIX))) return;
            globalThis.clearTimeout(refreshTimer);
            refreshTimer = globalThis.setTimeout(() => { void refresh(); }, 20);
        });
    }

    void refresh();
    return { refresh };
};
