// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Files from '../src/favorites/climber-files.ts';
import type { ClimberListKind, StoredClimberList } from '../src/favorites/climber-files.ts';
import { boundedText as Text } from '../src/net/bounded-text.ts';
import { optionsUtils as UI } from './options-utils.ts';
import { createStableText } from '../src/ui/stable-text.ts';

export interface ClimberFilesApi {
    storage: {
        local: {
            get(keys: string): Promise<Record<string, unknown>>;
        };
    };
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
    };
}

export interface ClimberFileTransferOptions {
    root: HTMLElement;
    kind: ClimberListKind | string;
    api: ClimberFilesApi;
}

interface PendingReplacement {
    current: StoredClimberList;
    replacement: StoredClimberList;
}

interface ReplacementMutationResponse {
    ok?: boolean;
    error?: {
        code?: string;
        message?: string;
    };
}

export function mountClimberFileTransfer({ root, kind, api }: ClimberFileTransferOptions): void {
    const doc = root.ownerDocument;
    const win = doc.defaultView ?? globalThis;
    const name = kind === 'favorites' ? 'favorites' : 'ignored climbers';
    root.classList.add('climber-file-transfer');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', `${name} files`);
    const actions = doc.createElement('div'); actions.className = 'climber-file-actions';
    const button = (label: string, action: string): HTMLButtonElement => {
        const element = doc.createElement('button'); element.type = 'button';
        element.className = 'panel-button secondary'; element.textContent = label;
        element.dataset.fileAction = action; return element;
    };
    const exportButton = button('Export JSON', 'export'), importButton = button('Import JSON…', 'import');
    const input = doc.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
    input.setAttribute('aria-label', `Import ${name} JSON`);
    actions.append(exportButton, importButton, input);
    const status = doc.createElement('p'); status.className = 'desc'; status.setAttribute('role', 'status');
    const stableStatus = createStableText(status);
    const conflictMessage = kind === 'favorites'
        ? 'Some climbers are ignored or have a pending list change. Review your lists before importing.'
        : 'Some climbers are favorites or buddies, or have a pending buddy change. Review your lists before importing.';
    const messages = ['Reading file…', 'Saving list…', 'JSON file exported.', 'List imported.',
        'Review the list replacement below.', 'Import cancelled.', conflictMessage,
        'The saved list could not be read. It has not been changed.',
        'The list could not be transferred. Try again.',
        'Choose a valid JSON file for this list (up to 1,500 climbers and 2 MB).',
        'This list changed. Review the updated counts before importing.'];
    stableStatus.reserve(messages);
    const preview = doc.createElement('div'); preview.className = 'climber-file-preview'; preview.hidden = true;
    const impact = doc.createElement('p');
    const previewActions = doc.createElement('div'); previewActions.className = 'climber-file-actions';
    const cancel = button('Cancel', 'cancel'), confirm = button('Replace list', 'confirm'); confirm.classList.add('danger');
    previewActions.append(cancel, confirm); preview.append(impact, previewActions);
    root.append(actions, status, preview);
    let pending: PendingReplacement | null = null;
    let busy = false;
    const read = async (): Promise<StoredClimberList> => {
        const key = Files.listKey(kind);
        if (!key) throw new Error('The saved list could not be read. It has not been changed.');
        const stored = await api.storage.local.get(key);
        return Files.readStoredList(kind, stored[key]);
    };
    const show = (current: StoredClimberList, replacement: StoredClimberList): void => {
        const opening = preview.hidden;
        pending = { current, replacement };
        const changes = Files.membershipChanges(current.entries, replacement.entries);
        const countName = current.entries.length === 1 ? kind === 'favorites' ? 'favorite' : 'ignored climber' : name;
        impact.textContent = `Replace ${current.entries.length} ${countName} with ${replacement.entries.length} from this file? `
            + `${changes.added} added, ${changes.removed} removed. Names and saved details also come from the file.`;
        preview.hidden = false;
        if (opening && (doc.activeElement === importButton || doc.activeElement === doc.body)) {
            cancel.focus({ preventScroll: true });
        }
    };
    const hide = (): void => {
        const focused = preview.contains(doc.activeElement);
        preview.hidden = true; pending = null;
        if (focused) importButton.focus({ preventScroll: true });
    };
    const run = async (operation: () => Promise<void>): Promise<void> => {
        if (busy) return;
        busy = true; root.setAttribute('aria-busy', 'true');
        for (const control of [exportButton, importButton, cancel, confirm]) UI.setButtonBusy(control, true);
        try { await operation(); }
        catch (error) {
            const err = error as { code?: unknown; message?: unknown } | null | undefined;
            const message = typeof err?.message === 'string' ? err.message : '';
            stableStatus.set(err?.code === 'list-conflict' ? conflictMessage
                : Text.isLimitError(error) ? 'Choose a valid JSON file for this list (up to 1,500 climbers and 2 MB).'
                    : messages.includes(message) ? message : 'The list could not be transferred. Try again.');
        }
        finally {
            busy = false; root.removeAttribute('aria-busy');
            for (const control of [exportButton, importButton, cancel, confirm]) UI.setButtonBusy(control, false);
        }
    };
    exportButton.addEventListener('click', () => void run(async () => {
        const text = Files.serializeListFile(kind, await read());
        const url = win.URL.createObjectURL(new win.Blob([text], { type: 'application/json' }));
        try {
            const link = doc.createElement('a'); link.href = url;
            link.download = `better-peakbagger-${kind}-${new Date().toISOString().slice(0, 10)}.json`; link.click();
            stableStatus.set('JSON file exported.');
        } finally { win.URL.revokeObjectURL(url); }
    }));
    importButton.addEventListener('click', () => { if (!busy) input.click(); });
    input.addEventListener('change', () => {
        const file = input.files?.[0]; input.value = '';
        if (!file || busy) return;
        void run(async () => {
            hide(); stableStatus.set('Reading file…');
            const text = await Text.readBoundedBlobText(file, { maxBytes: Files.MAX_BYTES, label: 'Climber file' });
            const replacement = Files.parseListFile(kind, text);
            show(await read(), replacement); stableStatus.set('Review the list replacement below.');
        });
    });
    cancel.addEventListener('click', () => { if (!busy) { hide(); stableStatus.set('Import cancelled.'); } });
    preview.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); hide(); stableStatus.set('Import cancelled.'); }
    });
    confirm.addEventListener('click', () => {
        if (busy || !pending) return;
        const activePending = pending;
        void run(async () => {
            stableStatus.set('Saving list…');
            const response = await api.runtime.sendMessage(
                Files.replacementMutation(kind, activePending.current, activePending.replacement),
            ) as ReplacementMutationResponse | null | undefined;
            if (response?.error?.code === 'stale') {
                show(await read(), activePending.replacement);
                stableStatus.set('This list changed. Review the updated counts before importing.'); return;
            }
            if (!response?.ok) throw Object.assign(new Error(response?.error?.message), { code: response?.error?.code });
            hide(); stableStatus.set('List imported.');
        });
    });
}

export function initClimberFiles(api: ClimberFilesApi): void {
    for (const root of document.querySelectorAll<HTMLElement>('[data-climber-files]')) {
        mountClimberFileTransfer({ root, kind: root.dataset.climberFiles ?? '', api });
    }
}
