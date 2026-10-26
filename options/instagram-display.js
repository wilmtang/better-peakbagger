// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { INSTAGRAM_DISPLAY_ORIGINS } from '../src/reports/instagram-display-registration.js';

export function initInstagramDisplay({ extensionApi: api, flash }) {
    const control = document.getElementById('instagram-display-fixes');
    if (!control || !api?.permissions?.contains) return;
    let busy = false, revision = 0;
    const refresh = async () => {
        const current = ++revision;
        try {
            const allowed = await api.permissions.contains({ origins: INSTAGRAM_DISPLAY_ORIGINS });
            if (current === revision && !busy) control.checked = allowed;
        } catch { if (current === revision && !busy) control.checked = false; }
    };
    for (const type of ['click', 'keydown']) control.addEventListener(type, event => {
        if (busy && (type === 'click' || event.key === ' ' || event.key === 'Enter')) event.preventDefault();
    });
    control.addEventListener('change', async () => {
        if (busy) return;
        busy = true; revision++; control.setAttribute('aria-disabled', 'true'); control.setAttribute('aria-busy', 'true');
        try {
            // Request directly from this explicit user action, before any await.
            const enable = control.checked;
            const changed = enable
                ? await api.permissions.request({ origins: INSTAGRAM_DISPLAY_ORIGINS })
                : await api.permissions.remove({ origins: INSTAGRAM_DISPLAY_ORIGINS });
            if (!changed) { flash(enable ? 'Instagram access wasn’t granted.' : 'Instagram access could not be removed.', { error: true }); return; }
            const reply = await api.runtime.sendMessage({ type: 'INSTAGRAM_DISPLAY_SYNC' });
            if (!reply?.ok) throw new Error('Instagram display fixes could not be updated. Reload the post to retry.');
            flash(enable ? 'Instagram display fixes enabled. Reload an open post to apply them.' : 'Instagram display fixes disabled.');
        } catch (error) { flash(error.message || 'Instagram access could not be changed.', { error: true }); }
        finally { busy = false; control.removeAttribute('aria-busy'); control.setAttribute('aria-disabled', 'false'); void refresh(); }
    });
    api.permissions.onAdded?.addListener(refresh);
    api.permissions.onRemoved?.addListener(refresh);
    void refresh();
}
