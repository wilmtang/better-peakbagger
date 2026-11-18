// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — device-local trip-report draft manager.

import {
    reportDrafts as Drafts,
    type ParsedReportDraftKey,
    type ReportDraftRecord,
} from '../src/reports/report-drafts.ts';
import { reportMarkup as Markup } from '../src/reports/report-markup.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';

export type DraftsFlash = (message?: string, options?: { error?: boolean }) => unknown;

export type DraftsExtensionApi = {
    storage?: {
        local?: {
            get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
        };
        onChanged?: {
            addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
        };
    };
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
    };
} | typeof chrome;

export interface InitDraftsOptions {
    extensionApi?: DraftsExtensionApi;
    flash?: DraftsFlash;
}

export interface DraftsController {
    refresh(): Promise<void> | void;
}

interface DraftEntry {
    key: string;
    record: ReportDraftRecord;
    parsed: ParsedReportDraftKey;
}

interface PendingDraftDelete {
    record: ReportDraftRecord;
    savedAt: number;
    title: string;
    timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    restoring: boolean;
    deleting: boolean;
    generation: string | null;
}

interface BulkDeleteEntry {
    record: ReportDraftRecord;
    generation: string | null;
}

interface PendingBulkDelete {
    records: Map<string, BulkDeleteEntry>;
    timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    restoring: boolean;
    deleting: boolean;
}

interface DraftMutationItemResult {
    draftKey: string;
    deleted?: boolean;
    restored?: boolean;
    record?: ReportDraftRecord;
    generation?: string;
}

interface DraftMutationResponse {
    ok?: boolean;
    deleted?: boolean;
    restored?: boolean;
    record?: ReportDraftRecord;
    generation?: string;
    results?: DraftMutationItemResult[];
}

export const initDrafts = ({
    extensionApi = ((globalThis as { browser?: DraftsExtensionApi }).browser
        || (globalThis as { chrome?: DraftsExtensionApi }).chrome),
    flash = () => {},
}: InitDraftsOptions = {}): DraftsController => {
    const store = extensionApi?.storage?.local as {
        get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
    } | undefined;
    const listEl = document.getElementById('drafts-list');
    const emptyEl = document.getElementById('drafts-empty');
    const deleteAllEl = document.getElementById('drafts-delete-all');
    const undoAllEl = document.getElementById('drafts-undo-all');
    const undoAllLabelEl = undoAllEl?.querySelector('span');
    const undoAllButtonEl = document.getElementById('drafts-undo-all-button') as HTMLButtonElement | null;
    const confirmationEl = document.getElementById('drafts-delete-all-confirmation');
    const confirmationTitleEl = document.getElementById('drafts-delete-all-confirmation-title');
    const confirmationCancelEl = document.getElementById('drafts-delete-all-cancel');
    const confirmationConfirmEl = document.getElementById('drafts-delete-all-confirm');
    const copyFallbackEl = document.getElementById('drafts-copy-fallback');
    const copyFallbackValueEl = document.getElementById('drafts-copy-fallback-value') as HTMLTextAreaElement | null;
    const copyFallbackDismissEl = document.getElementById('drafts-copy-fallback-dismiss');
    if (!store || !extensionApi || OptionsUtils.logMissingElements('draft manager', {
        'drafts-list': listEl,
        'drafts-empty': emptyEl,
        'drafts-delete-all': deleteAllEl,
        'drafts-undo-all': undoAllEl,
        'drafts-undo-all label': undoAllLabelEl,
        'drafts-undo-all-button': undoAllButtonEl,
        'drafts-delete-all-confirmation': confirmationEl,
        'drafts-delete-all-confirmation-title': confirmationTitleEl,
        'drafts-delete-all-cancel': confirmationCancelEl,
        'drafts-delete-all-confirm': confirmationConfirmEl,
        'drafts-copy-fallback': copyFallbackEl,
        'drafts-copy-fallback-value': copyFallbackValueEl,
        'drafts-copy-fallback-dismiss': copyFallbackDismissEl,
    }) || !listEl || !emptyEl || !deleteAllEl || !undoAllEl || !undoAllLabelEl
        || !undoAllButtonEl || !confirmationEl || !confirmationTitleEl
        || !confirmationCancelEl || !confirmationConfirmEl || !copyFallbackEl
        || !copyFallbackValueEl || !copyFallbackDismissEl) {
        return { refresh() {} };
    }
    // Manual-copy recovery must not push the draft's original actions away.
    listEl.after(copyFallbackEl);

    const DAY_MS = 24 * 60 * 60 * 1000;
    const UNDO_MS = 6000;
    const pendingDeletes = new Map<string, PendingDraftDelete>();
    let pendingBulk: PendingBulkDelete | null = null;
    let currentDrafts: DraftEntry[] = [];
    let refreshRevision = 0;
    let refreshTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let copyFallbackReturn: { key: string; control: HTMLElement } | null = null;
    const sendMutation = (message: Record<string, unknown>): Promise<DraftMutationResponse | undefined> =>
        extensionApi.runtime.sendMessage(message) as Promise<DraftMutationResponse | undefined>;

    const draftTitle = (draft: DraftEntry): string => {
        const rawLabel = draft.record.label;
        const label = rawLabel && typeof rawLabel === 'object'
            ? rawLabel as { peak?: unknown; date?: unknown }
            : null;
        const peak = typeof label?.peak === 'string' ? label.peak.trim().slice(0, 200) : '';
        const date = typeof label?.date === 'string' ? label.date.trim().slice(0, 20) : '';
        const base = peak || Drafts.fallbackTitle(draft.parsed);
        return date ? `${base} · ${date}` : base;
    };

    const markdownFor = (record: ReportDraftRecord): string =>
        record.mode === 'markdown' && typeof record.source === 'string'
            ? record.source
            : Markup.bracketToMarkdown(record.text);

    const excerptFor = (record: ReportDraftRecord): string => {
        let source: string;
        try { source = markdownFor(record); }
        catch (error) { source = record.text; }
        const oneLine = String(source).replace(/\s+/g, ' ').trim();
        return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
    };

    const savedLabel = (savedAt: number): string => new Date(savedAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });

    const expiryLabel = (record: ReportDraftRecord): string => {
        const remaining = Drafts.remainingMs(record, Date.now());
        return remaining <= DAY_MS ? 'Expires today' : `Expires in ${Math.ceil(remaining / DAY_MS)} days`;
    };

    const listRows = (): HTMLElement[] => [...listEl.children] as HTMLElement[];

    const undoControlFor = (key: string): HTMLElement | null | undefined => listRows()
        .find(item => item.dataset.draftKey === key)
        ?.querySelector<HTMLElement>('[data-action="undo"]');

    const ownsRowFocus = (key: string): boolean => document.activeElement === document.body
        || document.activeElement === listEl
        || document.activeElement?.closest<HTMLElement>('.draft-item')?.dataset.draftKey === key;

    const draftRowControl = (key: string | undefined): HTMLElement | null | undefined => {
        if (!key) return null;
        return listRows()
            .find(item => item.dataset.draftKey === key)
            ?.querySelector<HTMLElement>('a, button');
    };

    const undoDelete = async (key: string): Promise<void> => {
        const pending = pendingDeletes.get(key);
        if (!pending || pending.restoring) return;
        globalThis.clearTimeout(pending.timer);
        pending.timer = undefined;
        pending.restoring = true;
        render();
        try {
            const result = await sendMutation({
                type: 'REPORT_DRAFT_RESTORE',
                draftKey: key,
                generation: pending.generation,
                record: pending.record,
            });
            if (!result?.ok) throw new Error('draft restore failed');
            if (pendingDeletes.get(key) === pending) pendingDeletes.delete(key);
            await refresh();
            if (result.restored) {
                flash('Draft restored');
                if (ownsRowFocus(key)) draftRowControl(key)?.focus();
            } else {
                flash('Newer edits already restored this draft');
                if (ownsRowFocus(key)) draftRowControl(key)?.focus();
            }
        } catch (error) {
            pending.restoring = false;
            render();
            flash('Couldn’t restore the draft. Try again.', { error: true });
            if (ownsRowFocus(key)) undoControlFor(key)?.focus();
        }
    };

    const beginDelete = async (draft: DraftEntry): Promise<void> => {
        if (pendingDeletes.has(draft.key)) return;
        const pending: PendingDraftDelete = {
            record: draft.record,
            savedAt: draft.record.savedAt,
            title: draftTitle(draft),
            timer: undefined,
            restoring: false,
            deleting: true,
            generation: null,
        };
        pendingDeletes.set(draft.key, pending);
        render();
        try {
            const result = await sendMutation({
                type: 'REPORT_DRAFT_DELETE',
                draftKey: draft.key,
                expectedGeneration: draft.record[Drafts.GENERATION_FIELD] || null,
                expectedSavedAt: draft.record.savedAt,
            });
            if (!result?.ok) throw new Error('draft delete failed');
            if (!result.deleted) {
                pendingDeletes.delete(draft.key);
                await refresh();
                flash('Newer edits kept this draft');
                if (ownsRowFocus(draft.key)) draftRowControl(draft.key)?.focus();
                return;
            }
            if (!result.record || !result.generation) throw new Error('draft delete failed');
            pending.record = result.record;
            pending.generation = result.generation;
            pending.deleting = false;
            pending.timer = globalThis.setTimeout(() => {
                if (pendingDeletes.get(draft.key) !== pending) return;
                pendingDeletes.delete(draft.key);
                render();
                void sendMutation({
                    type: 'REPORT_DRAFT_FINALIZE_DELETE',
                    draftKey: draft.key,
                    generation: pending.generation,
                }).catch(() => {});
            }, UNDO_MS);
            render();
            if (ownsRowFocus(draft.key)) undoControlFor(draft.key)?.focus();
            await refresh();
        } catch (error) {
            globalThis.clearTimeout(pending.timer);
            pendingDeletes.delete(draft.key);
            render();
            flash('Couldn’t delete the draft', { error: true });
        }
    };

    const dismissCopyFallback = ({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void => {
        copyFallbackEl.hidden = true;
        copyFallbackValueEl.value = '';
        if (restoreFocus) {
            const control = copyFallbackReturn?.control?.isConnected
                ? copyFallbackReturn.control
                : listRows()
                    .find(item => item.dataset.draftKey === copyFallbackReturn?.key)
                    ?.querySelector<HTMLElement>('[data-action="copy"]');
            control?.focus();
        }
        copyFallbackReturn = null;
    };

    const showCopyFallback = (markdown: string, draft: DraftEntry, control: HTMLElement): void => {
        copyFallbackReturn = { key: draft.key, control };
        copyFallbackValueEl.value = markdown;
        copyFallbackEl.hidden = false;
        copyFallbackValueEl.focus();
        copyFallbackValueEl.select();
        flash('Markdown selected for manual copy');
    };

    copyFallbackDismissEl.addEventListener('click', () => dismissCopyFallback());
    copyFallbackEl.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        dismissCopyFallback();
    });

    const copyDraft = async (draft: DraftEntry, control: HTMLElement): Promise<void> => {
        let markdown: string;
        try {
            markdown = markdownFor(draft.record);
        } catch {
            flash('Couldn’t prepare Markdown for copying', { error: true });
            return;
        }
        try {
            const clipboard = globalThis.navigator?.clipboard;
            if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
            await clipboard.writeText(markdown);
            if (!copyFallbackEl.hidden) dismissCopyFallback({ restoreFocus: false });
            const label = control.querySelector('span');
            if (label) label.textContent = 'Copied';
            flash('Copied');
            globalThis.setTimeout(() => {
                if (control.isConnected) {
                    const resetLabel = control.querySelector('span');
                    if (resetLabel) resetLabel.textContent = 'Copy Markdown';
                }
            }, 1400);
        } catch {
            showCopyFallback(markdown, draft, control);
        }
    };

    const renderDraftRow = (draft: DraftEntry): HTMLLIElement => {
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
        open.className = 'panel-button secondary';
        const editHref = Drafts.editUrl(draft.parsed);
        if (editHref) open.href = editHref;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = 'Open';
        open.setAttribute('aria-label', `Open ${title}`);

        const copy = OptionsUtils.actionButton('secondary', 'Copy Markdown', `Copy ${title} as Markdown`);
        const copyLabel = document.createElement('span'); copyLabel.textContent = copy.textContent;
        copy.replaceChildren(copyLabel);
        copy.dataset.action = 'copy';
        copy.addEventListener('click', () => { void copyDraft(draft, copy); });
        const remove = OptionsUtils.actionButton('secondary', 'Delete', `Delete ${title}`);
        remove.dataset.action = 'delete';
        remove.addEventListener('click', () => { void beginDelete(draft); });
        actions.append(open, copy, remove);
        item.append(body, actions);
        return item;
    };

    const renderDeletedRow = (key: string, pending: PendingDraftDelete): { item: HTMLLIElement; savedAt: number } => {
        const item = document.createElement('li');
        item.className = 'draft-item draft-item-deleted';
        item.dataset.draftKey = key;
        const message = document.createElement('span');
        message.textContent = pending.deleting
            ? 'Deleting draft…'
            : pending.restoring ? 'Restoring draft…' : 'Draft deleted';
        const undo = OptionsUtils.actionButton(
            'link draft-undo',
            pending.deleting ? 'Deleting…' : pending.restoring ? 'Restoring…' : 'Undo',
            `Undo deletion of ${pending.title}`
        );
        undo.dataset.action = 'undo';
        undo.disabled = pending.deleting || pending.restoring;
        if (pending.deleting || pending.restoring) item.setAttribute('aria-busy', 'true');
        undo.addEventListener('click', () => { void undoDelete(key); });
        item.append(message, undo);
        return { item, savedAt: pending.savedAt };
    };

    const hideDeleteAllConfirmation = ({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void => {
        confirmationEl.hidden = true;
        if (restoreFocus && deleteAllEl.isConnected && !deleteAllEl.hidden) deleteAllEl.focus();
    };

    const render = (): void => {
        const restoreFocus = OptionsUtils.listFocusRestorer(listEl, 'draftKey', () => {
            const target = listEl.hidden ? emptyEl : listEl;
            target.tabIndex = -1;
            return target;
        });
        const bulkKeys = new Set(pendingBulk ? pendingBulk.records.keys() : []);
        const rows: { savedAt: number; item: HTMLLIElement; fresh?: boolean }[] = currentDrafts
            .filter(draft => !pendingDeletes.has(draft.key) && !bulkKeys.has(draft.key))
            .map(draft => ({ savedAt: draft.record.savedAt, item: renderDraftRow(draft), fresh: true }));
        for (const [key, pending] of pendingDeletes) rows.push(renderDeletedRow(key, pending));
        rows.sort((a, b) => b.savedAt - a.savedAt);

        listEl.textContent = '';
        listEl.append(...rows.map(row => row.item));
        listEl.hidden = rows.length === 0;
        undoAllEl.hidden = !pendingBulk;
        undoAllButtonEl.disabled = !!(pendingBulk?.deleting || pendingBulk?.restoring);
        undoAllButtonEl.textContent = pendingBulk?.deleting
            ? 'Deleting…' : pendingBulk?.restoring ? 'Restoring…' : 'Undo';
        if (pendingBulk) {
            undoAllLabelEl.textContent = pendingBulk.deleting
                ? 'Deleting drafts…' : pendingBulk.restoring ? 'Restoring drafts…' : 'All drafts deleted';
            undoAllEl.setAttribute('aria-busy', String(!!(pendingBulk.deleting || pendingBulk.restoring)));
        } else {
            undoAllEl.removeAttribute('aria-busy');
        }
        emptyEl.hidden = rows.length > 0 || !!pendingBulk;
        const freshCount = rows.filter(row => row.fresh).length;
        deleteAllEl.hidden = freshCount === 0;
        deleteAllEl.textContent = freshCount === 1
            ? 'Delete this draft'
            : `Delete all ${freshCount} drafts`;
        // Another tab may have emptied the list while the question was open;
        // never leave a confirmation for drafts that are no longer there.
        if (!confirmationEl.hidden && freshCount === 0) hideDeleteAllConfirmation({ restoreFocus: false });
        restoreFocus();
    };

    const refresh = async (): Promise<void> => {
        const revision = ++refreshRevision;
        try {
            const everything = await store.get(null);
            const now = Date.now();
            const validEntries = Object.entries(everything || {})
                .filter((entry): entry is [string, ReportDraftRecord] =>
                    entry[0].startsWith(Drafts.PREFIX) && Drafts.validRecord(entry[1]));
            if (revision !== refreshRevision) return;
            const expiredEntries = validEntries
                .filter(([, record]) => now - record.savedAt > Drafts.TTL_MS);
            const expiredKeys = expiredEntries.map(([key]) => key);
            if (expiredEntries.length) {
                await Promise.all(expiredEntries.map(([draftKey, record]) => sendMutation({
                    type: 'REPORT_DRAFT_REMOVE',
                    draftKey,
                    expectedGeneration: record[Drafts.GENERATION_FIELD] ?? null,
                    expectedSavedAt: record.savedAt,
                })));
            }
            if (revision !== refreshRevision) return;
            currentDrafts = validEntries
                .filter(([key]) => !expiredKeys.includes(key))
                .map(([key, record]) => {
                    const parsed = Drafts.parseKey(key);
                    return parsed ? { key, record, parsed } : null;
                })
                .filter((draft): draft is DraftEntry => draft !== null)
                .sort((a, b) => b.record.savedAt - a.record.savedAt);
            render();
        } catch (error) {
            if (revision !== refreshRevision) return;
            currentDrafts = [];
            render();
            flash('Trip report drafts are unavailable', { error: true });
        }
    };

    // The native confirm() cannot follow the extension's dark theme, cannot be
    // styled, and blocks the page. This is the third host for the in-page block
    // the favorites mirror and the settings import already use.
    const askDeleteAll = (): void => {
        const count = currentDrafts.filter(draft => !pendingDeletes.has(draft.key)).length;
        if (!count || pendingBulk) return;
        confirmationTitleEl.textContent = count === 1
            ? 'Delete this trip report draft from this device?'
            : `Delete all ${count} trip report drafts from this device?`;
        confirmationEl.hidden = false;
        confirmationConfirmEl.focus();
    };

    const beginDeleteAll = async (): Promise<void> => {
        if (pendingBulk) return;
        const records = new Map<string, BulkDeleteEntry>(currentDrafts
            .filter(draft => !pendingDeletes.has(draft.key))
            .map(draft => [draft.key, { record: draft.record, generation: null }]));
        if (!records.size) return;
        hideDeleteAllConfirmation({ restoreFocus: false });
        const pending: PendingBulkDelete = { records, timer: undefined, restoring: false, deleting: true };
        pendingBulk = pending;
        render();
        try {
            const result = await sendMutation({
                type: 'REPORT_DRAFT_DELETE_MANY',
                entries: [...records].map(([draftKey, { record }]) => ({
                    draftKey,
                    expectedGeneration: record[Drafts.GENERATION_FIELD] || null,
                    expectedSavedAt: record.savedAt,
                })),
            });
            if (!result?.ok || !Array.isArray(result.results)) throw new Error('draft bulk delete failed');
            const deleted = result.results.filter(
                (item): item is DraftMutationItemResult & { record: ReportDraftRecord; generation: string } =>
                    Boolean(item.deleted && item.record && item.generation),
            );
            pending.records = new Map(deleted.map(item => [item.draftKey, {
                record: item.record,
                generation: item.generation,
            }]));
            if (!pending.records.size) {
                if (pendingBulk === pending) pendingBulk = null;
                await refresh();
                flash('Newer edits kept these drafts');
                deleteAllEl.focus();
                return;
            }
            pending.deleting = false;
            pending.timer = globalThis.setTimeout(() => {
                if (pendingBulk !== pending) return;
                pendingBulk = null;
                render();
                void sendMutation({
                    type: 'REPORT_DRAFT_FINALIZE_DELETE_MANY',
                    entries: [...pending.records].map(([draftKey, value]) => ({
                        draftKey,
                        generation: value.generation,
                    })),
                }).catch(() => {});
            }, UNDO_MS);
            render();
            undoAllButtonEl.focus();
            await refresh();
            if (deleted.length !== result.results.length) flash('Some newer drafts were kept');
        } catch (error) {
            globalThis.clearTimeout(pending.timer);
            if (pendingBulk === pending) pendingBulk = null;
            render();
            flash('Couldn’t delete the drafts', { error: true });
            deleteAllEl.focus();
        }
    };

    const undoDeleteAll = async (): Promise<void> => {
        if (!pendingBulk || pendingBulk.restoring) return;
        const pending = pendingBulk;
        globalThis.clearTimeout(pending.timer);
        pending.timer = undefined;
        pending.restoring = true;
        render();
        try {
            const result = await sendMutation({
                type: 'REPORT_DRAFT_RESTORE_MANY',
                entries: [...pending.records].map(([draftKey, value]) => ({
                    draftKey,
                    generation: value.generation,
                    record: value.record,
                })),
            });
            if (!result?.ok || !Array.isArray(result.results)) throw new Error('draft bulk restore failed');
            if (pendingBulk === pending) pendingBulk = null;
            await refresh();
            const restored = result.results.filter(item => item.restored).length;
            const conflicts = result.results.length - restored;
            if (restored && conflicts) flash('Drafts restored; newer edits were kept');
            else if (restored) flash('Drafts restored');
            else flash('Newer edits already restored these drafts');
            draftRowControl(result.results.find(item => item.restored)?.draftKey
                || result.results[0]?.draftKey)?.focus();
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

    const storageOnChanged = extensionApi.storage?.onChanged as {
        addListener?: (listener: (changes: Record<string, unknown>, areaName: string) => void) => void;
    } | undefined;
    if (storageOnChanged?.addListener) {
        storageOnChanged.addListener((changes, area) => {
            if (area !== 'local' || !Object.keys(changes).some(key => key.startsWith(Drafts.PREFIX))) return;
            globalThis.clearTimeout(refreshTimer);
            refreshTimer = globalThis.setTimeout(() => { void refresh(); }, 20);
        });
    }

    void refresh();
    return { refresh };
};
