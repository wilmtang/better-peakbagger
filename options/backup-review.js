// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { optionsUtils as UI } from './options-utils.js';

// A deliberate disclosure below the triggering row, with stable action labels
// through pending/error/retry. The worker rechecks both snapshots on acceptance.
export function createBackupReview({ anchor, submit }) {
    const panel = document.createElement('div');
    panel.className = 'backup-confirmation backup-replacement';
    panel.hidden = true;
    const copy = document.createElement('p');
    copy.textContent = 'GitHub has a different backup. Restore from GitHub to use it, or replace it with this device’s current copy.';
    const actions = document.createElement('div');
    actions.className = 'backup-actions';
    const cancel = UI.actionButton('secondary', 'Cancel', 'Cancel backup replacement');
    const accept = UI.actionButton('danger', 'Replace GitHub backup', 'Replace GitHub backup with this device’s copy');
    actions.append(cancel, accept); panel.append(copy, actions);
    anchor.closest('.subsection, .card')?.append(panel);
    let review = null, busy = false;
    const clear = () => {
        const focused = panel.contains(document.activeElement);
        panel.hidden = true; review = null;
        if (focused) anchor.focus();
    };
    cancel.addEventListener('click', () => { if (!busy) clear(); });
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); clear(); }
    });
    accept.addEventListener('click', async () => {
        if (busy || !review) return;
        busy = true;
        UI.setButtonBusy(accept, true); UI.setButtonBusy(cancel, true);
        panel.setAttribute('aria-busy', 'true');
        try { await submit(review); }
        finally {
            busy = false; panel.removeAttribute('aria-busy');
            UI.setButtonBusy(accept, false); UI.setButtonBusy(cancel, false);
        }
    });
    return { show(value) {
        const opening = panel.hidden;
        review = value; panel.hidden = false;
        if (opening && (document.activeElement === anchor || document.activeElement === document.body)) {
            cancel.focus({ preventScroll: true });
        }
    }, clear };
}
