// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { runtimeMessage as RuntimeMessage, type RuntimeMessageExtension } from '../src/ui/runtime-message.ts';
import { mutateIgnored, type IgnoredRuntimeApi } from '../src/favorites/ignored-client.ts';
import { hasGithubPermission, observeGithubAccess, type GithubAccessExtensionApi } from './github.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';
import * as I from '../src/favorites/ignored-climbers.ts';
import type { IgnoredClimberEntry, MergeChoice, MergeConflict } from '../src/favorites/ignored-climbers.ts';

export type IgnoredBackupExtensionApi = (GithubAccessExtensionApi & IgnoredRuntimeApi & RuntimeMessageExtension & {
    storage: {
        onChanged?: {
            addListener(listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void): void;
        };
    };
}) | typeof chrome;

export interface InitIgnoredBackupOptions {
    extensionApi?: IgnoredBackupExtensionApi;
}

interface IgnoredSyncState {
    enabled?: boolean;
    phase: string;
    error?: string;
    lastSuccess?: number | null;
    lastBackup?: number | null;
}

interface IgnoredSyncPreview {
    id: string;
    kind: 'backup' | 'restore' | 'setup' | 'conflict' | 'recovery';
    local: IgnoredClimberEntry[];
    remote: IgnoredClimberEntry[] | null;
    base: IgnoredClimberEntry[] | null;
    conflicts: MergeConflict[];
}

interface IgnoredUndoRecord {
    entries: IgnoredClimberEntry[];
    expectedRevision: number;
    expectedSignature: string;
}

interface IgnoredListResponse {
    ok?: boolean;
    error?: { code?: string; message?: string };
    state?: IgnoredSyncState;
    preview?: IgnoredSyncPreview | null;
    undo?: IgnoredUndoRecord | null;
    count?: number;
}

interface AuthStatusResponse {
    connected?: boolean;
}

const errorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    return String(error);
};

export const initIgnoredBackup = ({
    extensionApi = ((globalThis as { browser?: IgnoredBackupExtensionApi }).browser
        || (globalThis as { chrome?: IgnoredBackupExtensionApi }).chrome),
}: InitIgnoredBackupOptions = {}): void => {
    const root = document.getElementById('ignored-github');
    if (!root || !extensionApi) return;
    const element = <T extends HTMLElement = HTMLElement>(suffix: string): T =>
        document.getElementById(`ignored-${suffix}`) as T;
    const status = element('github-status'), backup = element<HTMLButtonElement>('backup');
    const restore = element<HTMLButtonElement>('restore'), syncToggle = element<HTMLInputElement>('sync-enable');
    const panel = element('review'), title = element('review-title'), impact = element('review-impact');
    const mode = element<HTMLSelectElement>('review-mode'), conflicts = element('review-conflicts');
    const confirm = element<HTMLButtonElement>('review-confirm'), cancel = element<HTMLButtonElement>('review-cancel');
    const undo = element<HTMLButtonElement>('restore-undo');
    const send = RuntimeMessage.bind(extensionApi as RuntimeMessageExtension);
    const runtimeApi = extensionApi as unknown as IgnoredRuntimeApi;
    let enabled = false, connected = false, busy = false;
    let pending: IgnoredSyncPreview | null = null, undoRecord: IgnoredUndoRecord | null = null;
    let trigger: HTMLElement = backup, revision = 0;
    const request = async (message: Record<string, unknown>): Promise<IgnoredListResponse> => {
        const response = await send<IgnoredListResponse>({ type: 'GITHUB_IGNORED_LIST', ...message });
        if (!response?.ok && !response?.preview) {
            throw new Error(response?.error?.message || 'Could not reach the backup worker. Try again.');
        }
        return response;
    };
    const paintImpact = (): void => {
        if (!pending) return;
        const remote = pending.remote || [];
        const choices: Record<number, MergeChoice> = {};
        for (const select of conflicts.querySelectorAll<HTMLSelectElement>('select')) {
            const cid = Number(select.dataset.cid);
            if (Number.isSafeInteger(cid)) {
                choices[cid] = select.value === 'github' ? 'github' : 'device';
            }
        }
        const candidate = mode.value === 'device' ? pending.local : mode.value === 'github' ? remote
            : I.mergeLists(pending.base || [], pending.local, remote, choices).entries;
        const changes = { local: I.membershipChanges(pending.local, candidate), remote: I.membershipChanges(remote, candidate) };
        impact.textContent = `${changes.local.added} added and ${changes.local.removed} removed on this device. `
            + `${changes.remote.added} added and ${changes.remote.removed} removed on GitHub.`;
        conflicts.hidden = mode.value !== 'merge';
    };
    const paintPreview = (preview: IgnoredSyncPreview, focus = true): void => {
        pending = preview; panel.hidden = false;
        const restoring = preview.kind === 'restore';
        title.textContent = restoring ? 'Restore ignored climbers?' : 'Review ignored climbers';
        mode.value = restoring ? 'github' : preview.kind === 'backup' ? 'device' : 'merge';
        mode.hidden = restoring;
        const modeLabel = mode.closest('label');
        if (modeLabel) modeLabel.hidden = restoring;
        panel.classList.toggle('is-review', !restoring);
        confirm.textContent = restoring ? 'Restore ignored climbers' : 'Apply reviewed changes';
        confirm.classList.toggle('danger', restoring);
        confirm.classList.toggle('primary', !restoring);
        conflicts.replaceChildren();
        for (const conflict of preview.conflicts) {
            const label = document.createElement('label'); label.className = 'ignored-conflict';
            label.append(document.createTextNode(`${conflict.device?.name || conflict.github?.name || 'Climber'} · #${conflict.cid} `));
            const sides: readonly [string, IgnoredClimberEntry | null][] = [
                ['Device', conflict.device],
                ['GitHub', conflict.github],
            ];
            for (const [side, entry] of sides) {
                const detail = document.createElement('span'); detail.className = 'desc ignored-conflict-version';
                const date = entry ? new Date(entry.addedAt) : null;
                detail.textContent = entry
                    ? `${side}: ${entry.name} · Added ${date && Number.isFinite(date.getTime()) ? date.toLocaleDateString() : 'date unavailable'}`
                    : `${side}: Removed`;
                label.append(detail);
            }
            const select = document.createElement('select'); select.dataset.cid = String(conflict.cid);
            select.setAttribute('aria-label', `Version to keep for climber ${conflict.cid}`);
            for (const [value, name] of [['', 'Choose version…'], ['device', conflict.device ? 'Keep device version' : 'Keep device removal'],
                ['github', conflict.github ? 'Keep GitHub version' : 'Keep GitHub removal']]) {
                const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
            }
            select.addEventListener('change', paintImpact); label.append(select); conflicts.append(label);
        }
        paintImpact(); if (focus) cancel.focus({ preventScroll: true });
    };
    const refresh = async (): Promise<void> => {
        const token = ++revision;
        try {
            const [response, auth, permission] = await Promise.all([request({ action: 'status' }),
                send<AuthStatusResponse>({ type: 'GITHUB_AUTH_STATUS' }), hasGithubPermission(extensionApi)]);
            if (token !== revision || busy) return;
            connected = !!auth?.connected && permission;
            backup.disabled = restore.disabled = !connected;
            const state = response.state;
            if (!state) return;
            enabled = !!state.enabled; syncToggle.checked = enabled; syncToggle.disabled = !connected;
            const backupLabel = backup.querySelector('span');
            if (backupLabel) backupLabel.textContent = enabled ? 'Sync now' : 'Back up now';
            if (response.preview && panel.hidden && state.phase === 'review') paintPreview(response.preview, false);
            status.textContent = state.phase === 'working' ? 'Syncing…' : state.phase === 'review' ? `Review changes${state.error ? ` · ${state.error}` : ''}`
                : state.phase === 'offline' ? `Offline — changes saved on this device${state.error ? ` · ${state.error}` : ''}`
                    : state.phase === 'pending' ? 'Pending changes' : state.phase === 'synced' && state.lastSuccess ? `Synced ${new Date(state.lastSuccess).toLocaleString()}`
                        : state.error || (state.phase === 'backed-up' && state.lastBackup
                            ? `Backed up ${new Date(state.lastBackup).toLocaleString()}`
                            : state.phase === 'restored' ? 'Ignored climbers restored.' : `Saved on this device · ${response.count} climbers${connected ? '' : ' · Connect GitHub above to back up'}`);
        } catch (error) { if (token === revision && !busy) status.textContent = errorMessage(error); }
    };
    const run = async (operation: () => Promise<IgnoredListResponse>): Promise<void> => {
        if (busy) return;
        const focused = document.activeElement;
        const ownsFocus = () => document.activeElement === focused;
        let nextFocus: HTMLElement | null = null;
        busy = true; revision++; root.setAttribute('aria-busy', 'true');
        for (const button of [backup, restore, confirm, cancel, undo]) OptionsUtils.setButtonBusy(button, true);
        mode.disabled = true; syncToggle.disabled = !enabled; status.textContent = enabled ? 'Syncing…' : 'Working with GitHub…';
        try {
            const response = await operation();
            if (response.state) { enabled = !!response.state.enabled; syncToggle.checked = enabled; }
            if (response.preview) {
                paintPreview(response.preview, false);
                if (ownsFocus()) nextFocus = cancel;
            }
            else {
                if (panel.contains(document.activeElement) || document.activeElement === undo) nextFocus = trigger;
                panel.hidden = true; pending = null;
                undoRecord = response.undo || null; undo.hidden = !undoRecord;
                status.textContent = response.state?.phase === 'synced' ? 'Ignored climbers synced.'
                    : response.state?.phase === 'pending' ? 'Pending changes'
                        : response.state?.phase === 'restored' ? 'Ignored climbers restored.' : 'Ignored climbers backed up.';
            }
        } catch (error) { status.textContent = errorMessage(error); }
        finally {
            busy = false; root.removeAttribute('aria-busy');
            for (const button of [backup, restore, confirm, cancel, undo]) OptionsUtils.setButtonBusy(button, false);
            mode.disabled = false; syncToggle.disabled = !connected; backup.disabled = restore.disabled = !connected;
            // A deliberate move elsewhere during the request belongs to the reader.
            nextFocus?.focus({ preventScroll: true });
            void refresh();
        }
    };
    backup.addEventListener('click', () => { if (busy) return; trigger = backup; void run(() => request({ action: enabled ? 'sync' : 'backup' })); });
    syncToggle.addEventListener('change', () => {
        const next = syncToggle.checked; trigger = syncToggle;
        if (busy && enabled && !next) {
            status.textContent = 'Cancelling sync…';
            void request({ action: 'disable' }).then(() => { enabled = false; syncToggle.checked = false; }).catch(error => { status.textContent = errorMessage(error); });
            return;
        }
        if (busy) { syncToggle.checked = enabled; return; }
        void run(() => request({ action: next ? 'enable' : 'disable' }));
    });
    restore.addEventListener('click', () => { if (busy) return; trigger = restore; void run(() => request({ action: 'restore' })); });
    mode.addEventListener('change', paintImpact);
    confirm.addEventListener('click', () => {
        if (!pending || busy) return;
        const reviewId = pending.id;
        const choices = Object.fromEntries([...conflicts.querySelectorAll<HTMLSelectElement>('select')].map(select => [select.dataset.cid ?? '', select.value]));
        void run(() => request({ action: 'confirm', reviewId, mode: mode.value, choices }));
    });
    const dismiss = (): void => { if (busy) return; void run(() => request({ action: 'dismiss' })); };
    cancel.addEventListener('click', dismiss);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden && !busy) { event.preventDefault(); dismiss(); } });
    undo.addEventListener('click', () => {
        if (!undoRecord || busy) return;
        const record = undoRecord;
        void run(async () => {
            await mutateIgnored(runtimeApi, { kind: 'replace', ...record });
            undoRecord = null; undo.hidden = true; return { state: { phase: 'restored' } };
        });
    });
    const storageOnChanged = extensionApi.storage?.onChanged as {
        addListener?: (listener: (changes: Record<string, unknown>, areaName: string) => void) => void;
    } | undefined;
    storageOnChanged?.addListener?.((changes, area) => {
        if (area === 'local' && (changes[I.IGNORED_KEY] || changes[I.SYNC_KEY])) void refresh();
    });
    observeGithubAccess(extensionApi, () => { void refresh(); });
    void refresh();
    void request({ action: 'check' }).then(refresh).catch(() => {});
};
