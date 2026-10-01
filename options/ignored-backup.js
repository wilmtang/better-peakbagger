// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { runtimeMessage as RuntimeMessage } from '../src/ui/runtime-message.js';
import { mutateIgnored } from '../src/favorites/ignored-client.js';
import { hasGithubPermission } from './github.js';
import { STORAGE_KEY as AUTH_KEY } from '../src/github/github-auth.js';
import * as I from '../src/favorites/ignored-climbers.js';

export const initIgnoredBackup = ({ extensionApi } = {}) => {
    const root = document.getElementById('ignored-github'); if (!root) return;
    const element = suffix => document.getElementById(`ignored-${suffix}`);
    const status = element('github-status'), backup = element('backup'), restore = element('restore');
    const panel = element('review'), title = element('review-title'), impact = element('review-impact');
    const mode = element('review-mode'), conflicts = element('review-conflicts');
    const confirm = element('review-confirm'), cancel = element('review-cancel'), undo = element('restore-undo');
    const send = RuntimeMessage.bind(extensionApi);
    let connected = false, busy = false, pending = null, undoRecord = null, trigger = backup, revision = 0;
    const request = async message => {
        const response = await send({ type: 'GITHUB_IGNORED_LIST', ...message });
        if (!response?.ok) throw new Error(response?.error?.message || 'Could not reach the backup worker. Try again.');
        return response;
    };
    const paintImpact = () => {
        const changes = pending?.impacts[mode.value]; if (!changes) return;
        impact.textContent = `${changes.local.added} added and ${changes.local.removed} removed on this device. `
            + `${changes.remote.added} added and ${changes.remote.removed} removed on GitHub.`;
        conflicts.hidden = mode.value !== 'merge';
    };
    const paintPreview = preview => {
        pending = preview; panel.hidden = false;
        title.textContent = preview.kind === 'restore' ? 'Restore ignored climbers?' : 'Review ignored climbers';
        mode.value = preview.kind === 'restore' ? 'github' : preview.kind === 'backup' ? 'device' : 'merge';
        mode.hidden = preview.kind === 'restore';
        conflicts.replaceChildren();
        for (const conflict of preview.conflicts) {
            const label = document.createElement('label'); label.className = 'ignored-conflict';
            label.append(document.createTextNode(`${conflict.device?.name || conflict.github?.name || 'Climber'} · #${conflict.cid} `));
            const select = document.createElement('select'); select.dataset.cid = String(conflict.cid);
            select.setAttribute('aria-label', `Version to keep for climber ${conflict.cid}`);
            for (const [value, name] of [['', 'Choose version…'], ['device', conflict.device ? 'Keep device version' : 'Keep device removal'],
                ['github', conflict.github ? 'Keep GitHub version' : 'Keep GitHub removal']]) {
                const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
            }
            label.append(select); conflicts.append(label);
        }
        paintImpact(); cancel.focus({ preventScroll: true });
    };
    const refresh = async () => {
        const token = ++revision;
        try {
            const [response, auth, permission] = await Promise.all([request({ action: 'status' }),
                send({ type: 'GITHUB_AUTH_STATUS' }), hasGithubPermission(extensionApi)]);
            if (token !== revision || busy) return;
            connected = !!auth?.connected && permission;
            backup.disabled = restore.disabled = !connected;
            const state = response.state;
            status.textContent = state.error || (state.phase === 'backed-up' && state.lastBackup
                ? `Backed up ${new Date(state.lastBackup).toLocaleString()}`
                : state.phase === 'restored' ? 'Ignored climbers restored.' : `Saved on this device · ${response.count} climbers${connected ? '' : ' · Connect GitHub above to back up'}`);
        } catch (error) { if (token === revision && !busy) status.textContent = error.message; }
    };
    const run = async operation => {
        if (busy) return;
        busy = true; revision++; root.setAttribute('aria-busy', 'true');
        for (const button of [backup, restore, confirm, cancel, undo]) button.disabled = true;
        mode.disabled = true; status.textContent = 'Working with GitHub…';
        try {
            const response = await operation();
            if (response.preview) paintPreview(response.preview);
            else {
                panel.hidden = true; pending = null; trigger.focus({ preventScroll: true });
                if (response.undo) { undoRecord = response.undo; undo.hidden = false; }
                status.textContent = response.state?.phase === 'restored' ? 'Ignored climbers restored.' : 'Ignored climbers backed up.';
            }
        } catch (error) { status.textContent = error.message; }
        finally {
            busy = false; root.removeAttribute('aria-busy');
            for (const button of [backup, restore, confirm, cancel, undo]) button.disabled = false;
            mode.disabled = false; backup.disabled = restore.disabled = !connected;
            // The triggering action may have been disabled while focus moved.
            if (!panel.hidden) cancel.focus({ preventScroll: true }); else trigger.focus({ preventScroll: true });
            void refresh();
        }
    };
    backup.addEventListener('click', () => { trigger = backup; void run(() => request({ action: 'backup' })); });
    restore.addEventListener('click', () => { trigger = restore; void run(() => request({ action: 'restore' })); });
    mode.addEventListener('change', paintImpact);
    confirm.addEventListener('click', () => {
        if (!pending || busy) return;
        const choices = Object.fromEntries([...conflicts.querySelectorAll('select')].map(select => [select.dataset.cid, select.value]));
        void run(() => request({ action: 'confirm', reviewId: pending.id, mode: mode.value, choices }));
    });
    const dismiss = () => { if (busy) return; void run(() => request({ action: 'dismiss' })); };
    cancel.addEventListener('click', dismiss);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden && !busy) { event.preventDefault(); dismiss(); } });
    undo.addEventListener('click', () => {
        if (!undoRecord || busy) return;
        void run(async () => {
            await mutateIgnored(extensionApi, { kind: 'replace', ...undoRecord });
            undoRecord = null; undo.hidden = true; return { state: { phase: 'restored' } };
        });
    });
    extensionApi.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes[I.IGNORED_KEY] || changes[I.SYNC_KEY] || changes[AUTH_KEY])) void refresh();
    });
    void refresh();
};
